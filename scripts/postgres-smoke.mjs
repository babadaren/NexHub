import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = new URL("../", import.meta.url);
const { default: pg } = await import(new URL("backend/node_modules/pg/lib/index.js", root).href);

const port = 19081;
const adminUsername = `admin_${randomUUID().slice(0, 8)}`;
const dockerContainerName = `nexhub-pg-smoke-${randomUUID().slice(0, 8)}`;
const dockerHostPort = 20000 + Math.floor(Math.random() * 20000);
let databaseUrl = process.env.POSTGRES_SMOKE_URL;
let dockerStarted = false;
const postgresSmokeRequired =
  process.env.POSTGRES_SMOKE_REQUIRED === "true" || (Boolean(process.env.CI) && process.env.CI !== "false");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 0, stdout, stderr }));
  });
}

function runServerExpectFailure(env, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn("node", ["backend/dist/server.js"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...env
      }
    });
    let logs = "";
    child.stdout.on("data", (chunk) => (logs += chunk.toString()));
    child.stderr.on("data", (chunk) => (logs += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exitCode: undefined, logs });
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, logs });
    });
  });
}

function skipOrFail(reason) {
  if (postgresSmokeRequired) {
    throw new Error(`postgres smoke required but unavailable: ${reason}`);
  }
  console.log(`postgres smoke skipped: ${reason}`);
  process.exit(0);
}

