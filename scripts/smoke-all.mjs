import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pnpm = "pnpm";
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--list", "--require-postgres", "--skip-postgres", "--include-compose", "--require-compose"]);
const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));

if (unknownArgs.length > 0) {
  throw new Error(`unknown smoke:all argument(s): ${unknownArgs.join(", ")}`);
}
if (args.has("--require-postgres") && args.has("--skip-postgres")) {
  throw new Error("--require-postgres and --skip-postgres cannot be used together");
}
if (args.has("--require-compose")) {
  args.add("--include-compose");
}

const commandMatrix = [
  "typecheck",
  "build",
  "test:adapters",
  "check:deploy",
  "smoke",
  "smoke:api-gap",
  "smoke:auth",
  "smoke:backup-cleanup",
  "smoke:backup-error",
  "smoke:cli",
  "smoke:compose",
  "smoke:compose-required",
  "smoke:engine",
  "smoke:engine-log-error",
  "smoke:engine-log",
  "smoke:engine-rollback",
  "smoke:frontend-contract",
  "smoke:install",
  "smoke:locks",
  "smoke:production-config",
  "smoke:redis-required",
  "smoke:runtime-config",
  "smoke:secrets",
  "smoke:share-rate",
  "smoke:subscription-security",
  "smoke:subscription-scheduler",
  "smoke:traffic-aggregate",
  "smoke:postgres"
];

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const packageScripts = packageJson.scripts ?? {};
const packageSmokeScripts = Object.keys(packageScripts).filter(
  (script) => (script === "smoke" || script.startsWith("smoke:")) && script !== "smoke:all"
);
const missingFromMatrix = packageSmokeScripts.filter((script) => !commandMatrix.includes(script));
if (missingFromMatrix.length > 0) {
  throw new Error(`smoke:all is missing package smoke script(s): ${missingFromMatrix.join(", ")}`);
}

for (const script of commandMatrix) {
  if (!packageScripts[script]) {
    throw new Error(`smoke:all references missing package script: ${script}`);
  }
}

const steps = commandMatrix
  .filter((script) => script !== "smoke:postgres" || !args.has("--skip-postgres"))
  .filter((script) => !["smoke:compose", "smoke:compose-required"].includes(script) || args.has("--include-compose"))
  .map((script) => ({
    script,
    env: {
      ...(script === "smoke:postgres" && args.has("--require-postgres") ? { POSTGRES_SMOKE_REQUIRED: "true" } : {}),
      ...(script === "smoke:compose" && args.has("--require-compose") ? { COMPOSE_SMOKE_REQUIRED: "true" } : {}),
      ...(script === "smoke:compose-required" && args.has("--require-compose") ? { COMPOSE_REQUIRED_SMOKE_REQUIRED: "true" } : {})
    }
  }));

if (args.has("--list")) {
  for (const step of steps) {
    const envPrefix = step.env.POSTGRES_SMOKE_REQUIRED ? "POSTGRES_SMOKE_REQUIRED=true " : "";
    const composeEnvPrefix = step.env.COMPOSE_SMOKE_REQUIRED ? "COMPOSE_SMOKE_REQUIRED=true " : "";
    const composeRequiredEnvPrefix = step.env.COMPOSE_REQUIRED_SMOKE_REQUIRED ? "COMPOSE_REQUIRED_SMOKE_REQUIRED=true " : "";
    console.log(`${envPrefix}${composeEnvPrefix}${composeRequiredEnvPrefix}pnpm ${step.script}`);
  }
  process.exit(0);
}

const startedAt = Date.now();
for (const [index, step] of steps.entries()) {
  await runStep(step, index + 1, steps.length);
}

const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\nsmoke:all ok (${steps.length} commands, ${durationSeconds}s)`);
if (!args.has("--include-compose")) {
  console.log("Docker compose up/health acceptance was skipped; run pnpm smoke:all -- --include-compose or pnpm smoke:compose when Docker is available.");
}

function runStep(step, index, total) {
  return new Promise((resolve, reject) => {
    const label = `pnpm ${step.script}`;
    const stepStartedAt = Date.now();
    console.log(`\n[smoke:all] ${index}/${total} ${label}`);
    const child = spawn(pnpm, [step.script], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...step.env },
      shell: process.platform === "win32"
    });
    child.on("error", reject);
    child.on("close", (status) => {
      const durationSeconds = ((Date.now() - stepStartedAt) / 1000).toFixed(1);
      if (status === 0) {
        console.log(`[smoke:all] passed ${label} (${durationSeconds}s)`);
        resolve();
        return;
      }
      reject(new Error(`${label} failed with exit code ${status ?? "unknown"} after ${durationSeconds}s`));
    });
  });
}
