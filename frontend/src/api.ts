import type { AdminUser, BackupSummary, CreateNodeResult, DashboardSummary, Direction, HistorySummary, ImportApplyResult, InstallStatus, NodeConfig, NodeRealtime, NodeTestResult, ParsedImportNode, PublicCheckResult, RealtimePoint, RestoreResult, SharePayload, SubscriptionRefreshLog, SubscriptionSource, SystemSettings, SystemStatus } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const TOKEN_KEY = "proxy-control-center-token";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly suggestion?: string,
    readonly field?: string,
    readonly fields: string[] = []
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    let message = response.statusText;
    let code: string | undefined;
    let suggestion: string | undefined;
    let field: string | undefined;
    let fields: string[] = [];
    try {
      const body = await response.json();
      suggestion = typeof body.suggestion === "string" ? body.suggestion : undefined;
      code = typeof body.code === "string" ? body.code : undefined;
      field = typeof body.field === "string" ? body.field : undefined;
      fields = Array.isArray(body.fields) ? body.fields.filter((item: unknown): item is string => typeof item === "string") : field ? [field] : [];
      message = `${body.message ?? body.error ?? message}${suggestion ? ` ${suggestion}` : ""}`;
    } catch {
      message = await response.text();
    }
    throw new ApiError(message || "请求失败", response.status, code, suggestion, field, fields);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  async login(username: string, password: string) {
    const result = await request<{ token: string; admin: AdminUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    setToken(result.token);
    return result.admin;
  },
  async logout() {
    try {
      await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    } finally {
      clearToken();
    }
  },
  me: () => request<AdminUser>("/api/auth/me"),
  installStatus: () => request<InstallStatus>("/api/install/status"),
  dashboard: () => request<DashboardSummary>("/api/dashboard/summary"),
  history: (days = 14) => request<HistorySummary>(`/api/history/summary?days=${days}`),
  nodes: (direction: Direction) => request<NodeConfig[]>(direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"),
  node: (direction: Direction, id: string) =>
    request<NodeConfig & { tests: NodeTestResult[]; realtime: NodeRealtime }>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/${id}`),
  createNode: (direction: Direction, payload: { name: string; protocol: string; enabled?: boolean; config: Record<string, unknown> }) =>
    request<NodeConfig>(direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  testCreateNode: (direction: Direction, payload: { name: string; protocol: string; config: Record<string, unknown> }) =>
    request<CreateNodeResult>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/test-create`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateNode: (direction: Direction, id: string, payload: Partial<Pick<NodeConfig, "name" | "config">>) =>
    request<NodeConfig>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteNode: (direction: Direction, id: string) =>
    request<void>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/${id}`, { method: "DELETE" }),
  testNode: (direction: Direction, id: string) =>
    request<NodeTestResult>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/${id}/test`, { method: "POST" }),
  enableNode: (direction: Direction, id: string) =>
    request<NodeConfig>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/${id}/enable`, { method: "POST" }),
  disableNode: (direction: Direction, id: string) =>
    request<NodeConfig>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/${id}/disable`, { method: "POST" }),
  stopLocalNode: (id: string) => request<{ node: NodeConfig; engine: Record<string, unknown> }>(`/api/local-nodes/${id}/stop`, { method: "POST" }),
  restartLocalNode: (id: string) => request<{ node: NodeConfig; test: NodeTestResult; engine: Record<string, unknown> }>(`/api/local-nodes/${id}/restart`, { method: "POST" }),
  publicCheckLocalNode: (id: string) => request<PublicCheckResult>(`/api/local-nodes/${id}/public-check`, { method: "POST" }),
  shareNode: (id: string) => request<SharePayload>(`/api/local-nodes/${id}/share`),
  rotateShareNode: (id: string) => request<SharePayload>(`/api/local-nodes/${id}/share/rotate`, { method: "POST" }),
  parseImport: (input: string) =>
    request<{ nodes: ParsedImportNode[] }>("/api/remote-nodes/import/parse", {
      method: "POST",
      body: JSON.stringify({ input })
    }),
  applyImport: (nodes: ParsedImportNode[]) =>
    request<ImportApplyResult>("/api/remote-nodes/import/apply", {
      method: "POST",
      body: JSON.stringify({ nodes })
    }),
  subscriptions: () => request<SubscriptionSource[]>("/api/subscriptions"),
  createSubscription: (payload: { name: string; url?: string; content?: string; sourceType?: "url" | "content"; autoRefresh?: boolean; refreshCron?: string; autoEnableNewNodes?: boolean; allowPrivateNetwork?: boolean }) =>
    request<SubscriptionSource>("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateSubscription: (id: string, payload: Partial<Pick<SubscriptionSource, "name" | "url" | "content" | "sourceType" | "autoRefresh" | "refreshCron" | "autoEnableNewNodes" | "allowPrivateNetwork">>) =>
    request<SubscriptionSource>(`/api/subscriptions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteSubscription: (id: string) => request<void>(`/api/subscriptions/${id}`, { method: "DELETE" }),
  refreshSubscription: (id: string) => request<ImportApplyResult>(`/api/subscriptions/${id}/refresh`, { method: "POST" }),
  subscriptionRefreshLog: (id: string) => request<SubscriptionRefreshLog>(`/api/subscriptions/${id}/refresh-log`),
  protocols: (direction: Direction) => request<Array<{ protocol: string; label: string }>>(`/api/protocols?direction=${direction}`),
  realtime: () => request<{ now: Record<string, number>; points: RealtimePoint[]; events: Array<Record<string, unknown>> }>("/api/realtime/summary"),
  systemStatus: () => request<SystemStatus>("/api/system/status"),
  systemSettings: () => request<SystemSettings>("/api/system/settings"),
  updateSystemSettings: (payload: SystemSettings) =>
    request<SystemSettings>("/api/system/settings", {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  backups: () => request<BackupSummary[]>("/api/system/backups"),
  backup: () => request<BackupSummary & { message: string }>("/api/system/backup", { method: "POST" }),
  restoreBackup: (file: string) => request<RestoreResult>(`/api/system/backups/${encodeURIComponent(file)}/restore`, { method: "POST" }),
  updateCheck: () => request<{ current: string; latest: string; upToDate: boolean }>("/api/system/update-check", { method: "POST" }),
  restartSystem: () => request<{ ok: boolean; result: { ok: boolean; skipped?: boolean; message?: string }; engine: Record<string, unknown> }>("/api/system/restart", { method: "POST" }),
  changePassword: (password: string) =>
    request<{ ok: boolean }>("/api/admin/password", {
      method: "PATCH",
      body: JSON.stringify({ password })
    })
};
