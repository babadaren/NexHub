import { Link } from "react-router-dom";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Direction, NodeConfig } from "../types";
import { StatusBadge } from "../components/Status";

export function NodesPage({ direction }: { direction: Direction }) {
  const [nodes, setNodes] = useState<NodeConfig[]>([]);
  const [testing, setTesting] = useState<string | undefined>();

  const load = () => api.nodes(direction).then(setNodes);
  useEffect(() => {
    load();
  }, [direction]);

  async function test(id: string) {
    setTesting(id);
    try {
      await api.testNode(direction, id);
      await load();
    } finally {
      setTesting(undefined);
    }
  }

  async function remove(id: string) {
    await api.deleteNode(direction, id);
    await load();
  }

  const title = direction === "remote" ? "远端节点" : "本地节点";

  return (
    <div className="page">
      <section className="panel list-header">
        <div>
          <h2>{title}</h2>
          <p>{direction === "remote" ? "管理本机要连接出去的节点" : "管理别人连接本机的入口"}</p>
        </div>
        <Link className="primary small" to={`/${direction}-nodes/new`}>
          <Plus size={17} />
          {direction === "remote" ? "添加远端节点" : "创建本地节点"}
        </Link>
      </section>

      {nodes.length === 0 ? (
        <section className="empty panel">
          <h2>{direction === "remote" ? "还没有远端节点" : "还没有本地节点"}</h2>
          <p>{direction === "remote" ? "添加一个远端节点后，本机就可以连接出去。" : "创建本地节点后，手机或异地设备就可以连接本机。"}</p>
          <Link className="primary" to={`/${direction}-nodes/new`}>
            <Plus size={18} />
            开始创建
          </Link>
        </section>
      ) : (
        <section className="panel table-panel">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>协议</th>
                <th>{direction === "remote" ? "地址" : "监听地址"}</th>
                <th>状态</th>
                <th>{direction === "remote" ? "今日流量" : "接入客户端"}</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.id}>
                  <td>
                    <Link to={`/${direction}-nodes/${node.id}`}>{node.name}</Link>
                  </td>
                  <td>{node.protocol.toUpperCase()}</td>
                  <td>{direction === "remote" ? `${node.safeSummary.server}:${node.safeSummary.port}` : String(node.safeSummary.listen)}</td>
                  <td>
                    <StatusBadge status={node.lastTestStatus ?? node.status} />
                  </td>
                  <td>{direction === "remote" ? String(node.safeSummary.todayTraffic ?? "0B") : String(node.safeSummary.clients ?? 0)}</td>
                  <td className="actions">
                    <button className="ghost icon" onClick={() => test(node.id)} disabled={testing === node.id} title="一键测试">
                      <RefreshCw size={16} />
                    </button>
                    <button className="danger icon" onClick={() => remove(node.id)} title="删除">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
