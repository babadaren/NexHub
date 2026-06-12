import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFailureCase(name, env) {
  const dataDir = await mkdtemp(path.join(tmpdir(), `pcc-redis-required-${name}-`));
  const child = spawn("node", ["backend/dist/server.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: "19101",
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: "admin12345",
      JWT_SECRET: `redis-required-${name}-secret`,
      CONFIG_ENCRYPTION_KEY: `redis-required-${name}-encryption-key`,
      REDIS_REQUIRED: "true",
      ...env
    }
  });

  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk) => (logs += chunk.toString()));

  try {
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(undefined);
      }, 8000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    if (exitCode === 0 || exitCode === undefined) {
      throw new Error(`${name} expected startup failure, got exit ${exitCode}; logs:\n${logs}`);
    }
    if (!logs.includes("Redis is required but unavailable")) {
      throw new Error(`${name} missing required redis error message:\n${logs}`);
    }
  } finally {
    child.kill();
    await wait(250);
    await rm(dataDir, { recursive: true, force: true });
  }
}

await runFailureCase("missing-url", { REDIS_URL: "" });
await runFailureCase("unavailable-url", { REDIS_URL: "redis://127.0.0.1:63999/0" });

console.log("redis required smoke ok");
