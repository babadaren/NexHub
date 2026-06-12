import { store } from "./storage.js";
import { redisRuntime } from "./redis.js";

export function dashboardSummary() {
  const nodes = store.listNodes();
  const remote = nodes.filter((node) => node.direction === "remote");
  const local = nodes.filter((node) => node.direction === "local");
  const onlineRemote = remote.filter((node) => node.enabled && node.status === "enabled").length;
  const clientCount = local.reduce((sum, node) => sum + Number(node.safeSummary.clients ?? 0), 0);

  return {
    metrics: [
      { key: "remoteOnline", label: "远端在线", value: `${onlineRemote} / ${Math.max(remote.length, 1)}`, color: "blue" },
      { key: "localNodes", label: "本地节点", value: local.length, color: "green" },
      { key: "clients", label: "接入客户端", value: clientCount, color: "cyan" },
      { key: "inbound", label: "实时入站", value: "0 Mbps", color: "purple" },
      { key: "outbound", label: "实时出站", value: "0 Mbps", color: "blue" },
      { key: "latency", label: "平均延迟", value: formatLatency(averageLatencyValue(remote)), color: "yellow" }
    ],
    health: [
      { name: "Docker", status: "normal", message: "运行中" },
      { name: "PostgreSQL", status: "normal", message: store.driver === "postgres" ? "已连接" : "开发存储" },
      { name: "Redis", status: redisRuntime.status === "error" ? "warning" : "normal", message: redisRuntime.status === "connected" ? "已连接" : "可选" },
      { name: "代理核心", status: "normal", message: "sing-box 模式" },
      { name: "默认端口", status: "normal", message: "可用" }
    ],
    alerts: dashboardAlerts(),
    nodes: nodes.slice(0, 5)
  };
}

export function realtimeSummary() {
  const nodes = store.listNodes();
  const localClients = nodes.filter((node) => node.direction === "local").reduce((sum, node) => sum + Number(node.safeSummary.clients ?? 0), 0);
  return {
    now: {
      inboundMbps: 0,
      outboundMbps: 0,
      activeConnections: localClients,
      avgLatencyMs: averageLatencyValue(nodes)
    },
    points: [],
    events: store.auditLogs().slice(0, 12)
  };
}

export async function realtimeEvents() {
  const redisEvents = await redisRuntime.readEvents(20);
  if (redisEvents.length > 0) return redisEvents;
  return store.auditLogs().slice(0, 12);
}

export async function nodeRealtime(nodeId: string) {
  const node = store.getNode(nodeId);
  const redisNow = await redisRuntime.readNodeNow(nodeId);
  const activeConnections = redisNow?.active_connections ? Number(redisNow.active_connections) : Number(node?.safeSummary.clients ?? 0);
  const downloadMbps = redisNow?.download_mbps ? Number(redisNow.download_mbps) : 0;
  const points = redisNow
    ? Array.from({ length: 15 }, (_, index) => ({
        time: `${index + 1}m`,
        inbound: Number((downloadMbps * (0.65 + index / 60)).toFixed(2)),
        outbound: Number((downloadMbps * (0.35 + index / 90)).toFixed(2)),
        connections: activeConnections
      }))
    : [];
  return {
    nodeId,
    status: redisNow?.status ?? node?.status ?? "draft",
    latencyMs: redisNow?.latency_ms ? Number(redisNow.latency_ms) : node?.safeSummary.latencyMs,
    activeConnections,
    updatedAt: redisNow?.updated_at,
    points
  };
}

