import { useEffect, useState } from "react";
import { Activity, Clock, Gauge, Users } from "lucide-react";
import { api } from "../api";
import type { RealtimePoint } from "../types";
import { TrafficChart } from "../components/Charts";

export function RealtimePage() {
  const [data, setData] = useState<{ now: Record<string, number>; points: RealtimePoint[]; events: Array<Record<string, unknown>> }>();

  useEffect(() => {
    api.realtime().then(setData);
    const timer = window.setInterval(() => api.realtime().then(setData), 10000);
    return () => window.clearInterval(timer);
  }, []);

  if (!data) return <div className="panel">正在等待监控数据...</div>;

  return (
    <div className="page">
      <section className="metric-grid four">
        <div className="metric blue">
          <Activity />
          <span>实时入站</span>
          <strong>{data.now.inboundMbps} Mbps</strong>
        </div>
        <div className="metric purple">
          <Gauge />
          <span>实时出站</span>
          <strong>{data.now.outboundMbps} Mbps</strong>
        </div>
        <div className="metric green">
          <Users />
          <span>连接数</span>
          <strong>{data.now.activeConnections}</strong>
        </div>
        <div className="metric yellow">
          <Clock />
          <span>平均延迟</span>
          <strong>{data.now.avgLatencyMs} ms</strong>
        </div>
      </section>
      <section className="panel chart-panel">
        <h2>近 24 小时趋势</h2>
        <TrafficChart data={data.points} />
      </section>
      <section className="panel table-panel">
        <h2>短期事件</h2>
        <table>
          <tbody>
            {data.events.map((event) => (
              <tr key={String(event.id)}>
                <td>{String(event.action)}</td>
                <td>{String(event.summary)}</td>
                <td>{new Date(String(event.createdAt)).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
