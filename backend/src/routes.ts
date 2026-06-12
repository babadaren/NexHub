import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BackupError, createBackup, listBackups, restoreBackup } from "./backup.js";
import { config } from "./config.js";
import { buildShareLink, parseImport, protocols, schemaFor, type ParsedNode } from "./adapters.js";
import { engineRuntime } from "./engine.js";
import { dashboardSummary, historySummary, nodeRealtime, realtimeEvents, realtimeSummary } from "./metrics.js";
import { LockConflictError, redisRuntime } from "./redis.js";
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

const nodePatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    config: z.record(z.unknown()).optional()
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "至少提交一个节点配置字段" });

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
  sourceType: z.enum(["url", "content"]).optional(),
  autoRefresh: z.boolean().optional(),
  refreshCron: z.string().optional(),
  autoEnableNewNodes: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional()
};

const subscriptionSchema = z.object(subscriptionShape).superRefine((body, ctx) => {
  if (body.url || body.content) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["url"],
    message: "订阅 URL 和粘贴内容至少填写一个"
  });
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["content"],
    message: "订阅 URL 和粘贴内容至少填写一个"
  });
});

const subscriptionPatchSchema = z.object(subscriptionShape).partial().refine((body) => Object.keys(body).length > 0, { message: "至少提交一个字段" });

const systemSettingsPatchSchema = z
  .object({
    retention: z
      .object({
        realtimeTtlHours: z.number().int().min(1).max(24).optional(),
        dailySummaryDays: z.number().int().min(1).max(3650).optional(),
        auditLogDays: z.number().int().min(1).max(3650).optional()
      })
      .partial()
      .optional(),
    security: z
      .object({
        allowPrivateSubscriptions: z.boolean().optional()
      })
      .partial()
      .optional()
  })
  .passthrough()
  .refine((body) => Object.keys(body).length > 0, { message: "至少提交一个设置项" });

const passwordPatchSchema = z.object({ password: z.string().min(8) });

function auth(request: FastifyRequest) {
  return request.jwtVerify();
}

function lockConflictMessage(error: unknown, fallback: string) {
  return error instanceof LockConflictError ? fallback : undefined;
}

function businessError(reply: FastifyReply, statusCode: number, code: string, message: string, suggestion?: string, details: Record<string, unknown> = {}) {
  return reply.code(statusCode).send({
    ok: false,
    code,
    message,
    suggestion,
    ...details
  });
}

function notFound(reply: FastifyReply, message = "资源不存在") {
  return businessError(reply, 404, "NOT_FOUND", message, "请刷新列表后重试，确认该资源没有被删除。");
}

function badRequest(reply: FastifyReply, code: string, message: string, suggestion?: string) {
  return businessError(reply, 400, code, message, suggestion);
}

function conflict(reply: FastifyReply, code: string, message: string, suggestion?: string) {
  return businessError(reply, 409, code, message, suggestion ?? "请等待当前操作完成后再重试。");
}

function tooManyRequests(reply: FastifyReply, code: string, message: string, suggestion?: string) {
  return businessError(reply, 429, code, message, suggestion ?? "请稍后再试。");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numericRecord(value: unknown): Record<string, number> {
  const record = recordValue(value);
  return Object.fromEntries(Object.entries(record).filter(([, item]) => typeof item === "number")) as Record<string, number>;
}

async function recordNodeOperationFailed(action: string, code: string, node: NodeConfig, message: string, metadata: Record<string, unknown> = {}) {
  await store.recordAudit(action, "node", node.id, `${node.name} 操作失败：${message}`, {
    code,
    direction: node.direction,
    protocol: node.protocol,
    ...metadata
  });
}

function publicBaseUrl(request: FastifyRequest) {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedHost = request.headers["x-forwarded-host"];
  const proto = firstHeaderValue(forwardedProto);
  const host = firstHeaderValue(forwardedHost);
  if (proto && host) return `${proto === "https" ? "https" : "http"}://${host}`;
  return `http://${firstHeaderValue(request.headers.host) ?? "localhost"}`;
}

function firstHeaderValue(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim();
}

function publicShareHost(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return url.hostname || "localhost";
  } catch {
    return baseUrl.replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0] || "localhost";
  }
}

function clientIp(request: FastifyRequest) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return (raw?.split(",")[0]?.trim() || request.ip || "unknown").replace(/[^\w:.-]/g, "_");
}

