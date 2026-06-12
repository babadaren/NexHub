import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-smoke-"));
const port = 19080;
const sensitiveNeedles = ["admin12345", "smoke-secret", "CONFIG_ENCRYPTION_KEY", "JWT_SECRET", "DATABASE_URL", "ADMIN_PASSWORD"];

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

function assertNoSensitiveValue(name, payload) {
  const text = JSON.stringify(payload);
  for (const secret of sensitiveNeedles) {
    if (text.includes(secret)) throw new Error(`${name} leaked sensitive value: ${secret}`);
  }
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
    JWT_SECRET: "smoke-secret",
    NETWORK_MODE: "bridge",
    PUBLIC_BASE_URL: "https://public.example.test/panel/"
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
  if (logs.includes("admin password: admin12345") || logs.includes("admin password:")) {
    throw new Error("explicit ADMIN_PASSWORD was printed in startup logs");
  }
  let auth = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };
  let authNoBody = { Authorization: `Bearer ${login.token}` };
  const logout = await request("/api/auth/logout", { method: "POST", headers: authNoBody });
  if (!logout.ok) throw new Error("logout endpoint did not return ok");
  const relogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin12345" })
  });
  auth = { Authorization: `Bearer ${relogin.token}`, "Content-Type": "application/json" };
  authNoBody = { Authorization: `Bearer ${relogin.token}` };

  const dashboard = await request("/api/dashboard/summary", { headers: auth });
  if (dashboard.metrics.length !== 6) throw new Error("dashboard metrics missing");
  const dashboardText = JSON.stringify(dashboard);
  for (const placeholder of ["JP-02", "US-01", "Relay-HK 公网可达"]) {
    if (dashboardText.includes(placeholder)) throw new Error(`dashboard leaked placeholder alert: ${placeholder}`);
  }

  const realtime = await request("/api/realtime/summary", { headers: authNoBody });
  if (realtime.points.length !== 0 || realtime.now.inboundMbps !== 0 || realtime.now.outboundMbps !== 0) {
    throw new Error("realtime summary returned fabricated traffic data without Redis samples");
  }

  const ready = await request("/ready");
  if (!ready.ready || ready.checks.app.status !== "ok" || ready.checks.engine.status !== "ok") {
    throw new Error("ready endpoint did not report expected healthy state");
  }
  assertNoSensitiveValue("ready endpoint", ready);

  const installStatus = await request("/api/install/status");
  if (installStatus.adminUsername !== "admin" || installStatus.loginPath !== "/login" || !installStatus.passwordCommand.includes("docker compose logs app")) {
    throw new Error("install status did not include expected first-run guidance");
  }
  assertNoSensitiveValue("install status", installStatus);

  const unauthenticatedSystemStatus = await rawRequest("/api/system/status");
  if (unauthenticatedSystemStatus.status !== 401) {
    throw new Error(`system status allowed unauthenticated access: ${unauthenticatedSystemStatus.status}`);
  }

  const systemStatus = await request("/api/system/status", { headers: authNoBody });
  assertNoSensitiveValue("system status", systemStatus);
  if (!systemStatus.ready || systemStatus.ports.localTcpPortRange !== "20000-20100" || !systemStatus.storage.dataDir) {
    throw new Error("system status did not include deployment and port metadata");
  }
  if (systemStatus.deployment.mode !== "development" || systemStatus.storage.releaseMode !== false) {
    throw new Error("system status did not expose expected server mode");
  }
  if (systemStatus.deployment.networkMode !== "bridge" || systemStatus.deployment.advancedNetwork !== false) {
    throw new Error(`system status did not expose default bridge network mode: ${JSON.stringify(systemStatus.deployment)}`);
  }
  if (systemStatus.deployment.app !== "ok" || systemStatus.deployment.postgres !== "json-dev" || typeof systemStatus.deployment.redis !== "string" || typeof systemStatus.deployment.engine !== "string") {
    throw new Error(`system status did not expose explicit deployment components: ${JSON.stringify(systemStatus.deployment)}`);
  }
  if (!systemStatus.disk.path || systemStatus.checks.migrations.status !== "ok") {
    throw new Error("system status did not include disk or migration checks");
  }

  const localNodes = await request("/api/local-nodes", { headers: authNoBody });
  if (localNodes.length !== 0) throw new Error("fresh install should not include seed or placeholder local nodes");
  const invalidNodeCreate = await rawRequest("/api/remote-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "",
      protocol: "vless",
      config: {
        server: "invalid-node.example.com",
        port: 443
      }
    })
  });
  if (invalidNodeCreate.status !== 400) throw new Error(`invalid node create returned ${invalidNodeCreate.status}`);
  const invalidNodeError = await invalidNodeCreate.json();
  if (invalidNodeError.code !== "VALIDATION_ERROR" || invalidNodeError.field !== "name" || !invalidNodeError.fields?.includes("name") || !invalidNodeError.suggestion) {
    throw new Error(`invalid node create did not return field-level validation guidance: ${JSON.stringify(invalidNodeError)}`);
  }
  const draftOnly = await request("/api/remote-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Draft-Only",
      protocol: "vless",
      config: {
        server: "draft-only.example.com",
        port: 443,
        uuid: "12121212-1212-4212-8212-121212121212",
        tls: true
      }
    })
  });
  if (draftOnly.enabled || draftOnly.status !== "draft" || draftOnly.lastTestStatus) {
    throw new Error(`untested node create was not kept as draft: ${JSON.stringify(draftOnly)}`);
  }
  const testedCreate = await request("/api/remote-nodes/test-create", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Test-Create",
      protocol: "vless",
      config: {
        server: "test-create.example.com",
        port: 443,
        uuid: "13131313-1313-4313-8313-131313131313",
        tls: true
      }
    })
  });
  if (!testedCreate.node?.enabled || testedCreate.node.status !== "enabled" || !["passed", "warning"].includes(testedCreate.test?.finalStatus)) {
    throw new Error(`test-create did not test and enable valid node: ${JSON.stringify(testedCreate)}`);
  }
  const localNode = await request("/api/local-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Smoke-Local",
      protocol: "vless",
      enabled: true,
      config: {
        listenHost: "0.0.0.0",
        listenPort: 20001,
        exposure: "public",
        uuid: "33333333-3333-4333-8333-333333333333",
        credential: "33333333-3333-4333-8333-333333333333",
        tls: false,
        sharePublicHost: "127.0.0.1"
      }
    })
  });
  if (!localNode.enabled || localNode.status !== "enabled" || !["passed", "warning"].includes(localNode.lastTestStatus)) {
    throw new Error("local node fixture was not tested before being enabled");
  }
  const share = await request(`/api/local-nodes/${localNode.id}/share`, { headers: authNoBody });
  if (!share.token || !share.subscriptionPath) throw new Error("local share did not return token");
  if (!share.tokenIssuedAt) throw new Error("local share did not expose token issue time");
  const localNodeAfterShare = await request(`/api/local-nodes/${localNode.id}`, { headers: authNoBody });
  if ("shareTokenHash" in localNodeAfterShare.config || "shareTokenIssuedAt" in localNodeAfterShare.config) {
    throw new Error("local node config leaked share token persistence fields");
  }
  if (share.qrPayload !== share.subscription || !share.clash?.includes("proxies:") || !share.singBox?.outbounds?.length) {
    throw new Error("local share did not include QR, Clash and Sing-box payloads");
  }
  if (!share.message.includes("可信设备")) throw new Error("local share did not include credential risk guidance");
  const publicShare = await request(share.subscriptionPath);
  if (publicShare.link !== share.link) throw new Error("public share did not return expected link");
  const rotated = await request(`/api/local-nodes/${localNode.id}/share/rotate`, {
    method: "POST",
    headers: authNoBody
  });
  if (!rotated.token || rotated.token === share.token) throw new Error("share token did not rotate");
  if (!rotated.tokenIssuedAt || rotated.tokenIssuedAt === share.tokenIssuedAt) throw new Error("share token issue time did not update after rotation");
  const oldShareResponse = await rawRequest(share.subscriptionPath);
  if (oldShareResponse.status !== 404) throw new Error("old share token remained valid after rotation");
  const rotatedPublicShare = await request(rotated.subscriptionPath);
  if (rotatedPublicShare.link !== rotated.link) throw new Error("rotated public share did not return expected link");

  const fallbackShareNode = await request("/api/local-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Fallback-Share",
      protocol: "vless",
      enabled: true,
      config: {
        listenHost: "0.0.0.0",
        listenPort: 20002,
        exposure: "public",
        uuid: "44444444-4444-4444-8444-444444444444",
        credential: "44444444-4444-4444-8444-444444444444",
        tls: false
      }
    })
  });
  const fallbackShare = await request(`/api/local-nodes/${fallbackShareNode.id}/share`, { headers: authNoBody });
  if (!fallbackShare.subscription?.startsWith("https://public.example.test/panel/sub/")) {
    throw new Error(`local share did not use PUBLIC_BASE_URL for subscription: ${fallbackShare.subscription}`);
  }
  if (!fallbackShare.link.includes("@public.example.test:20002") || fallbackShare.link.includes("proxy.example.com")) {
    throw new Error(`local share did not use PUBLIC_BASE_URL for single-node URI: ${fallbackShare.link}`);
  }
  const forwardedShare = await request(`/api/local-nodes/${fallbackShareNode.id}/share/rotate`, {
    method: "POST",
    headers: {
      ...authNoBody,
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "panel.example.test"
    }
  });
  if (!forwardedShare.subscription?.startsWith("https://public.example.test/panel/sub/")) {
    throw new Error(`PUBLIC_BASE_URL did not take priority over X-Forwarded-* for subscription: ${forwardedShare.subscription}`);
  }
  if (!forwardedShare.link.includes("@public.example.test:20002") || !forwardedShare.clash.includes("server: public.example.test")) {
    throw new Error(`PUBLIC_BASE_URL did not take priority over X-Forwarded-* for node payload: ${JSON.stringify(forwardedShare)}`);
  }

  const localPublicCheck = await request(`/api/local-nodes/${localNode.id}/public-check`, {
    method: "POST",
    headers: authNoBody
  });
  if (localPublicCheck.reachable || !localPublicCheck.port.includes("已在 Docker 映射范围内") || !localPublicCheck.suggestion.includes("未接入外部探测服务")) {
    throw new Error(`local public check did not explain mapped port and external probe state: ${JSON.stringify(localPublicCheck)}`);
  }

  const restartedLocal = await request(`/api/local-nodes/${localNode.id}/restart`, {
    method: "POST",
    headers: authNoBody
  });
  if (!restartedLocal.node.enabled || !["passed", "warning"].includes(restartedLocal.test.finalStatus) || !restartedLocal.engine) {
    throw new Error("local node restart did not return enabled node, test result and engine status");
  }

  const blockedLocal = await request("/api/local-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Blocked-Port",
      protocol: "http",
      enabled: true,
      config: {
        listenHost: "0.0.0.0",
        listenPort: 25000,
        exposure: "public"
      }
    })
  });
  if (blockedLocal.enabled || blockedLocal.status !== "draft" || blockedLocal.lastTestStatus !== "failed") {
    throw new Error("out-of-range local node was enabled during create");
  }

  const publicPresetLocal = await request("/api/local-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Public-Preset",
      protocol: "vless",
      enabled: true,
      config: {
        listenHost: "0.0.0.0",
        listenPort: 443,
        exposure: "public",
        uuid: "11111111-1111-4111-8111-111111111111",
        credential: "11111111-1111-4111-8111-111111111111",
        tls: true
      }
    })
  });
  if (publicPresetLocal.enabled || publicPresetLocal.status !== "draft" || publicPresetLocal.config.exposure !== "public") {
    throw new Error("public local preset was not protected as draft when Docker port was unmapped");
  }

  const publicPresetCheck = await request(`/api/local-nodes/${publicPresetLocal.id}/public-check`, {
    method: "POST",
    headers: authNoBody
  });
  if (publicPresetCheck.reachable || !publicPresetCheck.port.includes("未映射") || !publicPresetCheck.suggestion.includes("Docker 宿主机")) {
    throw new Error(`public preset check did not expose Docker mapping failure: ${JSON.stringify(publicPresetCheck)}`);
  }

  const blockedTest = await request(`/api/local-nodes/${blockedLocal.id}/test`, {
    method: "POST",
    headers: authNoBody
  });
  if (blockedTest.finalStatus !== "failed" || !blockedTest.humanMessage.includes("没有映射到 Docker 宿主机")) {
    throw new Error("out-of-range local node test did not expose Docker port mapping failure");
  }

  const blockedStart = await rawRequest(`/api/local-nodes/${blockedLocal.id}/start`, {
    method: "POST",
    headers: authNoBody
  });
  if (blockedStart.status !== 400) throw new Error("out-of-range local node start was not blocked");
  const blockedStartError = await blockedStart.json();
  if (blockedStartError.code !== "LOCAL_NODE_START_BLOCKED" || !blockedStartError.message.includes("Docker 宿主机") || !blockedStartError.suggestion) {
    throw new Error(`out-of-range local node start did not return structured guidance: ${JSON.stringify(blockedStartError)}`);
  }

  const blockedEnable = await rawRequest(`/api/local-nodes/${blockedLocal.id}/enable`, {
    method: "POST",
    headers: authNoBody
  });
  if (blockedEnable.status !== 400) throw new Error("out-of-range local node enable was not blocked");
  const blockedEnableError = await blockedEnable.json();
  if (blockedEnableError.code !== "NODE_ENABLE_BLOCKED" || !blockedEnableError.message.includes("Docker 宿主机") || !blockedEnableError.suggestion) {
    throw new Error(`out-of-range local node enable did not return structured guidance: ${JSON.stringify(blockedEnableError)}`);
  }

  const blockedRestart = await rawRequest(`/api/local-nodes/${blockedLocal.id}/restart`, {
    method: "POST",
    headers: authNoBody
  });
  if (blockedRestart.status !== 400) throw new Error("out-of-range local node restart was not blocked");
  const blockedRestartError = await blockedRestart.json();
  if (blockedRestartError.code !== "LOCAL_NODE_RESTART_BLOCKED" || !blockedRestartError.message.includes("Docker 宿主机") || !blockedRestartError.suggestion) {
    throw new Error(`out-of-range local node restart did not return structured guidance: ${JSON.stringify(blockedRestartError)}`);
  }

  const blockedNodeEvents = await request("/api/dashboard/events", { headers: authNoBody });
  for (const [action, code] of [
    ["node.start.failed", "LOCAL_NODE_START_BLOCKED"],
    ["node.enable.failed", "NODE_ENABLE_BLOCKED"],
    ["node.restart.failed", "LOCAL_NODE_RESTART_BLOCKED"]
  ]) {
    if (!blockedNodeEvents.some((event) => event.action === action && event.targetId === blockedLocal.id && event.metadata?.code === code)) {
      throw new Error(`blocked local node audit event missing ${action}: ${JSON.stringify(blockedNodeEvents)}`);
    }
  }

  const stoppedLocal = await request(`/api/local-nodes/${localNode.id}/stop`, {
    method: "POST",
    headers: authNoBody
  });
  if (stoppedLocal.node.enabled || stoppedLocal.node.status !== "disabled") {
    throw new Error("local node stop did not disable node");
  }
  const crossDirectionPatch = await rawRequest(`/api/remote-nodes/${localNode.id}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      name: "Cross-Direction-Should-Not-Apply"
    })
  });
  if (crossDirectionPatch.status !== 404) {
    throw new Error(`cross-direction patch returned ${crossDirectionPatch.status}: ${await crossDirectionPatch.text()}`);
  }
  const crossDirectionDisable = await rawRequest(`/api/remote-nodes/${localNode.id}/disable`, {
    method: "POST",
    headers: authNoBody
  });
  if (crossDirectionDisable.status !== 404) {
    throw new Error(`cross-direction disable returned ${crossDirectionDisable.status}: ${await crossDirectionDisable.text()}`);
  }
  const localAfterCrossDirection = await request(`/api/local-nodes/${localNode.id}`, { headers: authNoBody });
  if (localAfterCrossDirection.name === "Cross-Direction-Should-Not-Apply") {
    throw new Error("cross-direction patch mutated local node through remote route");
  }

  const parsed = await request("/api/remote-nodes/import/parse", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ input: "vless://22222222-2222-4222-8222-222222222222@smoke-import.example.com:443?security=tls&type=tcp#Smoke-Import" })
  });
  if (parsed.nodes[0].status !== "parsed" || parsed.nodes[0].config.server !== "smoke-import.example.com") {
    throw new Error("import parser did not return expected vless node");
  }
  if (parsed.nodes[0].sourceFormat !== "share-link" || !parsed.nodes[0].fingerprint) {
    throw new Error("smart import preview did not include source format and fingerprint");
  }

  const applied = await request("/api/remote-nodes/import/apply", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ nodes: parsed.nodes })
  });
  if (applied.created !== 1 || applied.status !== "passed") throw new Error("import apply did not create node");
  if (!applied.nodes[0]?.id) throw new Error("import apply did not return created node for success next actions");

  const created = await request("/api/remote-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: parsed.nodes[0].name,
      protocol: parsed.nodes[0].protocol,
      config: parsed.nodes[0].config
    })
  });

  const patchedNode = await request(`/api/remote-nodes/${created.id}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      name: "Smoke-Edited",
      config: { ...created.config, server: "smoke-edited.example.com", port: 443 }
    })
  });
  if (patchedNode.name !== "Smoke-Edited" || patchedNode.enabled || patchedNode.status !== "draft" || patchedNode.config.server !== "smoke-edited.example.com") {
    throw new Error("node patch did not persist editable fields as draft");
  }
  const bypassEnablePatch = await rawRequest(`/api/remote-nodes/${created.id}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      enabled: true,
      status: "enabled"
    })
  });
  if (bypassEnablePatch.status !== 400) {
    throw new Error(`node patch allowed direct enable bypass: ${bypassEnablePatch.status} ${await bypassEnablePatch.text()}`);
  }
  const bypassEnableError = await bypassEnablePatch.json();
  if (bypassEnableError.code !== "VALIDATION_ERROR" || !bypassEnableError.suggestion) {
    throw new Error(`node patch bypass did not return validation guidance: ${JSON.stringify(bypassEnableError)}`);
  }

  const disabledNode = await request(`/api/remote-nodes/${created.id}/disable`, {
    method: "POST",
    headers: authNoBody
  });
  if (disabledNode.enabled || disabledNode.status !== "disabled") throw new Error("node disable did not persist disabled state");

  const enabledNode = await request(`/api/remote-nodes/${created.id}/enable`, {
    method: "POST",
    headers: authNoBody
  });
  if (!enabledNode.enabled || enabledNode.status !== "enabled") throw new Error("node enable did not persist enabled state");

  const detailBeforeTest = await request(`/api/remote-nodes/${created.id}`, { headers: authNoBody });
  if (detailBeforeTest.realtime.points.length !== 0 || detailBeforeTest.realtime.activeConnections !== 0) {
    throw new Error("node detail returned fabricated realtime points before test data existed");
  }

  const tested = await request(`/api/remote-nodes/${created.id}/test`, {
    method: "POST",
    headers: authNoBody
  });
  if (!["passed", "warning"].includes(tested.finalStatus)) throw new Error("node test did not pass");
  const detailAfterTest = await request(`/api/remote-nodes/${created.id}`, { headers: authNoBody });
  if (detailAfterTest.realtime.points.length !== 0 || detailAfterTest.realtime.status !== "enabled" || !detailAfterTest.realtime.latencyMs || detailAfterTest.realtime.activeConnections < 0) {
    throw new Error("node detail did not expose test-backed realtime summary after test");
  }

  const history = await request("/api/history/summary", { headers: authNoBody });
  if (history.days !== 14 || history.daily.length !== 14 || history.totals.passedTests + history.totals.warningTests < 1) {
    throw new Error("history summary did not include recent test aggregate");
  }

  const engineConfig = JSON.parse(await readFile(path.join(dataDir, "engine", "current.json"), "utf8"));
  if (!engineConfig.outbounds.some((item) => item.server === "smoke-edited.example.com" && item.type === "vless")) {
    throw new Error("engine config did not include edited node");
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
  if (subscription.sourceType !== "content" || subscription.autoEnableNewNodes || subscription.allowPrivateNetwork) {
    throw new Error(`subscription default options were not persisted: ${JSON.stringify(subscription)}`);
  }
  const refreshed = await request(`/api/subscriptions/${subscription.id}/refresh`, {
    method: "POST",
    headers: authNoBody
  });
  if (refreshed.created !== 1 || refreshed.status !== "passed") throw new Error("subscription refresh did not create node");
  let remoteNodesAfterRefresh = await request("/api/remote-nodes", { headers: authNoBody });
  const smokeClashNode = remoteNodesAfterRefresh.find((node) => node.name === "Smoke-Clash");
  if (!smokeClashNode || smokeClashNode.sourceMissing || smokeClashNode.config.sourceId !== subscription.id) {
    throw new Error(`subscription refresh did not attach active node source: ${JSON.stringify(smokeClashNode)}`);
  }

  await request(`/api/subscriptions/${subscription.id}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      content: `
proxies:
  - name: Smoke-Clash-New
    type: vless
    server: smoke-clash-new.example.com
    port: 443
    uuid: 56565656-5656-4656-8656-565656565656
    tls: true
`
    })
  });
  const refreshedMissing = await request(`/api/subscriptions/${subscription.id}/refresh`, {
    method: "POST",
    headers: authNoBody
  });
  if (refreshedMissing.created !== 1 || refreshedMissing.status !== "passed") {
    throw new Error(`subscription refresh did not import replacement node: ${JSON.stringify(refreshedMissing)}`);
  }
  remoteNodesAfterRefresh = await request("/api/remote-nodes", { headers: authNoBody });
  const missingClashNode = remoteNodesAfterRefresh.find((node) => node.id === smokeClashNode.id);
  const replacementClashNode = remoteNodesAfterRefresh.find((node) => node.name === "Smoke-Clash-New");
  if (!missingClashNode?.sourceMissing || missingClashNode.config.sourceId !== subscription.id) {
    throw new Error(`subscription refresh did not mark missing old node: ${JSON.stringify(missingClashNode)}`);
  }
  if (!replacementClashNode || replacementClashNode.sourceMissing) {
    throw new Error(`subscription refresh marked replacement node missing: ${JSON.stringify(replacementClashNode)}`);
  }

  await request(`/api/subscriptions/${subscription.id}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
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
  const refreshedBack = await request(`/api/subscriptions/${subscription.id}/refresh`, {
    method: "POST",
    headers: authNoBody
  });
  if (refreshedBack.updated !== 1 || refreshedBack.status !== "passed") {
    throw new Error(`subscription refresh did not revive missing node: ${JSON.stringify(refreshedBack)}`);
  }
  remoteNodesAfterRefresh = await request("/api/remote-nodes", { headers: authNoBody });
  const revivedClashNode = remoteNodesAfterRefresh.find((node) => node.id === smokeClashNode.id);
  if (!revivedClashNode || revivedClashNode.sourceMissing) {
    throw new Error(`subscription refresh did not clear sourceMissing on revived node: ${JSON.stringify(revivedClashNode)}`);
  }

  const subscriptions = await request("/api/subscriptions", { headers: authNoBody });
  if (subscriptions[0].lastRefreshStatus !== "passed" || !subscriptions[0].lastRefreshMessage.includes("旧节点已标记为订阅缺失")) {
    throw new Error(`subscription missing marker status was not persisted: ${JSON.stringify(subscriptions[0])}`);
  }

  const backup = await request("/api/system/backup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ reason: "smoke" })
  });
  if (!backup.file.endsWith(".json") || backup.manifest.state.nodes < 3) throw new Error("backup manifest did not include current state");
  if (backup.manifest.state.nodeConfigVersions < backup.manifest.state.nodes || backup.manifest.state.shareTokens < 1 || typeof backup.manifest.state.backupJobs !== "number") {
    throw new Error(`backup manifest did not include operational state counts: ${JSON.stringify(backup.manifest.state)}`);
  }
  const backupPayload = JSON.parse(await readFile(path.join(dataDir, "backups", backup.file), "utf8"));
  if (!backupPayload.state?.nodes?.length || !backupPayload.manifest?.containsSecrets || typeof backupPayload.manifest.state?.backupJobs !== "number") {
    throw new Error("backup payload missing state, job count or manifest");
  }
  const stateAfterBackup = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
  if (!stateAfterBackup.nodeConfigVersions?.some((version) => version.nodeId === localNode.id)) {
    throw new Error("node config versions were not persisted in JSON state");
  }
  if (!stateAfterBackup.backupJobs?.some((job) => job.jobType === "backup" && job.status === "passed" && String(job.filePath ?? "").endsWith(backup.file))) {
    throw new Error("backup job was not persisted after backup creation");
  }
  const auditAfterBackup = await request("/api/dashboard/events", { headers: authNoBody });
  if (!auditAfterBackup.some((event) => event.action === "system.backup.created")) {
    throw new Error(`backup creation audit event missing: ${JSON.stringify(auditAfterBackup)}`);
  }

  const backups = await request("/api/system/backups", { headers: authNoBody });
  if (!backups.some((item) => item.file === backup.file)) throw new Error("backup list did not include created backup");

  const missingRestore = await rawRequest("/api/system/backups/backup-missing.json/restore", {
    method: "POST",
    headers: authNoBody
  });
  if (missingRestore.status !== 404) throw new Error(`missing backup restore returned ${missingRestore.status}`);
  const missingRestoreError = await missingRestore.json();
  if (missingRestoreError.code !== "BACKUP_NOT_FOUND" || !missingRestoreError.suggestion) {
    throw new Error(`missing backup restore did not return structured guidance: ${JSON.stringify(missingRestoreError)}`);
  }

  const invalidSettings = await rawRequest("/api/system/settings", {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ retention: { realtimeTtlHours: 99 } })
  });
  if (invalidSettings.status !== 400) throw new Error(`invalid settings patch returned ${invalidSettings.status}`);
  const invalidSettingsError = await invalidSettings.json();
  if (invalidSettingsError.code !== "VALIDATION_ERROR" || !invalidSettingsError.suggestion) {
    throw new Error(`invalid settings patch did not return structured guidance: ${JSON.stringify(invalidSettingsError)}`);
  }

  await request(`/api/remote-nodes/${created.id}`, {
    method: "DELETE",
    headers: authNoBody
  });
  const afterDelete = await request("/api/remote-nodes", { headers: authNoBody });
  if (afterDelete.some((node) => node.id === created.id)) throw new Error("node delete before restore failed");
  const auditAfterNodeDelete = await request("/api/dashboard/events", { headers: authNoBody });
  if (!auditAfterNodeDelete.some((event) => event.action === "node.deleted" && event.targetId === created.id)) {
    throw new Error(`node delete audit event missing: ${JSON.stringify(auditAfterNodeDelete)}`);
  }

  const restore = await request(`/api/system/backups/${encodeURIComponent(backup.file)}/restore`, {
    method: "POST",
    headers: authNoBody
  });
  if (!restore.preRestoreFile || restore.file !== backup.file) throw new Error("restore did not return pre-restore backup");
  const afterRestore = await request("/api/remote-nodes", { headers: authNoBody });
  if (!afterRestore.some((node) => node.id === created.id)) throw new Error("restore did not recover deleted node");
  const auditAfterRestore = await request("/api/dashboard/events", { headers: authNoBody });
  if (!auditAfterRestore.some((event) => event.action === "system.backup.restored")) {
    throw new Error(`backup restore audit event missing: ${JSON.stringify(auditAfterRestore)}`);
  }

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
