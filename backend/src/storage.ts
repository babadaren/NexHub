import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import pg from "pg";
import { fingerprintNode, maskNodeConfig, parseImport, validateNodeConfig, type ParsedNode } from "./adapters.js";
import { config } from "./config.js";
import { renderEngineConfig } from "./engine.js";
import { runMigrations } from "./migrations.js";
import { redisRuntime } from "./redis.js";
import type { AppState, AuditLog, Direction, NodeConfig, NodeTestResult, SubscriptionSource, TestStatus } from "./types.js";

const stateFile = path.join(config.dataDir, "state.json");
const { Pool } = pg;

const now = () => new Date().toISOString();

export interface ApplyImportResult {
  status: "passed" | "warning" | "failed";
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  nodes: NodeConfig[];
  message: string;
}

export interface ShareTokenResult {
  token: string;
  issuedAt: string;
  tokenHash: string;
}

function initialState(): AppState {
  return {
    admins: [],
    nodes: [],
    tests: [],
    auditLogs: [],
    subscriptions: [],
    settings: {
      retention: {
        realtimeTtlHours: config.realtimeTtlHours,
        dailySummaryDays: 180
      },
      deployment: {
        app: "running",
        postgres: "configured",
        redis: "configured",
        engineProvider: config.engineProvider
      }
    }
  };
}

export class JsonStore {
  private state: AppState | undefined;
  private pool: pg.Pool | undefined;
  readonly driver = config.storageDriver;
  generatedAdminPassword: string | undefined;

  async load() {
    if (this.driver === "postgres") {
      await this.loadPostgres();
    } else {
      await this.loadJson();
    }
    await this.ensureAdmin();
    await this.seedNodes();
  }

  private async loadJson() {
    await mkdir(config.dataDir, { recursive: true });
    try {
      const raw = await readFile(stateFile, "utf8");
      this.state = JSON.parse(raw) as AppState;
    } catch {
      this.state = initialState();
      await this.save();
    }
  }