function localShareHost(node: NodeConfig, fallbackHost: string) {
  const share = recordValue(node.config.share);
  return String(node.config.sharePublicHost ?? node.config.publicHost ?? share.publicHost ?? fallbackHost);
}

function localSharePayload(node: NodeConfig, token: string | undefined, baseUrl: string, includeToken: boolean) {
  const host = localShareHost(node, publicShareHost(baseUrl));
  const shareNode =
    node.config.sharePublicHost || node.config.publicHost || recordValue(node.config.share).publicHost
      ? node
      : { ...node, config: { ...node.config, sharePublicHost: host } };
  const link = buildShareLink(shareNode) ?? `${node.protocol}://${host}/${node.id}`;
  const subscriptionPath = token ? `/sub/${token}` : undefined;
  const subscription = subscriptionPath ? `${baseUrl}${subscriptionPath}` : undefined;
  return {
    link,
    subscription,
    subscriptionPath,
    token: includeToken ? token : undefined,
    tokenAvailable: Boolean(token),
    tokenIssuedAt: store.shareTokenIssuedAt(node.id),
    qrPayload: subscription ?? link,
    clash: `proxies:\n  - name: ${node.name}\n    type: ${node.protocol}\n    server: ${host}\n`,
    singBox: { outbounds: [{ type: node.protocol, tag: node.name, server: host }] },
    message: token ? "分享链接已生成，请只发送给可信设备。" : "当前分享 token 已存在但不会再次显示；如需复制新链接，请轮换分享链接。"
  };
}

function localPortDiagnostic(node: NodeConfig) {
  const transport = ["wireguard", "hysteria2", "tuic"].includes(node.protocol) ? "udp" : "tcp";
  const allowedRange = transport === "udp" ? config.localUdpPortRange : config.localTcpPortRange;
  const port = Number(node.config.listenPort ?? node.config.port);
  const ranges = allowedRange
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [startRaw, endRaw] = part.split("-");
      const start = Number(startRaw);
      const end = Number(endRaw ?? startRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) return undefined;
      return { start, end };
    })
    .filter((range): range is { start: number; end: number } => Boolean(range));
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  const mapped = validPort && ranges.some((range) => port >= range.start && port <= range.end);
  return { transport, allowedRange, port, validPort, mapped };
}

function publicCheckResult(node: NodeConfig, request: FastifyRequest) {
  const diagnostic = localPortDiagnostic(node);
  const exposure = String(node.config.exposure ?? "lan");
  const forwardedFor = request.headers["x-forwarded-for"];
  const publicIp = Array.isArray(forwardedFor) ? forwardedFor[0]?.split(",")[0]?.trim() : forwardedFor?.split(",")[0]?.trim();
  const needsPublicReachability = exposure === "public" || exposure === "relay";
  if (!diagnostic.validPort) {
    return {
      publicIp: publicIp || "未检测",
      dns: "未检测",
      port: "监听端口无效",
      ipv6: "未检测",
      natType: "未检测",
      reachable: false,
      suggestion: "监听端口缺失或无效，请先修改本地节点端口并重新测试。"
    };
  }
  if (!diagnostic.mapped) {
    return {
      publicIp: publicIp || "未检测",
      dns: "未检测",
      port: `${diagnostic.port}/${diagnostic.transport} 未映射`,
      ipv6: "未检测",
      natType: "未检测",
      reachable: false,
      suggestion: `端口 ${diagnostic.port}/${diagnostic.transport} 没有映射到 Docker 宿主机。请改用 ${diagnostic.allowedRange} 范围内的端口，或切换到 host network 部署方式。`
    };
  }
  if (!needsPublicReachability) {
    return {
      publicIp: publicIp || "未检测",
      dns: "不需要",
      port: `${diagnostic.port}/${diagnostic.transport} 已映射`,
      ipv6: "未检测",
      natType: "局域网模式",
      reachable: false,
      suggestion: "当前开放范围不是公网或中继。局域网使用无需公网检测；如需外地设备连接，请切换为公网用途并配置域名、防火墙和端口转发。"
    };
  }
  return {
    publicIp: publicIp || "未检测",
    dns: String(node.config.publicHost ?? node.config.sharePublicHost ?? "未配置"),
    port: `${diagnostic.port}/${diagnostic.transport} 已在 Docker 映射范围内`,
    ipv6: "未检测",
    natType: "需以路由器/云防火墙实际结果为准",
    reachable: false,
    suggestion: "端口已满足 Docker 映射条件，但当前未接入外部探测服务。请继续确认云防火墙、路由器端口转发和域名解析是否指向本机公网地址。"
  };
}

