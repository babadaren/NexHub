import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-subscription-scheduler-"));
const port = 19089;

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
    JWT_SECRET: "subscription-scheduler-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "subscription-scheduler-smoke-encryption-key",
    SUBSCRIPTION_REFRESH_ENABLED: "true",
    SUBSCRIPTION_SCHEDULER_INTERVAL_SECONDS: "1"
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
      name: "Scheduled subscription",
      content: "vless://77777777-7777-4777-8777-777777777777@scheduler.example.com:443?security=tls&type=tcp#Scheduler",
      autoRefresh: true,
      refreshCron: "* * * * *",
      autoEnableNewNodes: true
    })
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const subscriptions = await request("/api/subscriptions", { headers: authNoBody });
    const current = subscriptions.find((item) => item.id === subscription.id);
    if (current?.lastRefreshStatus === "passed") break;
    await wait(1000);
  }

  const subscriptions = await request("/api/subscriptions", { headers: authNoBody });
  const current = subscriptions.find((item) => item.id === subscription.id);
  if (current?.lastRefreshStatus !== "passed" || !current.lastRefreshAt) {
    throw new Error(`subscription scheduler did not refresh: ${JSON.stringify(current)}`);
  }

  const nodes = await request("/api/remote-nodes", { headers: authNoBody });
  const scheduledNode = nodes.find((node) => node.safeSummary?.server === "scheduler.example.com");
  if (!scheduledNode) {
    throw new Error("scheduled subscription did not create imported node");
  }
  if (!scheduledNode.enabled || scheduledNode.status !== "enabled") {
    throw new Error(`scheduled subscription did not auto-enable tested node: ${JSON.stringify(scheduledNode)}`);
  }

  const events = await request("/api/dashboard/events", { headers: authNoBody });
  if (!events.some((event) => event.action === "subscription.scheduler.triggered")) {
    throw new Error("subscription scheduler trigger audit was not recorded");
  }

  console.log("subscription scheduler smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
