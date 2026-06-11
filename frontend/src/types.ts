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

export interface SubscriptionSource {
  id: string;
  name: string;
  url?: string;
  content?: string;
  autoRefresh: boolean;
  refreshCron?: string;
  lastRefreshStatus?: "never" | "passed" | "warning" | "failed";
  lastRefreshMessage?: string;
  lastRefreshAt?: string;
  createdAt: string;
  updatedAt: string;
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
    state: {
      admins: number;
      nodes: number;
      tests: number;
      auditLogs: number;
      subscriptions: number;
    };
  };
  message?: string;
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

export interface DashboardSummary {
  metrics: Array<{ key: string; label: string; value: string | number; color: string }>;
  health: Array<{ name: string; status: string; message: string }>;
  alerts: Array<{ level: "warning" | "error" | "success"; title: string; message: string; time: string }>;
  nodes: NodeConfig[];
}

export interface RealtimePoint {
  time: string;
  inbound: number;
  outbound: number;
  connections: number;
  errors?: number;
}