function checkStatus(ok: boolean, message: string, detail?: string) {
  return {
    status: ok ? "ok" : "error",
    message,
    detail
  };
}

async function diskUsage(targetPath: string) {
  try {
    const stats = await statfs(targetPath);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      path: targetPath,
      totalBytes,
      freeBytes,
      usedBytes: Math.max(totalBytes - freeBytes, 0),
      usedPercent: totalBytes > 0 ? Number((((totalBytes - freeBytes) / totalBytes) * 100).toFixed(2)) : 0
    };
  } catch (error) {
    return {
      path: targetPath,
      error: error instanceof Error ? error.message : "disk usage unavailable"
    };
  }
}

async function systemStatus() {
  const engineStatus = engineRuntime.getStatus();
  const engineSettings = recordValue(store.snapshot().settings.engine);
  const backupStatus = await backupSummaryStatus();
  const redisOk = redisRuntime.status === "connected" || (!config.redisRequired && redisRuntime.status === "disabled");
  const engineOk = !engineSettings.lastRenderError && (config.engineMode !== "managed" || engineStatus.running);
  const databaseStatus = checkStatus(true, store.driver === "postgres" ? "PostgreSQL connected" : "JSON development storage");
  const redisStatus = checkStatus(redisOk, redisRuntime.status === "connected" ? "Redis connected" : redisRuntime.status === "disabled" ? "Redis disabled" : "Redis unavailable", redisRuntime.error);
  const engineCheck = checkStatus(Boolean(engineOk), engineSettings.lastRenderError ? "Engine render failed" : config.engineMode === "managed" ? "Engine managed runtime ready" : "Engine render-only mode", String(engineSettings.lastRenderError ?? ""));
  const checks = {
    app: checkStatus(true, "App process running"),
    database: databaseStatus,
    redis: redisStatus,
    migrations: checkStatus(true, store.driver === "postgres" ? "Migrations applied" : "Migrations skipped for JSON storage"),
    engine: engineCheck,
    backups: backupStatus.check
  };
  const ready = Object.values(checks).every((item) => item.status === "ok");
  return {
    status: ready ? "ready" : "degraded",
    ready,
    version: config.version,
    deployment: {
      app: checks.app.status,
      mode: config.serverMode,
      networkMode: config.networkMode,
      advancedNetwork: config.networkMode === "host",
      postgres: store.driver === "postgres" ? checks.database.status : "json-dev",
      redis: redisRuntime.status,
      engine: engineCheck.status
    },
    checks,
    storage: {
      driver: store.driver,
      dataDir: config.dataDir,
      backupDir: config.backupDir ?? path.join(config.dataDir, "backups"),
      releaseMode: config.releaseMode,
      redisRequired: config.redisRequired,
      redisError: redisRuntime.error
    },
    engine: {
      ...engineSettings,
      runtime: engineStatus
    },
    ports: {
      localTcpPortRange: config.localTcpPortRange,
      localUdpPortRange: config.localUdpPortRange
    },
    backups: {
      count: backupStatus.backups.length,
      error: backupStatus.error,
      latest: backupStatus.backups[0]
        ? {
            file: backupStatus.backups[0].file,
            createdAt: backupStatus.backups[0].createdAt,
            sizeBytes: backupStatus.backups[0].sizeBytes
          }
        : undefined
    },
    disk: await diskUsage(config.dataDir)
  };
}

async function backupSummaryStatus() {
  try {
    const backups = await listBackups();
    return {
      backups,
      check: checkStatus(true, backups[0] ? "Backup directory readable" : "Backup directory readable; no backups yet")
    };
  } catch (error) {
    if (error instanceof BackupError) {
      return {
        backups: [],
        error: { code: error.code, message: error.message, suggestion: error.suggestion },
        check: checkStatus(false, error.message, error.suggestion)
      };
    }
    const message = error instanceof Error ? error.message : "Backup summary unavailable";
    return {
      backups: [],
      error: { code: "BACKUP_STATUS_UNAVAILABLE", message, suggestion: "请检查备份目录权限和应用日志。" },
      check: checkStatus(false, message, "请检查备份目录权限和应用日志。")
    };
  }
}

