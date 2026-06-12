import { BackupError, createBackup, listBackups } from "./backup.js";
import { config, validateStartupConfig } from "./config.js";
import { engineRuntime } from "./engine.js";
import { redisRuntime } from "./redis.js";
import { store } from "./storage.js";

async function main() {
  const [command, subcommand, ...args] = process.argv.slice(2);
  if (command === "backup" && subcommand === "create") {
    await loadState();
    await redisRuntime.connect();
    const reason = readArg(args, "--reason") ?? "cli";
    const backup = await createBackup(reason);
    console.log(
      JSON.stringify(
        {
          ok: true,
          file: backup.file,
          path: backup.path,
          sizeBytes: backup.sizeBytes,
          message: backup.message,
          cleanupWarning: backup.cleanupWarning
        },
        null,
        2
      )
    );
    return;
  }

  if (command === "backup" && subcommand === "list") {
    await loadState();
    const backups = await listBackups();
    console.log(JSON.stringify(backups.map((backup) => ({ file: backup.file, createdAt: backup.createdAt, sizeBytes: backup.sizeBytes })), null, 2));
    return;
  }

  if (command === "system" && subcommand === "status") {
    await loadState();
    await redisRuntime.connect();
    const backupStatus = await backupSummaryStatus();
    const snapshot = store.snapshot();
    const engineSettings = recordValue(snapshot.settings.engine);
    const engineStatus = engineRuntime.getStatus();
    const redisOk = redisRuntime.status === "connected" || (!config.redisRequired && redisRuntime.status === "disabled");
    const engineOk = !engineSettings.lastRenderError && (config.engineMode !== "managed" || engineStatus.running);
    const ready = redisOk && engineOk && backupStatus.ok;
    console.log(
      JSON.stringify(
        {
          ready,
          status: ready ? "ready" : "degraded",
          version: config.version,
          deployment: {
            app: "ok",
            mode: config.serverMode,
            networkMode: config.networkMode,
            advancedNetwork: config.networkMode === "host",
            releaseMode: config.releaseMode,
            postgres: store.driver === "postgres" ? "ok" : "json-dev",
            redis: redisRuntime.status,
            engine: engineOk ? "ok" : "error"
          },
          storage: {
            driver: store.driver,
            dataDir: config.dataDir,
            backupDir: config.backupDir,
            redisRequired: config.redisRequired
          },
          redis: {
            status: redisRuntime.status,
            error: redisRuntime.error
          },
          engine: {
            ...engineSettings,
            runtime: engineStatus
          },
          ports: {
            localTcpPortRange: config.localTcpPortRange,
            localUdpPortRange: config.localUdpPortRange
          },
          counts: {
            admins: snapshot.admins.length,
            nodes: snapshot.nodes.length,
            nodeConfigVersions: snapshot.nodeConfigVersions.length,
            subscriptions: snapshot.subscriptions.length,
            tests: snapshot.tests.length,
            trafficSummaries: snapshot.trafficSummaries.length,
            backups: backupStatus.backups.length
          },
          backups: {
            count: backupStatus.backups.length,
            error: backupStatus.error
          },
          latestBackup: backupStatus.backups[0]
            ? {
                file: backupStatus.backups[0].file,
                createdAt: backupStatus.backups[0].createdAt,
                sizeBytes: backupStatus.backups[0].sizeBytes
              }
            : undefined
        },
        null,
        2
      )
    );
    return;
  }

  printHelp();
  process.exitCode = 1;
}

async function backupSummaryStatus() {
  try {
    const backups = await listBackups();
    return { ok: true, backups };
  } catch (error) {
    if (error instanceof BackupError) {
      return {
        ok: false,
        backups: [],
        error: { code: error.code, message: error.message, suggestion: error.suggestion }
      };
    }
    return {
      ok: false,
      backups: [],
      error: {
        code: "BACKUP_STATUS_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Backup summary unavailable",
        suggestion: "请检查备份目录权限和应用日志。"
      }
    };
  }
}

async function loadState() {
  validateStartupConfig();
  await store.load();
}

function readArg(args: string[], key: string) {
  const index = args.indexOf(key);
  if (index === -1) return undefined;
  return args[index + 1];
}

function printHelp() {
  console.log(`Proxy Control Center CLI

Usage:
  proxy-control-center backup create --reason before-update
  proxy-control-center backup list
  proxy-control-center system status
`);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

main()
  .catch((error) => {
    if (error instanceof BackupError) {
      console.error(JSON.stringify({ ok: false, code: error.code, message: error.message, suggestion: error.suggestion }, null, 2));
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await redisRuntime.close().catch(() => undefined);
    await store.close().catch(() => undefined);
  });
