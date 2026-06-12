import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-api-gap-"));
const port = 19093;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

const child = spawn("node", ["backend/dist/server.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    DATA_DIR: dataDir,
    ADMIN_PASSWORD: "admin12345",
    JWT_SECRET: "api-gap-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "api-gap-smoke-encryption-key"
  }
});

let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk.toString()));
child.stderr.on("data", (chunk) => (logs += chunk.toString()));

try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await request("/health");
      break;
    } catch {
      await wait(250);
    }
  }

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin12345" })
  });
  const auth = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };
  const authNoBody = { Authorization: `Bearer ${login.token}` };

  const subscription = await request("/api/subscriptions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "API gap subscription",
      content: "vless://99999999-9999-4999-8999-999999999999@api-gap.example.com:443?security=tls&type=tcp#ApiGap"
    })
  });
  await request(`/api/subscriptions/${subscription.id}/refresh`, { method: "POST", headers: authNoBody });
  const log = await request(`/api/subscriptions/${subscription.id}/refresh-log`, { headers: authNoBody });
  if (!log.audits.some((item) => item.action === "subscription.refresh.succeeded")) {
    throw new Error(`refresh-log did not include success audit: ${JSON.stringify(log)}`);
  }
  const importedNodes = await request("/api/remote-nodes", { headers: authNoBody });
  const importedNode = importedNodes.find((node) => node.name === "ApiGap");
  if (!importedNode || importedNode.sourceMissing || importedNode.config.sourceId !== subscription.id) {
    throw new Error(`subscription refresh did not attach imported node: ${JSON.stringify(importedNode)}`);
  }

  const patched = await request(`/api/subscriptions/${subscription.id}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      autoRefresh: true,
      refreshCron: "*/5 * * * *",
      autoEnableNewNodes: true,
      allowPrivateNetwork: true
    })
  });
  if (!patched.autoRefresh || patched.refreshCron !== "*/5 * * * *" || !patched.autoEnableNewNodes || !patched.allowPrivateNetwork) {
    throw new Error(`subscription patch did not persist refresh and import options: ${JSON.stringify(patched)}`);
  }

  await request(`/api/subscriptions/${subscription.id}`, { method: "DELETE", headers: authNoBody });
  const afterDelete = await fetch(`http://127.0.0.1:${port}/api/subscriptions/${subscription.id}`, { headers: authNoBody });
  if (afterDelete.status !== 404) {
    throw new Error(`deleted subscription remained readable: ${afterDelete.status} ${await afterDelete.text()}`);
  }
  const nodesAfterSubscriptionDelete = await request("/api/remote-nodes", { headers: authNoBody });
  const detachedNode = nodesAfterSubscriptionDelete.find((node) => node.id === importedNode.id);
  if (!detachedNode || !detachedNode.sourceMissing || "sourceId" in detachedNode.config) {
    throw new Error(`subscription delete did not detach and retain imported node: ${JSON.stringify(detachedNode)}`);
  }

  const restart = await request("/api/system/restart", { method: "POST", headers: authNoBody });
  if (!restart.ok || !restart.result?.skipped || !String(restart.result.message ?? "").includes("render-only")) {
    throw new Error(`system restart did not expose render-only restart result: ${JSON.stringify(restart)}`);
  }

  const settings = await request("/api/system/settings", { headers: authNoBody });
  const updatedSettings = await request("/api/system/settings", {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      ...settings,
      retention: {
        ...(settings.retention ?? {}),
        realtimeTtlHours: 12,
        dailySummaryDays: 90,
        auditLogDays: 120
      }
    })
  });
  if (updatedSettings.retention?.realtimeTtlHours !== 12 || updatedSettings.retention?.dailySummaryDays !== 90 || updatedSettings.retention?.auditLogDays !== 120) {
    throw new Error(`system settings patch did not persist retention: ${JSON.stringify(updatedSettings)}`);
  }
  const updateCheck = await request("/api/system/update-check", { method: "POST", headers: authNoBody });
  if (!updateCheck.upToDate) throw new Error(`system update check did not return expected result: ${JSON.stringify(updateCheck)}`);
  const auditEvents = await request("/api/dashboard/events", { headers: authNoBody });
  for (const action of ["system.engine.restarted", "system.settings.updated", "system.update.checked", "subscription.deleted", "subscription.nodes.detached"]) {
    if (!auditEvents.some((event) => event.action === action)) {
      throw new Error(`audit event missing ${action}: ${JSON.stringify(auditEvents)}`);
    }
  }

  const controller = new AbortController();
  const streamResponse = await fetch(`http://127.0.0.1:${port}/api/realtime/stream`, {
    headers: authNoBody,
    signal: controller.signal
  });
  if (!streamResponse.ok || !streamResponse.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error(`SSE stream response invalid: ${streamResponse.status} ${streamResponse.headers.get("content-type")}`);
  }
  const reader = streamResponse.body?.getReader();
  if (!reader) throw new Error("SSE response body missing");
  const { value } = await reader.read();
  controller.abort();
  const text = Buffer.from(value ?? new Uint8Array()).toString("utf8");
  if (!text.includes("event: summary") || !text.includes("\"now\"") || !text.includes("\"points\"")) {
    throw new Error(`SSE stream did not send summary event: ${text}`);
  }

  console.log("api gap smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
