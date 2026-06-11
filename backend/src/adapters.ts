import type { Direction } from "./types.js";

export const protocols = {
  remote: ["smart", "http", "socks5", "shadowsocks", "vmess", "vless", "trojan", "wireguard", "hysteria2", "tuic", "ssh_tunnel"],
  local: ["http", "socks5", "shadowsocks", "vless", "trojan", "wireguard", "hysteria2"]
} satisfies Record<Direction, string[]>;

const baseFields = [
  { key: "name", label: "节点名称", type: "text", required: true },
  { key: "server", label: "服务器地址", type: "text", required: true },
  { key: "port", label: "端口", type: "number", required: true }
];

export function schemaFor(protocol: string, direction: Direction) {
  const remoteCredential = protocol === "trojan" || protocol === "shadowsocks" || protocol === "hysteria2" ? "密码" : "UUID / 密钥";
  if (direction === "remote") {
    return {
      protocol,
      direction,
      required_fields: [
        ...baseFields,
        { key: "credential", label: remoteCredential, type: "password", required: protocol !== "smart" }
      ],
      advanced_fields: [
        { key: "transport.type", label: "传输方式", type: "select", options: ["tcp", "ws", "grpc", "quic"] },
        { key: "tls.sni", label: "TLS SNI", type: "text" },
        { key: "reality.publicKey", label: "Reality PublicKey", type: "password" },
        { key: "fingerprint", label: "Fingerprint", type: "text" }
      ]
    };
  }
  return {
    protocol,
    direction,
    required_fields: [
      { key: "name", label: "节点名称", type: "text", required: true },
      { key: "listenHost", label: "监听地址", type: "text", required: true },
      { key: "listenPort", label: "监听端口", type: "number", required: true },
      { key: "exposure", label: "开放范围", type: "select", options: ["local", "lan", "public", "relay"], required: true }
    ],
    advanced_fields: [
      { key: "routeMode", label: "转发方式", type: "select", options: ["direct", "forward_to_remote"] },
      { key: "tls.enabled", label: "TLS", type: "checkbox" },
      { key: "share.publicHost", label: "分享域名", type: "text" }
    ]
  };
}

export function parseImport(input: string) {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = lines.length ? lines : [input.trim()];
  return candidates.map((line, index) => {
    const protocol = line.includes("://") ? line.split("://")[0] : "smart";
    return {
      id: `parsed-${index + 1}`,
      name: `${protocol.toUpperCase()}-${index + 1}`,
      protocol,
      server: protocol === "smart" ? "subscription.example.com" : "imported.example.com",
      port: protocol === "http" ? 8080 : 443,
      status: "parsed",
      raw: line
    };
  });
}
