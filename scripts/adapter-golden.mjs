import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { parseImport, renderNodeEngineConfig, validateNodeConfig, buildShareLink } from "../backend/dist/adapters.js";

const vmessPayload = Buffer.from(
  JSON.stringify({
    v: "2",
    ps: "VMess-HK",
    add: "vmess.example.com",
    port: "443",
    id: "11111111-1111-4111-8111-111111111111",
    aid: "0",
    net: "tcp",
    type: "none",
    host: "",
    path: "",
    tls: "tls",
    sni: "vmess.example.com"
  })
).toString("base64url");

const fixtures = [
  {
    raw: "vless://22222222-2222-4222-8222-222222222222@vless.example.com:443?security=tls&type=tcp&sni=vless.example.com#VLESS-HK",
    protocol: "vless",
    server: "vless.example.com",
    engineType: "vless"
  },
  {
    raw: "trojan://secret@trojan.example.com:443?sni=trojan.example.com#Trojan-HK",
    protocol: "trojan",
    server: "trojan.example.com",
    engineType: "trojan"
  },
  {
    raw: `vmess://${vmessPayload}`,
    protocol: "vmess",
    server: "vmess.example.com",
    engineType: "vmess"
  },
  {
    raw: "ss://YWVzLTEyOC1nY206cGFzcw@ss.example.com:8388#SS-HK",
    protocol: "shadowsocks",
    server: "ss.example.com",
    engineType: "shadowsocks"
  },
  {
    raw: "socks5://user:pass@socks.example.com:1080#SOCKS-HK",
    protocol: "socks5",
    server: "socks.example.com",
    engineType: "socks"
  },
  {
    raw: "http://user:pass@http.example.com:8080#HTTP-HK",
    protocol: "http",
    server: "http.example.com",
    engineType: "http"
  },
  {
    raw: "wireguard://private-key@wg.example.com:51820?publickey=peer-public-key&address=10.7.0.2/32&mtu=1420#WG-HK",
    protocol: "wireguard",
    server: "wg.example.com",
    engineType: "wireguard"
  },
  {
    raw: "hysteria2://hy-secret@hy2.example.com:443?sni=hy2.example.com&obfs=salamander&obfs-password=obfs-pass#HY2-HK",
    protocol: "hysteria2",
    server: "hy2.example.com",
    engineType: "hysteria2"
  },
  {
    raw: "tuic://77777777-7777-4777-8777-777777777777:tuic-pass@tuic.example.com:443?sni=tuic.example.com&congestion_control=bbr#TUIC-HK",
    protocol: "tuic",
    server: "tuic.example.com",
    engineType: "tuic"
  },
  {
    raw: "ssh://root:ssh-pass@ssh.example.com:22#SSH-HK",
    protocol: "ssh_tunnel",
    server: "ssh.example.com",
    engineType: "ssh"
  }
];

for (const fixture of fixtures) {
  const [node] = parseImport(fixture.raw);
  assert.equal(node.status, "parsed", `${fixture.protocol} should parse`);
  assert.equal(node.protocol, fixture.protocol);
  assert.equal(node.server, fixture.server);
  const validation = validateNodeConfig(node.protocol, "remote", node.config);
  assert.equal(validation.ok, true, `${fixture.protocol} should validate: ${JSON.stringify(validation.errors)}`);
  const engine = renderNodeEngineConfig({
    id: `test-${fixture.protocol}`,
    direction: "remote",
    name: node.name,
    protocol: node.protocol,
    status: "enabled",
    enabled: true,
    config: node.config,
    safeSummary: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  assert.equal(engine.type, fixture.engineType);
  assert.equal(engine.server, fixture.server);
}

const clash = parseImport(`
proxies:
  - name: Clash-VLESS
    type: vless
    server: clash-vless.example.com
    port: 443
    uuid: 44444444-4444-4444-8444-444444444444
    tls: true
  - { name: Clash-SS, type: ss, server: clash-ss.example.com, port: 8388, cipher: aes-128-gcm, password: pass }
`);
assert.equal(clash.length, 2);
assert.equal(clash[0].status, "parsed");
assert.equal(clash[0].sourceFormat, "clash");
assert.equal(clash[0].server, "clash-vless.example.com");
assert.equal(clash[1].protocol, "shadowsocks");
assert.equal(clash[1].config.password, "pass");

const singBox = parseImport(
  JSON.stringify({
    outbounds: [
      { type: "direct", tag: "direct" },
      {
        type: "trojan",
        tag: "SingBox-Trojan",
        server: "singbox-trojan.example.com",
        server_port: 443,
        password: "secret",
        tls: { enabled: true, server_name: "singbox-trojan.example.com" }
      }
    ]
  })
);
assert.equal(singBox.length, 1);
assert.equal(singBox[0].protocol, "trojan");
assert.equal(singBox[0].sourceFormat, "sing-box");
assert.equal(singBox[0].server, "singbox-trojan.example.com");

const subscription = Buffer.from(fixtures[0].raw).toString("base64url");
const [subscriptionNode] = parseImport(subscription);
assert.equal(subscriptionNode.status, "parsed");
assert.equal(subscriptionNode.sourceFormat, "base64-subscription");
assert.equal(subscriptionNode.server, "vless.example.com");

const local = {
  id: "local-vless",
  direction: "local",
  name: "Local-VLESS",
  protocol: "vless",
  status: "enabled",
  enabled: true,
  config: {
    listenHost: "0.0.0.0",
    listenPort: 20001,
    uuid: "33333333-3333-4333-8333-333333333333",
    tls: false,
    publicHost: "proxy.example.com"
  },
  safeSummary: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const link = buildShareLink(local);
assert.ok(link.startsWith("vless://33333333-3333-4333-8333-333333333333@proxy.example.com:20001"));
const inbound = renderNodeEngineConfig(local);
assert.equal(inbound.type, "vless");
assert.equal(inbound.listen_port, 20001);

console.log("adapter golden ok");
