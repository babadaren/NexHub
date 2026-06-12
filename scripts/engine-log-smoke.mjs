import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-engine-log-"));
const port = 19094;

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
    JWT_SECRET: "engine-log-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "engine-log-smoke-encryption-key",
    ENGINE_MODE: "managed",
    ENGINE_BINARY: "definitely-missing-sing-box",
    LOG_OUTPUT_TO_FILE: "true",
    LOG_ROTATION_MAX_SIZE_MB: "1"
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
  await request("/api/remote-nodes", {
    method: "POST",
    headers: { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Engine-Log-Fail",
      protocol: "vless",
      enabled: true,
      config: { server: "engine-log.example.com", port: 443, uuid: "10101010-1010-4010-9010-101010101010", tls: true }
    })
  });

  const logText = await readFile(path.join(dataDir, "logs", "engine.log"), "utf8");
  if (!logText.includes("definitely-missing-sing-box check -c") || !logText.includes("\"stream\":\"stderr\"")) {
    throw new Error(`engine log missing command or stderr entry:\n${logText}`);
  }
  console.log("engine log smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
