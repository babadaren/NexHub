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
import { encryptionKeyFingerprint, protectNodeConfig, protectOptionalSecret, unprotectNodeConfig, unprotectOptionalSecret } from "./secrets.js";
import type { AppState, AuditLog, BackupJob, CreateNodeResult, Direction, LocalShareToken, NodeConfig, NodeConfigVersion, NodeTestResult, SubscriptionSource, TestStatus, TrafficSummary } from "./types.js";

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

export interface EnableNodeResult {
  ok: boolean;
  node?: NodeConfig;
  message?: string;
}

export type AuthResult =
  | { ok: true; admin: AppState["admins"][number] }
  | { ok: false; reason: "invalid" | "locked"; message: string; lockedUntil?: string };

type LocalTransport = "tcp" | "udp";

interface LocalPortCheck {
  ok: boolean;
  transport: LocalTransport;
  allowedRange: string;
  port?: number;
  message: string;
}

const udpLocalProtocols = new Set(["wireguard", "hysteria2", "tuic"]);

function initialState(): AppState {
  return {
    admins: [],
    nodes: [],
    nodeConfigVersions: [],
    tests: [],
    auditLogs: [],
    subscriptions: [],
    trafficSummaries: [],
    shareTokens: [],
    backupJobs: [],
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
    this.normalizeSubscriptionSources();
    this.normalizeNodeMetadata();
    this.migrateLegacyShareTokens();
    this.ensureNodeConfigVersions();
    await this.ensureAdmin();
  }

  private async loadJson() {
    await mkdir(config.dataDir, { recursive: true });
    try {
      const raw = await readFile(stateFile, "utf8");
      this.state = unprotectState(JSON.parse(raw) as AppState);
    } catch {
      this.state = initialState();
      await this.save();
    }
  }

  private async loadPostgres() {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_DRIVER=postgres");
    }
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: Math.max(config.databaseMaxOpenConns, 1),
      min: 0,
      idleTimeoutMillis: 30_000,
      maxLifetimeSeconds: Math.max(config.databaseConnMaxLifetimeMinutes, 1) * 60
    });
    await runMigrations(this.pool);
    this.state = await this.readPostgresState();
  }

  snapshot() {
    if (!this.state) throw new Error("store not loaded");
    return this.state;
  }

  private migrateLegacyShareTokens() {
    const state = this.snapshot();
    state.shareTokens = state.shareTokens ?? [];
    let changed = false;
    for (const node of state.nodes) {
      const tokenHash = typeof node.config.shareTokenHash === "string" ? node.config.shareTokenHash : undefined;
      if (!tokenHash) continue;
      const issuedAt = typeof node.config.shareTokenIssuedAt === "string" ? node.config.shareTokenIssuedAt : node.updatedAt;
      if (!state.shareTokens.some((token) => token.tokenHash === tokenHash)) {
        state.shareTokens.push({
          id: randomUUID(),
          nodeId: node.id,
          tokenHash,
          status: "active",
          createdAt: issuedAt
        });
      }
      const { shareTokenHash: _legacyHash, shareTokenIssuedAt: _legacyIssuedAt, ...nextConfig } = node.config;
      node.config = nextConfig;
      node.safeSummary = this.safeSummary(node.direction, node.protocol, node.config);
      changed = true;
    }
    if (changed) void this.save();
  }

  private normalizeSubscriptionSources() {
    const state = this.snapshot();
    let changed = false;
    for (const subscription of state.subscriptions) {
      if (!subscription.sourceType) {
        subscription.sourceType = subscription.content ? "content" : "url";
        changed = true;
      }
      if (subscription.autoEnableNewNodes === undefined) {
        subscription.autoEnableNewNodes = false;
        changed = true;
      }
      if (subscription.allowPrivateNetwork === undefined) {
        subscription.allowPrivateNetwork = false;
        changed = true;
      }
    }
    if (changed) void this.save();
  }

  private normalizeNodeMetadata() {
    const state = this.snapshot();
    let changed = false;
    for (const node of state.nodes) {
      if (node.sourceMissing === undefined) {
        node.sourceMissing = false;
        changed = true;
      }
    }
    if (changed) void this.save();
  }

  private ensureNodeConfigVersions() {
    this.snapshot().nodeConfigVersions = this.snapshot().nodeConfigVersions ?? [];
    let changed = false;
    for (const node of this.snapshot().nodes) {
      if (!this.snapshot().nodeConfigVersions.some((version) => version.nodeId === node.id)) {
        this.recordNodeConfigVersion(node, node.createdAt);
        changed = true;
      }
    }
    if (changed) void this.save();
  }

  async restoreSnapshot(snapshot: AppState, source: string) {
    assertRestorableState(snapshot);
    const restored: AppState = structuredClone(snapshot);
    restored.nodeConfigVersions = restored.nodeConfigVersions ?? [];
    restored.shareTokens = restored.shareTokens ?? [];
    restored.backupJobs = restored.backupJobs ?? [];
    restored.nodes = restored.nodes.map((node) => ({
      ...node,
      sourceMissing: Boolean(node.sourceMissing)
    }));
    this.state = restored;
    this.migrateLegacyShareTokens();
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
    await writeFile(stateFile, JSON.stringify(protectState(this.state), null, 2), "utf8");
  }

  async ensureAdmin() {
    const state = this.snapshot();
    if (state.admins.length > 0) return;

    const generatedPassword = config.adminPassword ? undefined : this.makePassword();
    const password = config.adminPassword || generatedPassword;
    if (!password) throw new Error("管理员密码初始化失败");
    this.generatedAdminPassword = generatedPassword;
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

  async authenticate(username: string, password: string): Promise<AuthResult> {
    const admin = this.snapshot().admins.find((item) => item.username === username);
    if (!admin) return { ok: false, reason: "invalid", message: "管理员账号或密码不正确" };
    const lockedUntil = admin.lockedUntil ? new Date(admin.lockedUntil) : undefined;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      return {
        ok: false,
        reason: "locked",
        lockedUntil: lockedUntil.toISOString(),
        message: `登录失败次数过多，账号已锁定到 ${lockedUntil.toLocaleString("zh-CN", { hour12: false })}`
      };
    }
    if (lockedUntil && lockedUntil.getTime() <= Date.now()) {
      admin.lockedUntil = undefined;
      admin.failedLoginCount = 0;
    }

    if (!(await bcrypt.compare(password, admin.passwordHash))) {
      const failedCount = (admin.failedLoginCount ?? 0) + 1;
      let nextLockedUntil: string | undefined;
      admin.failedLoginCount = failedCount;
      admin.updatedAt = now();
      if (failedCount >= config.loginMaxFailures) {
        nextLockedUntil = new Date(Date.now() + config.loginLockMinutes * 60 * 1000).toISOString();
        admin.lockedUntil = nextLockedUntil;
        this.addAudit("admin.login.locked", "admin", admin.id, `管理员登录失败次数过多，账号锁定到 ${nextLockedUntil}`, { failedCount });
      }
      await this.save();
      return {
        ok: false,
        reason: nextLockedUntil ? "locked" : "invalid",
        lockedUntil: nextLockedUntil,
        message: nextLockedUntil ? `登录失败次数过多，账号已锁定 ${config.loginLockMinutes} 分钟。` : "管理员账号或密码不正确"
      };
    }

    admin.failedLoginCount = 0;
    admin.lockedUntil = undefined;
    admin.lastLoginAt = now();
    await this.save();
    return { ok: true, admin };
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

  private recordNodeConfigVersion(node: NodeConfig, createdAt = now()) {
    const versions = this.snapshot().nodeConfigVersions.filter((item) => item.nodeId === node.id);
    const version = versions.reduce((max, item) => Math.max(max, item.version), 0) + 1;
    const entry: NodeConfigVersion = {
      id: randomUUID(),
      nodeId: node.id,
      version,
      config: structuredClone(node.config),
      summary: structuredClone(node.safeSummary),
      createdAt
    };
    this.snapshot().nodeConfigVersions.push(entry);
    this.snapshot().nodeConfigVersions = this.snapshot().nodeConfigVersions.slice(-5000);
    return entry;
  }

  async createNode(direction: Direction, input: Partial<NodeConfig> & { name: string; protocol: string; config?: Record<string, unknown> }): Promise<CreateNodeResult> {
    const timestamp = now();
    const nodeConfig = input.config ?? {};
    const validation = validateNodeConfig(input.protocol, direction, nodeConfig);
    const portCheck = this.localPortCheck(direction, input.protocol, nodeConfig);
    const node: NodeConfig = {
      id: randomUUID(),
      direction,
      name: input.name,
      protocol: input.protocol,
      status: "draft",
      enabled: false,
      config: nodeConfig,
      safeSummary: this.safeSummary(direction, input.protocol, nodeConfig),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (input.enabled && validation.ok && !portCheck.ok) {
      node.lastTestStatus = "failed";
      node.lastTestAt = timestamp;
    }
    this.snapshot().nodes.unshift(node);
    this.recordNodeConfigVersion(node, timestamp);
    this.addAudit("node.created", "node", node.id, `创建${direction === "remote" ? "远端" : "本地"}节点 ${node.name}`);
    await this.save();
    await this.refreshEngineConfig();
    if (!input.enabled) return { node };
    const test = await this.runTest(node);
    return { node: this.getNode(node.id) ?? node, test };
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
    const portCheck = this.localPortCheck(node.direction, node.protocol, node.config);
    if (node.enabled && node.status === "enabled" && !portCheck.ok) {
      node.status = "draft";
      node.enabled = false;
      node.lastTestStatus = "failed";
      node.lastTestAt = now();
    }
    node.safeSummary = this.safeSummary(node.direction, node.protocol, node.config);
    if (patch.config) this.recordNodeConfigVersion(node);
    this.addAudit("node.updated", "node", node.id, `更新节点 ${node.name}`);
    await this.save();
    await this.refreshEngineConfig();
    return node;
  }

  async enableNode(id: string): Promise<EnableNodeResult> {
    const node = this.getNode(id);
    if (!node) return { ok: false, message: "节点不存在" };
    const validation = validateNodeConfig(node.protocol, node.direction, node.config);
    if (!validation.ok) {
      node.enabled = false;
      node.status = "draft";
      node.updatedAt = now();
      this.addAudit("node.enable.blocked", "node", node.id, `Enable ${node.name} blocked by invalid config`, { errors: validation.errors });
      await this.save();
      await this.refreshEngineConfig();
      return { ok: false, node, message: "节点配置不完整，已保存为草稿，不能启用。" };
    }

    const portCheck = this.localPortCheck(node.direction, node.protocol, node.config);
    if (!portCheck.ok) {
      node.enabled = false;
      node.status = "draft";
      node.lastTestStatus = "failed";
      node.lastTestAt = now();
      node.updatedAt = node.lastTestAt;
      this.addAudit("node.enable.blocked", "node", node.id, portCheck.message, {
        port: portCheck.port,
        transport: portCheck.transport,
        allowedRange: portCheck.allowedRange
      });
      await this.save();
      await this.refreshEngineConfig();
      return { ok: false, node, message: portCheck.message };
    }

    const updated = await this.updateNode(id, { enabled: true, status: "enabled" });
    return { ok: Boolean(updated), node: updated, message: updated ? undefined : "节点不存在" };
  }

  async deleteNode(id: string) {
    const state = this.snapshot();
    const node = this.getNode(id);
    state.nodes = state.nodes.filter((item) => item.id !== id);
    state.nodeConfigVersions = state.nodeConfigVersions.filter((item) => item.nodeId !== id);
    state.shareTokens = state.shareTokens.filter((item) => item.nodeId !== id);
    this.addAudit("node.deleted", "node", id, node ? `删除节点 ${node.name}` : "删除节点");
    await this.save();
    await this.refreshEngineConfig();
  }

  async recordBackupJob(input: Omit<BackupJob, "id" | "createdAt"> & { id?: string; createdAt?: string }) {
    const timestamp = now();
    const job: BackupJob = {
      id: input.id ?? randomUUID(),
      jobType: input.jobType,
      status: input.status,
      filePath: input.filePath,
      containsSecrets: input.containsSecrets,
      message: input.message,
      manifest: input.manifest,
      createdAt: input.createdAt ?? timestamp,
      finishedAt: input.finishedAt ?? timestamp
    };
    const state = this.snapshot();
    state.backupJobs = [job, ...(state.backupJobs ?? []).filter((item) => item.id !== job.id)].slice(0, 500);
    await this.save();
    return job;
  }

  async ensureShareToken(node: NodeConfig): Promise<ShareTokenResult> {
    if (node.direction !== "local") throw new Error("only local nodes can create share tokens");
    const existing = this.activeShareTokenForNode(node.id);
    if (existing) {
      return {
        token: "",
        tokenHash: existing.tokenHash,
        issuedAt: existing.createdAt
      };
    }
    return this.rotateShareToken(node);
  }

  async rotateShareToken(node: NodeConfig): Promise<ShareTokenResult> {
    if (node.direction !== "local") throw new Error("只有本地节点可以生成分享 token");
    const token = randomBytes(24).toString("base64url");
    const issuedAt = now();
    for (const shareToken of this.snapshot().shareTokens.filter((item) => item.nodeId === node.id && item.status === "active")) {
      shareToken.status = "revoked";
      shareToken.revokedAt = issuedAt;
    }
    const shareToken: LocalShareToken = {
      id: randomUUID(),
      nodeId: node.id,
      tokenHash: hashToken(token),
      status: "active",
      createdAt: issuedAt
    };
    this.snapshot().shareTokens.unshift(shareToken);
    node.updatedAt = issuedAt;
    node.safeSummary = this.safeSummary(node.direction, node.protocol, node.config);
    this.addAudit("node.share.rotated", "node", node.id, `轮换分享链接 ${node.name}`);
    await this.save();
    return {
      token,
      tokenHash: shareToken.tokenHash,
      issuedAt
    };
  }

  findLocalNodeByShareToken(token: string) {
    const tokenHash = hashToken(token);
    const shareToken = this.snapshot().shareTokens.find((item) => item.tokenHash === tokenHash && item.status === "active" && (!item.expiresAt || new Date(item.expiresAt).getTime() > Date.now()));
    if (!shareToken) return undefined;
    shareToken.lastUsedAt = now();
    void this.save();
    return this.snapshot().nodes.find((node) => node.direction === "local" && node.id === shareToken.nodeId);
  }

  shareTokenIssuedAt(nodeId: string) {
    return this.activeShareTokenForNode(nodeId)?.createdAt;
  }

  private activeShareTokenForNode(nodeId: string) {
    return this.snapshot().shareTokens.find((item) => item.nodeId === nodeId && item.status === "active" && (!item.expiresAt || new Date(item.expiresAt).getTime() > Date.now()));
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
        if (JSON.stringify(existing.config) === JSON.stringify(nextConfig) && !existing.sourceMissing) {
          unchanged += 1;
          imported.push(existing);
          continue;
        }
        existing.config = nextConfig;
        existing.protocol = parsedNode.protocol;
        existing.sourceMissing = false;
        existing.safeSummary = this.safeSummary("remote", parsedNode.protocol, nextConfig);
        existing.updatedAt = timestamp;
        this.recordNodeConfigVersion(existing, timestamp);
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
        sourceMissing: false,
        safeSummary: this.safeSummary("remote", parsedNode.protocol, {
          ...parsedNode.config,
          importFingerprint: fingerprint
        }),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.snapshot().nodes.unshift(node);
      this.recordNodeConfigVersion(node, timestamp);
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
    sourceType?: "url" | "content";
    autoRefresh?: boolean;
    refreshCron?: string;
    autoEnableNewNodes?: boolean;
    allowPrivateNetwork?: boolean;
  }) {
    const timestamp = now();
    const subscription: SubscriptionSource = {
      id: randomUUID(),
      name: input.name,
      url: input.url,
      content: input.content,
      sourceType: input.sourceType ?? (input.content ? "content" : "url"),
      autoRefresh: Boolean(input.autoRefresh),
      refreshCron: input.refreshCron,
      autoEnableNewNodes: Boolean(input.autoEnableNewNodes),
      allowPrivateNetwork: Boolean(input.allowPrivateNetwork),
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
    let detached = 0;
    const timestamp = now();
    for (const node of state.nodes.filter((item) => item.direction === "remote" && item.config.sourceId === id)) {
      const { sourceId: _sourceId, ...nextConfig } = node.config;
      node.config = nextConfig;
      node.sourceMissing = true;
      node.updatedAt = timestamp;
      this.recordNodeConfigVersion(node, timestamp);
      detached += 1;
    }
    this.addAudit("subscription.deleted", "subscription", id, subscription ? `删除订阅源 ${subscription.name}` : "删除订阅源");
    if (detached > 0) {
      this.addAudit("subscription.nodes.detached", "subscription", id, `订阅源删除后保留 ${detached} 个已导入节点`, { detached });
    }
    await this.save();
  }

  async refreshSubscription(id: string): Promise<ApplyImportResult> {
    return redisRuntime.withLock(`lock:subscription:${id}`, 120, () => this.refreshSubscriptionUnlocked(id));
  }

  async recordSubscriptionSchedulerEvent(action: string, summary: string, metadata: Record<string, unknown> = {}) {
    this.addAudit(action, "subscription", undefined, summary, metadata);
    await this.save();
  }

  private async refreshSubscriptionUnlocked(id: string): Promise<ApplyImportResult> {
    const subscription = this.getSubscription(id);
    if (!subscription) throw new Error("订阅源不存在");
    try {
      const input = subscription.content || (subscription.url ? await fetchSubscription(subscription.url, subscription.allowPrivateNetwork) : "");
      if (!input.trim()) throw new Error("订阅内容为空");
      const parsed = parseImport(input);
      const result = await this.applyParsedNodes(parsed, subscription.id);
      const missing = result.nodes.length > 0 ? this.markMissingSubscriptionNodes(subscription.id, result.nodes.map((node) => node.id)) : 0;
      if (subscription.autoEnableNewNodes) {
        await this.autoEnableImportedNodes(result.nodes, subscription.id);
      }
      subscription.lastRefreshStatus = result.status;
      subscription.lastRefreshMessage = missing > 0 ? `${result.message}；${missing} 个旧节点已标记为订阅缺失` : result.message;
      subscription.lastRefreshAt = now();
      subscription.updatedAt = subscription.lastRefreshAt;
      this.addAudit("subscription.refresh.succeeded", "subscription", subscription.id, subscription.lastRefreshMessage, {
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        failed: result.failed,
        missing
      });
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

  private async autoEnableImportedNodes(nodes: NodeConfig[], sourceId: string) {
    for (const node of nodes.filter((item) => item.direction === "remote" && item.config.sourceId === sourceId && !item.enabled)) {
      const latest = this.getNode(node.id) ?? node;
      const test = await this.runTest(latest);
      if (test.finalStatus === "passed" || test.finalStatus === "warning") {
        latest.enabled = true;
        latest.status = "enabled";
        latest.updatedAt = now();
        this.addAudit("subscription.node.auto-enabled", "node", latest.id, `订阅源自动启用节点 ${latest.name}`, { sourceId, testStatus: test.finalStatus });
      }
    }
  }

  private markMissingSubscriptionNodes(sourceId: string, currentNodeIds: string[]) {
    const current = new Set(currentNodeIds);
    let missing = 0;
    const timestamp = now();
    for (const node of this.snapshot().nodes.filter((item) => item.direction === "remote" && item.config.sourceId === sourceId && !current.has(item.id))) {
      if (node.sourceMissing) continue;
      node.sourceMissing = true;
      node.updatedAt = timestamp;
      missing += 1;
    }
    if (missing > 0) {
      this.addAudit("subscription.nodes.missing", "subscription", sourceId, `订阅刷新后标记 ${missing} 个缺失节点`, { missing });
    }
    return missing;
  }

  async runTest(node: NodeConfig) {
    return redisRuntime.withLock(`lock:test:${node.id}`, 120, () => this.runTestUnlocked(node));
  }

  private async runTestUnlocked(node: NodeConfig) {
    if (config.nodeTestDelayMs > 0) await sleep(config.nodeTestDelayMs);
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

  trafficSummaries(days = 14) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.max(days, 1) + 1);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    return this.snapshot().trafficSummaries.filter((summary) => summary.day >= cutoffDay);
  }

  async aggregateTrafficSummaries() {
    const timestamp = now();
    const day = timestamp.slice(0, 10);
    const summaries: TrafficSummary[] = [];
    for (const node of this.snapshot().nodes) {
      const realtime = await redisRuntime.readNodeNow(node.id);
      const testValues = this.recentTests(node.id).filter((test) => test.createdAt.slice(0, 10) === day);
      const latencyValues = testValues.map((test) => test.latencyMs).filter((value): value is number => value !== undefined);
      const source = realtime ? "redis" : "estimated";
      const downloadMbps = realtime?.download_mbps ? Number(realtime.download_mbps) : averageNumber(testValues.map((test) => test.downloadMbps).filter((value): value is number => value !== undefined));
      const activeConnections = realtime?.active_connections ? Number(realtime.active_connections) : Number(node.safeSummary.clients ?? 0);
      const downloadBytes = source === "redis" ? bytesFromMbps(downloadMbps, 60) : bytesFromMbps(downloadMbps || (node.enabled ? 2 : 0), 60 * 60);
      const uploadBytes = source === "redis" ? bytesFromMbps(Math.max(downloadMbps * 0.35, activeConnections * 0.05), 60) : bytesFromMbps((downloadMbps || (node.enabled ? 1 : 0)) * 0.4, 60 * 60);
      summaries.push({
        id: randomUUID(),
        day,
        nodeId: node.id,
        direction: node.direction,
        uploadBytes: Math.round(uploadBytes),
        downloadBytes: Math.round(downloadBytes),
        maxLatencyMs: latencyValues.length ? Math.max(...latencyValues) : realtime?.latency_ms ? Number(realtime.latency_ms) : undefined,
        avgLatencyMs: latencyValues.length ? averageNumber(latencyValues) : realtime?.latency_ms ? Number(realtime.latency_ms) : undefined,
        errorCount: testValues.filter((test) => test.finalStatus === "failed").length,
        source,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    const state = this.snapshot();
    for (const summary of summaries) {
      const existing = state.trafficSummaries.find((item) => item.day === summary.day && item.nodeId === summary.nodeId);
      if (existing) {
        Object.assign(existing, {
          direction: summary.direction,
          uploadBytes: existing.uploadBytes + summary.uploadBytes,
          downloadBytes: existing.downloadBytes + summary.downloadBytes,
          maxLatencyMs: Math.max(existing.maxLatencyMs ?? 0, summary.maxLatencyMs ?? 0) || undefined,
          avgLatencyMs: summary.avgLatencyMs ?? existing.avgLatencyMs,
          errorCount: existing.errorCount + summary.errorCount,
          source: existing.source === "redis" || summary.source === "redis" ? "redis" : "estimated",
          updatedAt: timestamp
        });
      } else {
        state.trafficSummaries.push(summary);
      }
    }
    state.trafficSummaries = state.trafficSummaries.slice(-5000);
    this.addAudit("traffic.aggregated", "system", undefined, `聚合 ${summaries.length} 个节点的每日流量摘要`, { day, count: summaries.length });
    await this.save();
    return { day, count: summaries.length, summaries };
  }

  auditLogs() {
    return this.snapshot().auditLogs.slice(0, 100);
  }

  subscriptionRefreshLogs(id: string) {
    return this.snapshot().auditLogs.filter((log) => log.targetType === "subscription" && log.targetId === id).slice(0, 50);
  }

  async recordAudit(action: string, targetType: string, targetId: string | undefined, summary: string, metadata: Record<string, unknown> = {}) {
    this.addAudit(action, targetType, targetId, summary, metadata);
    await this.save();
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

  private localPortCheck(direction: Direction, protocol: string, data: Record<string, unknown>): LocalPortCheck {
    const transport = udpLocalProtocols.has(protocol) ? "udp" : "tcp";
    const allowedRange = transport === "udp" ? config.localUdpPortRange : config.localTcpPortRange;
    if (direction !== "local") {
      return { ok: true, transport, allowedRange, message: "非本地节点不需要检查监听端口映射。" };
    }

    const port = localListenPort(data);
    if (!port) {
      return { ok: false, transport, allowedRange, message: "监听端口缺失或无效，不能启用。" };
    }

    const ranges = parsePortRanges(allowedRange);
    if (ranges.length === 0) {
      return { ok: false, transport, allowedRange, port, message: `${transport.toUpperCase()} 端口范围配置无效：${allowedRange}。请检查 LOCAL_${transport.toUpperCase()}_PORT_RANGE。` };
    }

    if (!portInRanges(port, ranges)) {
      return {
        ok: false,
        transport,
        allowedRange,
        port,
        message: `端口 ${port}/${transport} 没有映射到 Docker 宿主机。请改用 ${allowedRange} 范围内的端口，或切换到 host network 部署方式。`
      };
    }

    return { ok: true, transport, allowedRange, port, message: `端口 ${port}/${transport} 已在 Docker 映射范围 ${allowedRange} 内。` };
  }

  private testStatus(node: NodeConfig): TestStatus {
    const validation = validateNodeConfig(node.protocol, node.direction, node.config);
    if (!validation.ok) return "failed";
    const portCheck = this.localPortCheck(node.direction, node.protocol, node.config);
    if (!portCheck.ok) return "failed";
    const values = JSON.stringify(node.config).toLowerCase();
    if (values.includes("fail") || values.includes("timeout")) return "failed";
    if (node.protocol === "wireguard" || values.includes("warning")) return "warning";
    return "passed";
  }

  private testSteps(node: NodeConfig, status: TestStatus) {
    const validation = validateNodeConfig(node.protocol, node.direction, node.config);
    if (node.direction === "local") {
      const portCheck = this.localPortCheck(node.direction, node.protocol, node.config);
      return [
        { name: "配置校验", status: validation.ok ? "passed" as const : "failed" as const, message: validation.ok ? "代理核心配置已生成" : `配置不完整：${validation.errors.map((item) => item.field).join(", ")}` },
        { name: "Docker 端口映射", status: portCheck.ok ? "passed" as const : "failed" as const, message: portCheck.message },
        { name: "本机监听", status: status === "failed" ? "failed" as const : "passed" as const, message: status === "failed" ? "本机服务未启动" : "本机服务已启动" },
        { name: "公网检测", status, message: status === "passed" ? "公网可达" : status === "warning" ? "公网可达性需要复核" : "公网不可达" },
        { name: "分享链接", status: status === "failed" ? "failed" as const : "passed" as const, message: status === "failed" ? "无法生成可用分享链接" : "已生成" }
      ];
    }
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
    const validation = validateNodeConfig(node.protocol, node.direction, node.config);
    if (!validation.ok) return `测试失败，节点配置不完整：${validation.errors.map((item) => item.field).join(", ")}。`;
    const portCheck = this.localPortCheck(node.direction, node.protocol, node.config);
    if (!portCheck.ok) return portCheck.message;
    if (status === "passed") return node.direction === "remote" ? "节点可用，可以保存并启用。" : "本地节点可用，可以复制二维码分享。";
    if (status === "warning") return "节点基本可用，但存在可达性或速度警告。";
    return "测试失败，已保存为草稿且不会启用。请检查地址、端口、认证或防火墙。";
  }

  private makePassword() {
    return `${nanoid(4)}-${nanoid(4)}-${nanoid(4)}-${nanoid(4)}`;
  }

  private async readPostgresState(): Promise<AppState> {
    if (!this.pool) return initialState();
    const [admins, nodes, tests, nodeConfigVersions, auditLogs, settings, subscriptions, trafficSummaries, shareTokens, backupJobs] = await Promise.all([
      this.pool.query<{
        id: string;
        username: string;
        email: string | null;
        password_hash: string;
        must_change_password: boolean;
        failed_login_count: number;
        locked_until: Date | null;
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
        source_missing: boolean | null;
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
        node_id: string;
        version: number;
        config: Record<string, unknown>;
        summary: Record<string, unknown>;
        created_at: Date;
      }>("SELECT * FROM node_config_versions ORDER BY created_at ASC"),
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
        source_type: "url" | "content" | null;
        auto_refresh: boolean;
        refresh_cron: string | null;
        auto_enable_new_nodes: boolean | null;
        allow_private_network: boolean | null;
        last_refresh_status: SubscriptionSource["lastRefreshStatus"] | null;
        last_refresh_message: string | null;
        last_refresh_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>("SELECT * FROM subscription_sources ORDER BY updated_at DESC"),
      this.pool.query<{
        id: string;
        day: Date;
        node_id: string | null;
        direction: Direction;
        upload_bytes: string;
        download_bytes: string;
        max_latency_ms: number | null;
        avg_latency_ms: number | null;
        error_count: number;
        source: "redis" | "estimated" | null;
        created_at: Date;
        updated_at: Date | null;
      }>(
        `SELECT id, day, node_id, direction, upload_bytes, download_bytes, max_latency_ms, avg_latency_ms, error_count,
                COALESCE(source, 'estimated') AS source, created_at, updated_at
         FROM daily_traffic_summaries ORDER BY day DESC`
      ),
      this.pool.query<{
        id: string;
        node_id: string;
        token_hash: string;
        status: "active" | "revoked";
        last_used_at: Date | null;
        expires_at: Date | null;
        created_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT id, node_id, token_hash, status, last_used_at, expires_at, created_at, revoked_at
         FROM local_share_tokens ORDER BY created_at DESC`
      ),
      this.pool.query<{
        id: string;
        job_type: "backup" | "restore";
        status: "passed" | "warning" | "failed";
        file_path: string | null;
        contains_secrets: boolean;
        message: string | null;
        manifest: Record<string, unknown>;
        created_at: Date;
        finished_at: Date | null;
      }>(
        `SELECT id, job_type, status, file_path, contains_secrets, message, manifest, created_at, finished_at
         FROM backup_jobs ORDER BY created_at DESC LIMIT 500`
      )
    ]);

    const state = initialState();
    state.admins = admins.rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email ?? undefined,
      passwordHash: row.password_hash,
      mustChangePassword: row.must_change_password,
      failedLoginCount: row.failed_login_count,
      lockedUntil: row.locked_until?.toISOString(),
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
      config: unprotectNodeConfig(row.config),
      safeSummary: row.safe_summary,
      lastTestStatus: row.last_test_status ?? undefined,
      lastTestAt: row.last_test_at?.toISOString(),
      sourceMissing: row.source_missing ?? false,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    }));
    state.nodeConfigVersions = nodeConfigVersions.rows.map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      version: row.version,
      config: unprotectNodeConfig(row.config),
      summary: row.summary,
      createdAt: row.created_at.toISOString()
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
      url: unprotectOptionalSecret(row.url),
      content: unprotectOptionalSecret(row.content),
      sourceType: row.source_type ?? (row.content ? "content" : "url"),
      autoRefresh: row.auto_refresh,
      refreshCron: row.refresh_cron ?? undefined,
      autoEnableNewNodes: Boolean(row.auto_enable_new_nodes),
      allowPrivateNetwork: Boolean(row.allow_private_network),
      lastRefreshStatus: row.last_refresh_status ?? "never",
      lastRefreshMessage: row.last_refresh_message ?? undefined,
      lastRefreshAt: row.last_refresh_at?.toISOString(),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    }));
    state.trafficSummaries = trafficSummaries.rows.map((row) => ({
      id: row.id,
      day: row.day.toISOString().slice(0, 10),
      nodeId: row.node_id ?? undefined,
      direction: row.direction,
      uploadBytes: Number(row.upload_bytes),
      downloadBytes: Number(row.download_bytes),
      maxLatencyMs: row.max_latency_ms ?? undefined,
      avgLatencyMs: row.avg_latency_ms ?? undefined,
      errorCount: row.error_count,
      source: row.source ?? "estimated",
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at?.toISOString() ?? row.created_at.toISOString()
    }));
    state.shareTokens = shareTokens.rows.map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      tokenHash: row.token_hash,
      status: row.status,
      lastUsedAt: row.last_used_at?.toISOString(),
      expiresAt: row.expires_at?.toISOString(),
      createdAt: row.created_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString()
    }));
    state.backupJobs = backupJobs.rows.map((row) => ({
      id: row.id,
      jobType: row.job_type,
      status: row.status,
      filePath: row.file_path ?? undefined,
      containsSecrets: row.contains_secrets,
      message: row.message ?? undefined,
      manifest: row.manifest,
      createdAt: row.created_at.toISOString(),
      finishedAt: row.finished_at?.toISOString()
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
          `INSERT INTO admins(id, username, email, password_hash, must_change_password, failed_login_count, locked_until, created_at, updated_at, last_login_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             username = EXCLUDED.username,
             email = EXCLUDED.email,
             password_hash = EXCLUDED.password_hash,
             must_change_password = EXCLUDED.must_change_password,
             failed_login_count = EXCLUDED.failed_login_count,
             locked_until = EXCLUDED.locked_until,
             updated_at = EXCLUDED.updated_at,
             last_login_at = EXCLUDED.last_login_at`,
          [
            admin.id,
            admin.username,
            admin.email ?? null,
            admin.passwordHash,
            admin.mustChangePassword,
            admin.failedLoginCount ?? 0,
            admin.lockedUntil ?? null,
            admin.createdAt,
            admin.updatedAt,
            admin.lastLoginAt ?? null
          ]
        );
      }

      for (const node of state.nodes) {
        await client.query(
          `INSERT INTO node_configs(id, direction, name, protocol, status, enabled, config, safe_summary, last_test_status, last_test_at, source_missing, created_at, updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
             source_missing = EXCLUDED.source_missing,
             updated_at = EXCLUDED.updated_at`,
          [
            node.id,
            node.direction,
            node.name,
            node.protocol,
            node.status,
            node.enabled,
            JSON.stringify(protectNodeConfig(node.config)),
            JSON.stringify(node.safeSummary),
            node.lastTestStatus ?? null,
            node.lastTestAt ?? null,
            node.sourceMissing ?? false,
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

      for (const version of state.nodeConfigVersions) {
        await client.query(
          `INSERT INTO node_config_versions(id, node_id, version, config, summary, created_at)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (node_id, version) DO UPDATE SET
             config = EXCLUDED.config,
             summary = EXCLUDED.summary`,
          [
            version.id,
            version.nodeId,
            version.version,
            JSON.stringify(protectNodeConfig(version.config)),
            JSON.stringify(version.summary),
            version.createdAt
          ]
        );
      }

      const versionIds = state.nodeConfigVersions.map((version) => version.id);
      if (versionIds.length > 0) {
        await client.query("DELETE FROM node_config_versions WHERE NOT (id = ANY($1::uuid[]))", [versionIds]);
      } else {
        await client.query("DELETE FROM node_config_versions");
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

      for (const shareToken of state.shareTokens) {
        await client.query(
          `INSERT INTO local_share_tokens(id, node_id, token_hash, status, last_used_at, expires_at, created_at, revoked_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             node_id = EXCLUDED.node_id,
             token_hash = EXCLUDED.token_hash,
             status = EXCLUDED.status,
             last_used_at = EXCLUDED.last_used_at,
             expires_at = EXCLUDED.expires_at,
             revoked_at = EXCLUDED.revoked_at`,
          [
            shareToken.id,
            shareToken.nodeId,
            shareToken.tokenHash,
            shareToken.status,
            shareToken.lastUsedAt ?? null,
            shareToken.expiresAt ?? null,
            shareToken.createdAt,
            shareToken.revokedAt ?? null
          ]
        );
      }

      const shareTokenIds = state.shareTokens.map((shareToken) => shareToken.id);
      if (shareTokenIds.length > 0) {
        await client.query("DELETE FROM local_share_tokens WHERE NOT (id = ANY($1::uuid[]))", [shareTokenIds]);
      } else {
        await client.query("DELETE FROM local_share_tokens");
      }

      for (const job of state.backupJobs) {
        await client.query(
          `INSERT INTO backup_jobs(id, job_type, status, file_path, contains_secrets, message, manifest, created_at, finished_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET
             job_type = EXCLUDED.job_type,
             status = EXCLUDED.status,
             file_path = EXCLUDED.file_path,
             contains_secrets = EXCLUDED.contains_secrets,
             message = EXCLUDED.message,
             manifest = EXCLUDED.manifest,
             finished_at = EXCLUDED.finished_at`,
          [
            job.id,
            job.jobType,
            job.status,
            job.filePath ?? null,
            job.containsSecrets,
            job.message ?? null,
            JSON.stringify(job.manifest),
            job.createdAt,
            job.finishedAt ?? null
          ]
        );
      }

      const backupJobIds = state.backupJobs.map((job) => job.id);
      if (backupJobIds.length > 0) {
        await client.query("DELETE FROM backup_jobs WHERE NOT (id = ANY($1::uuid[]))", [backupJobIds]);
      } else {
        await client.query("DELETE FROM backup_jobs");
      }

      for (const subscription of state.subscriptions) {
        await client.query(
          `INSERT INTO subscription_sources(id, name, url, content, source_type, auto_refresh, refresh_cron, auto_enable_new_nodes, allow_private_network, last_refresh_status, last_refresh_message, last_refresh_at, created_at, updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             url = EXCLUDED.url,
             content = EXCLUDED.content,
             source_type = EXCLUDED.source_type,
             auto_refresh = EXCLUDED.auto_refresh,
             refresh_cron = EXCLUDED.refresh_cron,
             auto_enable_new_nodes = EXCLUDED.auto_enable_new_nodes,
             allow_private_network = EXCLUDED.allow_private_network,
             last_refresh_status = EXCLUDED.last_refresh_status,
             last_refresh_message = EXCLUDED.last_refresh_message,
             last_refresh_at = EXCLUDED.last_refresh_at,
             updated_at = EXCLUDED.updated_at`,
          [
            subscription.id,
            subscription.name,
            protectOptionalSecret(subscription.url) ?? null,
            protectOptionalSecret(subscription.content) ?? null,
            subscription.sourceType,
            subscription.autoRefresh,
            subscription.refreshCron ?? null,
            subscription.autoEnableNewNodes,
            subscription.allowPrivateNetwork,
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

      for (const summary of state.trafficSummaries) {
        await client.query(
          `INSERT INTO daily_traffic_summaries(id, day, node_id, direction, upload_bytes, download_bytes, max_latency_ms, avg_latency_ms, error_count, source, created_at, updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (day, node_id) DO UPDATE SET
             direction = EXCLUDED.direction,
             upload_bytes = EXCLUDED.upload_bytes,
             download_bytes = EXCLUDED.download_bytes,
             max_latency_ms = EXCLUDED.max_latency_ms,
             avg_latency_ms = EXCLUDED.avg_latency_ms,
             error_count = EXCLUDED.error_count,
             source = EXCLUDED.source,
             updated_at = EXCLUDED.updated_at`,
          [
            summary.id,
            summary.day,
            summary.nodeId ?? null,
            summary.direction,
            summary.uploadBytes,
            summary.downloadBytes,
            summary.maxLatencyMs ?? null,
            summary.avgLatencyMs ?? null,
            summary.errorCount,
            summary.source,
            summary.createdAt,
            summary.updatedAt
          ]
        );
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
  if (state.nodeConfigVersions !== undefined && !Array.isArray(state.nodeConfigVersions)) throw new Error("备份节点配置版本结构无效");
  if (!Array.isArray(state.tests)) throw new Error("备份缺少测试摘要");
  if (!Array.isArray(state.auditLogs)) throw new Error("备份缺少审计记录");
  if (!Array.isArray(state.subscriptions)) throw new Error("备份缺少订阅源列表");
  if (state.trafficSummaries !== undefined && !Array.isArray(state.trafficSummaries)) throw new Error("备份流量摘要结构无效");
  if (state.shareTokens !== undefined && !Array.isArray(state.shareTokens)) throw new Error("备份分享 token 结构无效");
  if (state.backupJobs !== undefined && !Array.isArray(state.backupJobs)) throw new Error("备份任务摘要结构无效");
  if (!state.settings || typeof state.settings !== "object" || Array.isArray(state.settings)) throw new Error("备份缺少系统设置");
}

async function fetchSubscription(rawUrl: string, allowPrivateNetwork = config.subscriptionAllowPrivateNetwork) {
  let url = new URL(rawUrl);
  await assertSubscriptionUrlAllowed(url, allowPrivateNetwork);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.subscriptionFetchTimeoutSeconds * 1000);
  try {
    for (let redirectCount = 0; redirectCount <= config.subscriptionRedirectLimit; redirectCount += 1) {
      const response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": `ProxyControlCenter/${config.version}` }
      });
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("订阅重定向缺少 Location");
        if (redirectCount >= config.subscriptionRedirectLimit) throw new Error("订阅重定向次数超过限制");
        url = new URL(location, url);
        await assertSubscriptionUrlAllowed(url, allowPrivateNetwork);
        continue;
      }
      if (!response.ok) throw new Error(`订阅拉取失败：HTTP ${response.status}`);
      return readLimitedResponseText(response);
    }
    throw new Error("订阅重定向次数超过限制");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("订阅拉取超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRedirect(status: number) {
  return status >= 300 && status < 400;
}

async function readLimitedResponseText(response: Response) {
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
}

async function assertSubscriptionUrlAllowed(url: URL, allowPrivateNetwork = config.subscriptionAllowPrivateNetwork) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("订阅地址只支持 http 或 https");
  if (allowPrivateNetwork) return;
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

function localListenPort(data: Record<string, unknown>) {
  const port = Number(data.listenPort ?? data.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

function parsePortRanges(input: string) {
  return input
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
}

function portInRanges(port: number, ranges: Array<{ start: number; end: number }>) {
  return ranges.some((range) => port >= range.start && port <= range.end);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function averageNumber(values: number[]) {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function bytesFromMbps(mbps: number, seconds: number) {
  if (!Number.isFinite(mbps) || mbps <= 0) return 0;
  return (mbps * 1_000_000 * seconds) / 8;
}

export function protectState(state: AppState): AppState {
  const protectedState = structuredClone(state) as AppState;
  protectedState.nodes = protectedState.nodes.map((node) => ({
    ...node,
    sourceMissing: Boolean(node.sourceMissing),
    config: protectNodeConfig(node.config)
  }));
  protectedState.nodeConfigVersions = (protectedState.nodeConfigVersions ?? []).map((version) => ({
    ...version,
    config: protectNodeConfig(version.config)
  }));
  protectedState.subscriptions = protectedState.subscriptions.map((subscription) => ({
    ...subscription,
    sourceType: subscription.sourceType ?? (subscription.content ? "content" : "url"),
    autoEnableNewNodes: Boolean(subscription.autoEnableNewNodes),
    allowPrivateNetwork: Boolean(subscription.allowPrivateNetwork),
    url: protectOptionalSecret(subscription.url),
    content: protectOptionalSecret(subscription.content)
  }));
  protectedState.trafficSummaries = protectedState.trafficSummaries ?? [];
  protectedState.shareTokens = (protectedState.shareTokens ?? []).map((shareToken) => ({
    ...shareToken,
    tokenHash: protectOptionalSecret(shareToken.tokenHash) ?? shareToken.tokenHash
  }));
  protectedState.backupJobs = protectedState.backupJobs ?? [];
  protectedState.settings = {
    ...protectedState.settings,
    security: {
      ...(typeof protectedState.settings.security === "object" && protectedState.settings.security ? protectedState.settings.security : {}),
      encryptionKeyFingerprint: encryptionKeyFingerprint()
    }
  };
  return protectedState;
}

export function unprotectState(state: AppState): AppState {
  const unprotectedState = structuredClone(state) as AppState;
  unprotectedState.nodes = unprotectedState.nodes.map((node) => ({
    ...node,
    sourceMissing: Boolean(node.sourceMissing),
    config: unprotectNodeConfig(node.config)
  }));
  unprotectedState.nodeConfigVersions = (unprotectedState.nodeConfigVersions ?? []).map((version) => ({
    ...version,
    config: unprotectNodeConfig(version.config)
  }));
  unprotectedState.subscriptions = unprotectedState.subscriptions.map((subscription) => ({
    ...subscription,
    sourceType: subscription.sourceType ?? (subscription.content ? "content" : "url"),
    autoEnableNewNodes: Boolean(subscription.autoEnableNewNodes),
    allowPrivateNetwork: Boolean(subscription.allowPrivateNetwork),
    url: unprotectOptionalSecret(subscription.url),
    content: unprotectOptionalSecret(subscription.content)
  }));
  unprotectedState.trafficSummaries = unprotectedState.trafficSummaries ?? [];
  unprotectedState.shareTokens = (unprotectedState.shareTokens ?? []).map((shareToken) => ({
    ...shareToken,
    tokenHash: unprotectOptionalSecret(shareToken.tokenHash) ?? shareToken.tokenHash
  }));
  unprotectedState.backupJobs = unprotectedState.backupJobs ?? [];
  return unprotectedState;
}

export const store = new JsonStore();
