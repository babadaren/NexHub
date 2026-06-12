import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-locks-"));
const port = 19085;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

async function raw(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, options);
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
    JWT_SECRET: "locks-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "locks-smoke-encryption-key",
    NODE_TEST_DELAY_MS: "1500"
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
  const auth = { Authorization: `Bearer ${login.token}` };
  const node = await request("/api/local-nodes", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Lock-Local",
      protocol: "socks5",
      enabled: true,
      config: { listenHost: "0.0.0.0", listenPort: 20085, exposure: "lan" }
    })
  });

  const responses = await Promise.all([
    raw(`/api/local-nodes/${node.id}/test`, { method: "POST", headers: auth }),
    raw(`/api/local-nodes/${node.id}/test`, { method: "POST", headers: auth })
  ]);
  const statuses = responses.map((response) => response.status).sort();
  if (statuses[0] !== 200 || statuses[1] !== 409) {
    throw new Error(`expected one successful test and one conflict, got ${statuses.join(",")}`);
  }
  const conflictResponse = responses.find((response) => response.status === 409);
  const conflict = await conflictResponse.json();
  if (conflict.code !== "NODE_TEST_LOCKED" || !conflict.suggestion) {
    throw new Error(`lock conflict did not return structured guidance: ${JSON.stringify(conflict)}`);
  }

  console.log("locks smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