async function maybeStartDockerPostgres() {
  if (databaseUrl) return;
  const dockerVersion = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (dockerVersion.status !== 0) {
    skipOrFail(`POSTGRES_SMOKE_URL is not set and Docker is unavailable (${dockerVersion.stderr || dockerVersion.stdout})`);
  }
  const started = await run("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    dockerContainerName,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=nexhub_smoke",
    "-p",
    `${dockerHostPort}:5432`,
    "postgres:16-alpine"
  ]);
  if (started.status !== 0) {
    skipOrFail(`failed to start Docker PostgreSQL (${started.stderr || started.stdout})`);
  }
  dockerStarted = true;
  databaseUrl = `postgres://postgres:postgres@127.0.0.1:${dockerHostPort}/nexhub_smoke`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await canQueryPostgres(databaseUrl)) return;
    await wait(500);
  }
  const logs = await run("docker", ["logs", dockerContainerName, "--tail", "120"]);
  await run("docker", ["rm", "-f", dockerContainerName]);
  dockerStarted = false;
  throw new Error(`Docker PostgreSQL did not become ready: ${dockerContainerName}\n${logs.stdout || logs.stderr}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function requestNoContent(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
}

async function canQueryPostgres(connectionString) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function waitForServerReady(child, logsRef) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`postgres smoke server exited during startup with code ${child.exitCode}; logs=${logsRef()}`);
    }
    try {
      await request("/ready");
      return;
    } catch {
      await wait(250);
    }
  }
  throw new Error(`postgres smoke server did not become ready; logs=${logsRef()}`);
}

await maybeStartDockerPostgres();

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
  await waitForServerReady(child, () => logs);

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: adminUsername, password: "admin12345" })
  }).catch(async () => {
    throw new Error(`login failed; logs=${logs}`);
  });

  const authNoBody = { Authorization: `Bearer ${login.token}` };
  const auth = { ...authNoBody, "Content-Type": "application/json" };
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
  const stopped = await request(`/api/local-nodes/${created.id}/stop`, { method: "POST", headers: authNoBody });
  if (stopped.node?.enabled || stopped.node?.status !== "disabled") {
    throw new Error(`postgres local node stop did not persist disabled state: ${JSON.stringify(stopped)}`);
  }
  const started = await request(`/api/local-nodes/${created.id}/start`, { method: "POST", headers: authNoBody });
  if (!started.node?.enabled || started.node?.status !== "enabled") {
    throw new Error(`postgres local node start did not persist enabled state: ${JSON.stringify(started)}`);
  }
  const restarted = await request(`/api/local-nodes/${created.id}/restart`, { method: "POST", headers: authNoBody });
  if (!restarted.node?.enabled || !["passed", "warning"].includes(restarted.test?.finalStatus)) {
    throw new Error(`postgres local node restart did not test and enable node: ${JSON.stringify(restarted)}`);
  }
  const disabled = await request(`/api/local-nodes/${created.id}/disable`, { method: "POST", headers: authNoBody });
  if (disabled.enabled || disabled.status !== "disabled") {
    throw new Error(`postgres local node disable did not persist disabled state: ${JSON.stringify(disabled)}`);
  }
  const enabled = await request(`/api/local-nodes/${created.id}/enable`, { method: "POST", headers: authNoBody });
  if (!enabled.enabled || enabled.status !== "enabled") {
    throw new Error(`postgres local node enable did not persist enabled state: ${JSON.stringify(enabled)}`);
  }
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
  const deletedSubscription = await request("/api/subscriptions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "PG subscription delete",
      content: "vless://68686868-6868-4686-8686-686868686868@pg-sub-delete.example.com:443#PgSubDelete"
    })
  });
  const deletedSubscriptionRefresh = await request(`/api/subscriptions/${deletedSubscription.id}/refresh`, { method: "POST", headers: authNoBody });
  if (deletedSubscriptionRefresh.created !== 1 || !deletedSubscriptionRefresh.nodes?.some((node) => node.name === "PgSubDelete")) {
    throw new Error(`postgres subscription delete fixture was not imported before delete: ${JSON.stringify(deletedSubscriptionRefresh)}`);
  }
  await requestNoContent(`/api/subscriptions/${deletedSubscription.id}`, { method: "DELETE", headers: authNoBody });
  await request("/api/system/settings", {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      retention: { realtimeTtlHours: 6, dailySummaryDays: 90, auditLogDays: 365 },
      security: { allowPrivateSubscriptions: true }
    })
  });
  await request("/api/system/update-check", { method: "POST", headers: authNoBody });
  const engineRestart = await request("/api/system/restart", { method: "POST", headers: authNoBody });
  if (!engineRestart.ok) {
    throw new Error(`postgres engine restart endpoint did not return ok: ${JSON.stringify(engineRestart)}`);
  }
  await request("/api/system/traffic/aggregate", { method: "POST", headers: authNoBody });
  const backup = await request("/api/system/backup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ reason: "postgres-smoke" })
  });
  if (!backup.file?.endsWith(".json") || typeof backup.manifest?.state?.backupJobs !== "number") {
    throw new Error(`postgres backup did not return backup job manifest: ${JSON.stringify(backup)}`);
  }
  const restoreOnlyNode = await request("/api/local-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "PG-Restore-Should-Disappear",
      protocol: "http",
      config: { listenHost: "0.0.0.0", listenPort: 20098, exposure: "lan" }
    })
  });
  const restore = await request(`/api/system/backups/${encodeURIComponent(backup.file)}/restore`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.token}` }
  });
  if (restore.file !== backup.file || !restore.preRestoreFile) {
    throw new Error(`postgres restore did not return expected payload: ${JSON.stringify(restore)}`);
  }
  await request("/api/admin/password", {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ password: "admin12345-updated" })
  });
  const logout = await request("/api/auth/logout", { method: "POST", headers: authNoBody });
  if (!logout.ok) throw new Error(`postgres logout endpoint did not return ok: ${JSON.stringify(logout)}`);
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
    const detachedSubscriptionNodes = await client.query(
      `SELECT n.id, n.name, n.config->>'sourceId' AS source_id, n.source_missing, COUNT(v.id)::int AS version_count
       FROM node_configs n
       LEFT JOIN node_config_versions v ON v.node_id = n.id
       WHERE n.name = $1
       GROUP BY n.id, n.name, n.config, n.source_missing`,
      ["PgSubDelete"]
    );
    if (
      detachedSubscriptionNodes.rowCount !== 1 ||
      detachedSubscriptionNodes.rows[0].source_id !== null ||
      detachedSubscriptionNodes.rows[0].source_missing !== true ||
      detachedSubscriptionNodes.rows[0].version_count < 2
    ) {
      throw new Error(`deleted subscription nodes were not detached with source_missing and config versions: ${JSON.stringify(detachedSubscriptionNodes.rows)}`);
    }
    const subscriptionNodeRows = await client.query("SELECT name, source_missing FROM node_configs WHERE config->>'sourceId' = $1 ORDER BY name", [subscription.id]);
    const pgSub = subscriptionNodeRows.rows.find((row) => row.name === "PgSub");
    const pgSubNew = subscriptionNodeRows.rows.find((row) => row.name === "PgSubNew");
    if (!pgSub?.source_missing || !pgSubNew || pgSubNew.source_missing) {
      throw new Error(`subscription source_missing lifecycle was not persisted: ${JSON.stringify(subscriptionNodeRows.rows)}`);
    }
    const removedNode = await client.query("SELECT id FROM node_configs WHERE id = $1", [restoreOnlyNode.id]);
    if (removedNode.rowCount !== 0) {
      throw new Error(`postgres restore did not remove post-backup node: ${JSON.stringify(removedNode.rows)}`);
    }
    const restoreJobs = await client.query("SELECT job_type, status FROM backup_jobs WHERE file_path LIKE $1", [`%${restore.file}`]);
    if (!restoreJobs.rows.some((row) => row.job_type === "restore" && row.status === "passed")) {
      throw new Error(`restore backup_jobs row missing or invalid: ${JSON.stringify(restoreJobs.rows)}`);
    }
    const subscriptionRows = await client.query("SELECT source_type, auto_enable_new_nodes, allow_private_network FROM subscription_sources WHERE id = $1", [subscription.id]);
    if (subscriptionRows.rowCount !== 1 || subscriptionRows.rows[0].source_type !== "content" || !subscriptionRows.rows[0].auto_enable_new_nodes || !subscriptionRows.rows[0].allow_private_network) {
      throw new Error(`subscription option columns were not persisted: ${JSON.stringify(subscriptionRows.rows)}`);
    }
    const securitySettings = await client.query("SELECT value FROM system_settings WHERE key = 'security'");
    if (securitySettings.rowCount !== 1 || securitySettings.rows[0].value?.allowPrivateSubscriptions !== true) {
      throw new Error(`system private subscription setting was not persisted: ${JSON.stringify(securitySettings.rows)}`);
    }
    const settingsAudit = await client.query("SELECT metadata FROM audit_logs WHERE action = 'system.settings.updated' ORDER BY created_at DESC LIMIT 1");
    if (settingsAudit.rowCount !== 1 || settingsAudit.rows[0].metadata?.allowPrivateSubscriptions !== true || !settingsAudit.rows[0].metadata?.keys?.includes("security")) {
      throw new Error(`system private subscription audit metadata missing: ${JSON.stringify(settingsAudit.rows)}`);
    }
    const expectedAuditActions = [
      "admin.password.changed",
      "admin.logout",
      "node.created",
      "node.tested",
      "node.share.rotated",
      "node.started",
      "node.stopped",
      "node.restarted",
      "node.enabled",
      "node.disabled",
      "subscription.created",
      "subscription.updated",
      "subscription.deleted",
      "subscription.nodes.detached",
      "subscription.refresh.succeeded",
      "system.settings.updated",
      "system.update.checked",
      "system.engine.restarted",
      "system.backup.created",
      "system.backup.restored",
      "traffic.aggregated"
    ];
    const auditRows = await client.query(
      "SELECT action FROM audit_logs WHERE action = ANY($1::text[])",
      [expectedAuditActions]
    );
    const auditActions = new Set(auditRows.rows.map((row) => row.action));
    for (const action of expectedAuditActions) {
      if (!auditActions.has(action)) {
        throw new Error(`audit_logs missing ${action}: ${JSON.stringify(auditRows.rows)}`);
      }
    }
    const migrationRow = await client.query("SELECT version, checksum FROM schema_migrations ORDER BY version LIMIT 1");
    if (migrationRow.rowCount !== 1) throw new Error("schema_migrations row missing");
    const { version, checksum } = migrationRow.rows[0];
    await client.query("UPDATE schema_migrations SET checksum = $1 WHERE version = $2", [`broken-${checksum}`, version]);
    try {
      const failedMigrationStartup = await runServerExpectFailure({
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: "19082",
        STORAGE_DRIVER: "postgres",
        DATABASE_URL: databaseUrl,
        ADMIN_USERNAME: adminUsername,
        ADMIN_PASSWORD: "admin12345",
        JWT_SECRET: "postgres-smoke-secret"
      });
      if (failedMigrationStartup.exitCode === 0 || failedMigrationStartup.exitCode === undefined) {
        throw new Error(`migration checksum mismatch did not stop startup: ${JSON.stringify(failedMigrationStartup)}`);
      }
      for (const expected of ["Migration checksum changed", "restore the last good backup", "compensating migration"]) {
        if (!failedMigrationStartup.logs.includes(expected)) {
          throw new Error(`migration checksum startup guidance missing ${expected}:\n${failedMigrationStartup.logs}`);
        }
      }
    } finally {
      await client.query("UPDATE schema_migrations SET checksum = $1 WHERE version = $2", [checksum, version]);
    }
  } finally {
    await client.end();
  }
  console.log("postgres smoke ok");
} finally {
  child.kill();
  if (dockerStarted) {
    await run("docker", ["rm", "-f", dockerContainerName]);
  }
}
