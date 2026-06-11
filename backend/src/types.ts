export type Direction = "remote" | "local";
export type NodeStatus = "draft" | "enabled" | "disabled" | "error";
export type TestStatus = "passed" | "warning" | "failed";

export interface AdminAccount {
  id: string;
  username: string;
  email?: string;
  passwordHash: string;
  mustChangePassword: boolean;
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

export interface AuditLog {
  id: string;
  action: string;
  targetType: string;
  targetId?: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AppState {
  admins: AdminAccount[];
  nodes: NodeConfig[];
  tests: NodeTestResult[];
  auditLogs: AuditLog[];
  settings: Record<string, unknown>;
}
