import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-share-rate-"));
const port = 19086;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
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
    JWT_SECRET: "share-rate-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "share-rate-smoke-encryption-key",
    SHARE_RATE_LIMIT_PER_MINUTE: "2"
  }
});

let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk.toString()));
child.stderr.on("data", (chunk) => (logs += chunk.toString()));

try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
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
  });
  const auth = { Authorization: `Bearer ${login.token}` };
  const node = await request("/api/local-nodes", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Share-Rate-Local",
      protocol: "socks5",
      enabled: true,
      config: { listenHost: "0.0.0.0", listenPort: 20086, exposure: "lan" }
    })
  });
  const share = await request(`/api/local-nodes/${node.id}/share`, { headers: auth });

  const first = await fetch(`http://127.0.0.1:${port}${share.subscriptionPath}`);
  const second = await fetch(`http://127.0.0.1:${port}${share.subscriptionPath}`);
  const third = await fetch(`http://127.0.0.1:${port}${share.subscriptionPath}`);
  if (first.status !== 200 || second.status !== 200 || third.status !== 429) {
    throw new Error(`expected 200,200,429; got ${first.status},${second.status},${third.status}`);
  }
  if (!third.headers.get("retry-after") || third.headers.get("x-ratelimit-limit") !== "2") {
    throw new Error("rate limit response headers missing");
  }
  const limited = await third.json();
  if (limited.code !== "SHARE_RATE_LIMITED" || !limited.suggestion) {
    throw new Error(`rate limit response did not include structured guidance: ${JSON.stringify(limited)}`);
  }

  console.log("share rate smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