async function installStatus() {
  const status = await systemStatus();
  const admin = store.snapshot().admins[0];
  return {
    ready: status.ready,
    status: status.status,
    version: status.version,
    serverMode: config.serverMode,
    adminUsername: admin?.username ?? config.adminUsername,
    dataDir: config.dataDir,
    storageDriver: store.driver,
    passwordCommand: "docker compose logs app | grep -i admin",
    loginPath: "/login",
    steps: [
      {
        key: "storage",
        title: store.driver === "postgres" ? "PostgreSQL 已连接" : "JSON 存储已初始化",
        message: store.driver === "postgres" ? "用于保存管理员账号、节点配置和审计摘要" : "用于本地开发和轻量试用"
      },
      {
        key: "redis",
        title: redisRuntime.status === "connected" ? "Redis 已连接" : config.redisRequired ? "Redis 未连接" : "Redis 可选",
        message: redisRuntime.status === "connected" ? "用于实时网速、延迟、在线状态和限流" : "未启用时实时监控会降级显示"
      },
      {
        key: "admin",
        title: "管理员账号已创建",
        message: "系统只保留一个管理员账号，不提供注册入口"
      },
      {
        key: "next",
        title: "打开控制台开始配置",
        message: "先添加远端节点或创建本地节点"
      }
    ]
  };
}

function directionRoutes(app: FastifyInstance, direction: Direction, prefix: string) {
  app.get(prefix, { preHandler: auth }, async () => store.listNodes(direction));

  app.post(prefix, { preHandler: auth }, async (request, reply) => {
    const input = nodeSchema.parse(request.body);
    const { node } = await store.createNode(direction, input);
    reply.code(201);
    return node;
  });

  app.post(`${prefix}/test-create`, { preHandler: auth }, async (request, reply) => {
    const input = nodeSchema.parse(request.body);
    try {
      const result = await store.createNode(direction, { ...input, enabled: true });
      reply.code(201);
      return result;
    } catch (error) {
      const message = lockConflictMessage(error, "节点正在创建或测试中，请稍后再试");
      if (message) return conflict(reply, "NODE_TEST_LOCKED", message);
      throw error;
    }
  });

  app.get(`${prefix}/:id`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== direction) return notFound(reply, "节点不存在");
    return { ...node, tests: store.recentTests(id).slice(0, 5), realtime: await nodeRealtime(id) };
  });

  app.patch(`${prefix}/:id`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = nodePatchSchema.parse(request.body);
    const current = store.getNode(id);
    if (!current || current.direction !== direction) return notFound(reply, "节点不存在");
    return store.updateNode(id, { ...patch, enabled: false, status: "draft" });
  });

  app.delete(`${prefix}/:id`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== direction) return notFound(reply, "节点不存在");
    await store.deleteNode(id);
    reply.code(204);
  });

  app.post(`${prefix}/:id/test`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== direction) return notFound(reply, "节点不存在");
    try {
      return await store.runTest(node);
    } catch (error) {
      const message = lockConflictMessage(error, "节点正在测试中，请稍后再试");
      if (message) {
        await store.recordAudit("node.test.locked", "node", id, `节点测试被互斥锁阻止：${node.name}`, {
          code: "NODE_TEST_LOCKED",
          direction,
          protocol: node.protocol
        });
        return conflict(reply, "NODE_TEST_LOCKED", message);
      }
      throw error;
    }
  });

  app.post(`${prefix}/:id/enable`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== direction) return notFound(reply, "节点不存在");
    const result = await store.enableNode(id);
    if (!result.ok) {
      const message = result.message ?? "节点不能启用";
      await recordNodeOperationFailed("node.enable.failed", "NODE_ENABLE_BLOCKED", node, message);
      return badRequest(reply, "NODE_ENABLE_BLOCKED", message, "请打开节点详情页，按提示补齐配置或改用已映射端口后再启用。");
    }
    await store.recordAudit("node.enabled", "node", id, `启用节点 ${node.name}`, { direction, protocol: node.protocol });
    return result.node;
  });

  app.post(`${prefix}/:id/disable`, { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = store.getNode(id);
    if (!current || current.direction !== direction) return notFound(reply, "节点不存在");
    const node = await store.updateNode(id, { enabled: false, status: "disabled" });
    if (!node) return notFound(reply, "节点不存在");
    await store.recordAudit("node.disabled", "node", id, `停用节点 ${node.name}`, { direction, protocol: node.protocol });
    return node;
  });
}

