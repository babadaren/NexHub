import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.POSTGRES_SMOKE_URL;
if (!databaseUrl) {
  console.log("postgres smoke skipped: POSTGRES_SMOKE_URL is not set");
  process.exit(0);
}

const port = 19081;
const adminUsername = `admin_${randomUUID().slice(0, 8)}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const child = spawn("node", ["backend/dist/server.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    STORAGE_DRIVER: "postgres",
    DATABASE_URL: databaseUrl,
    ADMIN_USERNAME: adminUsername,
    ADMIN_PASSWORD: "admin12345",
    JWT_SECRET: "postgres-smoke-secret"
  }
});

let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk.toString()));
child.stderr.on("data", (chunk) => (logs += chunk.toString()));

try {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await request("/ready");
      break;
    } catch {
      await wait(250);
    }
  }

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: adminUsername, password: "admin12345" })
  }).catch(async () => {
    throw new Error(`login failed; logs=${logs}`);
  });

  const auth = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };
  const created = await request("/api/local-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "PG-Local",
      protocol: "socks5",
      config: { listenHost: "0.0.0.0", listenPort: 20099, exposure: "lan" }
    })
  });
  await request(`/api/local-nodes/${created.id}/test`, { method: "POST", headers: { Authorization: `Bearer ${login.token}` } });
  const nodes = await request("/api/local-nodes", { headers: auth });
  if (!nodes.some((node) => node.id === created.id)) throw new Error("created local node missing after postgres write");
  console.log("postgres smoke ok");
} finally {
  child.kill();
}
