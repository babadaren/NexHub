import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { NodeConfig } from "./types.js";

export interface EngineRenderResult {
  ok: boolean;
  currentPath: string;
  previousPath: string;
  message: string;
}

const engineDir = path.join(config.dataDir, "engine");
const currentPath = path.join(engineDir, "current.json");
const previousPath = path.join(engineDir, "previous.json");
const nextPath = path.join(engineDir, "next.json");

export function renderSingBoxConfig(nodes: NodeConfig[]) {
  const enabled = nodes.filter((node) => node.enabled && node.status === "enabled");
  const outbounds = enabled
    .filter((node) => node.direction === "remote")
    .map((node) => ({
      type: node.protocol === "shadowsocks" ? "shadowsocks" : node.protocol,
      tag: node.name,
      server: node.config.server ?? node.config.host ?? "example.com",
      server_port: Number(node.config.port ?? 443)
    }));

  const inbounds = enabled
    .filter((node) => node.direction === "local")
    .map((node) => ({
      type: node.protocol === "socks5" ? "socks" : node.protocol,
      tag: node.name,
      listen: node.config.listenHost ?? "0.0.0.0",
      listen_port: Number(node.config.listenPort ?? node.config.port ?? 20001)
    }));

  return {
    log: {
      level: "info",
      timestamp: true
    },
    inbounds,
    outbounds: [
      ...outbounds,
      {
        type: "direct",
        tag: "direct"
      }
    ],
    route: {
      final: outbounds[0]?.tag ?? "direct"
    },
    experimental: {
      cache_file: {
        enabled: true,
        path: "cache.db"
      }
    }
  };
}

export async function renderEngineConfig(nodes: NodeConfig[]): Promise<EngineRenderResult> {
  await mkdir(engineDir, { recursive: true });
  const nextConfig = renderSingBoxConfig(nodes);
  await writeFile(nextPath, JSON.stringify(nextConfig, null, 2), "utf8");
  await validateEngineConfig(nextConfig);

  try {
    await readFile(currentPath, "utf8");
    await rename(currentPath, previousPath);
  } catch {
    await writeFile(previousPath, JSON.stringify({ inbounds: [], outbounds: [{ type: "direct", tag: "direct" }] }, null, 2), "utf8");
  }

  await rename(nextPath, currentPath);
  return {
    ok: true,
    currentPath,
    previousPath,
    message: "代理核心配置已生成。开发模式不会调用真实 sing-box reload。"
  };
}

async function validateEngineConfig(engineConfig: ReturnType<typeof renderSingBoxConfig>) {
  const tags = new Set<string>();
  for (const item of [...engineConfig.inbounds, ...engineConfig.outbounds]) {
    if (!item.tag) throw new Error("代理核心配置缺少 tag");
    if (tags.has(item.tag)) throw new Error(`代理核心配置存在重复 tag: ${item.tag}`);
    tags.add(item.tag);
  }
}
