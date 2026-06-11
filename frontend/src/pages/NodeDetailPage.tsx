import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Copy, QrCode, RefreshCw, Square } from "lucide-react";
import { api } from "../api";
import type { Direction, NodeConfig, NodeTestResult, RealtimePoint } from "../types";
import { StatusBadge } from "../components/Status";
import { TrafficChart } from "../components/Charts";

export function NodeDetailPage({ direction }: { direction: Direction }) {
  const { id } = useParams();
  const [node, setNode] = useState<(NodeConfig & { tests: NodeTestResult[]; realtime: { points: RealtimePoint[] } }) | undefined>();
  const [testing, setTesting] = useState(false);
  const [share, setShare] = useState<string | undefined>();

  const load = () => id && api.node(direction, id).then(setNode);
  useEffect(() => {
    load();
  }, [id, direction]);

  async function runTest() {
    if (!id) return;
    setTesting(true);
    try {
      await api.testNode(direction, id);
      await load();
    } finally {
      setTesting(false);
    }
  }

  async function copyShare() {
    if (!id || direction !== "local") return;
    const data = await api.shareNode(id);
    setShare(data.link);
    await navigator.clipboard?.writeText(data.link);
  }

  if (!node) return <div className="panel">正在加载节点详情...</div>;

  const latest = node.tests[0];

  return (
    <div className="page detail-page">
      <section className="detail-grid">
        <div className="panel node-status-card">
          <h2>节点状态</h2>
          <strong>{node.name}</strong>
          <div className="tag-row">
            <StatusBadge status={node.status} />
            <span className="tag">{node.protocol.toUpperCase()}</span>
            <span className="tag green">{direction === "local" ? "公网可达" : "远端节点"}</span>
          </div>
          <p>{direction === "remote" ? `地址：${node.safeSummary.server}:${node.safeSummary.port}` : `监听：${node.safeSummary.listen}`}</p>
        </div>

        <div className="panel node-status-card">
          <h2>连接信息</h2>
          <p>外部地址：{String(node.config.server ?? node.config.share ?? "proxy.example.com")}</p>
          <p>内部地址：192.168.1.8:{String(node.config.listenPort ?? node.config.port ?? 443)}</p>
          <p>订阅链接：{direction === "local" ? "已生成" : "不适用"}</p>
          {share && <p>分享链接：{share}</p>}
        </div>

        <div className="actions-bar">
          <button className="primary" onClick={runTest} disabled={testing}>
            <RefreshCw size={18} />
            {testing ? "测试中..." : "一键测试"}
          </button>
          <button className="ghost" onClick={() => navigator.clipboard?.writeText(JSON.stringify(node.config, null, 2))}>
            <Copy size={18} />
            复制配置
          </button>
          {direction === "local" && (
            <button className="ghost" onClick={copyShare}>
              <QrCode size={18} />
              分享二维码
            </button>
          )}
          <button className="danger">
            <Square size={18} />
            停止
          </button>
        </div>

        <div className="panel test-panel">
          <h2>一键测试结果</h2>
          {!latest ? (
            <p>还没有测试记录。</p>
          ) : (
            <div className="test-table">
              {latest.steps.map((step) => (
                <div key={step.name}>
                  <span>{step.name}</span>
                  <StatusBadge status={step.status} />
                  <em>{step.message}</em>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel chart-panel">
          <h2>实时流量</h2>
          <TrafficChart data={node.realtime.points} compact />
        </div>

        <div className="panel">
          <h2>接入客户端</h2>
          <table>
            <tbody>
              {["device-23", "client-17", "phone-05"].map((client, index) => (
                <tr key={client}>
                  <td>{client}</td>
                  <td>{["上海", "东京", "洛杉矶"][index]}</td>
                  <td>{[21, 8, 42][index]}分钟</td>
                  <td>{[18.3, 6.2, 3.1][index]} Mbps</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
