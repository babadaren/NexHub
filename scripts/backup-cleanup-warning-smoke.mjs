import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-backup-cleanup-"));
const backupDir = path.join(dataDir, "backups");
const staleBackupDir = path.join(backupDir, "backup-2000-01-01T00-00-00.000Z.json");
const port = 19104;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

await mkdir(staleBackupDir, { recursive: true });
const staleDate = new Date("2000-01-01T00:00:00.000Z");
await utimes(staleBackupDir, staleDate, staleDate);

const child = spawn("node", ["backend/dist/server.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    DATA_DIR: dataDir,
    ADMIN_PASSWORD: "admin12345",
    JWT_SECRET: "backup-cleanup-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "backup-cleanup-smoke-encryption-key",
    BACKUP_RETENTION_DAYS: "0"
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

  const backup = await request("/api/system/backup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ reason: "backup-cleanup-warning-smoke" })
  });
  if (!backup.file?.endsWith(".json") || !backup.cleanupWarning || !backup.message.includes("旧备份清理失败")) {
    throw new Error(`backup did not return cleanup warning while preserving success: ${JSON.stringify(backup)}`);
  }

  const state = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
  const job = state.backupJobs?.find((item) => String(item.filePath ?? "").endsWith(backup.file));
  if (!job || job.status !== "warning" || !String(job.message ?? "").includes("旧备份清理失败")) {
    throw new Error(`backup cleanup warning job was not persisted: ${JSON.stringify(state.backupJobs)}`);
  }

  const listed = await request("/api/system/backups", { headers: { Authorization: `Bearer ${login.token}` } });
  if (!listed.some((item) => item.file === backup.file)) {
    throw new Error(`new backup missing from backup list after cleanup warning: ${JSON.stringify(listed)}`);
  }

  console.log("backup cleanup warning smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
