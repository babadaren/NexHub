import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-auth-"));
const generatedDataDir = await mkdtemp(path.join(tmpdir(), "pcc-auth-generated-"));
const port = 19083;
const generatedPort = 19084;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawLogin(password) {
  return fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password })
  });
}

async function loginAt(port, password) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password })
  });
  if (!response.ok) throw new Error(`login at ${port} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function authedRequest(port, token, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} at ${port} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function request(pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  if (!response.ok) throw new Error(`${pathname} failed: ${response.status}`);
  return response.json();
}

const child = spawn("node", ["backend/dist/server.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    SERVER_MODE: "development",
    DATA_DIR: dataDir,
    ADMIN_PASSWORD: "admin12345",
    JWT_SECRET: "auth-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "auth-smoke-encryption-key",
    LOGIN_MAX_FAILURES: "2",
    LOGIN_LOCK_MINUTES: "1"
  }
});

let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk.toString()));
child.stderr.on("data", (chunk) => (logs += chunk.toString()));
let generatedChild;
let generatedLogs = "";

try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await request("/health");
      break;
    } catch {
      await wait(250);
    }
  }

  const firstWrong = await rawLogin("wrong-1");
  if (firstWrong.status !== 401) throw new Error(`first wrong password returned ${firstWrong.status}`);

  const secondWrong = await rawLogin("wrong-2");
  if (secondWrong.status !== 429) throw new Error(`second wrong password did not lock account: ${secondWrong.status}`);

  const lockedCorrect = await rawLogin("admin12345");
  if (lockedCorrect.status !== 429) throw new Error(`locked account accepted correct password: ${lockedCorrect.status}`);

  generatedChild = spawn("node", ["backend/dist/server.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(generatedPort),
      SERVER_MODE: "development",
      DATA_DIR: generatedDataDir,
      JWT_SECRET: "auth-generated-secret-value-1234567890",
      CONFIG_ENCRYPTION_KEY: "auth-generated-encryption-key-1234567890"
    }
  });
  generatedChild.stdout.on("data", (chunk) => (generatedLogs += chunk.toString()));
  generatedChild.stderr.on("data", (chunk) => (generatedLogs += chunk.toString()));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await requestAt(generatedPort, "/health");
      break;
    } catch {
      await wait(250);
    }
  }
  const generatedPassword = readGeneratedPassword(generatedLogs);
  if (!generatedPassword) throw new Error(`generated admin password was not logged:\n${generatedLogs}`);
  const generatedLogin = await loginAt(generatedPort, generatedPassword);
  if (!generatedLogin.admin.mustChangePassword) throw new Error("generated admin did not require password change");
  await authedRequest(generatedPort, generatedLogin.token, "/api/admin/password", {
    method: "PATCH",
    body: JSON.stringify({ password: "new-admin-password" })
  });
  const me = await authedRequest(generatedPort, generatedLogin.token, "/api/auth/me");
  if (me.mustChangePassword) throw new Error("password change did not clear mustChangePassword");
  const passwordEvents = await authedRequest(generatedPort, generatedLogin.token, "/api/dashboard/events");
  if (!passwordEvents.some((event) => event.action === "admin.password.changed")) {
    throw new Error(`password change audit event missing: ${JSON.stringify(passwordEvents)}`);
  }
  await authedRequest(generatedPort, generatedLogin.token, "/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({})
  });
  const logoutEvents = await authedRequest(generatedPort, generatedLogin.token, "/api/dashboard/events");
  if (!logoutEvents.some((event) => event.action === "admin.logout")) {
    throw new Error(`logout audit event missing: ${JSON.stringify(logoutEvents)}`);
  }

  console.log("auth smoke ok");
} finally {
  child.kill();
  generatedChild?.kill();
  await rm(dataDir, { recursive: true, force: true });
  await rm(generatedDataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});

function requestAt(port, pathname) {
  return fetch(`http://127.0.0.1:${port}${pathname}`).then((response) => {
    if (!response.ok) throw new Error(`${pathname} failed: ${response.status}`);
    return response.json();
  });
}

function readGeneratedPassword(logs) {
  for (const line of logs.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line);
      const message = String(parsed.msg ?? "");
      const password = message.match(/admin password: (.+)$/)?.[1]?.trim();
      if (password) return password;
    } catch {
      const password = line.match(/admin password: ([^\r\n"]+)/)?.[1]?.trim();
      if (password) return password;
    }
  }
  return undefined;
}
