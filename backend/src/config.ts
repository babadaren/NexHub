import { randomBytes } from "node:crypto";
import path from "node:path";

const rootDir = path.resolve(process.cwd(), "..");
const serverMode = envValue(process.env.SERVER_MODE) ?? (process.env.NODE_ENV === "production" ? "release" : "development");
const jwtSecret = envValue(process.env.JWT_SECRET);
const configEncryptionKey = envValue(process.env.CONFIG_ENCRYPTION_KEY);

export class StartupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupConfigError";
  }
}

export const config = {
  host: process.env.SERVER_HOST ?? "0.0.0.0",
  port: Number(process.env.SERVER_PORT ?? 8080),
  serverMode,
  networkMode: process.env.NETWORK_MODE ?? "bridge",
  releaseMode: serverMode === "release" || serverMode === "production",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  publicBaseUrl: envValue(process.env.PUBLIC_BASE_URL),
  dataDir: process.env.DATA_DIR ?? path.join(rootDir, "data"),
  storageDriver: process.env.STORAGE_DRIVER ?? (process.env.DATABASE_URL ? "postgres" : "json"),
  databaseUrl: process.env.DATABASE_URL,
  databaseMaxOpenConns: Number(process.env.DATABASE_MAX_OPEN_CONNS ?? 50),
  databaseConnMaxLifetimeMinutes: Number(process.env.DATABASE_CONN_MAX_LIFETIME_MINUTES ?? 30),
  redisUrl: process.env.REDIS_URL,
  redisRequired: process.env.REDIS_REQUIRED === "true",
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPassword: process.env.ADMIN_PASSWORD,
  jwtSecret: jwtSecret ?? randomBytes(32).toString("hex"),
  jwtExpireHours: Number(process.env.JWT_EXPIRE_HOURS ?? 24),
  loginMaxFailures: Number(process.env.LOGIN_MAX_FAILURES ?? 5),
  loginLockMinutes: Number(process.env.LOGIN_LOCK_MINUTES ?? 15),
  configEncryptionKey: configEncryptionKey ?? randomBytes(32).toString("hex"),
  realtimeTtlHours: Number(process.env.REALTIME_TTL_HOURS ?? 6),
  realtimeMaxTtlHours: Number(process.env.REALTIME_MAX_TTL_HOURS ?? 24),
  version: process.env.npm_package_version ?? "0.1.0",
  engineProvider: process.env.ENGINE_PROVIDER ?? "sing-box",
  engineMode: process.env.ENGINE_MODE ?? "render-only",
  engineBinary: process.env.ENGINE_BINARY ?? "sing-box",
  engineConfigDir: process.env.ENGINE_CONFIG_DIR,
  engineReloadTimeoutSeconds: Number(process.env.ENGINE_RELOAD_TIMEOUT_SECONDS ?? 10),
  engineHealthcheckTimeoutSeconds: Number(process.env.ENGINE_HEALTHCHECK_TIMEOUT_SECONDS ?? 5),
  nodeTestDelayMs: Number(process.env.NODE_TEST_DELAY_MS ?? 0),
  localTcpPortRange: process.env.LOCAL_TCP_PORT_RANGE ?? "20000-20100",
  localUdpPortRange: process.env.LOCAL_UDP_PORT_RANGE ?? "20000-20100",
  subscriptionFetchTimeoutSeconds: Number(process.env.SUBSCRIPTION_FETCH_TIMEOUT_SECONDS ?? 15),
  subscriptionMaxBytes: Number(process.env.SUBSCRIPTION_MAX_BYTES ?? 1024 * 1024),
  subscriptionRedirectLimit: Number(process.env.SUBSCRIPTION_REDIRECT_LIMIT ?? 3),
  subscriptionAllowPrivateNetwork: process.env.SUBSCRIPTION_ALLOW_PRIVATE_NETWORK === "true",
  subscriptionRefreshEnabled: process.env.SUBSCRIPTION_REFRESH_ENABLED === "true",
  subscriptionRefreshCron: process.env.SUBSCRIPTION_REFRESH_CRON ?? "0 3 * * *",
  subscriptionSchedulerIntervalSeconds: Number(process.env.SUBSCRIPTION_SCHEDULER_INTERVAL_SECONDS ?? 60),
  subscriptionRefreshDelayMs: Number(process.env.SUBSCRIPTION_REFRESH_DELAY_MS ?? 0),
  shareRateLimitPerMinute: Number(process.env.SHARE_RATE_LIMIT_PER_MINUTE ?? 60),
  backupDir: process.env.BACKUP_DIR,
  backupRetentionDays: positiveIntegerEnv(process.env.BACKUP_RETENTION_DAYS, 30),
  testBackupFailPreRestore: process.env.TEST_BACKUP_FAIL_PRE_RESTORE === "true" && serverMode !== "release" && serverMode !== "production",
  testBackupFailRestorePersist: process.env.TEST_BACKUP_FAIL_RESTORE_PERSIST === "true" && serverMode !== "release" && serverMode !== "production",
  testFailRestoreSuccessAudit: process.env.TEST_FAIL_RESTORE_SUCCESS_AUDIT === "true" && serverMode !== "release" && serverMode !== "production",
  logOutputToFile: process.env.LOG_OUTPUT_TO_FILE !== "false",
  logRotationMaxSizeMb: Number(process.env.LOG_ROTATION_MAX_SIZE_MB ?? 100),
  logRotationMaxBackups: Number(process.env.LOG_ROTATION_MAX_BACKUPS ?? 10),
  logRotationMaxAgeDays: Number(process.env.LOG_ROTATION_MAX_AGE_DAYS ?? 7)
};

export function validateStartupConfig() {
  if (!config.releaseMode) return;

  const requiredSecrets = [
    { name: "JWT_SECRET", value: jwtSecret },
    { name: "CONFIG_ENCRYPTION_KEY", value: configEncryptionKey }
  ];
  const missing = requiredSecrets.filter((item) => !item.value).map((item) => item.name);
  const tooShort = requiredSecrets.filter((item) => item.value && item.value.length < 32).map((item) => item.name);
  const invalid = [...new Set([...missing, ...tooShort])];

  if (invalid.length === 0) return;

  const details = [
    `SERVER_MODE=${config.serverMode} requires ${invalid.join(", ")}.`,
    "Set each secret to a non-empty random value with at least 32 characters.",
    "Generate values with: openssl rand -hex 32"
  ];
  if (missing.length > 0) details.push(`Missing: ${missing.join(", ")}.`);
  if (tooShort.length > 0) details.push(`Too short: ${tooShort.join(", ")}.`);

  throw new StartupConfigError(details.join(" "));
}

function envValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveIntegerEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}