export async function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      const fields = error.issues.map((issue) => issue.path.join(".") || issue.message);
      return businessError(reply, 400, "VALIDATION_ERROR", `提交内容不完整或格式不正确：${fields.join(", ")}`, "请按页面提示补齐必填字段后再保存。", {
        field: fields[0],
        fields
      });
    }
    if (error instanceof BackupError) {
      return businessError(reply, error.statusCode, error.code, error.message, error.suggestion);
    }
    throw error;
  });

  app.get("/health", async () => ({ status: "ok", version: config.version }));
  app.get("/api/install/status", async () => installStatus());
  app.get("/ready", async (_request, reply) => {
    const status = await systemStatus();
    if (!status.ready) reply.code(503);
    return {
      status: status.status,
      ready: status.ready,
      version: status.version,
      checks: status.checks
    };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const authResult = await store.authenticate(body.username, body.password);
    if (!authResult.ok) {
      if (authResult.reason === "locked") return tooManyRequests(reply, "LOGIN_LOCKED", authResult.message, "请等待锁定时间结束后再尝试登录，或通过部署备份恢复管理员密码。");
      return businessError(reply, 401, "LOGIN_INVALID", authResult.message, "请检查管理员账号和密码；如果是首次安装，请查看 app 日志中的随机密码。");
    }
    const admin = authResult.admin;
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

  app.post("/api/auth/logout", { preHandler: auth }, async (request) => {
    const user = request.user as { sub?: string; username?: string };
    await store.recordAudit("admin.logout", "admin", user.sub, `管理员 ${user.username ?? "admin"} 退出登录`);
    return { ok: true };
  });

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

  const changePasswordHandler = async (request: FastifyRequest) => {
    const body = passwordPatchSchema.parse(request.body);
    await store.changePassword(body.password);
    return { ok: true };
  };

  const historySummaryHandler = async (request: FastifyRequest) => {
    const days = Math.min(Math.max(Number((request.query as { days?: string }).days ?? 14), 7), 180);
    return historySummary(days);
  };

  app.patch("/api/admin/password", { preHandler: auth }, changePasswordHandler);
  app.patch("/api/auth/password", { preHandler: auth }, changePasswordHandler);

  app.get("/api/dashboard/summary", { preHandler: auth }, async () => dashboardSummary());
  app.get("/api/dashboard/health", { preHandler: auth }, async () => dashboardSummary().health);
  app.get("/api/dashboard/events", { preHandler: auth }, async () => store.auditLogs());
  app.get("/api/history/summary", { preHandler: auth }, historySummaryHandler);
  app.get("/api/dashboard/history", { preHandler: auth }, historySummaryHandler);

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
    const node = store.getNode(id);
    if (!node || node.direction !== "local") return notFound(reply, "节点不存在");
    const result = await store.enableNode(id);
    if (!result.ok) {
      const message = result.message ?? "本地节点不能启动";
      await recordNodeOperationFailed("node.start.failed", "LOCAL_NODE_START_BLOCKED", node, message);
      return badRequest(reply, "LOCAL_NODE_START_BLOCKED", message, "请检查本地节点配置和 Docker 端口映射后再启动。");
    }
    await store.recordAudit("node.started", "node", id, `启动本地节点 ${node.name}`, { protocol: node.protocol });
    return { node: result.node, engine: engineRuntime.getStatus() };
  });

  app.post("/api/local-nodes/:id/stop", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = store.getNode(id);
    if (!current || current.direction !== "local") return notFound(reply, "节点不存在");
    const node = await store.updateNode(id, { enabled: false, status: "disabled" });
    await store.recordAudit("node.stopped", "node", id, `停止本地节点 ${current.name}`, { protocol: current.protocol });
    return { node, engine: engineRuntime.getStatus() };
  });

  app.post("/api/local-nodes/:id/restart", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== "local") return notFound(reply, "节点不存在");
    const enabled = await store.enableNode(id);
    if (!enabled.ok) {
      const message = enabled.message ?? "本地节点不能重启";
      await recordNodeOperationFailed("node.restart.failed", "LOCAL_NODE_RESTART_BLOCKED", node, message);
      return badRequest(reply, "LOCAL_NODE_RESTART_BLOCKED", message, "请检查本地节点配置和 Docker 端口映射后再重启。");
    }
    try {
      const latest = enabled.node ?? node;
      const test = await store.runTest(latest);
      await store.recordAudit("node.restarted", "node", id, `重启本地节点 ${node.name}`, { protocol: node.protocol, testStatus: test.finalStatus });
      return { node: store.getNode(id) ?? latest, test, engine: engineRuntime.getStatus() };
    } catch (error) {
      const message = lockConflictMessage(error, "节点正在重启或测试中，请稍后再试");
      if (message) {
        await recordNodeOperationFailed("node.restart.locked", "LOCAL_NODE_RESTART_LOCKED", node, message);
        return conflict(reply, "LOCAL_NODE_RESTART_LOCKED", message);
      }
      throw error;
    }
  });

  app.get("/api/local-nodes/:id/share", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== "local") return notFound(reply, "节点不存在");
    const token = await store.ensureShareToken(node);
    return localSharePayload(node, token.token || undefined, publicBaseUrl(request), true);
  });

  app.post("/api/local-nodes/:id/share/rotate", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== "local") return notFound(reply, "节点不存在");
    const token = await store.rotateShareToken(node);
    return localSharePayload(node, token.token, publicBaseUrl(request), true);
  });

  app.post("/api/local-nodes/:id/public-check", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = store.getNode(id);
    if (!node || node.direction !== "local") return notFound(reply, "节点不存在");
    return publicCheckResult(node, request);
  });

  app.get("/sub/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const limit = await redisRuntime.checkRateLimit(`rate:share:${clientIp(request)}:${token}`, config.shareRateLimitPerMinute, 60);
    reply.header("X-RateLimit-Limit", String(config.shareRateLimitPerMinute));
    reply.header("X-RateLimit-Remaining", String(limit.remaining));
    reply.header("X-RateLimit-Reset", String(limit.resetSeconds));
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.resetSeconds));
      return tooManyRequests(reply, "SHARE_RATE_LIMITED", "分享订阅访问过于频繁，请稍后再试", "请等待限流窗口结束，或在可信设备上重新打开分享链接。");
    }
    const node = store.findLocalNodeByShareToken(token);
    if (!node) return notFound(reply, "分享链接不存在或已失效");
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
  app.get("/api/realtime/stream", { preHandler: auth }, async (_request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const send = async () => {
      reply.raw.write("event: summary\n");
      reply.raw.write(`data: ${JSON.stringify(await realtimeSummary())}\n\n`);
    };
    await send();
    const timer = setInterval(() => {
      void send().catch((error) => {
        reply.log.error({ error }, "realtime stream send failed");
      });
    }, 5000);
    const heartbeat = setInterval(() => {
      reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15000);
    reply.raw.on("close", () => {
      clearInterval(timer);
      clearInterval(heartbeat);
    });
  });

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
    if (!subscription) return notFound(reply, "订阅源不存在");
    return subscription;
  });

  app.get("/api/subscriptions/:id/refresh-log", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const subscription = store.getSubscription(id);
    if (!subscription) return notFound(reply, "订阅源不存在");
    const redisEvents = (await redisRuntime.readEvents(50)).filter((event) => event.subscription_id === id);
    return {
      subscription,
      audits: store.subscriptionRefreshLogs(id),
      events: redisEvents
    };
  });

  app.patch("/api/subscriptions/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = subscriptionPatchSchema.parse(request.body);
    const subscription = await store.updateSubscription(id, body);
    if (!subscription) return notFound(reply, "订阅源不存在");
    return subscription;
  });

  app.delete("/api/subscriptions/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSubscription(id)) return notFound(reply, "订阅源不存在");
    await store.deleteSubscription(id);
    reply.code(204);
  });

  app.post("/api/subscriptions/:id/refresh", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const subscription = store.getSubscription(id);
    if (!subscription) return notFound(reply, "订阅源不存在");
    try {
      return await store.refreshSubscription(id);
    } catch (error) {
      const message = lockConflictMessage(error, "订阅正在刷新中，请稍后再试");
      if (message) {
        await store.recordAudit("subscription.refresh.locked", "subscription", id, `订阅刷新被互斥锁阻止：${subscription.name}`, {
          code: "SUBSCRIPTION_REFRESH_LOCKED"
        });
        return conflict(reply, "SUBSCRIPTION_REFRESH_LOCKED", message);
      }
      throw error;
    }
  });

  app.get("/api/system/status", { preHandler: auth }, async () => systemStatus());

  app.get("/api/system/settings", { preHandler: auth }, async () => store.snapshot().settings);
  app.patch("/api/system/settings", { preHandler: auth }, async (request) => {
    const body = systemSettingsPatchSchema.parse(request.body);
    const settings = store.snapshot().settings;
    if (body.retention) {
      settings.retention = {
        ...numericRecord(settings.retention),
        ...body.retention
      };
    }
    if (body.security) {
      settings.security = {
        ...recordValue(settings.security),
        ...body.security
      };
    }
    await store.save();
    await store.recordAudit("system.settings.updated", "system", undefined, "更新系统设置", {
      keys: Object.keys(body),
      allowPrivateSubscriptions: recordValue(settings.security).allowPrivateSubscriptions === true
    });
    return settings;
  });

  app.get("/api/system/backups", { preHandler: auth }, async () => listBackups());

  app.post("/api/system/backup", { preHandler: auth }, async (request) => {
    const body = z.object({ reason: z.string().optional() }).optional().parse(request.body);
    const reason = body?.reason ?? "manual";
    let backup;
    try {
      backup = await createBackup(reason);
    } catch (error) {
      if (error instanceof BackupError) {
        await store.recordAudit("system.backup.failed", "backup", undefined, `创建备份失败：${error.message}`, {
          code: error.code,
          reason,
          suggestion: error.suggestion
        });
      }
      throw error;
    }
    await store.recordAudit("system.backup.created", "backup", undefined, `创建备份 ${backup.file}`, {
      file: backup.file,
      reason,
      sizeBytes: backup.sizeBytes
    });
    return backup;
  });

  app.post("/api/system/backups/:file/restore", { preHandler: auth }, async (request) => {
    const { file } = request.params as { file: string };
    let result;
    try {
      result = await restoreBackup(file);
    } catch (error) {
      if (error instanceof BackupError) {
        await store.recordAudit("system.backup.restore.failed", "backup", undefined, `恢复备份失败：${error.message}`, {
          code: error.code,
          file,
          suggestion: error.suggestion
        });
      }
      throw error;
    }
    try {
      if (config.testFailRestoreSuccessAudit) {
        throw new Error("simulated restore success audit failure");
      }
      await store.recordAudit("system.backup.restored", "backup", undefined, `恢复备份 ${result.file}`, {
        file: result.file,
        preRestoreFile: result.preRestoreFile
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "恢复成功审计写入失败";
      return {
        ...result,
        auditWarning: {
          code: "RESTORE_AUDIT_WRITE_FAILED",
          message: "备份已恢复，但恢复成功审计写入失败。",
          suggestion: "请检查数据库或 state.json 写入权限；当前恢复结果已生效，避免未经确认重复恢复。",
          detail: message
        }
      };
    }
  });

  app.post("/api/system/update-check", { preHandler: auth }, async () => {
    await store.recordAudit("system.update.checked", "system", undefined, "检查系统更新", { current: config.version });
    return {
      current: config.version,
      latest: config.version,
      upToDate: true
    };
  });

  app.post("/api/system/restart", { preHandler: auth }, async (_request, reply) => {
    let result;
    try {
      result = await engineRuntime.restart();
    } catch (error) {
      const message = error instanceof Error ? error.message : "代理核心重启失败";
      await store.recordAudit("system.engine.restart.failed", "system", undefined, `重启代理核心失败：${message}`, {
        code: "ENGINE_RESTART_FAILED",
        message
      });
      return badRequest(
        reply,
        "ENGINE_RESTART_FAILED",
        message,
        "请查看系统设置中的代理核心状态和 data/logs/engine.log，确认 sing-box 路径、配置和端口占用。"
      );
    }
    await store.recordAudit("system.engine.restarted", "system", undefined, "重启代理核心", {
      skipped: Boolean((result as { skipped?: boolean }).skipped),
      message: (result as { message?: string }).message
    });
    return {
      ok: true,
      result,
      engine: engineRuntime.getStatus()
    };
  });

  app.post("/api/system/traffic/aggregate", { preHandler: auth }, async () => store.aggregateTrafficSummaries());
}
