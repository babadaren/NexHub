import { randomBytes } from "node:crypto";
import path from "node:path";

const rootDir = path.resolve(process.cwd(), "..");

export const config = {
  host: process.env.SERVER_HOST ?? "0.0.0.0",
  port: Number(process.env.SERVER_PORT ?? 8080),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  dataDir: process.env.DATA_DIR ?? path.join(rootDir, "data"),
  storageDriver: process.env.STORAGE_DRIVER ?? (process.env.DATABASE_URL ? "postgres" : "json"),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  redisRequired: process.env.REDIS_REQUIRED === "true",
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPassword: process.env.ADMIN_PASSWORD,
  jwtSecret: process.env.JWT_SECRET ?? randomBytes(32).toString("hex"),
  jwtExpireHours: Number(process.env.JWT_EXPIRE_HOURS ?? 24),
  configEncryptionKey: process.env.CONFIG_ENCRYPTION_KEY ?? randomBytes(32).toString("hex"),
  realtimeTtlHours: Number(process.env.REALTIME_TTL_HOURS ?? 6),
  version: process.env.npm_package_version ?? "0.1.0",
  engineProvider: process.env.ENGINE_PROVIDER ?? "sing-box",
  engineMode: process.env.ENGINE_MODE ?? "render-only",
  engineBinary: process.env.ENGINE_BINARY ?? "sing-box",
  engineConfigDir: process.env.ENGINE_CONFIG_DIR,
  engineReloadTimeoutSeconds: Number(process.env.ENGINE_RELOAD_TIMEOUT_SECONDS ?? 10),
  localTcpPortRange: process.env.LOCAL_TCP_PORT_RANGE ?? "20000-20100",
  localUdpPortRange: process.env.LOCAL_UDP_PORT_RANGE ?? "20000-20100",
  subscriptionFetchTimeoutSeconds: Number(process.env.SUBSCRIPTION_FETCH_TIMEOUT_SECONDS ?? 15),
  subscriptionMaxBytes: Number(process.env.SUBSCRIPTION_MAX_BYTES ?? 1024 * 1024),
  subscriptionAllowPrivateNetwork: process.env.SUBSCRIPTION_ALLOW_PRIVATE_NETWORK === "true",
  backupDir: process.env.BACKUP_DIR,
  backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 30)
};
