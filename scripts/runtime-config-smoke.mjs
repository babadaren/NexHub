import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const { default: Redis } = await import(new URL("backend/node_modules/ioredis/built/index.js", new URL("../", import.meta.url)).href);

const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-runtime-config-"));
const port = 19101;
const redisName = "pcc-runtime-config-redis";
const redisPort = 56380;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

function run(command, args) {
  const result = spawn(command, args, { cwd: root, stdio: "ignore" });
  return new Promise((resolve) => result.on("exit", (code) => resolve(code ?? 0)));
}

await run("docker", ["rm", "-f", redisName]);
const started = await run("docker", ["run", "-d", "--name", redisName, "-p", `${redisPort}:6379`, "redis:7-alpine"]);
if (started !== 0) {
  console.log("runtime config smoke skipped: docker redis is not available");
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}

const child = spawn("node", ["backend/dist/server.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    DATA_DIR: dataDir,
    ADMIN_PASSWORD: "admin12345",
    JWT_SECRET: "runtime-config-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "runtime-config-smoke-encryption-key",
    REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
    REALTIME_TTL_HOURS: "24",
    REALTIME_MAX_TTL_HOURS: "1"
  }
});

let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk.toString()));
child.stderr.on("data", (chunk) => (logs += chunk.toString()));

try {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await request("/health");
      break;
    } catch {
      await wait(250);
    }
  }

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin12345" })
  }).catch(async () => {
    throw new Error(`login failed; logs=${logs}`);
  });
  const auth = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };

  const node = await request("/api/remote-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Runtime-Config",
      protocol: "vless",
      enabled: true,
      config: {
        server: "runtime-config.example.com",
        port: 443,
        uuid: "14141414-1414-4414-8414-141414141414",
        tls: true
      }
    })
  });

  const redis = new Redis(`redis://127.0.0.1:${redisPort}/0`, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    const ttl = await redis.ttl(`rt:node:${node.id}:now`);
    if (ttl < 3500 || ttl > 3600) throw new Error(`realtime ttl was not capped to REALTIME_MAX_TTL_HOURS=1: ${ttl}`);
  } finally {
    await redis.quit();
  }

  console.log("runtime config smoke ok");
} finally {
  child.kill();
  await run("docker", ["rm", "-f", redisName]);
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
