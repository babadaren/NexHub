import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { parseImport, protocols, schemaFor } from "./adapters.js";
import { dashboardSummary, nodeRealtime, realtimeSummary } from "./metrics.js";
import { store } from "./storage.js";
import type { Direction } from "./types.js";

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

function auth(request: FastifyRequest) {
  return request.jwtVerify();
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
    return { ...node, tests: store.recentTests(id).slice(0, 5), realtime: nodeRealtime(id) };
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
      postgres: "configured",
      redis: "configured",
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

  app.post("/api/local-nodes/:id/start", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = await store.updateNode(id, { enabled: true, status: "enabled" });
    if (!node) return reply.notFound("节点不存在");
    return node;
  });

  app.post("/api/local-nodes/:id/stop", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = await store.updateNode(id, { enabled: false, status: "disabled" });
    if (!node) return reply.notFound("节点不存在");
    return node;
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
    if (!node) return reply.notFound("节点不存在");
    const host = node.config.share && typeof node.config.share === "object" && "publicHost" in node.config.share ? String(node.config.share.publicHost) : "proxy.example.com";
    return {
      link: `${node.protocol}://${host}/${node.id}`,
      subscription: `https://${host}/sub/${node.id}`,
      qrPayload: `${node.protocol}://${host}/${node.id}`,
      clash: `proxies:\n  - name: ${node.name}\n    type: ${node.protocol}\n    server: ${host}\n`,
      singBox: { outbounds: [{ type: node.protocol, tag: node.name, server: host }] }
    };
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
  app.get("/api/realtime/events", { preHandler: auth }, async () => store.auditLogs());

  app.get("/api/system/status", { preHandler: auth }, async () => ({
    version: config.version,
    deployment: {
      app: "running",
      postgres: "configured",
      redis: "configured",
      engine: config.engineProvider
    },
    engine: store.snapshot().settings.engine ?? null,
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

  app.post("/api/system/backup", { preHandler: auth }, async () => ({
    file: `backup-${new Date().toISOString().replaceAll(":", "-")}.tar.gz`,
    containsSecrets: true,
    message: "开发模式已记录备份请求。Docker 部署时执行 pg_dump 和目录打包。"
  }));

  app.post("/api/system/update-check", { preHandler: auth }, async () => ({
    current: config.version,
    latest: config.version,
    upToDate: true
  }));

  app.post("/api/system/restart", { preHandler: auth }, async () => ({
    ok: true,
    message: "开发模式不会重启进程。"
  }));
}
