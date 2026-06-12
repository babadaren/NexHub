import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RealtimePoint } from "../types";

export function Sparkline({ data, color = "#2f83ff" }: { data: RealtimePoint[]; color?: string }) {
  if (data.length === 0) return <div className="chart-empty compact">暂无实时数据</div>;
  return (
    <ResponsiveContainer width="100%" height={42}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id={`spark-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.5} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="inbound" stroke={color} fill={`url(#spark-${color})`} strokeWidth={2} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TrafficChart({ data, compact = false }: { data: RealtimePoint[]; compact?: boolean }) {
  if (data.length === 0) return <div className={compact ? "chart-empty compact" : "chart-empty"}>暂无实时数据</div>;
  return (
    <ResponsiveContainer width="100%" height={compact ? 220 : 310}>
      <LineChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#1e3857" vertical={false} />
        <XAxis dataKey="time" stroke="#8ba3c2" tickLine={false} axisLine={false} />
        <YAxis stroke="#8ba3c2" tickLine={false} axisLine={false} width={42} />
        <Tooltip contentStyle={{ background: "#0d1b2d", border: "1px solid #25486d", borderRadius: 8, color: "#eaf2ff" }} />
        <Line type="monotone" dataKey="inbound" name="入站" stroke="#2f83ff" strokeWidth={3} dot={false} />
        <Line type="monotone" dataKey="outbound" name="出站" stroke="#8b48ff" strokeWidth={3} dot={false} />
        <Line type="monotone" dataKey="connections" name="连接数" stroke="#21d873" strokeWidth={3} dot={false} />
        {"errors" in (data[0] ?? {}) && <Line type="monotone" dataKey="errors" name="错误率" stroke="#ff4d5e" strokeWidth={2} dot={false} />}
      </LineChart>
    </ResponsiveContainer>
  );
}
