export type Direction = "remote" | "local";
export type NodeStatus = "draft" | "enabled" | "disabled" | "error";
export type TestStatus = "passed" | "warning" | "failed";

export interface AdminAccount {
  id: string;
  username: string;
  email?: string;
  passwordHash: string;
  mustChangePassword: boolean;
  failedLoginCount?: number;
  lockedUntil?: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
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
  testType: "remote" | "local";
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

export interface NodeConfigVersion {
  id: string;
  nodeId: string;
  version: number;
  config: Record<string, unknown>;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  action: string;
  targetType: string;
  targetId?: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
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

export interface TrafficSummary {
  id: string;
  day: string;
  nodeId?: string;
  direction: Direction;
  uploadBytes: number;
  downloadBytes: number;
  maxLatencyMs?: number;
  avgLatencyMs?: number;
  errorCount: number;
  source: "redis" | "estimated";
  createdAt: string;
  updatedAt: string;
}

export interface LocalShareToken {
  id: string;
  nodeId: string;
  tokenHash: string;
  status: "active" | "revoked";
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export interface BackupJob {
  id: string;
  jobType: "backup" | "restore";
  status: "passed" | "warning" | "failed";
  filePath?: string;
  containsSecrets: boolean;
  message?: string;
  manifest: Record<string, unknown>;
  createdAt: string;
  finishedAt?: string;
}

export interface AppState {
  admins: AdminAccount[];
  nodes: NodeConfig[];
  nodeConfigVersions: NodeConfigVersion[];
  tests: NodeTestResult[];
  auditLogs: AuditLog[];
  subscriptions: SubscriptionSource[];
  trafficSummaries: TrafficSummary[];
  shareTokens: LocalShareToken[];
  backupJobs: BackupJob[];
  settings: Record<string, unknown>;
}
