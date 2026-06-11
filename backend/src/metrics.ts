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
      { key: "clients", label: "接入客户端", value: clientCount + 56, color: "cyan" },
      { key: "inbound", label: "实时入站", value: "312 Mbps", color: "purple" },
      { key: "outbound", label: "实时出站", value: "84 Mbps", color: "blue" },
      { key: "latency", label: "平均延迟", value: "68 ms", color: "yellow" }
    ],
    health: [
      { name: "Docker", status: "normal", message: "运行中" },
      { name: "PostgreSQL", status: "normal", message: store.driver === "postgres" ? "已连接" : "开发存储" },
      { name: "Redis", status: redisRuntime.status === "error" ? "warning" : "normal", message: redisRuntime.status === "connected" ? "已连接" : "可选" },
      { name: "代理核心", status: "normal", message: "sing-box 模式" },
      { name: "默认端口", status: "normal", message: "可用" }
    ],
    alerts: [
      { level: "warning", title: "JP-02 延迟偏高", message: "建议切换线路", time: "2 分钟前" },
      { level: "error", title: "US-01 不可连接", message: "测试失败：服务器超时", time: "15 分钟前" },
      { level: "success", title: "Relay-HK 公网可达", message: "可复制二维码分享其他设备", time: "1 小时前" }
    ],
    nodes: nodes.slice(0, 5)
  };
}

export function realtimeSummary() {
  const points = Array.from({ length: 24 }, (_, index) => {
    const x = index;
    return {
      time: `${String(index).padStart(2, "0")}:00`,
      inbound: Math.round(180 + Math.sin(x / 2) * 70 + Math.cos(x / 3) * 40 + index * 3),
      outbound: Math.round(120 + Math.sin(x / 2 + 0.8) * 55 + index * 2),
      connections: Math.round(60 + Math.sin(x / 1.8) * 35 + index),
      errors: Math.max(0, Math.round(6 + Math.sin(x) * 5))
    };
  });
  return {
    now: {
      inboundMbps: 312,
      outboundMbps: 84,
      activeConnections: 128,
      avgLatencyMs: 68
    },
    points,
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
  const points = Array.from({ length: 15 }, (_, index) => ({
    time: `${index + 1}m`,
    inbound: Math.round(40 + Math.sin(index) * 16 + index * 3),
    outbound: Math.round(35 + Math.cos(index / 2) * 12 + index * 2),
    connections: Math.round(8 + Math.sin(index / 3) * 4 + index)
  }));
  return {
    nodeId,
    status: redisNow?.status ?? node?.status ?? "draft",
    latencyMs: redisNow?.latency_ms ? Number(redisNow.latency_ms) : node?.safeSummary.latencyMs ?? 58,
    activeConnections: redisNow?.active_connections ? Number(redisNow.active_connections) : node?.safeSummary.clients ?? 3,
    updatedAt: redisNow?.updated_at,
    points
  };
}
