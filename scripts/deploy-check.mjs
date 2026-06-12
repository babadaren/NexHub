import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = path.resolve(import.meta.dirname, "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function assertIncludes(name, content, needles) {
  for (const needle of needles) {
    if (!content.includes(needle)) {
      throw new Error(`${name} is missing required content: ${needle}`);
    }
  }
}

function assertExcludes(name, content, needles) {
  for (const needle of needles) {
    if (content.includes(needle)) {
      throw new Error(`${name} includes unsupported configuration: ${needle}`);
    }
  }
}

function envKeys(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.split("=", 1)[0]);
}

function assertComposeReceivesEnv(name, content, keys) {
  const missing = keys.filter((key) => !content.includes(`${key}:`));
  if (missing.length > 0) {
    throw new Error(`${name} does not pass .env variables to app: ${missing.join(", ")}`);
  }
}

function smokeAllMatrix(content) {
  const match = content.match(/const commandMatrix = \[([\s\S]*?)\];/);
  if (!match) {
    throw new Error("scripts/smoke-all.mjs commandMatrix not found");
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map(([, script]) => script);
}

function assertAcceptanceMatrixDocumented(matrix, content) {
  const missing = matrix.filter((script) => !content.includes(`pnpm ${script}`) && !content.includes(`\`${script}\``));
  if (missing.length > 0) {
    throw new Error(`proxy_control_center_full_design_dev_spec.md is missing smoke:all acceptance command(s): ${missing.join(", ")}`);
  }
}

const [
  dockerfile,
  dockerignore,
  backendPackage,
  env,
  localCompose,
  hostCompose,
  install,
  readme,
  rootReadme,
  releaseNotes,
  caddy,
  trafficMigration,
  sourceMissingMigration,
  smokeAll,
  designSpec
] = await Promise.all([
  read("Dockerfile"),
  read(".dockerignore"),
  read("backend/package.json"),
  read("deploy/.env.example"),
  read("deploy/docker-compose.local.yml"),
  read("deploy/docker-compose.host.yml"),
  read("deploy/install.sh"),
  read("deploy/README.md"),
  read("README.md"),
  read("RELEASE_NOTES.md"),
  read("deploy/Caddyfile.example"),
  read("backend/migrations/004_traffic_summary_source.sql"),
  read("backend/migrations/008_subscription_source_missing.sql"),
  read("scripts/smoke-all.mjs"),
  read("proxy_control_center_full_design_dev_spec.md")
]);

assertIncludes("Dockerfile", dockerfile, [
  "ENV NODE_ENV=production",
  "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./",
  "pnpm install --frozen-lockfile",
  "pnpm --filter @proxy-control-center/backend --prod deploy --legacy /prod",
  "PUBLIC_DIR=/app/backend/public",
  "USER pcc",
  "HEALTHCHECK",
  "proxy-control-center"
]);

assertIncludes(".dockerignore", dockerignore, [
  "node_modules",
  "deploy/.env",
  "deploy/postgres_data",
  "frontend/dist"
]);

assertIncludes("backend/package.json", backendPackage, [
  "\"bin\"",
  "\"proxy-control-center\": \"dist/cli.js\""
]);

assertIncludes("backend/migrations/004_traffic_summary_source.sql", trafficMigration, [
  "daily_traffic_summaries",
  "source TEXT",
  "updated_at"
]);

assertIncludes("backend/migrations/008_subscription_source_missing.sql", sourceMissingMigration, [
  "node_configs",
  "source_missing BOOLEAN NOT NULL DEFAULT false",
  "idx_node_configs_source_missing"
]);

assertIncludes("deploy/.env.example", env, [
  "SERVER_MODE=release",
  "NETWORK_MODE=bridge",
  "PUBLIC_BASE_URL=",
  "POSTGRES_PASSWORD=",
  "JWT_SECRET=",
  "CONFIG_ENCRYPTION_KEY=",
  "LOCAL_TCP_PORT_RANGE=20000-20100",
  "LOCAL_UDP_PORT_RANGE=20000-20100",
  "SUBSCRIPTION_REDIRECT_LIMIT=3",
  "SUBSCRIPTION_REFRESH_ENABLED=false",
  "SUBSCRIPTION_REFRESH_CRON=0 3 * * *",
  "SUBSCRIPTION_SCHEDULER_INTERVAL_SECONDS=60",
  "SHARE_RATE_LIMIT_PER_MINUTE=60",
  "BACKUP_RETENTION_DAYS=30",
  "LOG_OUTPUT_TO_FILE=true",
  "LOG_ROTATION_MAX_SIZE_MB=100",
  "LOG_ROTATION_MAX_BACKUPS=10"
]);
assertExcludes("deploy/.env.example", env, [
  "COOKIE_SECURE",
  "COOKIE_SAME_SITE",
  "DATABASE_MAX_IDLE_CONNS",
  "REDIS_POOL_SIZE",
  "BACKUP_BEFORE_UPDATE",
  "LOG_FORMAT"
]);

assertIncludes("deploy/docker-compose.local.yml", localCompose, [
  "./data:/app/data",
  "x-app-environment",
  "SERVER_MODE: \"${SERVER_MODE:-release}\"",
  "NETWORK_MODE: \"${NETWORK_MODE:-bridge}\"",
  "PUBLIC_BASE_URL:",
  "SUBSCRIPTION_FETCH_TIMEOUT_SECONDS:",
  "SHARE_RATE_LIMIT_PER_MINUTE:",
  "LOG_ROTATION_MAX_BACKUPS:",
  "./postgres_data:/var/lib/postgresql/data",
  "POSTGRES_PASSWORD is required for PostgreSQL",
  "exec docker-entrypoint.sh postgres",
  "./redis_data:/data",
  "${LOCAL_TCP_PORT_RANGE:-20000-20100}:${LOCAL_TCP_PORT_RANGE:-20000-20100}/tcp",
  "${LOCAL_UDP_PORT_RANGE:-20000-20100}:${LOCAL_UDP_PORT_RANGE:-20000-20100}/udp",
  "condition: service_healthy"
]);

assertIncludes("deploy/docker-compose.host.yml", hostCompose, [
  "x-app-environment",
  "network_mode: host",
  "SERVER_MODE: \"${SERVER_MODE:-release}\"",
  "NETWORK_MODE: \"host\"",
  "PUBLIC_BASE_URL:",
  "SUBSCRIPTION_FETCH_TIMEOUT_SECONDS:",
  "SHARE_RATE_LIMIT_PER_MINUTE:",
  "LOG_ROTATION_MAX_BACKUPS:",
  "127.0.0.1:5432:5432",
  "127.0.0.1:6379:6379",
  "POSTGRES_PASSWORD is required for PostgreSQL",
  "REDIS_PASSWORD is required when Redis is mapped to host 127.0.0.1:6379",
  "--requirepass \"$$REDIS_PASSWORD\"",
  "LOCAL_TCP_PORT_RANGE: \"${LOCAL_TCP_PORT_RANGE:-1-65535}\"",
  "DATABASE_URL:"
]);

assertIncludes("deploy/docker-compose.yml", await read("deploy/docker-compose.yml"), [
  "x-app-environment",
  "STORAGE_DRIVER: \"json\"",
  "NETWORK_MODE: \"${NETWORK_MODE:-bridge}\"",
  "PUBLIC_BASE_URL:",
  "SUBSCRIPTION_FETCH_TIMEOUT_SECONDS:",
  "SHARE_RATE_LIMIT_PER_MINUTE:",
  "LOG_ROTATION_MAX_BACKUPS:"
]);

const appEnvKeys = envKeys(env).filter(
  (key) =>
    ![
      "IMAGE_TAG",
      "BIND_HOST",
      "POSTGRES_DB",
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "STORAGE_DRIVER",
      "DATABASE_MAX_OPEN_CONNS",
      "DATABASE_CONN_MAX_LIFETIME_MINUTES",
      "REDIS_PASSWORD",
      "REDIS_DB",
      "REDIS_REQUIRED"
    ].includes(key)
);
assertComposeReceivesEnv("deploy/docker-compose.local.yml", localCompose, appEnvKeys);
assertComposeReceivesEnv("deploy/docker-compose.host.yml", hostCompose, appEnvKeys);
assertComposeReceivesEnv("deploy/docker-compose.yml", await read("deploy/docker-compose.yml"), appEnvKeys.filter((key) => !["REDIS_REQUIRED"].includes(key)));

assertIncludes("deploy/install.sh", install, [
  "docker compose version",
  "install_compose_file",
  "PCC_INSTALL_COMPOSE_SOURCE",
  "PCC_INSTALL_KEEP_COMPOSE",
  "docker-compose.local.yml",
  "docker-compose.yml.bak.",
  "set_env_value POSTGRES_PASSWORD",
  "set_env_value JWT_SECRET",
  "set_env_value CONFIG_ENCRYPTION_KEY",
  "docker compose up -d",
  "LOCAL_TCP_PORT_RANGE"
]);

assertIncludes("deploy/README.md", readme, [
  "v0.1.0",
  "Docker Compose v2",
  "IMAGE_TAG=v0.1.0",
  "https://raw.githubusercontent.com/<owner>/<repo>/v0.1.0/deploy/install.sh",
  "curl http://127.0.0.1:8080/ready",
  "SERVER_MODE=release",
  "openssl rand -hex 32",
  "proxy-control-center system status",
  "Docker bridge",
  "docker-compose.host.yml",
  "migration checksum",
  "REDIS_PASSWORD"
]);

assertIncludes("README.md", rootReadme, [
  "RELEASE_NOTES.md",
  "IMAGE_TAG=v0.1.0",
  "latest",
  "https://raw.githubusercontent.com/<owner>/<repo>/v0.1.0/deploy/install.sh"
]);

assertIncludes("RELEASE_NOTES.md", releaseNotes, [
  "## v0.1.0",
  "ghcr.io/<owner>/proxy-control-center:v0.1.0",
  "001_init.sql",
  "008_subscription_source_missing.sql",
  "POSTGRES_PASSWORD",
  "CONFIG_ENCRYPTION_KEY",
  "NETWORK_MODE",
  "LOCAL_TCP_PORT_RANGE=20000-20100",
  "data/engine/current.json",
  "data/engine/previous.json",
  "proxy-control-center backup create --reason before-update",
  "IMAGE_TAG=v0.1.0",
  "pnpm smoke:all -- --require-postgres"
]);

assertIncludes("deploy/Caddyfile.example", caddy, [
  "X-Forwarded-Proto",
  "X-Forwarded-Host",
  "reverse_proxy 127.0.0.1:8080"
]);

assertAcceptanceMatrixDocumented(smokeAllMatrix(smokeAll), designSpec);

validateComposeConfig();

console.log("deploy check ok");

function validateComposeConfig() {
  const docker = spawnSync("docker", ["compose", "version"], { cwd: root, encoding: "utf8" });
  if (docker.status !== 0) {
    console.log("docker compose config check skipped: docker compose is not available");
    return;
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), "pcc-compose-env-"));
  const envFile = path.join(tempDir, ".env");
  writeFileSync(
    envFile,
    [
      "IMAGE_TAG=smoke",
      "BIND_HOST=127.0.0.1",
      "SERVER_PORT=18080",
      "SERVER_MODE=release",
      "NETWORK_MODE=bridge",
      "PUBLIC_BASE_URL=https://panel.example.test",
      "TZ=Asia/Shanghai",
      "ADMIN_USERNAME=admin",
      "ADMIN_PASSWORD=",
      "JWT_SECRET=0123456789abcdef0123456789abcdef",
      "JWT_EXPIRE_HOURS=24",
      "CONFIG_ENCRYPTION_KEY=abcdef0123456789abcdef0123456789",
      "LOGIN_MAX_FAILURES=5",
      "LOGIN_LOCK_MINUTES=15",
      "POSTGRES_DB=proxy_panel",
      "POSTGRES_USER=proxy_panel",
      "POSTGRES_PASSWORD=postgres-smoke-password",
      "STORAGE_DRIVER=postgres",
      "DATABASE_MAX_OPEN_CONNS=50",
      "DATABASE_CONN_MAX_LIFETIME_MINUTES=30",
      "REDIS_PASSWORD=",
      "REDIS_DB=0",
      "REDIS_REQUIRED=false",
      "REALTIME_TTL_HOURS=6",
      "REALTIME_MAX_TTL_HOURS=24",
      "ENGINE_PROVIDER=sing-box",
      "ENGINE_MODE=render-only",
      "ENGINE_BINARY=sing-box",
      "ENGINE_CONFIG_DIR=/app/data/engine",
      "ENGINE_RELOAD_TIMEOUT_SECONDS=10",
      "ENGINE_HEALTHCHECK_TIMEOUT_SECONDS=5",
      "LOCAL_TCP_PORT_RANGE=20000-20100",
      "LOCAL_UDP_PORT_RANGE=20000-20100",
      "SUBSCRIPTION_FETCH_TIMEOUT_SECONDS=15",
      "SUBSCRIPTION_MAX_BYTES=1048576",
      "SUBSCRIPTION_REDIRECT_LIMIT=3",
      "SUBSCRIPTION_ALLOW_PRIVATE_NETWORK=false",
      "SUBSCRIPTION_REFRESH_ENABLED=false",
      "SUBSCRIPTION_REFRESH_CRON=0 3 * * *",
      "SUBSCRIPTION_SCHEDULER_INTERVAL_SECONDS=60",
      "SHARE_RATE_LIMIT_PER_MINUTE=60",
      "BACKUP_DIR=/app/data/backups",
      "BACKUP_RETENTION_DAYS=30",
      "LOG_LEVEL=info",
      "LOG_OUTPUT_TO_FILE=true",
      "LOG_ROTATION_MAX_SIZE_MB=100",
      "LOG_ROTATION_MAX_BACKUPS=10",
      "LOG_ROTATION_MAX_AGE_DAYS=7",
      ""
    ].join("\n"),
    "utf8"
  );
  try {
    for (const file of ["deploy/docker-compose.local.yml", "deploy/docker-compose.host.yml", "deploy/docker-compose.yml"]) {
      const result = spawnSync("docker", ["compose", "--env-file", envFile, "-f", file, "config", "--quiet"], { cwd: root, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`${file} failed docker compose config: ${result.stderr || result.stdout}`);
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
