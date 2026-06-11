import { Redis } from "ioredis";
import { config } from "./config.js";

export class RedisRuntime {
  client: Redis | undefined;
  status: "disabled" | "connected" | "error" = "disabled";
  error: string | undefined;

  async connect() {
    if (!config.redisUrl) return;
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1
    });
    try {
      await this.client.connect();
      await this.client.ping();
      this.status = "connected";
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : "redis connection failed";
      if (config.redisRequired) throw error;
    }
  }

  async close() {
    if (!this.client) return;
    await this.client.quit();
  }

  async writeNodeNow(nodeId: string, data: Record<string, string | number | boolean | undefined>) {
    if (!this.client || this.status !== "connected") return;
    const entries = Object.entries(data).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]).flat();
    if (entries.length === 0) return;
    await this.client.hset(`rt:node:${nodeId}:now`, ...entries);
    await this.client.expire(`rt:node:${nodeId}:now`, 30);
  }

  async readNodeNow(nodeId: string) {
    if (!this.client || this.status !== "connected") return undefined;
    const data = await this.client.hgetall(`rt:node:${nodeId}:now`);
    return Object.keys(data).length ? data : undefined;
  }

  async addEvent(event: Record<string, string | number | boolean | undefined>) {
    if (!this.client || this.status !== "connected") return;
    const entries = Object.entries(event).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]).flat();
    if (entries.length === 0) return;
    await this.client.xadd("stream:events", "MAXLEN", "~", "1000", "*", ...entries);
  }

  async readEvents(limit = 20) {
    if (!this.client || this.status !== "connected") return [];
    const rows = await this.client.xrevrange("stream:events", "+", "-", "COUNT", limit);
    return rows.map(([id, values]) => {
      const event: Record<string, string> = { id };
      for (let index = 0; index < values.length; index += 2) {
        event[values[index]] = values[index + 1];
      }
      return event;
    });
  }
}

export const redisRuntime = new RedisRuntime();
