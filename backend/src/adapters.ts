import { Buffer } from "node:buffer";
import type { Direction, NodeConfig } from "./types.js";

export interface ParsedNode {
  id: string;
  name: string;
  protocol: string;
  server?: string;
  port?: number;
  status: "parsed" | "failed";
  raw: string;
  config: Record<string, unknown>;
  error?: string;
  fingerprint?: string;
  sourceFormat?: string;
}

export interface AdapterValidation {
  ok: boolean;
  errors: Array<{ field: string; message: string }>;
}

export interface NodeAdapter {
  protocol: string;
  direction: Direction | "both";
  parseLink?: (input: string) => ParsedNode;
  validate: (config: Record<string, unknown>, direction: Direction) => AdapterValidation;
  mask: (config: Record<string, unknown>, direction: Direction) => Record<string, unknown>;
  renderEngineConfig: (node: NodeConfig) => Record<string, unknown>;
  buildShareLink?: (node: NodeConfig) => string;
}

export const protocols = {
  remote: ["smart", "http", "socks5", "shadowsocks", "vmess", "vless", "trojan", "wireguard", "hysteria2", "tuic", "ssh_tunnel"],
  local: ["http", "socks5", "shadowsocks", "vless", "trojan", "wireguard", "hysteria2"]
} satisfies Record<Direction, string[]>;

const requiredRemote = ["server", "port"];
const requiredLocal = ["listenHost", "listenPort"];

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function baseValidate(config: Record<string, unknown>, direction: Direction, extra: string[] = []): AdapterValidation {
  const fields = direction === "remote" ? requiredRemote : requiredLocal;
  const errors: AdapterValidation["errors"] = [];
  for (const field of [...fields, ...extra]) {
    const value = config[field];
    if (value === undefined || value === null || value === "") errors.push({ field, message: `${field} is required` });
  }
  const port = asNumber(direction === "remote" ? config.port : config.listenPort);
  if (!port || port < 1 || port > 65535) errors.push({ field: direction === "remote" ? "port" : "listenPort", message: "port must be 1-65535" });
  return { ok: errors.length === 0, errors };
}

function maskSecrets(config: Record<string, unknown>) {
  const copy = structuredClone(config) as Record<string, unknown>;
  for (const key of ["password", "credential", "uuid", "privateKey", "private_key", "token", "subscriptionUrl"]) {
    if (copy[key]) copy[key] = "********";
  }
  return copy;
}

function parsed(raw: string, protocol: string, config: Record<string, unknown>, name?: string): ParsedNode {
  return {
    id: `parsed-${fingerprintNode(protocol, config, raw)}`,
    name: name || `${protocol.toUpperCase()} ${asString(config.server) ?? "node"}`,
    protocol,
    server: asString(config.server),
    port: asNumber(config.port),
    status: "parsed",
    raw,
    config,
    fingerprint: fingerprintNode(protocol, config, raw)
  };
}

function failed(raw: string, protocol: string, error: string): ParsedNode {
  return {
    id: `failed-${hash(raw)}`,
    name: `${protocol.toUpperCase()} parse failed`,
    protocol,
    status: "failed",
    raw,
    config: {},
    error
  };
}

function hash(input: string) {
  let value = 0;
  for (let index = 0; index < input.length; index += 1) value = (value * 31 + input.charCodeAt(index)) >>> 0;
  return value.toString(16);
}

export function fingerprintNode(protocol: string, config: Record<string, unknown>, fallback = "") {
  const credential = config.uuid ?? config.password ?? config.credential ?? config.username ?? "";
  return hash(`${protocol}|${config.server ?? config.host ?? ""}|${config.port ?? ""}|${credential || fallback}`);
}

function decodeBase64(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseUrl(raw: string) {
  return new URL(raw);
}

function parseUserInfo(url: URL) {
  return {
    username: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || "")
  };
}

function commonOutbound(node: NodeConfig) {
  return {
    tag: node.name,
    server: node.config.server ?? node.config.host ?? "example.com",
    server_port: Number(node.config.port ?? 443)
  };
}

function commonInbound(node: NodeConfig, type: string) {
  return {
    type,
    tag: node.name,
    listen: node.config.listenHost ?? "0.0.0.0",
    listen_port: Number(node.config.listenPort ?? node.config.port ?? 20001)
  };
}

