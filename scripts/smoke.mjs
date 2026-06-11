import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-smoke-"));
const port = 19080;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

async function rawRequest(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, options);
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
    JWT_SECRET: "smoke-secret"
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

  const dashboard = await request("/api/dashboard/summary", { headers: auth });
  if (dashboard.metrics.length !== 6) throw new Error("dashboard metrics missing");

  const localNodes = await request("/api/local-nodes", { headers: authNoBody });
  const localNode = localNodes[0];
  if (!localNode) throw new Error("seed local node missing");
  const share = await request(`/api/local-nodes/${localNode.id}/share`, { headers: authNoBody });
  if (!share.token || !share.subscriptionPath) throw new Error("local share did not return token");
  const publicShare = await request(share.subscriptionPath);
  if (publicShare.link !== share.link) throw new Error("public share did not return expected link");
  const rotated = await request(`/api/local-nodes/${localNode.id}/share/rotate`, {
    method: "POST",
    headers: authNoBody
  });
  if (!rotated.token || rotated.token === share.token) throw new Error("share token did not rotate");
  const oldShareResponse = await rawRequest(share.subscriptionPath);
  if (oldShareResponse.status !== 404) throw new Error("old share token remained valid after rotation");
  const rotatedPublicShare = await request(rotated.subscriptionPath);
  if (rotatedPublicShare.link !== rotated.link) throw new Error("rotated public share did not return expected link");

  const parsed = await request("/api/remote-nodes/import/parse", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ input: "vless://22222222-2222-4222-8222-222222222222@smoke-import.example.com:443?security=tls&type=tcp#Smoke-Import" })
  });
  if (parsed.nodes[0].status !== "parsed" || parsed.nodes[0].config.server !== "smoke-import.example.com") {
    throw new Error("import parser did not return expected vless node");
  }

  const applied = await request("/api/remote-nodes/import/apply", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ nodes: parsed.nodes })
  });
  if (applied.created !== 1 || applied.status !== "passed") throw new Error("import apply did not create node");

  const created = await request("/api/remote-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: parsed.nodes[0].name,
      protocol: parsed.nodes[0].protocol,
      config: parsed.nodes[0].config
    })
  });

  const tested = await request(`/api/remote-nodes/${created.id}/test`, {
    method: "POST",
    headers: authNoBody
  });
  if (!["passed", "warning"].includes(tested.finalStatus)) throw new Error("node test did not pass");

  const engineConfig = JSON.parse(await readFile(path.join(dataDir, "engine", "current.json"), "utf8"));
  if (!engineConfig.outbounds.some((item) => item.server === "smoke-import.example.com" && item.type === "vless")) {
    throw new Error("engine config did not include created node");
  }

  const subscription = await request("/api/subscriptions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Smoke subscription",
      content: `
proxies:
  - name: Smoke-Clash
    type: vless
    server: smoke-clash.example.com
    port: 443
    uuid: 55555555-5555-4555-8555-555555555555
    tls: true
`
    })
  });
  const refreshed = await request(`/api/subscriptions/${subscription.id}/refresh`, {
    method: "POST",
    headers: authNoBody
  });
  if (refreshed.created !== 1 || refreshed.status !== "passed") throw new Error("subscription refresh did not create node");

  const subscriptions = await request("/api/subscriptions", { headers: authNoBody });
  if (subscriptions[0].lastRefreshStatus !== "passed") throw new Error("subscription status was not persisted");

  const backup = await request("/api/system/backup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ reason: "smoke" })
  });
  if (!backup.file.endsWith(".json") || backup.manifest.state.nodes < 3) throw new Error("backup manifest did not include current state");
  const backupPayload = JSON.parse(await readFile(path.join(dataDir, "backups", backup.file), "utf8"));
  if (!backupPayload.state?.nodes?.length || !backupPayload.manifest?.containsSecrets) throw new Error("backup payload missing state or manifest");

  const backups = await request("/api/system/backups", { headers: authNoBody });
  if (!backups.some((item) => item.file === backup.file)) throw new Error("backup list did not include created backup");

  await request(`/api/remote-nodes/${created.id}`, {
    method: "DELETE",
    headers: authNoBody
  });
  const afterDelete = await request("/api/remote-nodes", { headers: authNoBody });
  if (afterDelete.some((node) => node.id === created.id)) throw new Error("node delete before restore failed");

  const restore = await request(`/api/system/backups/${encodeURIComponent(backup.file)}/restore`, {
    method: "POST",
    headers: authNoBody
  });
  if (!restore.preRestoreFile || restore.file !== backup.file) throw new Error("restore did not return pre-restore backup");
  const afterRestore = await request("/api/remote-nodes", { headers: authNoBody });
  if (!afterRestore.some((node) => node.id === created.id)) throw new Error("restore did not recover deleted node");

  console.log("smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) {
    console.error(logs);
  }
});
