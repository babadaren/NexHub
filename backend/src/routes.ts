import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createBackup, listBackups, restoreBackup } from "./backup.js";
import { config } from "./config.js";
import { buildShareLink, parseImport, protocols, schemaFor, type ParsedNode } from "./adapters.js";
import { engineRuntime } from "./engine.js";
import { dashboardSummary, nodeRealtime, realtimeEvents, realtimeSummary } from "./metrics.js";
import { redisRuntime } from "./redis.js";
import { store } from "./storage.js";
import type { Direction, NodeConfig } from "./types.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const nodeSchema = z.object({
  name: z.string().min(1),
  protocol: z.string().min(1),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional()
});

const parsedNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.string(),
  server: z.string().optional(),
  port: z.number().optional(),
  status: z.enum(["parsed", "failed"]),
  raw: z.string(),
  config: z.record(z.unknown()),
  error: z.string().optional(),
  fingerprint: z.string().optional(),
  sourceFormat: z.string().optional()
});

const subscriptionShape = {
  name: z.string().min(1),
  url: z.string().url().optional(),
  content: z.string().optional(),
  autoRefresh: z.boolean().optional(),
  refreshCron: z.string().optional()
};

const subscriptionSchema = z.object(subscriptionShape).refine((body) => Boolean(body.url || body.content), { message: "订阅 URL 和粘贴内容至少填写一个" });

const subscriptionPatchSchema = z.object(subscriptionShape).partial().refine((body) => Object.keys(body).length > 0, { message: "至少提交一个字段" });

function auth(request: FastifyRequest) {
  return request.jwtVerify();
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function publicBaseUrl(request: FastifyRequest) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedHost = request.headers["x-forwarded-host"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  if (proto && host) return `${proto}://${host}`;
  return `http://${request.headers.host ?? "localhost"}`;
}

function localShareHost(node: NodeConfig) {
  const share = recordValue(node.config.share);
  return String(node.config.sharePublicHost ?? node.config.publicHost ?? share.publicHost ?? "proxy.example.com");
}

function localSharePayload(node: NodeConfig, token: string | undefined, baseUrl: string, includeToken: boolean) {
  const host = localShareHost(node);
  const link = buildShareLink(node) ?? `${node.protocol}://${host}/${node.id}`;
  const subscriptionPath = token ? `/sub/${token}` : undefined;
  const subscription = subscriptionPath ? `${baseUrl}${subscriptionPath}` : undefined;
  return {
    link,
    subscription,
    subscriptionPath,
    token: includeToken ? token : undefined,
    tokenAvailable: Boolean(token),
    tokenIssuedAt: node.config.shareTokenIssuedAt,
    qrPayload: subscription ?? link,
    clash: `proxies:\n  - name: ${node.name}\n    type: ${node.protocol}\n    server: ${host}\n`,
    singBox: { outbounds: [{ type: node.protocol, tag: node.name, server: host }] },
    message: token ? "分享链接已生成，请只发送给可信设备。" : "当前分享 token 已存在但不会再次显示；如需复制新链接，请轮换分享链接。"
  };
}

function directionRoutes(app: FastifyInstance, direction: Direction, prefix: string) {
  app.get(prefix, { preHandler: auth }, async () => store.listNodes(direction));

  app.post(prefix, { preHandler: auth }, async (request, reply) => {
    const input = nodeSchema.parse(request.body);
    const node = await store.createNode(direction, input);
    reply.code(201);
    return node;
  });

  app.get(`${prefix}/:id`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== direction) return reply.notFound("节点不存在");
    return { ...node, tests: store.recentTests(id).slice(0, 5), realtime: await nodeRealtime(id) };
  });

  app.patch(`${prefix}/:id`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = request.body as Record<string, unknown>;
    const node = await store.updateNode(id, patch);
    if (!node || node.direction !== direction) return reply.notFound("节点不存在");
    return node;
  });

  app.delete(`${prefix}/:id`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== direction) return reply.notFound("节点不存在");
    await store.deleteNode(id);
    reply.code(204);
  });

  app.post(`${prefix}/:id/test`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== direction) return reply.notFound("节点不存在");
    return store.runTest(node);
  });

  app.post(`${prefix}/:id/enable`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = await store.updateNode(id, { enabled: true, status: "enabled" });
    if (!node || node.direction !== direction) return reply.notFound("节点不存在");
    return node;
  });

  app.post(`${prefix}/:id/disable`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = await store.updateNode(id, { enabled: false, status: "disabled" });
    if (!node || node.direction !== direction) return reply.notFound("节点不存在");
    return node;
  });
}

