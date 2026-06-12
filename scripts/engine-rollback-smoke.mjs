import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-engine-rollback-"));
const engineDir = path.join(dataDir, "engine");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

async function startBackend(port, env = {}) {
  const child = spawn("node", ["backend/dist/server.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: "admin12345",
      JWT_SECRET: `engine-rollback-${port}-secret`,
      CONFIG_ENCRYPTION_KEY: "engine-rollback-encryption-key",
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

async function createRemoteNode(port, headers, name, server) {
  return request(port, "/api/remote-nodes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      protocol: "vless",
      enabled: true,
      config: { server, port: 443, uuid: "88888888-8888-4888-8888-888888888888", tls: true }
    })
  });
}

async function stop(child) {
  child.kill();
  await wait(500);
}

try {
  const first = await startBackend(19090);
  const auth = await login(19090);
  await createRemoteNode(19090, auth, "Stable", "stable.example.com");
  const stableConfig = await readFile(path.join(engineDir, "current.json"), "utf8");
  if (!stableConfig.includes("stable.example.com")) throw new Error("stable config was not written");
  await stop(first.child);

  const second = await startBackend(19091, {
    ENGINE_MODE: "managed",
    ENGINE_BINARY: "definitely-missing-sing-box"
  });
  const auth2 = await login(19091);
  await createRemoteNode(19091, auth2, "Broken", "broken.example.com");
  const afterFailure = await readFile(path.join(engineDir, "current.json"), "utf8");
  if (!afterFailure.includes("stable.example.com") || afterFailure.includes("broken.example.com")) {
    throw new Error("engine check failure changed current config instead of preserving previous config");
  }
  const status = await request(19091, "/api/system/status", { headers: { Authorization: auth2.Authorization } });
  const engineText = JSON.stringify(status.engine ?? {});
  if (!engineText.includes("definitely-missing-sing-box")) {
    throw new Error(`engine failure was not exposed in status: ${engineText}`);
  }
  await stop(second.child);
  console.log("engine rollback smoke ok");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
