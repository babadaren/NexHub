import { Link } from "react-router-dom";
import { ArrowRight, Bell, BookOpen, Globe2, Link2, Server, ShieldCheck, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { DashboardSummary, RealtimePoint } from "../types";
import { Sparkline, TrafficChart } from "../components/Charts";
import { StatusBadge } from "../components/Status";

export function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary>();
  const [traffic, setTraffic] = useState<RealtimePoint[]>([]);

  useEffect(() => {
    api.dashboard().then(setSummary);
    api.realtime().then((data) => setTraffic(data.points));
  }, []);

  if (!summary) return <div className="panel">正在加载总览...</div>;

  return (
    <div className="page">
      <section className="metric-grid">
        {summary.metrics.map((metric) => (
          <div className={`metric ${metric.color}`} key={metric.key}>
            <Globe2 size={26} />
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <Sparkline data={traffic} />
          </div>
        ))}
      </section>

      <section className="dashboard-grid">
        <div className="panel action-panel">
          <h2>今天你想做什么？</h2>
          <p>几步即可完成节点配置与测试</p>
          <div className="action-row">
            <Link className="big-action blue" to="/remote-nodes/new">
              <Globe2 size={42} />
              <span>
                <strong>连接远端节点</strong>
                添加并连接远端代理节点
              </span>
              <ArrowRight />
            </Link>
            <Link className="big-action green" to="/local-nodes/new">
              <Server size={42} />
              <span>
                <strong>创建本地节点</strong>
                在本机创建代理节点
              </span>
              <ArrowRight />
            </Link>
          </div>
          <div className="quick-row">
            <Link to="/remote-nodes">
              <Link2 size={18} />
              导入分享链接
            </Link>
            <Link to="/local-nodes">
              <Wifi size={18} />
              公网检测
            </Link>
            <Link to="/settings">
              <BookOpen size={18} />
              查看部署
            </Link>
          </div>
          <div className="steps">
            <span>1 选择用途</span>
            <span>2 粘贴或填写</span>
            <span>3 一键测试</span>
            <span>4 保存 / 分享</span>
          </div>
        </div>

        <div className="panel">
          <h2>
            <ShieldCheck size={22} />
            系统检查
          </h2>
          <div className="health-list">
            {summary.health.map((item) => (
              <div key={item.name}>
                <span>{item.name}</span>
                <strong>{item.message}</strong>
                <StatusBadge status={item.status} />
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>
            <Bell size={22} />
            最近提示
          </h2>
          <div className="alert-list">
            {summary.alerts.map((item) => (
              <div className={`alert ${item.level}`} key={item.title}>
                <strong>{item.title}</strong>
                <span>{item.message}</span>
                <em>{item.time}</em>
              </div>
            ))}
          </div>
        </div>

        <div className="panel table-panel">
          <h2>节点概览</h2>
          <table>
            <thead>
              <tr>
                <th>节点</th>
                <th>类型</th>
                <th>状态</th>
                <th>延迟</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {summary.nodes.map((node) => (
                <tr key={node.id}>
                  <td>{node.name}</td>
                  <td>{node.direction === "remote" ? "远端" : "本地"}</td>
                  <td>
                    <StatusBadge status={node.status} />
                  </td>
                  <td>{String(node.safeSummary.latencyMs ?? "—")} ms</td>
                  <td>
                    <Link to={`/${node.direction}-nodes/${node.id}`}>详情</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel chart-panel">
          <h2>全局流量趋势</h2>
          <TrafficChart data={traffic} />
        </div>
      </section>
    </div>
  );
}
