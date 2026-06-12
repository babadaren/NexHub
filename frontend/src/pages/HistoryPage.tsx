import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, CalendarDays, Gauge, Server } from "lucide-react";
import { api } from "../api";
import type { HistorySummary } from "../types";

export function HistoryPage() {
  const [days, setDays] = useState(14);
  const [summary, setSummary] = useState<HistorySummary>();

  useEffect(() => {
    api.history(days).then(setSummary);
  }, [days]);

  if (!summary) return <div className="panel">正在加载历史摘要...</div>;

  return (
    <div className="page">
      <section className="metric-grid four">
        <div className="metric green">
          <Activity size={26} />
          <span>测试通过</span>
          <strong>{summary.totals.passedTests}</strong>
        </div>
        <div className="metric yellow">
          <Gauge size={26} />
          <span>平均延迟</span>
          <strong>{summary.totals.avgLatencyMs || "-"} ms</strong>
        </div>
        <div className="metric blue">
          <Server size={26} />
          <span>当前节点</span>
          <strong>{summary.totals.latestRemoteNodes + summary.totals.latestLocalNodes}</strong>
        </div>
        <div className="metric purple">
          <CalendarDays size={26} />
          <span>估算流量</span>
          <strong>{(summary.totals.estimatedInboundGb + summary.totals.estimatedOutboundGb).toFixed(1)} GB</strong>
        </div>
      </section>

      <section className="panel">
        <div className="list-header compact">
          <div>
            <h2>每日摘要趋势</h2>
            <p>只展示聚合摘要，不保存秒级明细</p>
          </div>
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={7}>最近 7 天</option>
            <option value={14}>最近 14 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </select>
        </div>
        <div className="history-chart">
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={summary.daily}>
              <CartesianGrid stroke="#1d3551" strokeDasharray="3 3" />
              <XAxis dataKey="day" stroke="#8fa6c3" />
              <YAxis stroke="#8fa6c3" />
              <Tooltip contentStyle={{ background: "#07192b", border: "1px solid #24496d", borderRadius: 8 }} />
              <Area type="monotone" dataKey="estimatedInboundGb" name="入站 GB" stroke="#20d873" fill="#20d873" fillOpacity={0.18} />
              <Area type="monotone" dataKey="estimatedOutboundGb" name="出站 GB" stroke="#2f83ff" fill="#2f83ff" fillOpacity={0.16} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="panel table-panel">
        <h2>每日明细</h2>
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>远端/本地节点</th>
              <th>通过/警告/失败</th>
              <th>平均延迟</th>
              <th>平均测速</th>
              <th>估算入站/出站</th>
            </tr>
          </thead>
          <tbody>
            {summary.daily.map((day) => (
              <tr key={day.day}>
                <td>{day.day}</td>
                <td>
                  {day.remoteNodes} / {day.localNodes}
                </td>
                <td>
                  {day.passedTests} / {day.warningTests} / {day.failedTests}
                </td>
                <td>{day.avgLatencyMs || "-"} ms</td>
                <td>{day.avgDownloadMbps || "-"} Mbps</td>
                <td>
                  {day.estimatedInboundGb} / {day.estimatedOutboundGb} GB
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
