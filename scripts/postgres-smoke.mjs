import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = new URL("../", import.meta.url);
const { default: pg } = await import(new URL("backend/node_modules/pg/lib/index.js", root).href);

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
  const share = await request(`/api/local-nodes/${created.id}/share`, { method: "GET", headers: { Authorization: `Bearer ${login.token}` } });
  if (!share.token || !share.subscriptionPath) throw new Error("postgres share token was not created");
  const nodes = await request("/api/local-nodes", { headers: auth });
  if (!nodes.some((node) => node.id === created.id)) throw new Error("created local node missing after postgres write");
  const loaded = await request(`/api/local-nodes/${created.id}`, { headers: auth });
  if ("shareTokenHash" in loaded.config || "shareTokenIssuedAt" in loaded.config) {
    throw new Error("postgres node config leaked legacy share token fields");
  }
  const subscription = await request("/api/subscriptions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "PG subscription",
      content: "vless://66666666-6666-4666-8666-666666666666@pg-sub.example.com:443#PgSub",
      autoEnableNewNodes: true,
      allowPrivateNetwork: true
    })
  });
  if (!subscription.autoEnableNewNodes || !subscription.allowPrivateNetwork || subscription.sourceType !== "content") {
    throw new Error(`postgres subscription options were not returned: ${JSON.stringify(subscription)}`);
  }
  await request(`/api/subscriptions/${subscription.id}/refresh`, { method: "POST", headers: { Authorization: `Bearer ${login.token}` } });
  await request(`/api/subscriptions/${subscription.id}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      content: "vless://67676767-6767-4676-8676-676767676767@pg-sub-new.example.com:443#PgSubNew"
    })
  });
  await request(`/api/subscriptions/${subscription.id}/refresh`, { method: "POST", headers: { Authorization: `Bearer ${login.token}` } });
  const backup = await request("/api/system/backup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ reason: "postgres-smoke" })
  });
  if (!backup.file?.endsWith(".json") || typeof backup.manifest?.state?.backupJobs !== "number") {
    throw new Error(`postgres backup did not return backup job manifest: ${JSON.stringify(backup)}`);
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query("SELECT node_id, status FROM local_share_tokens WHERE node_id = $1", [created.id]);
    if (result.rowCount !== 1 || result.rows[0].status !== "active") {
      throw new Error(`local_share_tokens row missing or inactive: ${JSON.stringify(result.rows)}`);
    }
    const versions = await client.query("SELECT version FROM node_config_versions WHERE node_id = $1 ORDER BY version", [created.id]);
    if (!versions.rowCount || versions.rows[0].version !== 1) {
      throw new Error(`node_config_versions row missing or invalid: ${JSON.stringify(versions.rows)}`);
    }
    const localNodeRow = await client.query("SELECT source_missing FROM node_configs WHERE id = $1", [created.id]);
    if (localNodeRow.rowCount !== 1 || localNodeRow.rows[0].source_missing !== false) {
      throw new Error(`source_missing default was not persisted for local node: ${JSON.stringify(localNodeRow.rows)}`);
    }
    const subscriptionNodeRows = await client.query("SELECT name, source_missing FROM node_configs WHERE config->>'sourceId' = $1 ORDER BY name", [subscription.id]);
    const pgSub = subscriptionNodeRows.rows.find((row) => row.name === "PgSub");
    const pgSubNew = subscriptionNodeRows.rows.find((row) => row.name === "PgSubNew");
    if (!pgSub?.source_missing || !pgSubNew || pgSubNew.source_missing) {
      throw new Error(`subscription source_missing lifecycle was not persisted: ${JSON.stringify(subscriptionNodeRows.rows)}`);
    }
    const backupJobs = await client.query("SELECT job_type, status FROM backup_jobs WHERE file_path LIKE $1", [`%${backup.file}`]);
    if (backupJobs.rowCount !== 1 || backupJobs.rows[0].job_type !== "backup" || backupJobs.rows[0].status !== "passed") {
      throw new Error(`backup_jobs row missing or invalid: ${JSON.stringify(backupJobs.rows)}`);
    }
    const subscriptionRows = await client.query("SELECT source_type, auto_enable_new_nodes, allow_private_network FROM subscription_sources WHERE id = $1", [subscription.id]);
    if (subscriptionRows.rowCount !== 1 || subscriptionRows.rows[0].source_type !== "content" || !subscriptionRows.rows[0].auto_enable_new_nodes || !subscriptionRows.rows[0].allow_private_network) {
      throw new Error(`subscription option columns were not persisted: ${JSON.stringify(subscriptionRows.rows)}`);
    }
    const auditRows = await client.query(
      "SELECT action FROM audit_logs WHERE action IN ('node.created', 'node.tested', 'subscription.created', 'system.backup.created')"
    );
    const auditActions = new Set(auditRows.rows.map((row) => row.action));
    for (const action of ["node.created", "node.tested", "subscription.created", "system.backup.created"]) {
      if (!auditActions.has(action)) {
        throw new Error(`audit_logs missing ${action}: ${JSON.stringify(auditRows.rows)}`);
      }
    }
  } finally {
    await client.end();
  }
  console.log("postgres smoke ok");
} finally {
  child.kill();
}
