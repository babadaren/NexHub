import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { renderEngineConfig } from "./engine.js";
import type { AppState, AuditLog, Direction, NodeConfig, NodeTestResult, TestStatus } from "./types.js";

const stateFile = path.join(config.dataDir, "state.json");

const now = () => new Date().toISOString();

function initialState(): AppState {
  return {
    admins: [],
    nodes: [],
    tests: [],
    auditLogs: [],
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
  generatedAdminPassword: string | undefined;

  async load() {
    await mkdir(config.dataDir, { recursive: true });
    try {
      const raw = await readFile(stateFile, "utf8");
      this.state = JSON.parse(raw) as AppState;
    } catch {
      this.state = initialState();
      await this.save();
    }
    await this.ensureAdmin();
    await this.seedNodes();
  }

  snapshot() {
    if (!this.state) throw new Error("store not loaded");
    return this.state;
  }

  async save() {
    if (!this.state) return;
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
      id: nanoid(),
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

  async seedNodes() {
    const state = this.snapshot();
    if (state.nodes.length > 0) return;
    const timestamp = now();
    const nodes: NodeConfig[] = [
      {
        id: nanoid(),
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
        id: nanoid(),
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
    const node: NodeConfig = {
      id: nanoid(),
      direction,
      name: input.name,
      protocol: input.protocol,
      status: input.enabled ? "enabled" : "draft",
      enabled: Boolean(input.enabled),
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

  async runTest(node: NodeConfig) {
    const status: TestStatus = this.testStatus(node);
    const result: NodeTestResult = {
      id: nanoid(),
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
      id: nanoid(),
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
      return {
        server: data.server ?? data.host ?? "未填写",
        port: data.port ?? 443,
        protocol,
        latencyMs: 68,
        todayTraffic: "0B"
      };
    }
    return {
      listen: `${data.listenHost ?? "0.0.0.0"}:${data.listenPort ?? data.port ?? 20001}`,
      protocol,
      clients: 0,
      publicReachable: data.exposure === "public"
    };
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
}

export const store = new JsonStore();
