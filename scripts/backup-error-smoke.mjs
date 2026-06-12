import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-backup-error-"));
const blockedBackupPath = path.join(dataDir, "not-a-directory");
const port = 19102;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

await writeFile(blockedBackupPath, "this file intentionally blocks BACKUP_DIR", "utf8");

const child = spawn("node", ["backend/dist/server.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    DATA_DIR: dataDir,
    BACKUP_DIR: blockedBackupPath,
    ADMIN_PASSWORD: "admin12345",
    JWT_SECRET: "backup-error-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "backup-error-smoke-encryption-key"
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
  const authNoBody = { Authorization: `Bearer ${login.token}` };
  const auth = { ...authNoBody, "Content-Type": "application/json" };

  const listResponse = await fetch(`http://127.0.0.1:${port}/api/system/backups`, { headers: authNoBody });
  if (listResponse.status !== 400) throw new Error(`backup list returned ${listResponse.status}`);
  const listError = await listResponse.json();
  if (listError.code !== "BACKUP_DIR_UNAVAILABLE" || !String(listError.suggestion ?? "").includes("BACKUP_DIR")) {
    throw new Error(`backup list did not return structured directory guidance: ${JSON.stringify(listError)}`);
  }

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/system/backup`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ reason: "backup-error-smoke" })
  });
  if (createResponse.status !== 400) throw new Error(`backup create returned ${createResponse.status}`);
  const createError = await createResponse.json();
  if (createError.code !== "BACKUP_DIR_UNAVAILABLE" || !String(createError.suggestion ?? "").includes(blockedBackupPath)) {
    throw new Error(`backup create did not return structured directory guidance: ${JSON.stringify(createError)}`);
  }

  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/system/status`, { headers: authNoBody });
  if (!statusResponse.ok) throw new Error(`system status should remain available when backup dir is broken: ${statusResponse.status} ${await statusResponse.text()}`);
  const status = await statusResponse.json();
  if (status.ready || status.status !== "degraded" || status.checks?.backups?.status !== "error") {
    throw new Error(`system status did not degrade on backup directory failure: ${JSON.stringify(status)}`);
  }
  if (status.backups?.error?.code !== "BACKUP_DIR_UNAVAILABLE" || !String(status.backups.error.suggestion ?? "").includes("BACKUP_DIR")) {
    throw new Error(`system status did not expose backup directory guidance: ${JSON.stringify(status.backups)}`);
  }

  console.log("backup error smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
