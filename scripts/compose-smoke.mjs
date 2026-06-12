import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const deployDir = path.join(root, "deploy");
const composeFile = path.join(deployDir, "docker-compose.local.yml");
const composeRequired =
  process.env.COMPOSE_SMOKE_REQUIRED === "true" || (Boolean(process.env.CI) && process.env.CI !== "false");
const tempDir = await mkdtemp(path.join(tmpdir(), "pcc-compose-smoke-"));
const suffix = randomUUID().slice(0, 8);
const projectName = `pccsmoke${suffix}`;
const hostPort = 21000 + Math.floor(Math.random() * 10000);
const tcpPort = 22000 + Math.floor(Math.random() * 10000);
const udpPort = 32000 + Math.floor(Math.random() * 10000);
const imageTag = `compose-smoke-${suffix}`;
const envFile = path.join(tempDir, ".env");
const overrideFile = path.join(tempDir, "docker-compose.override.yml");
let composeAvailable = false;

function composePath(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 0, stdout, stderr }));
  });
}

function skipOrFail(reason) {
  if (composeRequired) {
    throw new Error(`compose smoke required but unavailable: ${reason}`);
  }
  console.log(`compose smoke skipped: ${reason}`);
  process.exit(0);
}

async function request(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}${pathname}`, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${pathname} failed: ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForReady() {
  const deadline = Date.now() + 120000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const health = await request("/health");
      const ready = await request("/ready");
      if (health.status === "ok" && ready.ready) return ready;
      lastError = JSON.stringify({ health, ready });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`compose app did not become ready: ${lastError}`);
}

async function composeDiagnostics() {
  const [ps, logs] = await Promise.all([
    run("docker", [...composeArgs, "ps"], { cwd: deployDir }),
    run("docker", [...composeArgs, "logs", "app", "--tail", "120"], { cwd: deployDir })
  ]);
  return [
    "compose ps:",
    ps.stdout || ps.stderr,
    "app logs:",
    logs.stdout || logs.stderr
  ].join("\n");
}

await writeFile(
  envFile,
  [
    `IMAGE_TAG=${imageTag}`,
    "BIND_HOST=127.0.0.1",
    `SERVER_PORT=${hostPort}`,
    "SERVER_MODE=release",
    "NETWORK_MODE=bridge",
    "PUBLIC_BASE_URL=",
    "TZ=Asia/Shanghai",
    "ADMIN_USERNAME=admin",
    "ADMIN_PASSWORD=",
    `JWT_SECRET=compose-smoke-jwt-secret-${suffix}-1234567890`,
    "JWT_EXPIRE_HOURS=24",
    `CONFIG_ENCRYPTION_KEY=compose-smoke-encryption-key-${suffix}`,
    "LOGIN_MAX_FAILURES=5",
    "LOGIN_LOCK_MINUTES=15",
    "POSTGRES_DB=proxy_panel",
    "POSTGRES_USER=proxy_panel",
    `POSTGRES_PASSWORD=compose-smoke-postgres-${suffix}`,
    "STORAGE_DRIVER=postgres",
    "DATABASE_MAX_OPEN_CONNS=10",
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
    `LOCAL_TCP_PORT_RANGE=${tcpPort}-${tcpPort}`,
    `LOCAL_UDP_PORT_RANGE=${udpPort}-${udpPort}`,
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

await writeFile(
  overrideFile,
  [
    "services:",
    "  app:",
    `    container_name: ${projectName}-app`,
    "    volumes:",
    "      - type: bind",
    `        source: ${JSON.stringify(composePath(path.join(tempDir, "data")))}`,
    "        target: /app/data",
    "  postgres:",
    `    container_name: ${projectName}-postgres`,
    "    volumes:",
    "      - type: bind",
    `        source: ${JSON.stringify(composePath(path.join(tempDir, "postgres_data")))}`,
    "        target: /var/lib/postgresql/data",
    "  redis:",
    `    container_name: ${projectName}-redis`,
    "    volumes:",
    "      - type: bind",
    `        source: ${JSON.stringify(composePath(path.join(tempDir, "redis_data")))}`,
    "        target: /data",
    ""
  ].join("\n"),
  "utf8"
);

const composeArgs = [
  "compose",
  "--project-name",
  projectName,
  "--env-file",
  envFile,
  "-f",
  composeFile,
  "-f",
  overrideFile
];

try {
  const version = await run("docker", ["compose", "version"]);
  if (version.status !== 0) {
    skipOrFail(`docker compose is not available (${version.stderr || version.stdout})`);
  }
  composeAvailable = true;

  const up = await run("docker", [...composeArgs, "up", "-d", "--build"], { cwd: deployDir });
  if (up.status !== 0) {
    throw new Error(`docker compose up failed:\n${up.stderr || up.stdout}`);
  }

  let ready;
  try {
    ready = await waitForReady();
  } catch (error) {
    const diagnostics = await composeDiagnostics();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
  }
  if (ready.checks.database.status !== "ok" || ready.checks.redis.status !== "ok" || ready.checks.migrations.status !== "ok") {
    throw new Error(`compose ready checks did not include healthy dependencies: ${JSON.stringify(ready.checks)}`);
  }

  const ps = await run("docker", [...composeArgs, "ps", "--format", "json"], { cwd: deployDir });
  if (ps.status !== 0) throw new Error(`docker compose ps failed:\n${ps.stderr || ps.stdout}`);
  for (const name of [`${projectName}-app`, `${projectName}-postgres`, `${projectName}-redis`]) {
    if (!ps.stdout.includes(name)) throw new Error(`compose ps missing ${name}: ${ps.stdout}`);
  }

  const logs = await run("docker", [...composeArgs, "logs", "app", "--tail", "200"], { cwd: deployDir });
  if (!logs.stdout.includes("[setup] admin account created") || !logs.stdout.includes("[setup] admin password:")) {
    throw new Error(`compose app logs did not include first-run admin password guidance:\n${logs.stdout || logs.stderr}`);
  }

  console.log("compose smoke ok");
} finally {
  if (composeAvailable) {
    await run("docker", [...composeArgs, "down", "-v", "--remove-orphans"], { cwd: deployDir });
    await run("docker", ["network", "prune", "--force", "--filter", `label=com.docker.compose.project=${projectName}`], { cwd: deployDir });
  }
  await rm(tempDir, { recursive: true, force: true });
}