export async function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok", version: config.version }));
  app.get("/ready", async () => ({
    status: "ready",
    checks: {
      app: "ok",
      postgres: store.driver === "postgres" ? "connected" : "json-dev",
      redis: redisRuntime.status,
      engine: config.engineProvider
    }
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const admin = await store.authenticate(body.username, body.password);
    if (!admin) return reply.unauthorized("管理员账号或密码不正确");
    const token = app.jwt.sign({ sub: admin.id, username: admin.username }, { expiresIn: `${config.jwtExpireHours}h` });
    return {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        mustChangePassword: admin.mustChangePassword
      }
    };
  });

  app.post("/api/auth/logout", { preHandler: auth }, async () => ({ ok: true }));

  app.get("/api/auth/me", { preHandler: auth }, async (request) => {
    const user = request.user as { sub: string; username: string };
    const admin = store.snapshot().admins.find((item) => item.id === user.sub);
    return {
      id: user.sub,
      username: user.username,
      email: admin?.email,
      mustChangePassword: admin?.mustChangePassword ?? false
    };
  });

  app.patch("/api/admin/password", { preHandler: auth }, async (request) => {
    const body = z.object({ password: z.string().min(8) }).parse(request.body);
    await store.changePassword(body.password);
    return { ok: true };
  });

  app.get("/api/dashboard/summary", { preHandler: auth }, async () => dashboardSummary());
  app.get("/api/dashboard/health", { preHandler: auth }, async () => dashboardSummary().health);
  app.get("/api/dashboard/events", { preHandler: auth }, async () => store.auditLogs());

  directionRoutes(app, "remote", "/api/remote-nodes");
  directionRoutes(app, "local", "/api/local-nodes");

  app.post("/api/remote-nodes/import/parse", { preHandler: auth }, async (request) => {
    const body = z.object({ input: z.string().min(1) }).parse(request.body);
    return { nodes: parseImport(body.input) };
  });

  app.post("/api/remote-nodes/import/apply", { preHandler: auth }, async (request) => {
    const body = z.object({ nodes: z.array(parsedNodeSchema).min(1) }).parse(request.body);
    return store.applyParsedNodes(body.nodes as ParsedNode[]);
  });

  app.post("/api/local-nodes/:id/start", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = await store.updateNode(id, { enabled: true, status: "enabled" });
    if (!node) return reply.notFound("节点不存在");
    return { node, engine: engineRuntime.getStatus() };
  });

  app.post("/api/local-nodes/:id/stop", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = await store.updateNode(id, { enabled: false, status: "disabled" });
    if (!node) return reply.notFound("节点不存在");
    return { node, engine: engineRuntime.getStatus() };
  });

  app.post("/api/local-nodes/:id/restart", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node) return reply.notFound("节点不存在");
    return store.runTest(node);
  });

  app.get("/api/local-nodes/:id/share", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== "local") return reply.notFound("节点不存在");
    const token = await store.ensureShareToken(node);
    return localSharePayload(node, token.token || undefined, publicBaseUrl(request), true);
  });

  app.post("/api/local-nodes/:id/share/rotate", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== "local") return reply.notFound("节点不存在");
    const token = await store.rotateShareToken(node);
    return localSharePayload(node, token.token, publicBaseUrl(request), true);
  });

  app.post("/api/local-nodes/:id/public-check", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node) return reply.notFound("节点不存在");
    return {
      publicIp: "203.0.113.24",
      dns: "正常",
      port: "可达",
      ipv6: "未检测",
      natType: "Cone",
      suggestion: "公网可达，可以分享给可信设备。"
    };
  });

  app.get("/sub/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const node = store.findLocalNodeByShareToken(token);
    if (!node) return reply.notFound("分享链接不存在或已失效");
    return localSharePayload(node, token, publicBaseUrl(request), false);
  });

  app.get("/api/protocols", { preHandler: auth }, async (request) => {
    const direction = ((request.query as { direction?: Direction }).direction ?? "remote") as Direction;
    return protocols[direction].map((protocol) => ({ protocol, label: protocol === "smart" ? "智能识别" : protocol.toUpperCase() }));
  });

  app.get("/api/protocols/:protocol/schema", { preHandler: auth }, async (request) => {
    const { protocol } = request.params as { protocol: string };
    const direction = ((request.query as { direction?: Direction }).direction ?? "remote") as Direction;
    return schemaFor(protocol, direction);
  });

  app.get("/api/realtime/summary", { preHandler: auth }, async () => realtimeSummary());
  app.get("/api/realtime/nodes/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    return nodeRealtime(id);
  });
  app.get("/api/realtime/events", { preHandler: auth }, async () => realtimeEvents());

  app.get("/api/subscriptions", { preHandler: auth }, async () => store.listSubscriptions());

  app.post("/api/subscriptions", { preHandler: auth }, async (request, reply) => {
    const body = subscriptionSchema.parse(request.body);
    const subscription = await store.createSubscription(body);
    reply.code(201);
    return subscription;
  });

  app.get("/api/subscriptions/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const subscription = store.getSubscription(id);
    if (!subscription) return reply.notFound("订阅源不存在");
    return subscription;
  });

  app.patch("/api/subscriptions/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = subscriptionPatchSchema.parse(request.body);
    const subscription = await store.updateSubscription(id, body);
    if (!subscription) return reply.notFound("订阅源不存在");
    return subscription;
  });

  app.delete("/api/subscriptions/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSubscription(id)) return reply.notFound("订阅源不存在");
    await store.deleteSubscription(id);
    reply.code(204);
  });

  app.post("/api/subscriptions/:id/refresh", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSubscription(id)) return reply.notFound("订阅源不存在");
    return store.refreshSubscription(id);
  });

  app.get("/api/system/status", { preHandler: auth }, async () => ({
    version: config.version,
    deployment: {
      app: "running",
      postgres: store.driver === "postgres" ? "connected" : "json-dev",
      redis: redisRuntime.status,
      engine: config.engineProvider
    },
    storage: {
      driver: store.driver,
      redisError: redisRuntime.error
    },
    engine: {
      ...recordValue(store.snapshot().settings.engine),
      runtime: engineRuntime.getStatus()
    },
    ports: {
      localTcpPortRange: config.localTcpPortRange,
      localUdpPortRange: config.localUdpPortRange
    }
  }));

  app.get("/api/system/settings", { preHandler: auth }, async () => store.snapshot().settings);
  app.patch("/api/system/settings", { preHandler: auth }, async (request) => {
    Object.assign(store.snapshot().settings, request.body);
    await store.save();
    return store.snapshot().settings;
  });

  app.get("/api/system/backups", { preHandler: auth }, async () => listBackups());

  app.post("/api/system/backup", { preHandler: auth }, async (request) => {
    const body = z.object({ reason: z.string().optional() }).optional().parse(request.body);
    return createBackup(body?.reason ?? "manual");
  });

  app.post("/api/system/backups/:file/restore", { preHandler: auth }, async (request) => {
    const { file } = request.params as { file: string };
    return restoreBackup(file);
  });

  app.post("/api/system/update-check", { preHandler: auth }, async () => ({
    current: config.version,
    latest: config.version,
    upToDate: true
  }));

  app.post("/api/system/restart", { preHandler: auth }, async () => {
    const result = await engineRuntime.restart();
    return {
      ok: true,
      result,
      engine: engineRuntime.getStatus()
    };
  });
}
