import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const bash = findUsableBash();

if (!bash) {
  console.log("install smoke skipped: bash is not available");
  process.exit(0);
}

const tempRoot = mkdtempSync(path.join(tmpdir(), "pcc-install-smoke-"));
const deployDir = path.join(tempRoot, "deploy");
const binDir = path.join(tempRoot, "bin");
const pathSeparator = process.platform === "win32" ? ";" : ":";

try {
  await cp(path.join(root, "deploy"), deployDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  const fakeDocker = path.join(binDir, "docker");
  await writeFile(
    fakeDocker,
    [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"compose\" ] && [ \"$2\" = \"version\" ]; then",
      "  echo 'Docker Compose version v2.0.0'",
      "  exit 0",
      "fi",
      "echo \"unexpected docker invocation: $*\" >&2",
      "exit 1",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(fakeDocker, 0o755);

  const firstInstall = await runInstall({ PCC_INSTALL_ASSUME_YES: "true" });
  if (firstInstall.status !== 0) throw new Error(`first install failed: ${firstInstall.stderr || firstInstall.stdout}`);
  await assertInstalled();
  await assertLocalComposeInstalled();
  const firstBackups = await composeBackups();
  if (firstBackups.length !== 1) {
    throw new Error(`install.sh did not back up existing quick-start compose before installing local template: ${firstBackups.join(", ")}`);
  }
  const firstEnv = await readFile(path.join(deployDir, ".env"), "utf8");
  const firstPostgresPassword = envValue(firstEnv, "POSTGRES_PASSWORD");
  const firstJwtSecret = envValue(firstEnv, "JWT_SECRET");
  const firstEncryptionKey = envValue(firstEnv, "CONFIG_ENCRYPTION_KEY");
  if (!firstPostgresPassword || !firstJwtSecret || !firstEncryptionKey) {
    throw new Error("install.sh did not fill required generated secrets");
  }

  const refused = await runInstall({ input: "\n" });
  if (refused.status === 0 || !/aborted/.test(refused.stdout + refused.stderr)) {
    throw new Error(`install.sh did not require confirmation for existing deployment: ${JSON.stringify(refused)}`);
  }

  const confirmed = await runInstall({ input: "y\n" });
  if (confirmed.status !== 0) throw new Error(`confirmed reinstall failed: ${confirmed.stderr || confirmed.stdout}`);
  await assertLocalComposeInstalled();
  const confirmedEnv = await readFile(path.join(deployDir, ".env"), "utf8");
  if (
    envValue(confirmedEnv, "POSTGRES_PASSWORD") !== firstPostgresPassword ||
    envValue(confirmedEnv, "JWT_SECRET") !== firstJwtSecret ||
    envValue(confirmedEnv, "CONFIG_ENCRYPTION_KEY") !== firstEncryptionKey
  ) {
    throw new Error("install.sh overwrote existing non-empty generated secrets");
  }

  const assumed = await runInstall({ PCC_INSTALL_ASSUME_YES: "true" });
  if (assumed.status !== 0) throw new Error(`assume-yes reinstall failed: ${assumed.stderr || assumed.stdout}`);
  await assertLocalComposeInstalled();
  const assumedEnv = await readFile(path.join(deployDir, ".env"), "utf8");
  if (envValue(assumedEnv, "JWT_SECRET") !== firstJwtSecret) {
    throw new Error("PCC_INSTALL_ASSUME_YES reinstall changed existing secrets");
  }

  const customCompose = "services:\n  custom:\n    image: alpine:3\n";
  await writeFile(path.join(deployDir, "docker-compose.yml"), customCompose, "utf8");
  const kept = await runInstall({ PCC_INSTALL_ASSUME_YES: "true", PCC_INSTALL_KEEP_COMPOSE: "true" });
  if (kept.status !== 0) throw new Error(`keep-compose reinstall failed: ${kept.stderr || kept.stdout}`);
  const keptCompose = await readFile(path.join(deployDir, "docker-compose.yml"), "utf8");
  if (keptCompose !== customCompose) {
    throw new Error("PCC_INSTALL_KEEP_COMPOSE=true did not preserve custom docker-compose.yml");
  }

  console.log("install smoke ok");
} finally {
  await removeTempRoot();
}

function runInstall(options = {}) {
  return new Promise((resolve) => {
    const child = spawn(bash, ["install.sh"], {
      cwd: deployDir,
      env: {
        ...process.env,
        ...options,
        PATH: `${binDir}${pathSeparator}${process.env.PATH ?? ""}`
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 0, stdout, stderr }));
    if (typeof options.input === "string") {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function findUsableBash() {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    process.env.GIT_BASH,
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "E:\\Git\\Git\\usr\\bin\\bash.exe",
    "E:\\Git\\Git\\bin\\bash.exe"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const pathEntries = (process.env.PATH ?? "").split(pathSeparator);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "bash.exe");
    if (candidate.toLowerCase().includes("\\windows\\system32\\bash.exe")) continue;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function assertInstalled() {
  for (const relativePath of [".env", "docker-compose.yml"]) {
    try {
      await readFile(path.join(deployDir, relativePath));
    } catch (error) {
      throw new Error(`install.sh did not create ${relativePath}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  for (const relativePath of ["data", "postgres_data", "redis_data"]) {
    const info = await stat(path.join(deployDir, relativePath));
    if (!info.isDirectory()) {
      throw new Error(`install.sh did not create directory ${relativePath}`);
    }
  }
}

function envValue(content, key) {
  const line = content.split(/\r?\n/).find((item) => item.startsWith(`${key}=`));
  return line?.slice(key.length + 1) ?? "";
}

async function removeTempRoot() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await wait(200);
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertLocalComposeInstalled() {
  const compose = await readFile(path.join(deployDir, "docker-compose.yml"), "utf8");
  const required = ["postgres:", "redis:", "./data:/app/data", "./postgres_data:/var/lib/postgresql/data", "./redis_data:/data"];
  for (const needle of required) {
    if (!compose.includes(needle)) {
      throw new Error(`installed docker-compose.yml is not the local PostgreSQL/Redis template; missing ${needle}`);
    }
  }
}

async function composeBackups() {
  const files = await readdir(deployDir);
  return files.filter((file) => file.startsWith("docker-compose.yml.bak."));
}