  private async loadPostgres() {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_DRIVER=postgres");
    }
    this.pool = new Pool({ connectionString: config.databaseUrl });
    await runMigrations(this.pool);
    this.state = await this.readPostgresState();
  }

  snapshot() {
    if (!this.state) throw new Error("store not loaded");
    return this.state;
  }

  async restoreSnapshot(snapshot: AppState, source: string) {
    assertRestorableState(snapshot);
    const restored: AppState = structuredClone(snapshot);
    this.state = restored;
    this.addAudit("system.restored", "backup", undefined, `从备份恢复：${source}`, {
      nodes: restored.nodes.length,
      subscriptions: restored.subscriptions.length
    });
    await this.save();
    await this.refreshEngineConfig();
    return this.snapshot();
  }

  async save() {
    if (!this.state) return;
    if (this.pool) {
      await this.writePostgresState(this.state);
      return;
    }
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(stateFile, JSON.stringify(this.state, null, 2), "utf8");
  }

  async ensureAdmin() {
    const state = this.snapshot();
    if (state.admins.length > 0) return;

    const password = config.adminPassword ?? this.makePassword();
    this.generatedAdminPassword = password;
    const timestamp = now();
    state.admins.push({
      id: randomUUID(),
      username: config.adminUsername,
      email: "",
      passwordHash: await bcrypt.hash(password, 10),
      mustChangePassword: !config.adminPassword,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.addAudit("admin.created", "admin", undefined, "自动创建唯一管理员账号");
    await this.save();
  }

  async close() {
    await this.pool?.end();
  }

  async seedNodes() {
    const state = this.snapshot();
    if (state.nodes.length > 0) return;
    const timestamp = now();
    const nodes: NodeConfig[] = [
      {
        id: randomUUID(),
        direction: "remote",
        name: "HK-01",
        protocol: "vless",
        status: "enabled",
        enabled: true,
        config: {
          server: "hk.example.com",
          port: 443,
          credential: { uuid: "encrypted" },
          transport: { type: "tcp", tls: true, sni: "hk.example.com" }
        },
        safeSummary: { server: "hk.example.com", port: 443, latencyMs: 42, todayTraffic: "18.6GB" },
        lastTestStatus: "passed",
        lastTestAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: randomUUID(),
        direction: "local",
        name: "Relay-HK",
        protocol: "vless",
        status: "enabled",
        enabled: true,
        config: {
          listenHost: "0.0.0.0",
          listenPort: 20001,
          exposure: "public",
          routeMode: "direct",
          share: { publicHost: "proxy.example.com", subscriptionEnabled: true }
        },
        safeSummary: { listen: "0.0.0.0:20001", clients: 72, publicReachable: true },
        lastTestStatus: "passed",
        lastTestAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ];
    state.nodes.push(...nodes);
    this.addAudit("nodes.seeded", "system", undefined, "初始化演示节点");
    await this.save();
  }

  async authenticate(username: string, password: string) {
    const admin = this.snapshot().admins.find((item) => item.username === username);
    if (!admin) return undefined;
    if (!(await bcrypt.compare(password, admin.passwordHash))) return undefined;
    admin.lastLoginAt = now();
    await this.save();
    return admin;
  }

  async changePassword(password: string) {
    const [admin] = this.snapshot().admins;
    admin.passwordHash = await bcrypt.hash(password, 10);
    admin.mustChangePassword = false;
    admin.updatedAt = now();
    this.addAudit("admin.password.changed", "admin", admin.id, "管理员修改密码");
    await this.save();
  }

  listNodes(direction?: Direction) {
    return this.snapshot().nodes.filter((node) => !direction || node.direction === direction);
  }

  getNode(id: string) {
    return this.snapshot().nodes.find((node) => node.id === id);
  }

  async createNode(direction: Direction, input: Partial<NodeConfig> & { name: string; protocol: string; config?: Record<string, unknown> }) {
    const timestamp = now();
    const validation = validateNodeConfig(input.protocol, direction, input.config ?? {});
    const enabled = Boolean(input.enabled && validation.ok);
    const node: NodeConfig = {
      id: randomUUID(),
      direction,
      name: input.name,
      protocol: input.protocol,
      status: enabled ? "enabled" : "draft",
      enabled,
      config: input.config ?? {},
      safeSummary: this.safeSummary(direction, input.protocol, input.config ?? {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.snapshot().nodes.unshift(node);
    this.addAudit("node.created", "node", node.id, `创建${direction === "remote" ? "远端" : "本地"}节点 ${node.name}`);
    await this.save();
    await this.refreshEngineConfig();
    return node;
  }

  async updateNode(id: string, patch: Partial<NodeConfig>) {
    const node = this.getNode(id);
    if (!node) return undefined;
    Object.assign(node, patch, { updatedAt: now() });
    if (patch.config) {
      const validation = validateNodeConfig(node.protocol, node.direction, node.config);
      if (!validation.ok) {
        node.status = "draft";
        node.enabled = false;
      }
    }
    node.safeSummary = this.safeSummary(node.direction, node.protocol, node.config);
    this.addAudit("node.updated", "node", node.id, `更新节点 ${node.name}`);
    await this.save();
    await this.refreshEngineConfig();
    return node;
  }

  async deleteNode(id: string) {
    const state = this.snapshot();
    const node = this.getNode(id);
    state.nodes = state.nodes.filter((item) => item.id !== id);
    this.addAudit("node.deleted", "node", id, node ? `删除节点 ${node.name}` : "删除节点");
    await this.save();
    await this.refreshEngineConfig();
  }

  async ensureShareToken(node: NodeConfig): Promise<ShareTokenResult> {
    const tokenHash = typeof node.config.shareTokenHash === "string" ? node.config.shareTokenHash : undefined;
    if (node.direction === "local" && tokenHash) {
      return {
        token: "",
        tokenHash,
        issuedAt: typeof node.config.shareTokenIssuedAt === "string" ? node.config.shareTokenIssuedAt : node.updatedAt
      };
    }
    return this.rotateShareToken(node);
  }

  async rotateShareToken(node: NodeConfig): Promise<ShareTokenResult> {
    if (node.direction !== "local") throw new Error("只有本地节点可以生成分享 token");
    const token = randomBytes(24).toString("base64url");
    const issuedAt = now();
    node.config = {
      ...node.config,
      shareTokenHash: hashToken(token),
      shareTokenIssuedAt: issuedAt
    };
    node.updatedAt = issuedAt;
    node.safeSummary = this.safeSummary(node.direction, node.protocol, node.config);
    this.addAudit("node.share.rotated", "node", node.id, `轮换分享链接 ${node.name}`);
    await this.save();
    return {
      token,
      tokenHash: String(node.config.shareTokenHash),
      issuedAt
    };
  }

  findLocalNodeByShareToken(token: string) {
    const tokenHash = hashToken(token);
    return this.snapshot().nodes.find((node) => node.direction === "local" && node.config.shareTokenHash === tokenHash);
  }

  async applyParsedNodes(nodes: ParsedNode[], sourceId?: string): Promise<ApplyImportResult> {
    const parsedNodes = nodes.filter((node) => node.status === "parsed");
    const failed = nodes.length - parsedNodes.length;
    const imported: NodeConfig[] = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const timestamp = now();

    for (const parsedNode of parsedNodes) {
      const fingerprint = parsedNode.fingerprint ?? fingerprintNode(parsedNode.protocol, parsedNode.config, parsedNode.raw);
      const existing = this.findNodeByFingerprint(fingerprint);
      if (existing) {
        const nextConfig = {
          ...existing.config,
          ...parsedNode.config,
          importFingerprint: fingerprint,
          sourceId: sourceId ?? existing.config.sourceId,
          sourceFormat: parsedNode.sourceFormat ?? existing.config.sourceFormat
        };
        if (JSON.stringify(existing.config) === JSON.stringify(nextConfig)) {
          unchanged += 1;
          imported.push(existing);
          continue;
        }
        existing.config = nextConfig;
        existing.protocol = parsedNode.protocol;
        existing.safeSummary = this.safeSummary("remote", parsedNode.protocol, nextConfig);
        existing.updatedAt = timestamp;
        updated += 1;
        imported.push(existing);
        continue;
      }

      const node: NodeConfig = {
        id: randomUUID(),
        direction: "remote",
        name: parsedNode.name,
        protocol: parsedNode.protocol,
        status: "draft",
        enabled: false,
        config: {
          ...parsedNode.config,
          importFingerprint: fingerprint,
          sourceId,
          sourceFormat: parsedNode.sourceFormat
        },
        safeSummary: this.safeSummary("remote", parsedNode.protocol, {
          ...parsedNode.config,
          importFingerprint: fingerprint
        }),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.snapshot().nodes.unshift(node);
      created += 1;
      imported.push(node);
    }

    const status = created + updated + unchanged === 0 ? "failed" : failed > 0 ? "warning" : "passed";
    const message = `导入完成：新增 ${created} 个，更新 ${updated} 个，未变化 ${unchanged} 个，失败 ${failed} 个。`;
    this.addAudit("nodes.imported", "subscription", sourceId, message, { created, updated, unchanged, failed });
    await this.save();
    await this.refreshEngineConfig();
    return { status, created, updated, unchanged, failed, nodes: imported, message };
  }

  listSubscriptions() {
    return this.snapshot().subscriptions;
  }

  getSubscription(id: string) {
    return this.snapshot().subscriptions.find((subscription) => subscription.id === id);
  }

  async createSubscription(input: {
    name: string;
    url?: string;
    content?: string;
    autoRefresh?: boolean;
    refreshCron?: string;
  }) {
    const timestamp = now();
    const subscription: SubscriptionSource = {
      id: randomUUID(),
      name: input.name,
      url: input.url,
      content: input.content,
      autoRefresh: Boolean(input.autoRefresh),
      refreshCron: input.refreshCron,
      lastRefreshStatus: "never",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.snapshot().subscriptions.unshift(subscription);
    this.addAudit("subscription.created", "subscription", subscription.id, `创建订阅源 ${subscription.name}`);
    await this.save();
    return subscription;
  }

  async updateSubscription(id: string, patch: Partial<SubscriptionSource>) {
    const subscription = this.getSubscription(id);
    if (!subscription) return undefined;
    Object.assign(subscription, patch, { updatedAt: now() });
    this.addAudit("subscription.updated", "subscription", id, `更新订阅源 ${subscription.name}`);
    await this.save();
    return subscription;
  }

  async deleteSubscription(id: string) {
    const state = this.snapshot();
    const subscription = this.getSubscription(id);
    state.subscriptions = state.subscriptions.filter((item) => item.id !== id);
    this.addAudit("subscription.deleted", "subscription", id, subscription ? `删除订阅源 ${subscription.name}` : "删除订阅源");
    await this.save();
  }

  async refreshSubscription(id: string): Promise<ApplyImportResult> {
    const subscription = this.getSubscription(id);
    if (!subscription) throw new Error("订阅源不存在");
    try {
      const input = subscription.content || (subscription.url ? await fetchSubscription(subscription.url) : "");
      if (!input.trim()) throw new Error("订阅内容为空");
      const parsed = parseImport(input);
      const result = await this.applyParsedNodes(parsed, subscription.id);
      subscription.lastRefreshStatus = result.status;
      subscription.lastRefreshMessage = result.message;
      subscription.lastRefreshAt = now();
      subscription.updatedAt = subscription.lastRefreshAt;
      await this.save();
      await redisRuntime.addEvent({
        type: "subscription.refreshed",
        subscription_id: subscription.id,
        subscription_name: subscription.name,
        status: result.status,
        message: result.message,
        created_at: subscription.lastRefreshAt
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "订阅刷新失败";
      subscription.lastRefreshStatus = "failed";
      subscription.lastRefreshMessage = message;
      subscription.lastRefreshAt = now();
      subscription.updatedAt = subscription.lastRefreshAt;
      this.addAudit("subscription.refresh.failed", "subscription", subscription.id, message);
      await this.save();
      return { status: "failed", created: 0, updated: 0, unchanged: 0, failed: 1, nodes: [], message };
    }
  }

  async runTest(node: NodeConfig) {
    const status: TestStatus = this.testStatus(node);
    const result: NodeTestResult = {
      id: randomUUID(),
      nodeId: node.id,
      direction: node.direction,
      testType: node.direction,
      finalStatus: status,
      latencyMs: status === "failed" ? undefined : 40 + Math.floor(Math.random() * 120),
      downloadMbps: status === "failed" ? undefined : Number((8 + Math.random() * 60).toFixed(2)),
      steps: this.testSteps(node, status),
      humanMessage: this.humanMessage(node, status),
      createdAt: now()
    };
    node.lastTestStatus = status;
    node.lastTestAt = result.createdAt;
    if (status === "failed") {
      node.enabled = false;
      node.status = "draft";
    } else {
      node.enabled = true;
      node.status = "enabled";
    }
    this.snapshot().tests.unshift(result);
    this.snapshot().tests = this.snapshot().tests.slice(0, 100);
    this.addAudit("node.tested", "node", node.id, `一键测试 ${node.name}: ${status}`);
    await this.save();
    await redisRuntime.writeNodeNow(node.id, {
      status: node.status,
      latency_ms: result.latencyMs,
      download_mbps: result.downloadMbps,
      active_connections: Number(node.safeSummary.clients ?? 0),
      updated_at: result.createdAt
    });
    await redisRuntime.addEvent({
      type: "node.tested",
      node_id: node.id,
      node_name: node.name,
      status,
      message: result.humanMessage,
      created_at: result.createdAt
    });
    await this.refreshEngineConfig();
    return result;
  }

  recentTests(nodeId?: string) {
    return this.snapshot().tests.filter((test) => !nodeId || test.nodeId === nodeId);
  }

  auditLogs() {
    return this.snapshot().auditLogs.slice(0, 100);
  }

  private addAudit(action: string, targetType: string, targetId: string | undefined, summary: string, metadata: Record<string, unknown> = {}) {
    const state = this.snapshot();
    const log: AuditLog = {
      id: randomUUID(),
      action,
      targetType,
      targetId,
      summary,
      metadata,
      createdAt: now()
    };
    state.auditLogs.unshift(log);
    state.auditLogs = state.auditLogs.slice(0, 200);
  }

  private async refreshEngineConfig() {
    try {
      const result = await renderEngineConfig(this.snapshot().nodes);
      this.snapshot().settings.engine = {
        provider: config.engineProvider,
        currentPath: result.currentPath,
        previousPath: result.previousPath,
        lastRenderAt: now(),
        lastRenderMessage: result.message
      };
      await this.save();
    } catch (error) {
      this.snapshot().settings.engine = {
        provider: config.engineProvider,
        lastRenderAt: now(),
        lastRenderError: error instanceof Error ? error.message : "代理核心配置生成失败"
      };
      await this.save();
    }
  }

  private safeSummary(direction: Direction, protocol: string, data: Record<string, unknown>) {
    if (direction === "remote") {
      const masked = maskNodeConfig(protocol, direction, data);
      return {
        server: masked.server ?? masked.host ?? "not set",
        port: data.port ?? 443,
        protocol,
        fingerprint: data.importFingerprint,
        latencyMs: 68,
        todayTraffic: "0B",
        credential: masked.credential ?? masked.uuid ?? masked.password
      };
    }
    const masked = maskNodeConfig(protocol, direction, data);
    return {
      listen: `${masked.listenHost ?? "0.0.0.0"}:${masked.listenPort ?? masked.port ?? 20001}`,
      protocol,
      clients: 0,
      publicReachable: data.exposure === "public"
    };
  }

  private findNodeByFingerprint(fingerprint: string) {
    return this.snapshot().nodes.find((node) => {
      const configFingerprint = typeof node.config.importFingerprint === "string" ? node.config.importFingerprint : undefined;
      const summaryFingerprint = typeof node.safeSummary.fingerprint === "string" ? node.safeSummary.fingerprint : undefined;
      return configFingerprint === fingerprint || summaryFingerprint === fingerprint;
    });
  }

  private testStatus(node: NodeConfig): TestStatus {
    const values = JSON.stringify(node.config).toLowerCase();
    if (values.includes("fail") || values.includes("timeout")) return "failed";
    if (node.protocol === "wireguard" || values.includes("warning")) return "warning";
    return "passed";
  }

  private testSteps(node: NodeConfig, status: TestStatus) {
    if (node.direction === "remote") {
      return [
        { name: "格式校验", status: "passed" as const, message: "字段完整" },
        { name: "DNS 解析", status: status === "failed" ? "failed" as const : "passed" as const, message: status === "failed" ? "服务器地址无法解析" : "解析正常" },
        { name: "连接测试", status, message: status === "failed" ? "服务器连接超时" : "握手成功" },
        { name: "认证", status: status === "failed" ? "failed" as const : "passed" as const, message: status === "failed" ? "请检查密码、UUID 或密钥" : "认证通过" },
        { name: "测速", status: status === "passed" ? "passed" as const : "warning" as const, message: status === "passed" ? "速度正常" : "速度较低或未完成" }
      ];
    }
    return [
      { name: "配置生成", status: "passed" as const, message: "代理核心配置已生成" },
      { name: "端口占用", status: "passed" as const, message: "监听端口可用" },
      { name: "本机监听", status: status === "failed" ? "failed" as const : "passed" as const, message: status === "failed" ? "本机服务未启动" : "本机服务已启动" },
      { name: "公网检测", status, message: status === "passed" ? "公网可达" : status === "warning" ? "公网可达性需要复查" : "公网不可达" },
      { name: "分享链接", status: status === "failed" ? "failed" as const : "passed" as const, message: status === "failed" ? "无法生成可用分享链接" : "已生成" }
    ];
  }

  private humanMessage(node: NodeConfig, status: TestStatus) {
    if (status === "passed") return node.direction === "remote" ? "节点可用，可以保存并启用。" : "本地节点可用，可以复制二维码分享。";
    if (status === "warning") return "节点基本可用，但存在可达性或速度警告。";
    return "测试失败，已保存为草稿且不会启用。请检查地址、端口、认证或防火墙。";
  }

  private makePassword() {
    return `${nanoid(4)}-${nanoid(4)}-${nanoid(4)}-${nanoid(4)}`;
  }

  private async readPostgresState(): Promise<AppState> {
    if (!this.pool) return initialState();
    const [admins, nodes, tests, auditLogs, settings, subscriptions] = await Promise.all([
      this.pool.query<{
        id: string;
        username: string;
        email: string | null;
        password_hash: string;
        must_change_password: boolean;
        created_at: Date;
        updated_at: Date;
        last_login_at: Date | null;
      }>("SELECT * FROM admins ORDER BY created_at ASC"),
      this.pool.query<{
        id: string;
        direction: Direction;
        name: string;
        protocol: string;
        status: NodeConfig["status"];
        enabled: boolean;
        config: Record<string, unknown>;
        safe_summary: Record<string, unknown>;
        last_test_status: TestStatus | null;
        last_test_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>("SELECT * FROM node_configs ORDER BY updated_at DESC"),
      this.pool.query<{
        id: string;
        node_id: string | null;
        direction: Direction;
        test_type: "remote" | "local";
        final_status: TestStatus;
        latency_ms: number | null;
        download_mbps: string | null;
        details: { steps?: NodeTestResult["steps"] };
        human_message: string | null;
        created_at: Date;
      }>("SELECT * FROM node_test_results ORDER BY created_at DESC LIMIT 100"),
      this.pool.query<{
        id: string;
        action: string;
        target_type: string;
        target_id: string | null;
        summary: string;
        metadata: Record<string, unknown>;
        created_at: Date;
      }>("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200"),
      this.pool.query<{ key: string; value: unknown }>("SELECT * FROM system_settings"),
      this.pool.query<{
        id: string;
        name: string;
        url: string | null;
        content: string | null;
        auto_refresh: boolean;
        refresh_cron: string | null;
        last_refresh_status: SubscriptionSource["lastRefreshStatus"] | null;
        last_refresh_message: string | null;
        last_refresh_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>("SELECT * FROM subscription_sources ORDER BY updated_at DESC")
    ]);

    const state = initialState();
    state.admins = admins.rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email ?? undefined,
      passwordHash: row.password_hash,
      mustChangePassword: row.must_change_password,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      lastLoginAt: row.last_login_at?.toISOString()
    }));
    state.nodes = nodes.rows.map((row) => ({
      id: row.id,
      direction: row.direction,
      name: row.name,
      protocol: row.protocol,
      status: row.status,
      enabled: row.enabled,
      config: row.config,
      safeSummary: row.safe_summary,
      lastTestStatus: row.last_test_status ?? undefined,
      lastTestAt: row.last_test_at?.toISOString(),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    }));
    state.tests = tests.rows.map((row) => ({
      id: row.id,
      nodeId: row.node_id ?? undefined,
      direction: row.direction,
      testType: row.test_type,
      finalStatus: row.final_status,
      latencyMs: row.latency_ms ?? undefined,
      downloadMbps: row.download_mbps ? Number(row.download_mbps) : undefined,
      steps: row.details.steps ?? [],
      humanMessage: row.human_message ?? "",
      createdAt: row.created_at.toISOString()
    }));
    state.auditLogs = auditLogs.rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id ?? undefined,
      summary: row.summary,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString()
    }));
    for (const row of settings.rows) {
      state.settings[row.key] = row.value;
    }
    state.subscriptions = subscriptions.rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url ?? undefined,
      content: row.content ?? undefined,
      autoRefresh: row.auto_refresh,
      refreshCron: row.refresh_cron ?? undefined,
      lastRefreshStatus: row.last_refresh_status ?? "never",
      lastRefreshMessage: row.last_refresh_message ?? undefined,
      lastRefreshAt: row.last_refresh_at?.toISOString(),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    }));
    return state;
  }

  private async writePostgresState(state: AppState) {
    if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const admin of state.admins) {
        await client.query(
          `INSERT INTO admins(id, username, email, password_hash, must_change_password, created_at, updated_at, last_login_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             username = EXCLUDED.username,
             email = EXCLUDED.email,
             password_hash = EXCLUDED.password_hash,
             must_change_password = EXCLUDED.must_change_password,
             updated_at = EXCLUDED.updated_at,
             last_login_at = EXCLUDED.last_login_at`,
          [admin.id, admin.username, admin.email ?? null, admin.passwordHash, admin.mustChangePassword, admin.createdAt, admin.updatedAt, admin.lastLoginAt ?? null]
        );
      }

      for (const node of state.nodes) {
        await client.query(
          `INSERT INTO node_configs(id, direction, name, protocol, status, enabled, config, safe_summary, last_test_status, last_test_at, created_at, updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id) DO UPDATE SET
             direction = EXCLUDED.direction,
             name = EXCLUDED.name,
             protocol = EXCLUDED.protocol,
             status = EXCLUDED.status,
             enabled = EXCLUDED.enabled,
             config = EXCLUDED.config,
             safe_summary = EXCLUDED.safe_summary,
             last_test_status = EXCLUDED.last_test_status,
             last_test_at = EXCLUDED.last_test_at,
             updated_at = EXCLUDED.updated_at`,
          [
            node.id,
            node.direction,
            node.name,
            node.protocol,
            node.status,
            node.enabled,
            JSON.stringify(node.config),
            JSON.stringify(node.safeSummary),
            node.lastTestStatus ?? null,
            node.lastTestAt ?? null,
            node.createdAt,
            node.updatedAt
          ]
        );
      }

      const nodeIds = state.nodes.map((node) => node.id);
      if (nodeIds.length > 0) {
        await client.query("DELETE FROM node_configs WHERE NOT (id = ANY($1::uuid[]))", [nodeIds]);
      } else {
        await client.query("DELETE FROM node_configs");
      }

      for (const test of state.tests) {
        await client.query(
          `INSERT INTO node_test_results(id, node_id, direction, test_type, final_status, latency_ms, download_mbps, details, human_message, created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO NOTHING`,
          [
            test.id,
            test.nodeId ?? null,
            test.direction,
            test.testType,
            test.finalStatus,
            test.latencyMs ?? null,
            test.downloadMbps ?? null,
            JSON.stringify({ steps: test.steps }),
            test.humanMessage,
            test.createdAt
          ]
        );
      }

      for (const log of state.auditLogs) {
        await client.query(
          `INSERT INTO audit_logs(id, action, target_type, target_id, summary, metadata, created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO NOTHING`,
          [log.id, log.action, log.targetType, log.targetId ?? null, log.summary, JSON.stringify(log.metadata), log.createdAt]
        );
      }

      for (const subscription of state.subscriptions) {
        await client.query(
          `INSERT INTO subscription_sources(id, name, url, content, auto_refresh, refresh_cron, last_refresh_status, last_refresh_message, last_refresh_at, created_at, updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             url = EXCLUDED.url,
             content = EXCLUDED.content,
             auto_refresh = EXCLUDED.auto_refresh,
             refresh_cron = EXCLUDED.refresh_cron,
             last_refresh_status = EXCLUDED.last_refresh_status,
             last_refresh_message = EXCLUDED.last_refresh_message,
             last_refresh_at = EXCLUDED.last_refresh_at,
             updated_at = EXCLUDED.updated_at`,
          [
            subscription.id,
            subscription.name,
            subscription.url ?? null,
            subscription.content ?? null,
            subscription.autoRefresh,
            subscription.refreshCron ?? null,
            subscription.lastRefreshStatus ?? "never",
            subscription.lastRefreshMessage ?? null,
            subscription.lastRefreshAt ?? null,
            subscription.createdAt,
            subscription.updatedAt
          ]
        );
      }

      const subscriptionIds = state.subscriptions.map((subscription) => subscription.id);
      if (subscriptionIds.length > 0) {
        await client.query("DELETE FROM subscription_sources WHERE NOT (id = ANY($1::uuid[]))", [subscriptionIds]);
      } else {
        await client.query("DELETE FROM subscription_sources");
      }

      for (const [key, value] of Object.entries(state.settings)) {
        await client.query(
          `INSERT INTO system_settings(key, value, updated_at)
           VALUES($1,$2,now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key, JSON.stringify(value)]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function assertRestorableState(value: unknown): asserts value is AppState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("备份状态结构无效");
  const state = value as Partial<AppState>;
  if (!Array.isArray(state.admins) || state.admins.length !== 1) throw new Error("备份必须包含唯一管理员账号");
  if (!Array.isArray(state.nodes)) throw new Error("备份缺少节点配置");
  if (!Array.isArray(state.tests)) throw new Error("备份缺少测试摘要");
  if (!Array.isArray(state.auditLogs)) throw new Error("备份缺少审计记录");
  if (!Array.isArray(state.subscriptions)) throw new Error("备份缺少订阅源列表");
  if (!state.settings || typeof state.settings !== "object" || Array.isArray(state.settings)) throw new Error("备份缺少系统设置");
}

async function fetchSubscription(rawUrl: string) {
  const url = new URL(rawUrl);
  await assertSubscriptionUrlAllowed(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.subscriptionFetchTimeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": `ProxyControlCenter/${config.version}` }
    });
    if (!response.ok) throw new Error(`订阅拉取失败：HTTP ${response.status}`);
    const finalUrl = new URL(response.url);
    await assertSubscriptionUrlAllowed(finalUrl);
    const reader = response.body?.getReader();
    if (!reader) return response.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > config.subscriptionMaxBytes) throw new Error("订阅内容超过大小限制");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("订阅拉取超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function assertSubscriptionUrlAllowed(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("订阅地址只支持 http 或 https");
  if (config.subscriptionAllowPrivateNetwork) return;
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("订阅地址指向内网或本机地址，已被安全策略拦截");
  }
}

function isPrivateAddress(address: string) {
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "localhost") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export const store = new JsonStore();
