import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-engine-smoke-"));
const port = 19082;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  } catch (error) {
    return { ok: false, status: 0, body: error instanceof Error ? error.message : "fetch failed" };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }
  return { ok: true, status: response.status, body: await response.json() };
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
    JWT_SECRET: "engine-smoke-secret",
    ENGINE_MODE: "managed",
    ENGINE_BINARY: "definitely-missing-sing-box"
  }
});

let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk.toString()));
child.stderr.on("data", (chunk) => (logs += chunk.toString()));

try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const health = await request("/health");
    if (health.ok) break;
    await wait(250);
  }

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin12345" })
  });
  if (!login.ok) throw new Error(`login failed: ${login.body}\n${logs}`);
  const token = login.body.token;

  const created = await request("/api/remote-nodes", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Engine-Fail",
      protocol: "vless",
      enabled: true,
      config: { server: "engine.example.com", port: 443 }
    })
  });
  if (!created.ok) throw new Error(`create failed: ${created.body}`);

  const status = await request("/api/system/status", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!status.ok) throw new Error(`status failed: ${status.body}`);
  const lastError = JSON.stringify(status.body.engine ?? {});
  if (!lastError.includes("definitely-missing-sing-box")) {
    throw new Error(`expected missing binary error in engine status, got ${lastError}`);
  }
  console.log("engine smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}
