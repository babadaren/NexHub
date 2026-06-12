import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const deployDir = path.join(root, "deploy");
const composeFile = path.join(deployDir, "docker-compose.local.yml");
const tempDir = await mkdtemp(path.join(tmpdir(), "pcc-compose-required-"));
const suffix = randomUUID().slice(0, 8);
const projectName = `pccrequired${suffix}`;
const envFile = path.join(tempDir, ".env");
const overrideFile = path.join(tempDir, "docker-compose.override.yml");
const composeRequired =
  process.env.COMPOSE_REQUIRED_SMOKE_REQUIRED === "true" || (Boolean(process.env.CI) && process.env.CI !== "false");
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
    throw new Error(`compose required smoke unavailable: ${reason}`);
  }
  console.log(`compose required smoke skipped: ${reason}`);
  process.exit(0);
}

await writeFile(
  envFile,
  [
    "IMAGE_TAG=compose-required-smoke",
    "SERVER_MODE=release",
    "POSTGRES_DB=proxy_panel",
    "POSTGRES_USER=proxy_panel",
    "POSTGRES_PASSWORD=",
    "JWT_SECRET=compose-required-jwt-secret-1234567890",
    "CONFIG_ENCRYPTION_KEY=compose-required-encryption-key-1234",
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
    "  postgres:",
    `    container_name: ${projectName}-postgres`,
    "    restart: \"no\"",
    "    volumes:",
    "      - type: bind",
    `        source: ${JSON.stringify(composePath(path.join(tempDir, "postgres_data")))}`,
    "        target: /var/lib/postgresql/data",
    "  redis:",
    `    container_name: ${projectName}-redis`,
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

  await run("docker", [...composeArgs, "up", "-d", "postgres"], { cwd: deployDir });
  const logs = await waitForPostgresExit();
  for (const expected of ["POSTGRES_PASSWORD is required for PostgreSQL", "deploy/install.sh", "set POSTGRES_PASSWORD in .env"]) {
    if (!logs.includes(expected)) {
      throw new Error(`postgres password guidance missing ${expected}:\n${logs}`);
    }
  }
  console.log("compose required smoke ok");
} finally {
  if (composeAvailable) {
    await run("docker", [...composeArgs, "down", "-v", "--remove-orphans"], { cwd: deployDir });
    await run("docker", ["network", "prune", "--force", "--filter", `label=com.docker.compose.project=${projectName}`], { cwd: deployDir });
  }
  await rm(tempDir, { recursive: true, force: true });
}

async function waitForPostgresExit() {
  const deadline = Date.now() + 30000;
  let lastLogs = "";
  while (Date.now() < deadline) {
    const logs = await run("docker", [...composeArgs, "logs", "postgres"], { cwd: deployDir });
    lastLogs = `${logs.stdout}\n${logs.stderr}`;
    const inspect = await run("docker", ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", `${projectName}-postgres`], { cwd: deployDir });
    if (inspect.stdout.includes("exited")) return lastLogs;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`postgres did not exit after empty POSTGRES_PASSWORD:\n${lastLogs}`);
}
