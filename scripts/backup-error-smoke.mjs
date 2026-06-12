import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

async function requestAt(targetPort, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${targetPort}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} at ${targetPort} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

async function waitForHealth(targetPort, logs) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/health`);
      if (response.ok) return;
    } catch {
      await wait(250);
    }
  }
  throw new Error(`backend ${targetPort} did not start:\n${logs()}`);
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
  await waitForHealth(port, () => logs);

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
  const failedBackupState = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
  const failedBackupJob = failedBackupState.backupJobs?.find((job) => job.jobType === "backup" && job.status === "failed");
  if (!failedBackupJob || !String(failedBackupJob.message ?? "").includes("BACKUP_DIR_UNAVAILABLE")) {
    throw new Error(`failed backup job was not persisted: ${JSON.stringify(failedBackupState.backupJobs)}`);
  }
  const failedBackupEvents = await request("/api/dashboard/events", { headers: authNoBody });
  const failedBackupAudit = failedBackupEvents.find((event) => event.action === "system.backup.failed");
  if (!failedBackupAudit || failedBackupAudit.metadata?.code !== "BACKUP_DIR_UNAVAILABLE") {
    throw new Error(`failed backup audit was not persisted: ${JSON.stringify(failedBackupEvents)}`);
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

  const { writeBackupFileAtomically } = await import("../backend/dist/backup.js");
  const atomicBackupDir = await mkdtemp(path.join(tmpdir(), "pcc-backup-atomic-"));
  const atomicTarget = path.join(atomicBackupDir, "backup-2099-02-01T00-00-00.000Z.json");
  try {
    await writeBackupFileAtomically(atomicTarget, "{\"incomplete\":", {
      writeFile: async (file, content) => {
        await writeFile(file, content.slice(0, 6), "utf8");
        throw new Error("simulated partial backup write failure");
      },
      rename: async () => {
        throw new Error("rename should not run after failed write");
      },
      unlink: async (file) => {
        await rm(file, { force: true });
      }
    }).then(
      () => {
        throw new Error("atomic backup write unexpectedly succeeded");
      },
      () => undefined
    );
    try {
      await stat(atomicTarget);
      throw new Error("partial backup target remained after failed atomic write");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const leftovers = await readdir(atomicBackupDir);
    if (leftovers.some((file) => file.includes(".tmp-"))) {
      throw new Error(`atomic backup temp file was not cleaned up: ${JSON.stringify(leftovers)}`);
    }
  } finally {
    await rm(atomicBackupDir, { recursive: true, force: true });
  }

  const invalidRestoreDir = await mkdtemp(path.join(tmpdir(), "pcc-backup-invalid-"));
  const invalidRestorePort = 19112;
  const invalidBackupDir = path.join(invalidRestoreDir, "backups");
  await mkdir(invalidBackupDir, { recursive: true });
  const invalidBackupFile = "backup-2099-01-01T00-00-00.000Z.json";
  await writeFile(
    path.join(invalidBackupDir, invalidBackupFile),
    JSON.stringify(
      {
        manifest: {
          version: "0.1.0",
          createdAt: "2099-01-01T00:00:00.000Z",
          storageDriver: "json",
          engineProvider: "sing-box",
          containsSecrets: true,
          encryptionKeyFingerprint: "sha256:cf14010a4f37a977",
          state: {
            admins: 0,
            nodes: 0,
            nodeConfigVersions: 0,
            tests: 0,
            auditLogs: 0,
            subscriptions: 0,
            trafficSummaries: 0,
            shareTokens: 0,
            backupJobs: 0
          },
          files: ["state"]
        },
        state: {
          admins: [],
          nodes: [],
          tests: [],
          auditLogs: [],
          subscriptions: [],
          settings: {}
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const invalidChild = spawn("node", ["backend/dist/server.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(invalidRestorePort),
      DATA_DIR: invalidRestoreDir,
      BACKUP_DIR: invalidBackupDir,
      ADMIN_PASSWORD: "admin12345",
      JWT_SECRET: "backup-invalid-smoke-secret",
      CONFIG_ENCRYPTION_KEY: "backup-error-smoke-encryption-key"
    }
  });
  let invalidLogs = "";
  invalidChild.stdout.on("data", (chunk) => (invalidLogs += chunk.toString()));
  invalidChild.stderr.on("data", (chunk) => (invalidLogs += chunk.toString()));
  try {
    await waitForHealth(invalidRestorePort, () => invalidLogs);
    const invalidLogin = await fetch(`http://127.0.0.1:${invalidRestorePort}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin12345" })
    }).then((response) => {
      if (!response.ok) throw new Error(`invalid restore login failed: ${response.status}`);
      return response.json();
    }).catch(async (error) => {
      throw new Error(`${error.message}; logs=${invalidLogs}`);
    });
    const invalidRestoreResponse = await fetch(`http://127.0.0.1:${invalidRestorePort}/api/system/backups/${encodeURIComponent(invalidBackupFile)}/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${invalidLogin.token}` }
    });
    if (invalidRestoreResponse.status !== 400) throw new Error(`invalid backup restore returned ${invalidRestoreResponse.status}: ${await invalidRestoreResponse.text()}`);
    const invalidRestoreError = await invalidRestoreResponse.json();
    if (invalidRestoreError.code !== "BACKUP_STATE_INVALID" || !String(invalidRestoreError.suggestion ?? "").includes("完整备份")) {
      throw new Error(`invalid backup restore did not return structured state guidance: ${JSON.stringify(invalidRestoreError)}`);
    }
    const failedRestoreState = JSON.parse(await readFile(path.join(invalidRestoreDir, "state.json"), "utf8"));
    const failedRestoreJob = failedRestoreState.backupJobs?.find((job) => job.jobType === "restore" && job.status === "failed");
    if (!failedRestoreJob || !String(failedRestoreJob.message ?? "").includes("BACKUP_STATE_INVALID")) {
      throw new Error(`failed restore job was not persisted: ${JSON.stringify(failedRestoreState.backupJobs)}`);
    }
    const failedRestoreEvents = await fetch(`http://127.0.0.1:${invalidRestorePort}/api/dashboard/events`, {
      headers: { Authorization: `Bearer ${invalidLogin.token}` }
    }).then((response) => {
      if (!response.ok) throw new Error(`failed restore events returned ${response.status}`);
      return response.json();
    });
    const failedRestoreAudit = failedRestoreEvents.find((event) => event.action === "system.backup.restore.failed");
    if (!failedRestoreAudit || failedRestoreAudit.metadata?.code !== "BACKUP_STATE_INVALID") {
      throw new Error(`failed restore audit was not persisted: ${JSON.stringify(failedRestoreEvents)}`);
    }
  } finally {
    invalidChild.kill();
    await rm(invalidRestoreDir, { recursive: true, force: true });
  }

  const keyMismatchDir = await mkdtemp(path.join(tmpdir(), "pcc-backup-key-mismatch-"));
  const keyMismatchPort = 19116;
  const keyMismatchBackupDir = path.join(keyMismatchDir, "backups");
  await mkdir(keyMismatchBackupDir, { recursive: true });
  const keyMismatchFile = "backup-2099-01-02T00-00-00.000Z.json";
  await writeFile(
    path.join(keyMismatchBackupDir, keyMismatchFile),
    JSON.stringify(
      {
        manifest: {
          version: "0.1.0",
          createdAt: "2099-01-02T00:00:00.000Z",
          storageDriver: "json",
          engineProvider: "sing-box",
          containsSecrets: true,
          encryptionKeyFingerprint: "sha256:not-current-key",
          state: {
            admins: 0,
            nodes: 0,
            nodeConfigVersions: 0,
            tests: 0,
            auditLogs: 0,
            subscriptions: 0,
            trafficSummaries: 0,
            shareTokens: 0,
            backupJobs: 0
          },
          files: ["state"]
        },
        state: {}
      },
      null,
      2
    ),
    "utf8"
  );
  const keyMismatchChild = spawn("node", ["backend/dist/server.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(keyMismatchPort),
      DATA_DIR: keyMismatchDir,
      BACKUP_DIR: keyMismatchBackupDir,
      ADMIN_PASSWORD: "admin12345",
      JWT_SECRET: "backup-key-mismatch-smoke-secret",
      CONFIG_ENCRYPTION_KEY: "backup-error-smoke-encryption-key"
    }
  });
  let keyMismatchLogs = "";
  keyMismatchChild.stdout.on("data", (chunk) => (keyMismatchLogs += chunk.toString()));
  keyMismatchChild.stderr.on("data", (chunk) => (keyMismatchLogs += chunk.toString()));
  try {
    await waitForHealth(keyMismatchPort, () => keyMismatchLogs);
    const keyMismatchLogin = await requestAt(keyMismatchPort, "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin12345" })
    });
    const keyMismatchAuth = { Authorization: `Bearer ${keyMismatchLogin.token}`, "Content-Type": "application/json" };
    const keyMismatchAuthNoBody = { Authorization: `Bearer ${keyMismatchLogin.token}` };
    const nodeThatMustRemain = await requestAt(keyMismatchPort, "/api/local-nodes", {
      method: "POST",
      headers: keyMismatchAuth,
      body: JSON.stringify({
        name: "Key-Mismatch-Should-Remain",
        protocol: "http",
        config: {
          listenHost: "0.0.0.0",
          listenPort: 20084,
          exposure: "lan"
        }
      })
    });
    const backupFilesBefore = await readdir(keyMismatchBackupDir);
    const keyMismatchRestore = await fetch(`http://127.0.0.1:${keyMismatchPort}/api/system/backups/${encodeURIComponent(keyMismatchFile)}/restore`, {
      method: "POST",
      headers: keyMismatchAuthNoBody
    });
    if (keyMismatchRestore.status !== 400) {
      throw new Error(`key mismatch restore returned ${keyMismatchRestore.status}: ${await keyMismatchRestore.text()}`);
    }
    const keyMismatchError = await keyMismatchRestore.json();
    if (keyMismatchError.code !== "BACKUP_KEY_MISMATCH" || !String(keyMismatchError.suggestion ?? "").includes("CONFIG_ENCRYPTION_KEY")) {
      throw new Error(`key mismatch restore did not return structured key guidance: ${JSON.stringify(keyMismatchError)}`);
    }
    const nodesAfterKeyMismatch = await requestAt(keyMismatchPort, "/api/local-nodes", { headers: keyMismatchAuthNoBody });
    if (!nodesAfterKeyMismatch.some((node) => node.id === nodeThatMustRemain.id)) {
      throw new Error(`key mismatch restore changed current state: ${JSON.stringify(nodesAfterKeyMismatch)}`);
    }
    const backupFilesAfter = await readdir(keyMismatchBackupDir);
    const unexpectedPreRestoreBackups = backupFilesAfter.filter((file) => file.startsWith("backup-") && file.endsWith(".json") && !backupFilesBefore.includes(file));
    if (unexpectedPreRestoreBackups.length > 0) {
      throw new Error(`key mismatch restore created pre-restore backup before key validation: ${JSON.stringify(unexpectedPreRestoreBackups)}`);
    }
    const keyMismatchState = JSON.parse(await readFile(path.join(keyMismatchDir, "state.json"), "utf8"));
    const keyMismatchFailedJob = keyMismatchState.backupJobs?.find((job) => job.jobType === "restore" && job.status === "failed" && String(job.message ?? "").includes("BACKUP_KEY_MISMATCH"));
    if (!keyMismatchFailedJob) {
      throw new Error(`key mismatch failed restore job was not persisted: ${JSON.stringify(keyMismatchState.backupJobs)}`);
    }
    const keyMismatchEvents = await requestAt(keyMismatchPort, "/api/dashboard/events", { headers: keyMismatchAuthNoBody });
    const keyMismatchAudit = keyMismatchEvents.find((event) => event.action === "system.backup.restore.failed" && event.metadata?.code === "BACKUP_KEY_MISMATCH");
    if (!keyMismatchAudit) {
      throw new Error(`key mismatch failure audit was not persisted: ${JSON.stringify(keyMismatchEvents)}`);
    }
  } finally {
    keyMismatchChild.kill();
    await rm(keyMismatchDir, { recursive: true, force: true });
  }

  const preRestoreDir = await mkdtemp(path.join(tmpdir(), "pcc-backup-pre-restore-"));
  const preRestorePort = 19113;
  const preRestoreBackupDir = path.join(preRestoreDir, "backups");
  const preRestoreChild = spawn("node", ["backend/dist/server.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(preRestorePort),
      DATA_DIR: preRestoreDir,
      BACKUP_DIR: preRestoreBackupDir,
      ADMIN_PASSWORD: "admin12345",
      JWT_SECRET: "backup-pre-restore-smoke-secret",
      CONFIG_ENCRYPTION_KEY: "backup-error-smoke-encryption-key",
      TEST_BACKUP_FAIL_PRE_RESTORE: "true"
    }
  });
  let preRestoreLogs = "";
  preRestoreChild.stdout.on("data", (chunk) => (preRestoreLogs += chunk.toString()));
  preRestoreChild.stderr.on("data", (chunk) => (preRestoreLogs += chunk.toString()));
  try {
    await waitForHealth(preRestorePort, () => preRestoreLogs);
    const preRestoreLogin = await requestAt(preRestorePort, "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin12345" })
    });
    const preRestoreAuth = { Authorization: `Bearer ${preRestoreLogin.token}`, "Content-Type": "application/json" };
    const preRestoreAuthNoBody = { Authorization: `Bearer ${preRestoreLogin.token}` };
    const baselineBackup = await requestAt(preRestorePort, "/api/system/backup", {
      method: "POST",
      headers: preRestoreAuth,
      body: JSON.stringify({ reason: "pre-restore-failure-baseline" })
    });
    const createdNode = await requestAt(preRestorePort, "/api/local-nodes", {
      method: "POST",
      headers: preRestoreAuth,
      body: JSON.stringify({
        name: "Pre-Restore-Should-Remain",
        protocol: "http",
        config: {
          listenHost: "0.0.0.0",
          listenPort: 20081,
          exposure: "lan"
        }
      })
    });
    const preRestoreFailure = await fetch(`http://127.0.0.1:${preRestorePort}/api/system/backups/${encodeURIComponent(baselineBackup.file)}/restore`, {
      method: "POST",
      headers: preRestoreAuthNoBody
    });
    if (preRestoreFailure.status !== 400) {
      throw new Error(`pre-restore backup failure returned ${preRestoreFailure.status}: ${await preRestoreFailure.text()}`);
    }
    const preRestoreError = await preRestoreFailure.json();
    if (preRestoreError.code !== "BACKUP_PRE_RESTORE_FAILED" || !String(preRestoreError.suggestion ?? "").includes("尚未被恢复覆盖")) {
      throw new Error(`pre-restore failure did not return structured guidance: ${JSON.stringify(preRestoreError)}`);
    }
    const nodesAfterFailedRestore = await requestAt(preRestorePort, "/api/local-nodes", { headers: preRestoreAuthNoBody });
    if (!nodesAfterFailedRestore.some((node) => node.id === createdNode.id)) {
      throw new Error(`failed pre-restore backup changed current state: ${JSON.stringify(nodesAfterFailedRestore)}`);
    }
    const preRestoreState = JSON.parse(await readFile(path.join(preRestoreDir, "state.json"), "utf8"));
    const preRestoreFailedJob = preRestoreState.backupJobs?.find((job) => job.jobType === "restore" && job.status === "failed" && String(job.message ?? "").includes("BACKUP_PRE_RESTORE_FAILED"));
    if (!preRestoreFailedJob || preRestoreFailedJob.manifest?.cause?.code !== "BACKUP_WRITE_FAILED") {
      throw new Error(`pre-restore failed restore job was not persisted: ${JSON.stringify(preRestoreState.backupJobs)}`);
    }
    const preRestoreEvents = await requestAt(preRestorePort, "/api/dashboard/events", { headers: preRestoreAuthNoBody });
    const preRestoreAudit = preRestoreEvents.find((event) => event.action === "system.backup.restore.failed" && event.metadata?.code === "BACKUP_PRE_RESTORE_FAILED");
    if (!preRestoreAudit) {
      throw new Error(`pre-restore failure audit was not persisted: ${JSON.stringify(preRestoreEvents)}`);
    }
  } finally {
    preRestoreChild.kill();
    await rm(preRestoreDir, { recursive: true, force: true });
  }

  const restorePersistDir = await mkdtemp(path.join(tmpdir(), "pcc-backup-restore-persist-"));
  const restorePersistPort = 19115;
  const restorePersistChild = spawn("node", ["backend/dist/server.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(restorePersistPort),
      DATA_DIR: restorePersistDir,
      BACKUP_DIR: path.join(restorePersistDir, "backups"),
      ADMIN_PASSWORD: "admin12345",
      JWT_SECRET: "backup-restore-persist-smoke-secret",
      CONFIG_ENCRYPTION_KEY: "backup-error-smoke-encryption-key",
      TEST_BACKUP_FAIL_RESTORE_PERSIST: "true"
    }
  });
  let restorePersistLogs = "";
  restorePersistChild.stdout.on("data", (chunk) => (restorePersistLogs += chunk.toString()));
  restorePersistChild.stderr.on("data", (chunk) => (restorePersistLogs += chunk.toString()));
  try {
    await waitForHealth(restorePersistPort, () => restorePersistLogs);
    const restorePersistLogin = await requestAt(restorePersistPort, "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin12345" })
    });
    const restorePersistAuth = { Authorization: `Bearer ${restorePersistLogin.token}`, "Content-Type": "application/json" };
    const restorePersistAuthNoBody = { Authorization: `Bearer ${restorePersistLogin.token}` };
    const baselineBackup = await requestAt(restorePersistPort, "/api/system/backup", {
      method: "POST",
      headers: restorePersistAuth,
      body: JSON.stringify({ reason: "restore-persist-failure-baseline" })
    });
    const nodeThatMustRemain = await requestAt(restorePersistPort, "/api/local-nodes", {
      method: "POST",
      headers: restorePersistAuth,
      body: JSON.stringify({
        name: "Restore-Persist-Should-Remain",
        protocol: "http",
        config: {
          listenHost: "0.0.0.0",
          listenPort: 20083,
          exposure: "lan"
        }
      })
    });
    const restorePersistFailure = await fetch(`http://127.0.0.1:${restorePersistPort}/api/system/backups/${encodeURIComponent(baselineBackup.file)}/restore`, {
      method: "POST",
      headers: restorePersistAuthNoBody
    });
    if (restorePersistFailure.status !== 400) {
      throw new Error(`restore persist failure returned ${restorePersistFailure.status}: ${await restorePersistFailure.text()}`);
    }
    const restorePersistError = await restorePersistFailure.json();
    if (restorePersistError.code !== "BACKUP_RESTORE_WRITE_FAILED" || !String(restorePersistError.suggestion ?? "").includes("尚未被恢复覆盖")) {
      throw new Error(`restore persist failure did not return structured guidance: ${JSON.stringify(restorePersistError)}`);
    }
    const nodesAfterPersistFailure = await requestAt(restorePersistPort, "/api/local-nodes", { headers: restorePersistAuthNoBody });
    if (!nodesAfterPersistFailure.some((node) => node.id === nodeThatMustRemain.id)) {
      throw new Error(`restore persist failure changed current state: ${JSON.stringify(nodesAfterPersistFailure)}`);
    }
    const restorePersistState = JSON.parse(await readFile(path.join(restorePersistDir, "state.json"), "utf8"));
    const restorePersistFailedJob = restorePersistState.backupJobs?.find((job) => job.jobType === "restore" && job.status === "failed" && String(job.message ?? "").includes("BACKUP_RESTORE_WRITE_FAILED"));
    if (!restorePersistFailedJob || restorePersistFailedJob.manifest?.cause?.code !== "RESTORE_PERSIST_FAILED") {
      throw new Error(`restore persist failed restore job was not persisted: ${JSON.stringify(restorePersistState.backupJobs)}`);
    }
    const restorePersistEvents = await requestAt(restorePersistPort, "/api/dashboard/events", { headers: restorePersistAuthNoBody });
    const restorePersistAudit = restorePersistEvents.find((event) => event.action === "system.backup.restore.failed" && event.metadata?.code === "BACKUP_RESTORE_WRITE_FAILED");
    if (!restorePersistAudit) {
      throw new Error(`restore persist failure audit was not persisted: ${JSON.stringify(restorePersistEvents)}`);
    }
  } finally {
    restorePersistChild.kill();
    await rm(restorePersistDir, { recursive: true, force: true });
  }

  const auditWarningDir = await mkdtemp(path.join(tmpdir(), "pcc-backup-audit-warning-"));
  const auditWarningPort = 19114;
  const auditWarningChild = spawn("node", ["backend/dist/server.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(auditWarningPort),
      DATA_DIR: auditWarningDir,
      BACKUP_DIR: path.join(auditWarningDir, "backups"),
      ADMIN_PASSWORD: "admin12345",
      JWT_SECRET: "backup-audit-warning-smoke-secret",
      CONFIG_ENCRYPTION_KEY: "backup-error-smoke-encryption-key",
      TEST_FAIL_RESTORE_SUCCESS_AUDIT: "true"
    }
  });
  let auditWarningLogs = "";
  auditWarningChild.stdout.on("data", (chunk) => (auditWarningLogs += chunk.toString()));
  auditWarningChild.stderr.on("data", (chunk) => (auditWarningLogs += chunk.toString()));
  try {
    await waitForHealth(auditWarningPort, () => auditWarningLogs);
    const auditWarningLogin = await requestAt(auditWarningPort, "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin12345" })
    });
    const auditWarningAuth = { Authorization: `Bearer ${auditWarningLogin.token}`, "Content-Type": "application/json" };
    const auditWarningAuthNoBody = { Authorization: `Bearer ${auditWarningLogin.token}` };
    const baselineBackup = await requestAt(auditWarningPort, "/api/system/backup", {
      method: "POST",
      headers: auditWarningAuth,
      body: JSON.stringify({ reason: "restore-audit-warning-baseline" })
    });
    const nodeToRestoreAway = await requestAt(auditWarningPort, "/api/local-nodes", {
      method: "POST",
      headers: auditWarningAuth,
      body: JSON.stringify({
        name: "Audit-Warning-Should-Disappear",
        protocol: "http",
        config: {
          listenHost: "0.0.0.0",
          listenPort: 20082,
          exposure: "lan"
        }
      })
    });
    const restoreWithAuditWarning = await requestAt(auditWarningPort, `/api/system/backups/${encodeURIComponent(baselineBackup.file)}/restore`, {
      method: "POST",
      headers: auditWarningAuthNoBody
    });
    if (restoreWithAuditWarning.file !== baselineBackup.file || restoreWithAuditWarning.auditWarning?.code !== "RESTORE_AUDIT_WRITE_FAILED") {
      throw new Error(`restore audit warning response invalid: ${JSON.stringify(restoreWithAuditWarning)}`);
    }
    const nodesAfterWarningRestore = await requestAt(auditWarningPort, "/api/local-nodes", { headers: auditWarningAuthNoBody });
    if (nodesAfterWarningRestore.some((node) => node.id === nodeToRestoreAway.id)) {
      throw new Error(`restore with audit warning did not apply restored state: ${JSON.stringify(nodesAfterWarningRestore)}`);
    }
    const auditWarningState = JSON.parse(await readFile(path.join(auditWarningDir, "state.json"), "utf8"));
    if (!auditWarningState.backupJobs?.some((job) => job.jobType === "restore" && job.status === "passed" && String(job.message ?? "").includes(baselineBackup.file))) {
      throw new Error(`restore passed job missing after audit warning: ${JSON.stringify(auditWarningState.backupJobs)}`);
    }
  } finally {
    auditWarningChild.kill();
    await rm(auditWarningDir, { recursive: true, force: true });
  }

  console.log("backup error smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
