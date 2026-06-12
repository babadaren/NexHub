import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePort = 19110;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function request(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

async function startBackend({ port, dataDir, env }) {
  const child = spawn("node", ["backend/dist/server.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: "admin12345",
      JWT_SECRET: `subscription-security-${port}-secret`,
      CONFIG_ENCRYPTION_KEY: `subscription-security-${port}-encryption-key`,
      ...env
    }
  });

  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk) => (logs += chunk.toString()));

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await request(port, "/health");
      return { child, logs: () => logs };
    } catch {
      await wait(250);
    }
  }

  child.kill();
  throw new Error(`backend ${port} did not start:\n${logs}`);
}

async function login(port) {
  const result = await request(port, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin12345" })
  });
  return { Authorization: `Bearer ${result.token}`, "Content-Type": "application/json" };
}

async function createAndRefreshSubscription(port, headers, url, extra = {}) {
  const subscription = await request(port, "/api/subscriptions", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Security ${port}`, url, ...extra })
  });
  const refresh = await request(port, `/api/subscriptions/${subscription.id}/refresh`, {
    method: "POST",
    headers: { Authorization: headers.Authorization }
  });
  return { subscription, refresh };
}

async function withBackend(port, env, fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), `pcc-subscription-security-${port}-`));
  const backend = await startBackend({ port, dataDir, env });
  try {
    const auth = await login(port);
    await fn(auth);
  } finally {
    backend.child.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const subscriptionServer = http.createServer((request, response) => {
  if (request.url === "/redirect/0") {
    response.writeHead(302, { Location: "/redirect/1" });
    response.end();
    return;
  }
  if (request.url === "/redirect/1") {
    response.writeHead(302, { Location: "/final" });
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("vless://55555555-5555-4555-8555-555555555555@subscription-security.example.com:443?security=tls&type=tcp#Security");
});

await listen(subscriptionServer, sourcePort);

try {
  await withBackend(19087, { SUBSCRIPTION_ALLOW_PRIVATE_NETWORK: "false" }, async (auth) => {
    const { subscription, refresh: result } = await createAndRefreshSubscription(19087, auth, `http://127.0.0.1:${sourcePort}/final`);
    if (result.status !== "failed" || !result.message.includes("内网")) {
      throw new Error(`expected private network rejection, got ${JSON.stringify(result)}`);
    }
    const events = await request(19087, "/api/dashboard/events", { headers: { Authorization: auth.Authorization } });
    if (!events.some((event) => event.action === "subscription.refresh.failed" && event.targetId === subscription.id && event.metadata?.code === "SUBSCRIPTION_REFRESH_FAILED")) {
      throw new Error(`subscription refresh failure audit was not recorded: ${JSON.stringify(events)}`);
    }
    const settings = await request(19087, "/api/system/settings", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ security: { allowPrivateSubscriptions: true } })
    });
    if (settings.security?.allowPrivateSubscriptions !== true) {
      throw new Error(`expected private subscription system setting to be enabled, got ${JSON.stringify(settings)}`);
    }
    const settingsEvents = await request(19087, "/api/dashboard/events", { headers: { Authorization: auth.Authorization } });
    if (
      !settingsEvents.some(
        (event) =>
          event.action === "system.settings.updated" &&
          event.metadata?.allowPrivateSubscriptions === true &&
          Array.isArray(event.metadata?.keys) &&
          event.metadata.keys.includes("security")
      )
    ) {
      throw new Error(`system setting audit was not recorded: ${JSON.stringify(settingsEvents)}`);
    }
    const { refresh: systemAllowed } = await createAndRefreshSubscription(19087, auth, `http://127.0.0.1:${sourcePort}/final`);
    if (systemAllowed.status !== "passed" || systemAllowed.nodes.length === 0) {
      throw new Error(`expected system private network allowance, got ${JSON.stringify(systemAllowed)}`);
    }
    const { refresh: allowed } = await createAndRefreshSubscription(19087, auth, `http://127.0.0.1:${sourcePort}/final`, { allowPrivateNetwork: true });
    if (allowed.status !== "passed" || allowed.nodes.length === 0) {
      throw new Error(`expected per-source private network allowance, got ${JSON.stringify(allowed)}`);
    }
  });

  await withBackend(
    19088,
    {
      SUBSCRIPTION_ALLOW_PRIVATE_NETWORK: "true",
      SUBSCRIPTION_REDIRECT_LIMIT: "1"
    },
    async (auth) => {
      const { subscription, refresh: result } = await createAndRefreshSubscription(19088, auth, `http://127.0.0.1:${sourcePort}/redirect/0`, { allowPrivateNetwork: true });
      if (result.status !== "failed" || !result.message.includes("重定向次数")) {
        throw new Error(`expected redirect limit failure, got ${JSON.stringify(result)}`);
      }
      const events = await request(19088, "/api/dashboard/events", { headers: { Authorization: auth.Authorization } });
      if (!events.some((event) => event.action === "subscription.refresh.failed" && event.targetId === subscription.id && event.metadata?.code === "SUBSCRIPTION_REFRESH_FAILED")) {
        throw new Error(`subscription redirect failure audit was not recorded: ${JSON.stringify(events)}`);
      }
    }
  );

  console.log("subscription security smoke ok");
} finally {
  await closeServer(subscriptionServer);
}
