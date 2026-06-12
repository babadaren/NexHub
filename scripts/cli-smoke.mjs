import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-cli-"));

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["backend/dist/cli.js", ...args], {
      cwd: root,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        ADMIN_PASSWORD: "admin12345",
        JWT_SECRET: "cli-smoke-secret",
        CONFIG_ENCRYPTION_KEY: "cli-smoke-encryption-key",
        NETWORK_MODE: "bridge",
        ...extraEnv
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code) reject(new Error(`cli exited ${code}: ${stderr || stdout}`));
      else resolve(stdout);
    });
  });
}

function runExpectFailure(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["backend/dist/cli.js", ...args], {
      cwd: root,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        ADMIN_PASSWORD: "admin12345",
        JWT_SECRET: "cli-smoke-secret",
        CONFIG_ENCRYPTION_KEY: "cli-smoke-encryption-key",
        NETWORK_MODE: "bridge",
        ...extraEnv
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code) resolve({ code, stdout, stderr });
      else reject(new Error(`cli unexpectedly succeeded: ${stdout}`));
    });
  });
}

try {
  const created = JSON.parse(await run(["backup", "create", "--reason", "cli-smoke"]));
  if (!created.ok || !created.file?.endsWith(".json")) throw new Error("backup create did not return expected payload");
  const listed = JSON.parse(await run(["backup", "list"]));
  if (!Array.isArray(listed) || !listed.some((item) => item.file === created.file)) throw new Error("backup list did not include created backup");
  const status = JSON.parse(await run(["system", "status"]));
  if (!status.ready || status.storage.driver !== "json" || status.counts.backups < 1 || status.counts.nodes !== 0) {
    throw new Error(`system status did not include expected deployment state: ${JSON.stringify(status)}`);
  }
  if (status.deployment.mode !== "development" || status.deployment.releaseMode !== false || status.deployment.app !== "ok" || status.deployment.engine !== "ok") {
    throw new Error(`system status did not include expected server mode: ${JSON.stringify(status.deployment)}`);
  }
  if (status.deployment.networkMode !== "bridge" || status.deployment.advancedNetwork !== false) {
    throw new Error(`system status did not include expected network mode: ${JSON.stringify(status.deployment)}`);
  }
  const hostNetworkStatus = JSON.parse(await run(["system", "status"], { NETWORK_MODE: "host" }));
  if (hostNetworkStatus.deployment.networkMode !== "host" || hostNetworkStatus.deployment.advancedNetwork !== true) {
    throw new Error(`system status did not expose host network mode: ${JSON.stringify(hostNetworkStatus.deployment)}`);
  }
  const staleBackupDir = path.join(dataDir, "backups", "backup-2000-01-01T00-00-00.000Z.json");
  await mkdir(staleBackupDir, { recursive: true });
  const staleDate = new Date("2000-01-01T00:00:00.000Z");
  await utimes(staleBackupDir, staleDate, staleDate);
  const warningCreated = JSON.parse(await run(["backup", "create", "--reason", "cli-cleanup-warning"], { BACKUP_RETENTION_DAYS: "1" }));
  if (!warningCreated.ok || !warningCreated.file?.endsWith(".json") || !warningCreated.message || !warningCreated.cleanupWarning) {
    throw new Error(`cli backup create did not expose cleanup warning: ${JSON.stringify(warningCreated)}`);
  }
  const blockedBackupPath = path.join(dataDir, "blocked-backup-dir");
  await writeFile(blockedBackupPath, "not a directory", "utf8");
  const failedCreate = await runExpectFailure(["backup", "create", "--reason", "cli-backup-error"], { BACKUP_DIR: blockedBackupPath });
  const errorPayload = JSON.parse(failedCreate.stderr);
  if (errorPayload.ok !== false || errorPayload.code !== "BACKUP_DIR_UNAVAILABLE" || !String(errorPayload.suggestion ?? "").includes("BACKUP_DIR")) {
    throw new Error(`cli backup error was not structured: ${failedCreate.stderr}`);
  }
  const degradedStatus = JSON.parse(await run(["system", "status"], { BACKUP_DIR: blockedBackupPath }));
  if (degradedStatus.ready || degradedStatus.status !== "degraded" || degradedStatus.backups?.error?.code !== "BACKUP_DIR_UNAVAILABLE") {
    throw new Error(`cli system status did not degrade with structured backup error: ${JSON.stringify(degradedStatus)}`);
  }
  console.log("cli smoke ok");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
