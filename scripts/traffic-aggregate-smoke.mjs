import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-traffic-aggregate-"));
const port = 19092;

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
    JWT_SECRET: "traffic-aggregate-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "traffic-aggregate-smoke-encryption-key"
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
  const auth = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };
  const authNoBody = { Authorization: `Bearer ${login.token}` };

  const node = await request("/api/remote-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Traffic-Remote",
      protocol: "vless",
      enabled: true,
      config: {
        server: "traffic.example.com",
        port: 443,
        uuid: "88888888-8888-4888-8888-888888888888",
        credential: "88888888-8888-4888-8888-888888888888",
        tls: true
      }
    })
  });
  await request(`/api/remote-nodes/${node.id}/test`, { method: "POST", headers: authNoBody });
  const aggregate = await request("/api/system/traffic/aggregate", { method: "POST", headers: authNoBody });
  if (aggregate.count < 1) throw new Error(`aggregate did not produce summaries: ${JSON.stringify(aggregate)}`);

  const history = await request("/api/history/summary?days=7", { headers: authNoBody });
  if (history.totals.estimatedInboundGb + history.totals.estimatedOutboundGb <= 0) {
    throw new Error(`history did not include persisted traffic summary: ${JSON.stringify(history.totals)}`);
  }

  const backup = await request("/api/system/backup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ reason: "traffic-aggregate-smoke" })
  });
  const payload = JSON.parse(await readFile(path.join(dataDir, "backups", backup.file), "utf8"));
  if (!Array.isArray(payload.state?.trafficSummaries) || payload.state.trafficSummaries.length < 1) {
    throw new Error("backup did not include traffic summaries");
  }

  console.log("traffic aggregate smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
