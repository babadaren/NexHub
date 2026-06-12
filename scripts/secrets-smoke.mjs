import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "pcc-secrets-"));
const port = 19084;

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
    JWT_SECRET: "secrets-smoke-secret",
    CONFIG_ENCRYPTION_KEY: "secrets-smoke-encryption-key"
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

  const uuid = "99999999-9999-4999-8999-999999999999";
  const password = "super-secret-password";
  const subscriptionSecret = "subscription-secret-token";
  const node = await request("/api/remote-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Secret Node",
      protocol: "vless",
      config: {
        server: "secret.example.com",
        port: 443,
        uuid,
        password,
        nested: {
          privateKey: "private-key-secret"
        }
      }
    })
  });

  const loaded = await request(`/api/remote-nodes/${node.id}`, { headers: authNoBody });
  if (loaded.config.uuid !== uuid || loaded.config.password !== password) throw new Error("API did not decrypt node config");

  const shareNode = await request("/api/local-nodes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Secret Share",
      protocol: "vless",
      enabled: true,
      config: {
        listenHost: "0.0.0.0",
        listenPort: 20084,
        exposure: "lan",
        uuid: "77777777-7777-4777-8777-777777777777",
        credential: "77777777-7777-4777-8777-777777777777",
        tls: false
      }
    })
  });
  const share = await request(`/api/local-nodes/${shareNode.id}/share`, { headers: authNoBody });
  if (!share.token || !share.tokenIssuedAt) throw new Error("share token was not created for secrets smoke");

  await request("/api/subscriptions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Secret subscription",
      content: `vless://${uuid}@secret-sub.example.com:443#${subscriptionSecret}`
    })
  });

  const backup = await request("/api/system/backup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ reason: "secrets-smoke" })
  });

  const stateRaw = await readFile(path.join(dataDir, "state.json"), "utf8");
  const backupRaw = await readFile(path.join(dataDir, "backups", backup.file), "utf8");
  for (const secret of [uuid, password, "private-key-secret", subscriptionSecret, share.token]) {
    if (stateRaw.includes(secret)) throw new Error(`state file leaked secret: ${secret}`);
    if (backupRaw.includes(secret)) throw new Error(`backup file leaked secret: ${secret}`);
  }
  if (stateRaw.includes("shareTokenHash") || backupRaw.includes("shareTokenHash")) {
    throw new Error("legacy share token fields were written to persisted state");
  }
  if (!stateRaw.includes("nodeConfigVersions") || !stateRaw.includes("shareTokens") || !backupRaw.includes("shareTokens") || !backupRaw.includes("backupJobs")) {
    throw new Error("node versions, share tokens or backup jobs were not persisted as independent state");
  }
  if (!stateRaw.includes("__pcc_encrypted") || !backupRaw.includes("encryptionKeyFingerprint")) {
    throw new Error("encrypted payload markers were not written");
  }

  console.log("secrets smoke ok");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

child.on("exit", (code) => {
  if (code && code !== 0 && !logs.includes("Server listening")) console.error(logs);
});