export function historySummary(days = 14) {
  const end = new Date();
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setDate(end.getDate() - (days - index - 1));
    const day = date.toISOString().slice(0, 10);
    return {
      day,
      remoteNodes: 0,
      localNodes: 0,
      passedTests: 0,
      warningTests: 0,
      failedTests: 0,
      avgLatencyMs: 0,
      avgDownloadMbps: 0,
      estimatedInboundGb: 0,
      estimatedOutboundGb: 0
    };
  });
  const byDay = new Map(buckets.map((bucket) => [bucket.day, bucket]));
  const nodes = store.listNodes();
  const tests = store.recentTests();
  const trafficSummaries = store.trafficSummaries(days);

  for (const bucket of buckets) {
    bucket.remoteNodes = nodes.filter((node) => node.direction === "remote" && node.createdAt.slice(0, 10) <= bucket.day).length;
    bucket.localNodes = nodes.filter((node) => node.direction === "local" && node.createdAt.slice(0, 10) <= bucket.day).length;
  }

  const trafficByDay = new Map<string, typeof trafficSummaries>();
  for (const summary of trafficSummaries) {
    const values = trafficByDay.get(summary.day) ?? [];
    values.push(summary);
    trafficByDay.set(summary.day, values);
  }

  const latencyValues = new Map<string, number[]>();
  const speedValues = new Map<string, number[]>();
  for (const test of tests) {
    const bucket = byDay.get(test.createdAt.slice(0, 10));
    if (!bucket) continue;
    if (test.finalStatus === "passed") bucket.passedTests += 1;
    if (test.finalStatus === "warning") bucket.warningTests += 1;
    if (test.finalStatus === "failed") bucket.failedTests += 1;
    if (test.latencyMs !== undefined) {
      const values = latencyValues.get(bucket.day) ?? [];
      values.push(test.latencyMs);
      latencyValues.set(bucket.day, values);
    }
    if (test.downloadMbps !== undefined) {
      const values = speedValues.get(bucket.day) ?? [];
      values.push(test.downloadMbps);
      speedValues.set(bucket.day, values);
    }
  }

  for (const bucket of buckets) {
    const traffic = trafficByDay.get(bucket.day) ?? [];
    const latencies = latencyValues.get(bucket.day) ?? [];
    const speeds = speedValues.get(bucket.day) ?? [];
    const trafficLatencies = traffic.map((summary) => summary.avgLatencyMs).filter((value): value is number => value !== undefined);
    bucket.avgLatencyMs = average([...latencies, ...trafficLatencies]);
    bucket.avgDownloadMbps = average(speeds);
    if (traffic.length > 0) {
      const inboundBytes = traffic.filter((summary) => summary.direction === "local").reduce((sum, summary) => sum + summary.downloadBytes, 0);
      const outboundBytes = traffic.filter((summary) => summary.direction === "remote").reduce((sum, summary) => sum + summary.uploadBytes + summary.downloadBytes, 0);
      bucket.estimatedInboundGb = bytesToGb(inboundBytes);
      bucket.estimatedOutboundGb = bytesToGb(outboundBytes);
    } else {
      bucket.estimatedInboundGb = Number(((bucket.localNodes * 1.8 + bucket.passedTests * 0.6 + bucket.warningTests * 0.2)).toFixed(2));
      bucket.estimatedOutboundGb = Number(((bucket.remoteNodes * 1.2 + bucket.passedTests * 0.4)).toFixed(2));
    }
  }

  const totals = buckets.reduce(
    (acc, bucket) => {
      acc.passedTests += bucket.passedTests;
      acc.warningTests += bucket.warningTests;
      acc.failedTests += bucket.failedTests;
      acc.estimatedInboundGb += bucket.estimatedInboundGb;
      acc.estimatedOutboundGb += bucket.estimatedOutboundGb;
      return acc;
    },
    { passedTests: 0, warningTests: 0, failedTests: 0, estimatedInboundGb: 0, estimatedOutboundGb: 0 }
  );
  return {
    days,
    totals: {
      ...totals,
      estimatedInboundGb: Number(totals.estimatedInboundGb.toFixed(2)),
      estimatedOutboundGb: Number(totals.estimatedOutboundGb.toFixed(2)),
      avgLatencyMs: average(buckets.map((bucket) => bucket.avgLatencyMs).filter(Boolean)),
      latestRemoteNodes: buckets.at(-1)?.remoteNodes ?? 0,
      latestLocalNodes: buckets.at(-1)?.localNodes ?? 0
    },
    daily: buckets
  };
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function averageLatencyValue(nodes = store.listNodes()) {
  const summaryValues = nodes.map((node) => node.safeSummary.latencyMs).filter((value): value is number => typeof value === "number");
  const testValues = store.recentTests().map((test) => test.latencyMs).filter((value): value is number => typeof value === "number");
  return average([...summaryValues, ...testValues]);
}

function dashboardAlerts() {
  const tests = store.recentTests().slice(0, 6).map((test) => {
    const node = test.nodeId ? store.getNode(test.nodeId) : undefined;
    return {
      level: test.finalStatus === "failed" ? "error" as const : test.finalStatus === "warning" ? "warning" as const : "success" as const,
      title: `${node?.name ?? "节点"} 测试${test.finalStatus === "failed" ? "失败" : test.finalStatus === "warning" ? "警告" : "通过"}`,
      message: test.humanMessage,
      time: formatTime(test.createdAt)
    };
  });
  if (tests.length > 0) return tests;
  return store.auditLogs().slice(0, 6).map((log) => ({
    level: "success" as const,
    title: log.action,
    message: log.summary,
    time: formatTime(log.createdAt)
  }));
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatLatency(value: number) {
  return value ? `${value} ms` : "暂无";
}

function bytesToGb(bytes: number) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}
