import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { store } from "./storage.js";
import type { AppState } from "./types.js";

export interface BackupManifest {
  version: string;
  createdAt: string;
  storageDriver: string;
  engineProvider: string;
  containsSecrets: boolean;
  state: {
    admins: number;
    nodes: number;
    tests: number;
    auditLogs: number;
    subscriptions: number;
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
}

interface BackupPayload {
  manifest: BackupManifest;
  reason?: string;
  state: AppState;
  engine?: {
    current?: unknown;
  };
}

const backupDir = () => config.backupDir ?? path.join(config.dataDir, "backups");

export async function createBackup(reason = "manual"): Promise<BackupSummary & { message: string }> {
  await mkdir(backupDir(), { recursive: true });
  const timestamp = new Date().toISOString();
  const filename = `backup-${timestamp.replaceAll(":", "-")}.json`;
  const fullPath = path.join(backupDir(), filename);
  const snapshot = store.snapshot();
  const engineConfig = await readOptionalJson(path.join(config.dataDir, "engine", "current.json"));
  const manifest: BackupManifest = {
    version: config.version,
    createdAt: timestamp,
    storageDriver: store.driver,
    engineProvider: config.engineProvider,
    containsSecrets: true,
    state: {
      admins: snapshot.admins.length,
      nodes: snapshot.nodes.length,
      tests: snapshot.tests.length,
      auditLogs: snapshot.auditLogs.length,
      subscriptions: snapshot.subscriptions.length
    },
    files: engineConfig ? ["state", "engine.current"] : ["state"]
  };

  const payload = {
    manifest,
    reason,
    state: snapshot,
    engine: {
      current: engineConfig
    }
  };

  await writeFile(fullPath, JSON.stringify(payload, null, 2), "utf8");
  await cleanupOldBackups();
  const stats = await stat(fullPath);
  return {
    file: filename,
    path: fullPath,
    sizeBytes: stats.size,
    createdAt: timestamp,
    containsSecrets: true,
    manifest,
    message: `备份已创建：${filename}`
  };
}

export async function listBackups(): Promise<BackupSummary[]> {
  await mkdir(backupDir(), { recursive: true });
  const files = (await readdir(backupDir())).filter((file) => file.startsWith("backup-") && file.endsWith(".json")).sort().reverse();
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
  const safeFile = normalizeBackupFile(file);
  const fullPath = path.join(backupDir(), safeFile);
  const raw = await readFile(fullPath, "utf8");
  const payload = JSON.parse(raw) as Partial<BackupPayload>;
  if (!payload.manifest || !payload.state) throw new Error("备份文件缺少 manifest 或 state");
  const preRestore = await createBackup(`before-restore:${safeFile}`);
  await store.restoreSnapshot(payload.state, safeFile);
  return {
    file: safeFile,
    restoredAt: new Date().toISOString(),
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

function normalizeBackupFile(file: string) {
  const basename = path.basename(file);
  if (basename !== file || !/^backup-[\w.-]+\.json$/.test(basename)) {
    throw new Error("备份文件名无效");
  }
  return basename;
}
