import { randomBytes } from "node:crypto";
import path from "node:path";

const rootDir = path.resolve(process.cwd(), "..");

export const config = {
  host: process.env.SERVER_HOST ?? "0.0.0.0",
  port: Number(process.env.SERVER_PORT ?? 8080),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  dataDir: process.env.DATA_DIR ?? path.join(rootDir, "data"),
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPassword: process.env.ADMIN_PASSWORD,
  jwtSecret: process.env.JWT_SECRET ?? randomBytes(32).toString("hex"),
  jwtExpireHours: Number(process.env.JWT_EXPIRE_HOURS ?? 24),
  configEncryptionKey: process.env.CONFIG_ENCRYPTION_KEY ?? randomBytes(32).toString("hex"),
  realtimeTtlHours: Number(process.env.REALTIME_TTL_HOURS ?? 6),
  version: process.env.npm_package_version ?? "0.1.0",
  engineProvider: process.env.ENGINE_PROVIDER ?? "sing-box",
  localTcpPortRange: process.env.LOCAL_TCP_PORT_RANGE ?? "20000-20100",
  localUdpPortRange: process.env.LOCAL_UDP_PORT_RANGE ?? "20000-20100"
};
