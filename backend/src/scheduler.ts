import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { LockConflictError, redisRuntime } from "./redis.js";
import { store } from "./storage.js";
import type { SubscriptionSource } from "./types.js";

const minuteMs = 60 * 1000;

export class SubscriptionScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly logger?: FastifyBaseLogger) {}

  start() {
    if (!config.subscriptionRefreshEnabled) {
      void store.recordSubscriptionSchedulerEvent("subscription.scheduler.disabled", "订阅定时刷新未开启", {
        enabled: false,
        defaultCron: config.subscriptionRefreshCron
      });
      return;
    }
    if (this.timer) return;
    void store.recordSubscriptionSchedulerEvent("subscription.scheduler.started", "订阅定时刷新已开启", {
      enabled: true,
      defaultCron: config.subscriptionRefreshCron,
      intervalSeconds: config.subscriptionSchedulerIntervalSeconds
    });
    this.timer = setInterval(() => {
      void this.tick(new Date());
    }, Math.max(config.subscriptionSchedulerIntervalSeconds, 1) * 1000);
    this.timer.unref?.();
    void this.tick(new Date());
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(date = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const subscriptions = store.listSubscriptions().filter((subscription) => subscription.autoRefresh);
      for (const subscription of subscriptions) {
        const cron = subscription.refreshCron?.trim() || config.subscriptionRefreshCron;
        if (!cronMatches(cron, date)) continue;
        const minuteKey = minuteBucket(date);
        const once = await redisRuntime.markOnce(`once:subscription-refresh:${subscription.id}:${minuteKey}`, 90);
        if (!once) continue;
        await this.refresh(subscription, cron, minuteKey);
      }
    } finally {
      this.running = false;
    }
  }

  private async refresh(subscription: SubscriptionSource, cron: string, minuteKey: string) {
    try {
      await store.recordSubscriptionSchedulerEvent("subscription.scheduler.triggered", `定时刷新订阅源 ${subscription.name}`, {
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
        cron,
        minute: minuteKey
      });
      await store.refreshSubscription(subscription.id);
    } catch (error) {
      if (error instanceof LockConflictError) return;
      const message = error instanceof Error ? error.message : "subscription scheduler failed";
      this.logger?.error({ error, subscriptionId: subscription.id }, "subscription scheduler failed");
      await store.recordSubscriptionSchedulerEvent("subscription.scheduler.failed", `定时刷新订阅源 ${subscription.name} 失败：${message}`, {
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
        cron,
        minute: minuteKey,
        error: message
      });
    }
  }
}

export function cronMatches(expression: string, date: Date) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return (
    fieldMatches(minute, date.getMinutes(), 0, 59) &&
    fieldMatches(hour, date.getHours(), 0, 23) &&
    fieldMatches(dayOfMonth, date.getDate(), 1, 31) &&
    fieldMatches(month, date.getMonth() + 1, 1, 12) &&
    fieldMatches(dayOfWeek, date.getDay(), 0, 7)
  );
}

function fieldMatches(field: string, value: number, min: number, max: number) {
  return field.split(",").some((part) => partMatches(part.trim(), value, min, max));
}

function partMatches(part: string, value: number, min: number, max: number) {
  if (!part) return false;
  if (part === "*") return true;
  const [rangePart, stepPart] = part.split("/");
  const step = stepPart ? Number(stepPart) : 1;
  if (!Number.isInteger(step) || step < 1) return false;

  const [startRaw, endRaw] = rangePart === "*" ? [String(min), String(max)] : rangePart.split("-");
  const start = Number(startRaw);
  const end = Number(endRaw ?? startRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return false;
  if (value < start || value > end) return false;
  return (value - start) % step === 0 || (max === 7 && value === 0 && end === 7 && (7 - start) % step === 0);
}

function minuteBucket(date: Date) {
  return String(Math.floor(date.getTime() / minuteMs));
}
