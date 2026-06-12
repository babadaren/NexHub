import { Redis } from "ioredis";
import { config } from "./config.js";

export class RedisRuntime {
  client: Redis | undefined;
  status: "disabled" | "connected" | "error" = "disabled";
  error: string | undefined;
  private memoryLocks = new Map<string, NodeJS.Timeout>();
  private memoryRateLimits = new Map<string, { count: number; resetAt: number }>();
  private memoryOnce = new Map<string, NodeJS.Timeout>();

  async connect() {
    if (!config.redisUrl) {
      this.status = "disabled";
      if (config.redisRequired) {
        this.error = "REDIS_REQUIRED=true but REDIS_URL is not configured";
        throw new RedisDependencyError(this.error);
      }
      return;
    }
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
      const reason = error instanceof Error ? error.message : "redis connection failed";
      this.error = reason;
      if (config.redisRequired) throw new RedisDependencyError(reason);
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
    await this.client.expire(`rt:node:${nodeId}:now`, realtimeTtlSeconds());
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

  async withLock<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const token = `${Date.now()}-${Math.random()}`;
    if (this.client && this.status === "connected") {
      const acquired = await this.client.set(key, token, "EX", ttlSeconds, "NX");
      if (acquired !== "OK") throw new LockConflictError(key);
      try {
        return await fn();
      } finally {
        await this.releaseRedisLock(key, token);
      }
    }

    if (this.memoryLocks.has(key)) throw new LockConflictError(key);
    const timer = setTimeout(() => this.memoryLocks.delete(key), ttlSeconds * 1000);
    this.memoryLocks.set(key, timer);
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
      this.memoryLocks.delete(key);
    }
  }

  async checkRateLimit(key: string, limit: number, windowSeconds: number) {
    if (limit <= 0) return { allowed: true, remaining: 0, resetSeconds: windowSeconds };
    if (this.client && this.status === "connected") {
      const count = await this.client.incr(key);
      if (count === 1) await this.client.expire(key, windowSeconds);
      const ttl = await this.client.ttl(key);
      return {
        allowed: count <= limit,
        remaining: Math.max(limit - count, 0),
        resetSeconds: ttl > 0 ? ttl : windowSeconds
      };
    }

    const now = Date.now();
    const existing = this.memoryRateLimits.get(key);
    if (!existing || existing.resetAt <= now) {
      this.memoryRateLimits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: limit - 1, resetSeconds: windowSeconds };
    }
    existing.count += 1;
    return {
      allowed: existing.count <= limit,
      remaining: Math.max(limit - existing.count, 0),
      resetSeconds: Math.max(Math.ceil((existing.resetAt - now) / 1000), 1)
    };
  }

  async markOnce(key: string, ttlSeconds: number) {
    if (this.client && this.status === "connected") {
      const acquired = await this.client.set(key, "1", "EX", ttlSeconds, "NX");
      return acquired === "OK";
    }

    if (this.memoryOnce.has(key)) return false;
    const timer = setTimeout(() => this.memoryOnce.delete(key), ttlSeconds * 1000);
    this.memoryOnce.set(key, timer);
    return true;
  }

  private async releaseRedisLock(key: string, token: string) {
    if (!this.client || this.status !== "connected") return;
    await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token
    );
  }
}

export class LockConflictError extends Error {
  constructor(readonly key: string) {
    super(`lock already held: ${key}`);
    this.name = "LockConflictError";
  }
}

export class RedisDependencyError extends Error {
  constructor(reason: string) {
    super(`Redis is required but unavailable. Check REDIS_URL, REDIS_REQUIRED, and redis service status. Cause: ${reason}`);
    this.name = "RedisDependencyError";
  }
}

function realtimeTtlSeconds() {
  const hours = Math.min(Math.max(config.realtimeTtlHours, 1), Math.max(config.realtimeMaxTtlHours, 1));
  return Math.round(hours * 60 * 60);
}

export const redisRuntime = new RedisRuntime();
