import type { AdminUser, BackupSummary, DashboardSummary, Direction, ImportApplyResult, NodeConfig, NodeTestResult, RealtimePoint, RestoreResult, SharePayload, SubscriptionSource } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const TOKEN_KEY = "proxy-control-center-token";

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
    try {
      const body = await response.json();
      message = body.message ?? body.error ?? message;
    } catch {
      message = await response.text();
    }
    throw new Error(message || "请求失败");
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
  me: () => request<AdminUser>("/api/auth/me"),
  dashboard: () => request<DashboardSummary>("/api/dashboard/summary"),
  nodes: (direction: Direction) => request<NodeConfig[]>(direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"),
  node: (direction: Direction, id: string) =>
    request<NodeConfig & { tests: NodeTestResult[]; realtime: { points: RealtimePoint[] } }>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/${id}`),
  createNode: (direction: Direction, payload: { name: string; protocol: string; enabled?: boolean; config: Record<string, unknown> }) =>
    request<NodeConfig>(direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteNode: (direction: Direction, id: string) =>
    request<void>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/${id}`, { method: "DELETE" }),
  testNode: (direction: Direction, id: string) =>
    request<NodeTestResult>(`${direction === "remote" ? "/api/remote-nodes" : "/api/local-nodes"}/${id}/test`, { method: "POST" }),
  shareNode: (id: string) => request<SharePayload>(`/api/local-nodes/${id}/share`),
  rotateShareNode: (id: string) => request<SharePayload>(`/api/local-nodes/${id}/share/rotate`, { method: "POST" }),
  parseImport: (input: string) =>
    request<{ nodes: Array<Record<string, unknown>> }>("/api/remote-nodes/import/parse", {
      method: "POST",
      body: JSON.stringify({ input })
    }),
  applyImport: (nodes: Array<Record<string, unknown>>) =>
    request<ImportApplyResult>("/api/remote-nodes/import/apply", {
      method: "POST",
      body: JSON.stringify({ nodes })
    }),
  subscriptions: () => request<SubscriptionSource[]>("/api/subscriptions"),
  createSubscription: (payload: { name: string; url?: string; content?: string; autoRefresh?: boolean; refreshCron?: string }) =>
    request<SubscriptionSource>("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  refreshSubscription: (id: string) => request<ImportApplyResult>(`/api/subscriptions/${id}/refresh`, { method: "POST" }),
  protocols: (direction: Direction) => request<Array<{ protocol: string; label: string }>>(`/api/protocols?direction=${direction}`),
  realtime: () => request<{ now: Record<string, number>; points: RealtimePoint[]; events: Array<Record<string, unknown>> }>("/api/realtime/summary"),
  systemStatus: () => request<{ version: string; deployment: Record<string, string>; ports: Record<string, string>; engine?: { runtime?: Record<string, unknown> } }>("/api/system/status"),
  backups: () => request<BackupSummary[]>("/api/system/backups"),
  backup: () => request<BackupSummary & { message: string }>("/api/system/backup", { method: "POST" }),
  restoreBackup: (file: string) => request<RestoreResult>(`/api/system/backups/${encodeURIComponent(file)}/restore`, { method: "POST" }),
  updateCheck: () => request<{ current: string; latest: string; upToDate: boolean }>("/api/system/update-check", { method: "POST" }),
  changePassword: (password: string) =>
    request<{ ok: boolean }>("/api/admin/password", {
      method: "PATCH",
      body: JSON.stringify({ password })
    })
};
