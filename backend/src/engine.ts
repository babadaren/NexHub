import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderNodeEngineConfig } from "./adapters.js";
import { config } from "./config.js";
import type { NodeConfig } from "./types.js";

export interface EngineStatus {
  provider: string;
  mode: string;
  binary: string;
  running: boolean;
  pid?: number;
  currentPath: string;
  previousPath: string;
  lastAction?: string;
  lastError?: string;
  lastCheckedAt?: string;
  lastStartedAt?: string;
}

export interface EngineRenderResult {
  ok: boolean;
  currentPath: string;
  previousPath: string;
  message: string;
  runtime: EngineStatus;
}

const engineDir = config.engineConfigDir ?? path.join(config.dataDir, "engine");
const currentPath = path.join(engineDir, "current.json");
const previousPath = path.join(engineDir, "previous.json");
const nextPath = path.join(engineDir, "next.json");
const defaultConfig = { inbounds: [], outbounds: [{ type: "direct", tag: "direct" }], route: { final: "direct" } };

class EngineRuntime {
  private process: ChildProcessWithoutNullStreams | undefined;
  private status: EngineStatus = {
    provider: config.engineProvider,
    mode: config.engineMode,
    binary: config.engineBinary,
    running: false,
    currentPath,
    previousPath,
    lastAction: "init"
  };

  getStatus(): EngineStatus {
    return {
      ...this.status,
      running: Boolean(this.process && !this.process.killed),
      pid: this.process?.pid
    };
  }

  async check(configPath = currentPath) {
    this.status.lastCheckedAt = new Date().toISOString();
    if (config.engineMode !== "managed") {
      this.status.lastAction = "check-skipped";
      return { ok: true, skipped: true, message: "ENGINE_MODE is render-only" };
    }
    return this.runCommand(["check", "-c", configPath], "check");
  }

  async reload() {
    if (config.engineMode !== "managed") {
      this.status.lastAction = "reload-skipped";
      return { ok: true, skipped: true, message: "ENGINE_MODE is render-only" };
    }
    await this.stop();
    return this.start();
  }

  async start() {
    if (config.engineMode !== "managed") {
      this.status.lastAction = "start-skipped";
      return { ok: true, skipped: true, message: "ENGINE_MODE is render-only" };
    }
    if (this.process && !this.process.killed) {
      this.status.lastAction = "start-existing";
      return { ok: true, message: "engine already running" };
    }
    await this.check(currentPath);
    this.process = spawn(config.engineBinary, ["run", "-c", currentPath], {
      stdio: "pipe",
      windowsHide: true
    });
    this.status.running = true;
    this.status.pid = this.process.pid;
    this.status.lastStartedAt = new Date().toISOString();
    this.status.lastAction = "start";
    this.status.lastError = undefined;
    this.process.on("exit", (code, signal) => {
      this.status.running = false;
      this.status.pid = undefined;
      this.status.lastAction = "exit";
      if (code && code !== 0) this.status.lastError = `engine exited with code ${code}`;
      if (signal) this.status.lastError = `engine exited with signal ${signal}`;
    });
    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.status.lastError = text.slice(-1000);
    });
    return { ok: true, message: "engine started", pid: this.process.pid };
  }

  async stop() {
    if (!this.process || this.process.killed) {
      this.status.running = false;
      this.status.pid = undefined;
      this.status.lastAction = "stop-empty";
      return { ok: true, message: "engine is not running" };
    }
    const proc = this.process;
    proc.kill();
    await waitForExit(proc, config.engineReloadTimeoutSeconds * 1000);
    this.process = undefined;
    this.status.running = false;
    this.status.pid = undefined;
    this.status.lastAction = "stop";
    return { ok: true, message: "engine stopped" };
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  private async runCommand(args: string[], action: string) {
    const result = await runProcess(config.engineBinary, args, config.engineReloadTimeoutSeconds * 1000);
    this.status.lastAction = action;
    if (!result.ok) {
      this.status.lastError = result.stderr || result.stdout || `${action} failed`;
      throw new Error(this.status.lastError);
    }
    this.status.lastError = undefined;
    return { ok: true, message: result.stdout || `${action} ok` };
  }
}

function runProcess(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, stdout, stderr: stderr || "engine command timed out" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export const engineRuntime = new EngineRuntime();

export function renderSingBoxConfig(nodes: NodeConfig[]) {
  const enabled = nodes.filter((node) => node.enabled && node.status === "enabled");
  const outbounds = enabled
    .filter((node) => node.direction === "remote")
    .map((node) => renderNodeEngineConfig(node));

  const inbounds = enabled
    .filter((node) => node.direction === "local")
    .map((node) => renderNodeEngineConfig(node));

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
  if (config.engineMode === "managed") {
    await engineRuntime.check(nextPath);
  }

  try {
    await readFile(currentPath, "utf8");
    await rename(currentPath, previousPath);
  } catch {
    await writeFile(previousPath, JSON.stringify(defaultConfig, null, 2), "utf8");
  }

  await rename(nextPath, currentPath);
  try {
    await engineRuntime.reload();
  } catch (error) {
    await rename(previousPath, currentPath);
    await engineRuntime.reload().catch(() => undefined);
    throw error;
  }
  return {
    ok: true,
    currentPath,
    previousPath,
    message: config.engineMode === "managed" ? "Engine config rendered and runtime reloaded." : "Engine config rendered. Runtime reload skipped in render-only mode.",
    runtime: engineRuntime.getStatus()
  };
}

async function validateEngineConfig(engineConfig: ReturnType<typeof renderSingBoxConfig>) {
  const tags = new Set<string>();
  for (const item of [...engineConfig.inbounds, ...engineConfig.outbounds]) {
    const tag = typeof item.tag === "string" ? item.tag : "";
    if (!tag) throw new Error("engine config item is missing tag");
    if (tags.has(tag)) throw new Error(`engine config has duplicate tag: ${tag}`);
    tags.add(tag);
  }
}
