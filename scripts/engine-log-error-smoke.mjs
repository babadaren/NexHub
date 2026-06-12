import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-engine-log-error-"));
const port = 19103;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

await writeFile(path.join(dataDir, "logs"), "this file intentionally blocks engine log directory", "utf8");

const child = spawn("node", ["backend/dist/server.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    DATA_DIR: dataDir,
    ADMIN_PASSWORD: "admin12345",
    JWT_SECRET: "engine-log-error-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "engine-log-error-smoke-encryption-key",
    ENGINE_MODE: "managed",
    ENGINE_BINARY: "definitely-missing-sing-box",
    LOG_OUTPUT_TO_FILE: "true"
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
  }).catch(async () => {
    throw new Error(`login failed; logs=${logs}`);
  });
  const auth = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };
  const authNoBody = { Authorization: `Bearer ${login.token}` };

  const created = await request("/api/remote-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Engine-Log-Write-Fail",
      protocol: "vless",
      enabled: true,
      config: { server: "engine-log-error.example.com", port: 443, uuid: "15151515-1515-4515-8515-151515151515", tls: true }
    })
  });
  if (!created.id) {
    throw new Error(`node create did not return a node: ${JSON.stringify(created)}`);
  }

  const status = await request("/api/system/status", { headers: authNoBody });
  const runtime = status.engine?.runtime ?? {};
  if (!String(runtime.lastError ?? "").includes("definitely-missing-sing-box")) {
    throw new Error(`engine runtime did not expose command failure: ${JSON.stringify(runtime)}`);
  }
  if (!runtime.lastLogError || !String(runtime.lastLogError).match(/ENOTDIR|not a directory|mkdir/i)) {
    throw new Error(`engine runtime did not expose log write failure: ${JSON.stringify(runtime)}`);
  }
  if (!runtime.lastLogErrorAt) {
    throw new Error(`engine runtime did not expose log write failure timestamp: ${JSON.stringify(runtime)}`);
  }

  console.log("engine log error smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
