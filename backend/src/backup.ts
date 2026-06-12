import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { encryptionKeyFingerprint } from "./secrets.js";
import { protectState, store, unprotectState } from "./storage.js";
import type { AppState } from "./types.js";

export interface BackupManifest {
  version: string;
  createdAt: string;
  storageDriver: string;
  engineProvider: string;
  containsSecrets: boolean;
  encryptionKeyFingerprint: string;
  state: {
    admins: number;
    nodes: number;
    nodeConfigVersions: number;
    tests: number;
    auditLogs: number;
    subscriptions: number;
    trafficSummaries: number;
    shareTokens: number;
    backupJobs: number;
  };
  files: string[];
}

export interface BackupSummary {
  file: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  containsSecrets: boolean;
  manifest: BackupManifest;
  cleanupWarning?: string;
}

export class BackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly suggestion: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "BackupError";
  }
}

interface BackupPayload {
  manifest: BackupManifest;
  reason?: string;
  state: AppState;
  engine?: {
    current?: unknown;
  };
}

interface AtomicWriteOperations {
  writeFile(file: string, data: string, encoding: BufferEncoding): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

const backupDir = () => config.backupDir ?? path.join(config.dataDir, "backups");
const defaultAtomicWriteOperations: AtomicWriteOperations = {
  writeFile: (file, data, encoding) => writeFile(file, data, encoding),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  unlink: (file) => unlink(file)
};

export async function createBackup(reason = "manual"): Promise<BackupSummary & { message: string }> {
  const timestamp = new Date().toISOString();
  const filename = `backup-${timestamp.replaceAll(":", "-")}.json`;
  const fullPath = path.join(backupDir(), filename);
  try {
    await ensureBackupDir();
  } catch (error) {
    if (error instanceof BackupError) await recordFailedBackupJob("backup", error, fullPath, { reason });
    throw error;
  }
  const snapshot = store.snapshot();
  const protectedSnapshot = protectState(snapshot);
  const engineConfig = await readOptionalJson(path.join(config.dataDir, "engine", "current.json"));
  const manifest: BackupManifest = {
    version: config.version,
    createdAt: timestamp,
    storageDriver: store.driver,
    engineProvider: config.engineProvider,
    containsSecrets: true,
    encryptionKeyFingerprint: encryptionKeyFingerprint(),
    state: {
      admins: snapshot.admins.length,
      nodes: snapshot.nodes.length,
      nodeConfigVersions: snapshot.nodeConfigVersions.length,
      tests: snapshot.tests.length,
      auditLogs: snapshot.auditLogs.length,
      subscriptions: snapshot.subscriptions.length,
      trafficSummaries: snapshot.trafficSummaries.length,
      shareTokens: snapshot.shareTokens.length,
      backupJobs: snapshot.backupJobs.length
    },
    files: engineConfig ? ["state", "engine.current"] : ["state"]
  };

  const payload = {
    manifest,
    reason,
    state: protectedSnapshot,
    engine: {
      current: engineConfig
    }
  };

  try {
    await writeBackupFileAtomically(fullPath, JSON.stringify(payload, null, 2));
  } catch {
    const error = new BackupError("BACKUP_WRITE_FAILED", "备份文件写入失败", backupDirSuggestion());
    await recordFailedBackupJob("backup", error, fullPath, { reason, manifest });
    throw error;
  }
  let cleanupWarning: string | undefined;
  try {
    await cleanupOldBackups();
  } catch (error) {
    cleanupWarning = `旧备份清理失败：${error instanceof Error ? error.message : "unknown error"}`;
  }
  let stats;
  try {
    stats = await stat(fullPath);
  } catch {
    const error = new BackupError("BACKUP_STAT_FAILED", "备份文件创建后无法读取文件信息", backupDirSuggestion());
    await recordFailedBackupJob("backup", error, fullPath, { reason, manifest });
    throw error;
  }
  await store.recordBackupJob({
    jobType: "backup",
    status: cleanupWarning ? "warning" : "passed",
    filePath: fullPath,
    containsSecrets: true,
    message: cleanupWarning ? `backup created: ${filename}; ${cleanupWarning}` : `backup created: ${filename}`,
    manifest: manifest as unknown as Record<string, unknown>,
    createdAt: timestamp,
    finishedAt: timestamp
  });
  return {
    file: filename,
    path: fullPath,
    sizeBytes: stats.size,
    createdAt: timestamp,
    containsSecrets: true,
    manifest,
    cleanupWarning,
    message: cleanupWarning ? `备份已创建：${filename}；但旧备份清理失败，请检查备份目录权限。` : `备份已创建：${filename}`
  };
}

export async function listBackups(): Promise<BackupSummary[]> {
  await ensureBackupDir();
  let files: string[];
  try {
    files = (await readdir(backupDir())).filter((file) => file.startsWith("backup-") && file.endsWith(".json")).sort().reverse();
  } catch {
    throw new BackupError("BACKUP_LIST_FAILED", "备份目录无法读取", backupDirSuggestion());
  }
  const summaries: BackupSummary[] = [];
  for (const file of files) {
    const fullPath = path.join(backupDir(), file);
    try {
      const [stats, raw] = await Promise.all([stat(fullPath), readFile(fullPath, "utf8")]);
      const parsed = JSON.parse(raw) as { manifest?: BackupManifest };
      if (!parsed.manifest) continue;
      summaries.push({
        file,
        path: fullPath,
        sizeBytes: stats.size,
        createdAt: parsed.manifest.createdAt,
        containsSecrets: parsed.manifest.containsSecrets,
        manifest: parsed.manifest
      });
    } catch {
      continue;
    }
  }
  return summaries;
}

export async function restoreBackup(file: string) {
  let safeFile: string;
  try {
    safeFile = normalizeBackupFile(file);
  } catch (error) {
    if (error instanceof BackupError) await recordFailedBackupJob("restore", error, file, { requestedFile: file });
    throw error;
  }
  const fullPath = path.join(backupDir(), safeFile);
  let raw: string;
  try {
    raw = await readFile(fullPath, "utf8");
  } catch {
    const error = new BackupError("BACKUP_NOT_FOUND", "备份文件不存在或不可读取", "请刷新备份列表，确认文件仍在备份目录中。", 404);
    await recordFailedBackupJob("restore", error, fullPath, { requestedFile: safeFile });
    throw error;
  }

  let payload: Partial<BackupPayload>;
  try {
    payload = JSON.parse(raw) as Partial<BackupPayload>;
  } catch {
    const error = new BackupError("BACKUP_INVALID_JSON", "备份文件不是有效 JSON", "请换用系统生成的备份文件，不要手工编辑备份内容。");
    await recordFailedBackupJob("restore", error, fullPath, { requestedFile: safeFile });
    throw error;
  }

  if (!payload.manifest || !payload.state) {
    const error = new BackupError("BACKUP_MANIFEST_MISSING", "备份文件缺少 manifest 或 state", "请换用完整备份文件，或先恢复整目录冷备。");
    await recordFailedBackupJob("restore", error, fullPath, { requestedFile: safeFile });
    throw error;
  }
  if (payload.manifest.encryptionKeyFingerprint !== encryptionKeyFingerprint()) {
    const error = new BackupError("BACKUP_KEY_MISMATCH", "备份加密密钥指纹与当前部署不一致", "请确认 .env 中 CONFIG_ENCRYPTION_KEY 与创建备份时一致，否则无法恢复已加密凭据。");
    await recordFailedBackupJob("restore", error, fullPath, { requestedFile: safeFile, manifest: payload.manifest });
    throw error;
  }
  let restoredState: AppState;
  try {
    restoredState = unprotectState(payload.state as AppState);
    await store.validateRestorableState(restoredState);
  } catch (error) {
    const backupError = new BackupError(
      "BACKUP_STATE_INVALID",
      error instanceof Error ? error.message : "备份状态结构无效",
      "请换用系统生成的完整备份文件；如果是升级后恢复失败，请先确认备份版本、migrations 状态和 CONFIG_ENCRYPTION_KEY。"
    );
    await recordFailedBackupJob("restore", backupError, fullPath, { requestedFile: safeFile, manifest: payload.manifest });
    throw backupError;
  }
  let preRestore: BackupSummary & { message: string };
  try {
    if (config.testBackupFailPreRestore) {
      throw new BackupError("BACKUP_WRITE_FAILED", "模拟恢复前安全备份创建失败", backupDirSuggestion());
    }
    preRestore = await createBackup(`before-restore:${safeFile}`);
  } catch (error) {
    if (error instanceof BackupError) {
      const backupError = new BackupError(
        "BACKUP_PRE_RESTORE_FAILED",
        "恢复前安全备份创建失败，已中止恢复",
        `${error.suggestion} 当前数据尚未被恢复覆盖，请先修复备份目录问题后再重试恢复。`
      );
      await recordFailedBackupJob("restore", backupError, fullPath, {
        requestedFile: safeFile,
        manifest: payload.manifest,
        cause: {
          code: error.code,
          message: error.message,
          suggestion: error.suggestion
        }
      });
      throw backupError;
    }
    throw error;
  }
  try {
    await store.restoreSnapshot(restoredState, safeFile);
  } catch (error) {
    const backupError = new BackupError(
      "BACKUP_RESTORE_WRITE_FAILED",
      "备份恢复写入失败，已中止恢复",
      "当前数据尚未被恢复覆盖。请检查 PostgreSQL 连接、磁盘空间或 data 目录写入权限，修复后再重试恢复。"
    );
    await recordFailedBackupJob("restore", backupError, fullPath, {
      requestedFile: safeFile,
      manifest: payload.manifest,
      cause: {
        code: "RESTORE_PERSIST_FAILED",
        message: error instanceof Error ? error.message : "restore persist failed",
        suggestion: backupError.suggestion
      }
    });
    throw backupError;
  }
  const restoredAt = new Date().toISOString();
  await store.recordBackupJob({
    jobType: "restore",
    status: "passed",
    filePath: fullPath,
    containsSecrets: payload.manifest.containsSecrets,
    message: `restored from backup: ${safeFile}`,
    manifest: payload.manifest as unknown as Record<string, unknown>,
    createdAt: restoredAt,
    finishedAt: restoredAt
  });
  return {
    file: safeFile,
    restoredAt,
    preRestoreFile: preRestore.file,
    manifest: payload.manifest,
    message: `已从备份恢复：${safeFile}`
  };
}

async function readOptionalJson(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function cleanupOldBackups() {
  if (config.backupRetentionDays <= 0) return;
  const cutoff = Date.now() - config.backupRetentionDays * 24 * 60 * 60 * 1000;
  const files = await readdir(backupDir());
  await Promise.all(
    files
      .filter((file) => file.startsWith("backup-") && file.endsWith(".json"))
      .map(async (file) => {
        const fullPath = path.join(backupDir(), file);
        const stats = await stat(fullPath);
        if (stats.mtimeMs < cutoff) await unlink(fullPath);
      })
  );
}

async function ensureBackupDir() {
  try {
    await mkdir(backupDir(), { recursive: true });
  } catch {
    throw new BackupError("BACKUP_DIR_UNAVAILABLE", "备份目录不可用或不可写", backupDirSuggestion());
  }
}

function backupDirSuggestion() {
  return `请检查 BACKUP_DIR=${backupDir()} 是否存在、是否为目录，并确认应用进程有读写权限；Docker 部署请检查 data 目录或自定义备份目录挂载。`;
}

export async function writeBackupFileAtomically(fullPath: string, content: string, operations: AtomicWriteOperations = defaultAtomicWriteOperations) {
  const tempPath = `${fullPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await operations.writeFile(tempPath, content, "utf8");
    await operations.rename(tempPath, fullPath);
  } catch (error) {
    await operations.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function recordFailedBackupJob(
  jobType: "backup" | "restore",
  error: BackupError,
  filePath: string | undefined,
  context: {
    reason?: string;
    requestedFile?: string;
    manifest?: BackupManifest;
    cause?: {
      code: string;
      message: string;
      suggestion: string;
    };
  } = {}
) {
  try {
    await store.recordBackupJob({
      jobType,
      status: "failed",
      filePath,
      containsSecrets: Boolean(context.manifest?.containsSecrets),
      message: `${error.code}: ${error.message}`,
      manifest: {
        ...(context.manifest ? { backup: context.manifest } : {}),
        ...(context.reason ? { reason: context.reason } : {}),
        ...(context.requestedFile ? { requestedFile: context.requestedFile } : {}),
        ...(context.cause ? { cause: context.cause } : {}),
        error: {
          code: error.code,
          message: error.message,
          suggestion: error.suggestion
        }
      },
      finishedAt: new Date().toISOString()
    });
  } catch {
    // Do not mask the original backup/restore error with a secondary status-write failure.
  }
}

function normalizeBackupFile(file: string) {
  const basename = path.basename(file);
  if (basename !== file || !/^backup-[\w.-]+\.json$/.test(basename)) {
    throw new BackupError("BACKUP_FILE_INVALID", "备份文件名无效", "只能恢复备份列表中显示的 backup-*.json 文件。");
  }
  return basename;
}
