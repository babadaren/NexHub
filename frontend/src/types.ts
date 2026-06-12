export type Direction = "remote" | "local";
export type NodeStatus = "draft" | "enabled" | "disabled" | "error";
export type TestStatus = "passed" | "warning" | "failed";

export interface AdminUser {
  id: string;
  username: string;
  email?: string;
  mustChangePassword?: boolean;
}

export interface NodeConfig {
  id: string;
  direction: Direction;
  name: string;
  protocol: string;
  status: NodeStatus;
  enabled: boolean;
  config: Record<string, unknown>;
  safeSummary: Record<string, unknown>;
  lastTestStatus?: TestStatus;
  lastTestAt?: string;
  sourceMissing?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TestStep {
  name: string;
  status: TestStatus;
  message: string;
}

export interface NodeTestResult {
  id: string;
  nodeId?: string;
  direction: Direction;
  finalStatus: TestStatus;
  latencyMs?: number;
  downloadMbps?: number;
  steps: TestStep[];
  humanMessage: string;
  createdAt: string;
}

export interface CreateNodeResult {
  node: NodeConfig;
  test?: NodeTestResult;
}

export interface SubscriptionSource {
  id: string;
  name: string;
  url?: string;
  content?: string;
  sourceType: "url" | "content";
  autoRefresh: boolean;
  refreshCron?: string;
  autoEnableNewNodes: boolean;
  allowPrivateNetwork: boolean;
  lastRefreshStatus?: "never" | "passed" | "warning" | "failed";
  lastRefreshMessage?: string;
  lastRefreshAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRefreshLog {
  subscription: SubscriptionSource;
  audits: Array<{
    id: string;
    action: string;
    message: string;
    createdAt: string;
  }>;
  events: Array<Record<string, unknown>>;
}

export interface ImportApplyResult {
  status: "passed" | "warning" | "failed";
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  nodes: NodeConfig[];
  message: string;
}

export interface ParsedImportNode {
  id: string;
  name: string;
  protocol: string;
  server?: string;
  port?: number;
  status: "parsed" | "failed";
  raw: string;
  config: Record<string, unknown>;
  error?: string;
  fingerprint?: string;
  sourceFormat?: string;
}

export interface BackupSummary {
  file: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  containsSecrets: boolean;
  manifest: {
    version: string;
    storageDriver: string;
    engineProvider: string;
    encryptionKeyFingerprint?: string;
    state: {
      admins: number;
      nodes: number;
      nodeConfigVersions?: number;
      tests: number;
      auditLogs: number;
      subscriptions: number;
      trafficSummaries?: number;
      shareTokens?: number;
      backupJobs?: number;
    };
  };
  message?: string;
}

export interface SystemCheck {
  status: "ok" | "error";
  message: string;
  detail?: string;
}

export interface SystemStatus {
  status: "ready" | "degraded";
  ready: boolean;
  version: string;
  deployment: Record<string, string>;
  checks: Record<string, SystemCheck>;
  storage: {
    driver: string;
    dataDir: string;
    backupDir: string;
    releaseMode: boolean;
    redisRequired: boolean;
    redisError?: string;
  };
  engine?: {
    provider?: string;
    currentPath?: string;
    previousPath?: string;
    lastRenderAt?: string;
    lastRenderMessage?: string;
    lastRenderError?: string;
    runtime?: Record<string, unknown>;
  };
  ports: {
    localTcpPortRange: string;
    localUdpPortRange: string;
  };
  backups: {
    count: number;
    error?: {
      code: string;
      message: string;
      suggestion?: string;
    };
    latest?: {
      file: string;
      createdAt: string;
      sizeBytes: number;
    };
  };
  disk: {
    path: string;
    totalBytes?: number;
    freeBytes?: number;
    usedBytes?: number;
    usedPercent?: number;
    error?: string;
  };
}

export interface SystemSettings {
  retention?: {
    realtimeTtlHours?: number;
    dailySummaryDays?: number;
    auditLogDays?: number;
  };
  deployment?: Record<string, unknown>;
  engine?: Record<string, unknown>;
  security?: Record<string, unknown>;
}

export interface InstallStatus {
  ready: boolean;
  status: "ready" | "degraded";
  version: string;
  serverMode: string;
  adminUsername: string;
  dataDir: string;
  storageDriver: string;
  passwordCommand: string;
  loginPath: string;
  steps: Array<{
    key: string;
    title: string;
    message: string;
  }>;
}

export interface RestoreResult {
  file: string;
  restoredAt: string;
  preRestoreFile: string;
  manifest: BackupSummary["manifest"];
  message: string;
}

export interface SharePayload {
  link: string;
  subscription?: string;
  subscriptionPath?: string;
  token?: string;
  tokenAvailable: boolean;
  tokenIssuedAt?: string;
  qrPayload: string;
  clash: string;
  singBox: unknown;
  message: string;
}

export interface PublicCheckResult {
  publicIp: string;
  dns: string;
  port: string;
  ipv6: string;
  natType: string;
  reachable: boolean;
  suggestion: string;
}

export interface DashboardSummary {
  metrics: Array<{ key: string; label: string; value: string | number; color: string }>;
  health: Array<{ name: string; status: string; message: string }>;
  alerts: Array<{ level: "warning" | "error" | "success"; title: string; message: string; time: string }>;
  nodes: NodeConfig[];
}

export interface HistorySummary {
  days: number;
  totals: {
    passedTests: number;
    warningTests: number;
    failedTests: number;
    estimatedInboundGb: number;
    estimatedOutboundGb: number;
    avgLatencyMs: number;
    latestRemoteNodes: number;
    latestLocalNodes: number;
  };
  daily: Array<{
    day: string;
    remoteNodes: number;
    localNodes: number;
    passedTests: number;
    warningTests: number;
    failedTests: number;
    avgLatencyMs: number;
    avgDownloadMbps: number;
    estimatedInboundGb: number;
    estimatedOutboundGb: number;
  }>;
}

export interface RealtimePoint {
  time: string;
  inbound: number;
  outbound: number;
  connections: number;
  errors?: number;
}

export interface NodeRealtime {
  nodeId: string;
  status: string;
  latencyMs?: number;
  activeConnections: number;
  updatedAt?: string;
  points: RealtimePoint[];
}
