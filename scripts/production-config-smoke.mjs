import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-production-config-"));
const port = 19096;

const child = spawn("node", ["backend/dist/server.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    SERVER_MODE: "release",
    DATA_DIR: dataDir,
    ADMIN_PASSWORD: "admin12345",
    JWT_SECRET: "",
    CONFIG_ENCRYPTION_KEY: ""
  }
});

let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk.toString()));
child.stderr.on("data", (chunk) => (logs += chunk.toString()));

const exitCode = await new Promise((resolve) => {
  const timeout = setTimeout(() => {
    child.kill();
    resolve("timeout");
  }, 5000);
  child.on("exit", (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
});

await rm(dataDir, { recursive: true, force: true });

if (exitCode === "timeout") {
  throw new Error("release startup did not fail when required secrets were missing");
}
if (exitCode === 0) {
  throw new Error("release startup succeeded when required secrets were missing");
}
if (!logs.includes("SERVER_MODE=release requires JWT_SECRET, CONFIG_ENCRYPTION_KEY")) {
  throw new Error(`release startup did not report missing secrets:\n${logs}`);
}
if (!logs.includes("openssl rand -hex 32")) {
  throw new Error(`release startup did not include secret generation guidance:\n${logs}`);
}

console.log("production config smoke ok");