const httpAdapter: NodeAdapter = {
  protocol: "http",
  direction: "both",
  parseLink(raw) {
    try {
      const url = parseUrl(raw);
      const auth = parseUserInfo(url);
      return parsed(raw, "http", {
        server: url.hostname,
        port: Number(url.port || 80),
        username: auth.username || undefined,
        password: auth.password || undefined
      }, url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined);
    } catch (error) {
      return failed(raw, "http", error instanceof Error ? error.message : "invalid http link");
    }
  },
  validate: (cfg, direction) => baseValidate(cfg, direction),
  mask: maskSecrets,
  renderEngineConfig(node) {
    if (node.direction === "local") return commonInbound(node, "http");
    return { type: "http", ...commonOutbound(node), username: node.config.username, password: node.config.password };
  },
  buildShareLink(node) {
    const host = node.config.sharePublicHost ?? node.config.publicHost ?? "proxy.example.com";
    return `http://${host}:${node.config.listenPort ?? node.config.port ?? 20001}`;
  }
};

const socksAdapter: NodeAdapter = {
  protocol: "socks5",
  direction: "both",
  parseLink(raw) {
    try {
      const url = parseUrl(raw.replace(/^socks5h:\/\//, "socks5://"));
      const auth = parseUserInfo(url);
      return parsed(raw, "socks5", {
        server: url.hostname,
        port: Number(url.port || 1080),
        username: auth.username || undefined,
        password: auth.password || undefined
      }, url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined);
    } catch (error) {
      return failed(raw, "socks5", error instanceof Error ? error.message : "invalid socks5 link");
    }
  },
  validate: (cfg, direction) => baseValidate(cfg, direction),
  mask: maskSecrets,
  renderEngineConfig(node) {
    if (node.direction === "local") return commonInbound(node, "socks");
    return { type: "socks", version: "5", ...commonOutbound(node), username: node.config.username, password: node.config.password };
  },
  buildShareLink(node) {
    const host = node.config.sharePublicHost ?? node.config.publicHost ?? "proxy.example.com";
    return `socks5://${host}:${node.config.listenPort ?? node.config.port ?? 20001}`;
  }
};

const shadowsocksAdapter: NodeAdapter = {
  protocol: "shadowsocks",
  direction: "both",
  parseLink(raw) {
    try {
      const body = raw.slice("ss://".length);
      const [mainAndHost, hashPart] = body.split("#");
      const decoded = mainAndHost.includes("@") ? mainAndHost : decodeBase64(mainAndHost);
      const [methodPassword, hostPort] = decoded.split("@");
      const decodedMethodPassword = methodPassword.includes(":") ? methodPassword : decodeBase64(methodPassword);
      const [method, password] = decodedMethodPassword.split(":");
      const [server, port] = hostPort.split(":");
      return parsed(raw, "shadowsocks", {
        server,
        port: Number(port),
        method,
        password
      }, hashPart ? decodeURIComponent(hashPart) : undefined);
    } catch (error) {
      return failed(raw, "shadowsocks", error instanceof Error ? error.message : "invalid shadowsocks link");
    }
  },
  validate: (cfg, direction) => baseValidate(cfg, direction, direction === "remote" ? ["method", "password"] : ["method"]),
  mask: maskSecrets,
  renderEngineConfig(node) {
    const base = node.direction === "local" ? commonInbound(node, "shadowsocks") : { type: "shadowsocks", ...commonOutbound(node) };
    return { ...base, method: node.config.method ?? "2022-blake3-aes-128-gcm", password: node.config.password ?? node.config.credential };
  },
  buildShareLink(node) {
    const host = node.config.sharePublicHost ?? node.config.publicHost ?? "proxy.example.com";
    const userInfo = Buffer.from(`${node.config.method ?? "2022-blake3-aes-128-gcm"}:${node.config.password ?? node.config.credential ?? ""}`).toString("base64url");
    return `ss://${userInfo}@${host}:${node.config.listenPort ?? node.config.port ?? 20001}#${encodeURIComponent(node.name)}`;
  }
};

const trojanAdapter: NodeAdapter = {
  protocol: "trojan",
  direction: "both",
  parseLink(raw) {
    try {
      const url = parseUrl(raw);
      return parsed(raw, "trojan", {
        server: url.hostname,
        port: Number(url.port || 443),
        password: decodeURIComponent(url.username),
        tls: true,
        sni: url.searchParams.get("sni") ?? undefined
      }, url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined);
    } catch (error) {
      return failed(raw, "trojan", error instanceof Error ? error.message : "invalid trojan link");
    }
  },
  validate: (cfg, direction) => baseValidate(cfg, direction, direction === "remote" ? ["password"] : []),
  mask: maskSecrets,
  renderEngineConfig(node) {
    const tls = { enabled: true, server_name: node.config.sni ?? node.config.server };
    if (node.direction === "local") return { ...commonInbound(node, "trojan"), users: [{ password: node.config.password ?? node.config.credential }], tls };
    return { type: "trojan", ...commonOutbound(node), password: node.config.password ?? node.config.credential, tls };
  },
  buildShareLink(node) {
    const host = node.config.sharePublicHost ?? node.config.publicHost ?? "proxy.example.com";
    return `trojan://${encodeURIComponent(String(node.config.password ?? node.config.credential ?? ""))}@${host}:${node.config.listenPort ?? node.config.port ?? 443}#${encodeURIComponent(node.name)}`;
  }
};

const vlessAdapter: NodeAdapter = {
  protocol: "vless",
  direction: "both",
  parseLink(raw) {
    try {
      const url = parseUrl(raw);
      return parsed(raw, "vless", {
        server: url.hostname,
        port: Number(url.port || 443),
        uuid: decodeURIComponent(url.username),
        flow: url.searchParams.get("flow") ?? undefined,
        transport: { type: url.searchParams.get("type") ?? "tcp" },
        tls: url.searchParams.get("security") === "tls" || url.searchParams.get("security") === "reality",
        sni: url.searchParams.get("sni") ?? undefined,
        reality: url.searchParams.get("security") === "reality" ? { publicKey: url.searchParams.get("pbk"), shortId: url.searchParams.get("sid") } : undefined
      }, url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined);
    } catch (error) {
      return failed(raw, "vless", error instanceof Error ? error.message : "invalid vless link");
    }
  },
  validate: (cfg, direction) => baseValidate(cfg, direction, direction === "remote" ? ["uuid"] : []),
  mask: maskSecrets,
  renderEngineConfig(node) {
    const tls = node.config.tls ? { enabled: true, server_name: node.config.sni ?? node.config.server } : undefined;
    if (node.direction === "local") {
      return { ...commonInbound(node, "vless"), users: [{ uuid: node.config.uuid ?? node.config.credential }], tls };
    }
    return { type: "vless", ...commonOutbound(node), uuid: node.config.uuid ?? node.config.credential, flow: node.config.flow, tls };
  },
  buildShareLink(node) {
    const host = node.config.sharePublicHost ?? node.config.publicHost ?? "proxy.example.com";
    return `vless://${encodeURIComponent(String(node.config.uuid ?? node.config.credential ?? ""))}@${host}:${node.config.listenPort ?? node.config.port ?? 443}?security=${node.config.tls ? "tls" : "none"}#${encodeURIComponent(node.name)}`;
  }
};

const vmessAdapter: NodeAdapter = {
  protocol: "vmess",
  direction: "remote",
  parseLink(raw) {
    try {
      const data = JSON.parse(decodeBase64(raw.slice("vmess://".length))) as Record<string, unknown>;
      return parsed(raw, "vmess", {
        server: data.add,
        port: Number(data.port ?? 443),
        uuid: data.id,
        alterId: Number(data.aid ?? 0),
        security: data.scy ?? "auto",
        transport: { type: data.net ?? "tcp", path: data.path },
        tls: data.tls === "tls",
        sni: data.sni
      }, asString(data.ps));
    } catch (error) {
      return failed(raw, "vmess", error instanceof Error ? error.message : "invalid vmess link");
    }
  },
  validate: (cfg) => baseValidate(cfg, "remote", ["uuid"]),
  mask: maskSecrets,
  renderEngineConfig(node) {
    return {
      type: "vmess",
      ...commonOutbound(node),
      uuid: node.config.uuid ?? node.config.credential,
      security: node.config.security ?? "auto",
      alter_id: Number(node.config.alterId ?? 0),
      tls: node.config.tls ? { enabled: true, server_name: node.config.sni ?? node.config.server } : undefined
    };
  }
};

const wireGuardAdapter: NodeAdapter = {
  protocol: "wireguard",
  direction: "both",
  parseLink(raw) {
    try {
      const url = parseUrl(raw.replace(/^wg:\/\//, "wireguard://"));
      return parsed(raw, "wireguard", {
        server: url.hostname,
        port: Number(url.port || 51820),
        privateKey: decodeURIComponent(url.username || ""),
        peerPublicKey: url.searchParams.get("publickey") ?? url.searchParams.get("peer") ?? undefined,
        preSharedKey: url.searchParams.get("psk") ?? undefined,
        address: url.searchParams.get("address") ?? undefined,
        mtu: Number(url.searchParams.get("mtu") ?? 1420),
        allowedIps: url.searchParams.get("allowedips") ?? "0.0.0.0/0,::/0"
      }, url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined);
    } catch (error) {
      return failed(raw, "wireguard", error instanceof Error ? error.message : "invalid wireguard link");
    }
  },
  validate: (cfg, direction) => baseValidate(cfg, direction, direction === "remote" ? ["privateKey", "peerPublicKey", "address"] : ["privateKey", "address"]),
  mask: maskSecrets,
  renderEngineConfig(node) {
    if (node.direction === "local") {
      return {
        ...commonInbound(node, "wireguard"),
        private_key: node.config.privateKey ?? node.config.private_key ?? node.config.credential,
        peers: node.config.peers ?? [],
        local_address: splitList(node.config.address ?? "10.0.0.1/24"),
        mtu: Number(node.config.mtu ?? 1420)
      };
    }
    return {
      type: "wireguard",
      tag: node.name,
      server: node.config.server ?? node.config.endpoint,
      server_port: Number(node.config.port ?? 51820),
      private_key: node.config.privateKey ?? node.config.private_key ?? node.config.credential,
      peer_public_key: node.config.peerPublicKey ?? node.config.publicKey ?? node.config.public_key,
      pre_shared_key: node.config.preSharedKey ?? node.config.pre_shared_key,
      local_address: splitList(node.config.address),
      mtu: Number(node.config.mtu ?? 1420),
      reserved: node.config.reserved
    };
  },
  buildShareLink(node) {
    const host = node.config.sharePublicHost ?? node.config.publicHost ?? "proxy.example.com";
    return `wireguard://${encodeURIComponent(String(node.config.privateKey ?? node.config.credential ?? ""))}@${host}:${node.config.listenPort ?? node.config.port ?? 51820}?address=${encodeURIComponent(String(node.config.address ?? "10.0.0.2/32"))}#${encodeURIComponent(node.name)}`;
  }
};

const hysteria2Adapter: NodeAdapter = {
  protocol: "hysteria2",
  direction: "both",
  parseLink(raw) {
    try {
      const normalized = raw.replace(/^hy2:\/\//, "hysteria2://");
      const url = parseUrl(normalized);
      return parsed(raw, "hysteria2", {
        server: url.hostname,
        port: Number(url.port || 443),
        password: decodeURIComponent(url.username || ""),
        obfs: url.searchParams.get("obfs") ?? undefined,
        obfsPassword: url.searchParams.get("obfs-password") ?? url.searchParams.get("obfs_password") ?? undefined,
        sni: url.searchParams.get("sni") ?? undefined,
        insecure: url.searchParams.get("insecure") === "1" || url.searchParams.get("insecure") === "true"
      }, url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined);
    } catch (error) {
      return failed(raw, "hysteria2", error instanceof Error ? error.message : "invalid hysteria2 link");
    }
  },
  validate: (cfg, direction) => baseValidate(cfg, direction, direction === "remote" ? ["password"] : []),
  mask: maskSecrets,
  renderEngineConfig(node) {
    const obfs = node.config.obfs ? { type: node.config.obfs, password: node.config.obfsPassword ?? node.config.obfs_password } : undefined;
    const tls = { enabled: true, server_name: node.config.sni ?? node.config.server, insecure: Boolean(node.config.insecure) };
    if (node.direction === "local") return { ...commonInbound(node, "hysteria2"), users: [{ password: node.config.password ?? node.config.credential }], obfs, tls };
    return { type: "hysteria2", ...commonOutbound(node), password: node.config.password ?? node.config.credential, obfs, tls };
  },
  buildShareLink(node) {
    const host = node.config.sharePublicHost ?? node.config.publicHost ?? "proxy.example.com";
    return `hysteria2://${encodeURIComponent(String(node.config.password ?? node.config.credential ?? ""))}@${host}:${node.config.listenPort ?? node.config.port ?? 443}#${encodeURIComponent(node.name)}`;
  }
};

const tuicAdapter: NodeAdapter = {
  protocol: "tuic",
  direction: "remote",
  parseLink(raw) {
    try {
      const url = parseUrl(raw);
      const auth = parseUserInfo(url);
      return parsed(raw, "tuic", {
        server: url.hostname,
        port: Number(url.port || 443),
        uuid: auth.username,
        password: auth.password,
        congestionControl: url.searchParams.get("congestion_control") ?? url.searchParams.get("congestion") ?? "bbr",
        sni: url.searchParams.get("sni") ?? undefined,
        insecure: url.searchParams.get("insecure") === "1" || url.searchParams.get("insecure") === "true"
      }, url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined);
    } catch (error) {
      return failed(raw, "tuic", error instanceof Error ? error.message : "invalid tuic link");
    }
  },
  validate: (cfg) => baseValidate(cfg, "remote", ["uuid", "password"]),
  mask: maskSecrets,
  renderEngineConfig(node) {
    return {
      type: "tuic",
      ...commonOutbound(node),
      uuid: node.config.uuid ?? node.config.credential,
      password: node.config.password,
      congestion_control: node.config.congestionControl ?? node.config.congestion_control ?? "bbr",
      tls: { enabled: true, server_name: node.config.sni ?? node.config.server, insecure: Boolean(node.config.insecure) }
    };
  }
};

const sshTunnelAdapter: NodeAdapter = {
  protocol: "ssh_tunnel",
  direction: "remote",
  parseLink(raw) {
    try {
      const url = parseUrl(raw);
      const auth = parseUserInfo(url);
      return parsed(raw, "ssh_tunnel", {
        server: url.hostname,
        port: Number(url.port || 22),
        username: auth.username || "root",
        password: auth.password || undefined,
        privateKey: url.searchParams.get("private_key") ?? undefined,
        localForward: url.searchParams.get("local_forward") ?? undefined
      }, url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined);
    } catch (error) {
      return failed(raw, "ssh_tunnel", error instanceof Error ? error.message : "invalid ssh tunnel link");
    }
  },
  validate: (cfg) => {
    const result = baseValidate(cfg, "remote", ["username"]);
    if (!cfg.password && !cfg.privateKey && !cfg.private_key) result.errors.push({ field: "password", message: "password or privateKey is required" });
    return { ok: result.errors.length === 0, errors: result.errors };
  },
  mask: maskSecrets,
  renderEngineConfig(node) {
    return {
      type: "ssh",
      ...commonOutbound(node),
      server_port: Number(node.config.port ?? 22),
      user: node.config.username ?? node.config.user ?? "root",
      password: node.config.password,
      private_key: node.config.privateKey ?? node.config.private_key
    };
  }
};

const fallbackAdapter: NodeAdapter = {
  protocol: "fallback",
  direction: "both",
  validate: (cfg, direction) => baseValidate(cfg, direction),
  mask: maskSecrets,
  renderEngineConfig(node) {
    if (node.direction === "local") return commonInbound(node, String(node.protocol));
    return { type: node.protocol, ...commonOutbound(node) };
  }
};

const registry = new Map<string, NodeAdapter>([
  ["http", httpAdapter],
  ["socks5", socksAdapter],
  ["socks", socksAdapter],
  ["shadowsocks", shadowsocksAdapter],
  ["ss", shadowsocksAdapter],
  ["trojan", trojanAdapter],
  ["vless", vlessAdapter],
  ["vmess", vmessAdapter],
  ["wireguard", wireGuardAdapter],
  ["wg", wireGuardAdapter],
  ["hysteria2", hysteria2Adapter],
  ["hy2", hysteria2Adapter],
  ["tuic", tuicAdapter],
  ["ssh_tunnel", sshTunnelAdapter],
  ["ssh", sshTunnelAdapter]
]);

export function getAdapter(protocol: string) {
  return registry.get(protocol.toLowerCase()) ?? fallbackAdapter;
}

export function validateNodeConfig(protocol: string, direction: Direction, config: Record<string, unknown>) {
  return getAdapter(protocol).validate(config, direction);
}

export function maskNodeConfig(protocol: string, direction: Direction, config: Record<string, unknown>) {
  return getAdapter(protocol).mask(config, direction);
}

export function renderNodeEngineConfig(node: NodeConfig) {
  return getAdapter(node.protocol).renderEngineConfig(node);
}

export function buildShareLink(node: NodeConfig) {
  return getAdapter(node.protocol).buildShareLink?.(node);
}

const baseFields = [
  { key: "name", label: "Node name", type: "text", required: true },
  { key: "server", label: "Server", type: "text", required: true },
  { key: "port", label: "Port", type: "number", required: true }
];

export function schemaFor(protocol: string, direction: Direction) {
  const remoteCredential = protocol === "trojan" || protocol === "shadowsocks" || protocol === "hysteria2" ? "Password" : "UUID / key";
  if (direction === "remote") {
    if (protocol === "wireguard") {
      return {
        protocol,
        direction,
        required_fields: [
          ...baseFields,
          { key: "privateKey", label: "Private key", type: "password", required: true },
          { key: "peerPublicKey", label: "Peer public key", type: "password", required: true },
          { key: "address", label: "Local address", type: "text", required: true }
        ],
        advanced_fields: [
          { key: "preSharedKey", label: "Pre-shared key", type: "password" },
          { key: "mtu", label: "MTU", type: "number" },
          { key: "allowedIps", label: "Allowed IPs", type: "text" }
        ]
      };
    }
    if (protocol === "ssh_tunnel") {
      return {
        protocol,
        direction,
        required_fields: [
          ...baseFields,
          { key: "username", label: "Username", type: "text", required: true },
          { key: "password", label: "Password or private key", type: "password", required: true }
        ],
        advanced_fields: [{ key: "localForward", label: "Local forward", type: "text" }]
      };
    }
    return {
      protocol,
      direction,
      required_fields: [...baseFields, { key: "credential", label: remoteCredential, type: "password", required: protocol !== "smart" }],
      advanced_fields: [
        { key: "transport.type", label: "Transport", type: "select", options: ["tcp", "ws", "grpc", "quic"] },
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
      { key: "name", label: "Node name", type: "text", required: true },
      { key: "listenHost", label: "Listen host", type: "text", required: true },
      { key: "listenPort", label: "Listen port", type: "number", required: true },
      { key: "exposure", label: "Exposure", type: "select", options: ["local", "lan", "public", "relay"], required: true }
    ],
    advanced_fields: [
      { key: "routeMode", label: "Route mode", type: "select", options: ["direct", "forward_to_remote"] },
      { key: "tls.enabled", label: "TLS", type: "checkbox" },
      { key: "share.publicHost", label: "Share host", type: "text" }
    ]
  };
}

export function parseImport(input: string): ParsedNode[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsedJson = parseSingBoxJson(trimmed);
    if (parsedJson.length > 0) return parsedJson;
  }
  if (/^\s*proxies\s*:/m.test(input)) {
    const parsedClash = parseClashYaml(input);
    if (parsedClash.length > 0) return parsedClash;
  }
  if (!trimmed.includes("://")) {
    const decoded = decodeSubscriptionBase64(trimmed);
    if (decoded && decoded !== trimmed) {
      const decodedNodes: ParsedNode[] = parseImport(decoded);
      if (decodedNodes.length > 0) return decodedNodes.map((node) => ({ ...node, sourceFormat: "base64-subscription" }));
    }
  }
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = lines.length ? lines : [input.trim()];
  return candidates.map((line) => {
    const protocol = line.includes("://") ? line.split("://")[0].toLowerCase() : "smart";
    const adapter = getAdapter(protocol);
    if (!adapter.parseLink) {
      return failed(line, protocol, "unsupported import format");
    }
    const node = adapter.parseLink(line);
    return node.status === "parsed" ? { ...node, sourceFormat: node.sourceFormat ?? "share-link" } : node;
  });
}

export function parseSingBoxJson(input: string): ParsedNode[] {
  try {
    const data = JSON.parse(input) as { outbounds?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const outbounds = Array.isArray(data) ? data : Array.isArray(data.outbounds) ? data.outbounds : [];
    return outbounds
      .filter((item) => typeof item.type === "string" && item.type !== "direct" && item.type !== "block" && item.type !== "dns")
      .map((item) => {
        const protocol = normalizeProtocol(String(item.type));
        const config = {
          server: item.server,
          port: item.server_port ?? item.port,
          uuid: item.uuid,
          password: item.password,
          username: item.username,
          privateKey: item.private_key,
          peerPublicKey: item.peer_public_key,
          preSharedKey: item.pre_shared_key,
          address: item.local_address,
          obfs: readObject(item.obfs)?.type,
          obfsPassword: readObject(item.obfs)?.password,
          congestionControl: item.congestion_control,
          method: item.method,
          tls: hasEnabledTls(item.tls),
          sni: readObject(item.tls)?.server_name
        };
        return { ...parsed(JSON.stringify(item), protocol, config, asString(item.tag)), sourceFormat: "sing-box" };
      });
  } catch {
    return [];
  }
}

export function parseClashYaml(input: string): ParsedNode[] {
  const lines = input.split(/\r?\n/);
  const proxies: Record<string, string>[] = [];
  let current: Record<string, string> | undefined;
  let inProxies = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "proxies:") {
      inProxies = true;
      continue;
    }
    if (!inProxies) continue;
    if (line.startsWith("- ")) {
      if (current) proxies.push(current);
      current = {};
      parseYamlInlineOrKeyValue(line.slice(2), current);
      continue;
    }
    if (current) parseYamlInlineOrKeyValue(line, current);
  }
  if (current) proxies.push(current);

  return proxies
    .filter((item) => item.type && item.server)
    .map((item) => {
      const protocol = normalizeProtocol(item.type);
      const config = {
        server: item.server,
        port: Number(item.port ?? 443),
        uuid: item.uuid,
        password: item.password,
        privateKey: item["private-key"] ?? item.privateKey ?? item.private_key,
        peerPublicKey: item["public-key"] ?? item.publicKey ?? item.peerPublicKey,
        preSharedKey: item["preshared-key"] ?? item.preSharedKey,
        address: item.ip ?? item.address,
        method: item.cipher,
        username: item.username,
        obfs: item.obfs,
        obfsPassword: item["obfs-password"] ?? item.obfsPassword,
        congestionControl: item["congestion-control"] ?? item.congestionControl,
        tls: item.tls === "true" || item.tls === "1",
        sni: item.servername ?? item.sni
      };
      return { ...parsed(JSON.stringify(item), protocol, config, item.name), sourceFormat: "clash" };
    });
}

function decodeSubscriptionBase64(input: string) {
  try {
    const decoded = decodeBase64(input.replace(/\s+/g, ""));
    return decoded.includes("://") || /^\s*proxies\s*:/m.test(decoded) || decoded.trim().startsWith("{") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function parseYamlInlineOrKeyValue(text: string, target: Record<string, string>) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    for (const part of trimmed.slice(1, -1).split(",")) {
      parseYamlKeyValue(part, target);
    }
    return;
  }
  parseYamlKeyValue(trimmed, target);
}

function parseYamlKeyValue(text: string, target: Record<string, string>) {
  const index = text.indexOf(":");
  if (index <= 0) return;
  const key = text.slice(0, index).trim();
  const value = text.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  target[key] = value;
}

function normalizeProtocol(protocol: string) {
  const lower = protocol.toLowerCase();
  if (lower === "ss") return "shadowsocks";
  if (lower === "socks") return "socks5";
  if (lower === "wg") return "wireguard";
  if (lower === "hy2") return "hysteria2";
  if (lower === "ssh") return "ssh_tunnel";
  return lower;
}

function readObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasEnabledTls(value: unknown) {
  const object = readObject(value);
  return Boolean(object?.enabled);
}

function splitList(value: unknown) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}
