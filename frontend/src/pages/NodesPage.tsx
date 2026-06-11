import { Link } from "react-router-dom";
import { Plus, RefreshCw, Rss, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Direction, NodeConfig, SubscriptionSource } from "../types";
import { StatusBadge } from "../components/Status";

function subscriptionSourceLabel(subscription: SubscriptionSource) {
  if (!subscription.url) return "粘贴内容";
  try {
    return new URL(subscription.url).host;
  } catch {
    return "订阅 URL";
  }
}

export function NodesPage({ direction }: { direction: Direction }) {
  const [nodes, setNodes] = useState<NodeConfig[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionSource[]>([]);
  const [testing, setTesting] = useState<string | undefined>();
  const [refreshingSubscription, setRefreshingSubscription] = useState<string | undefined>();
  const [subscriptionForm, setSubscriptionForm] = useState({ name: "", url: "", content: "" });
  const [subscriptionError, setSubscriptionError] = useState<string | undefined>();

  const load = () => api.nodes(direction).then(setNodes);
  const loadSubscriptions = () => {
    if (direction !== "remote") return Promise.resolve();
    return api.subscriptions().then(setSubscriptions);
  };

  useEffect(() => {
    load();
    loadSubscriptions();
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

  async function createSubscription(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubscriptionError(undefined);
    try {
      const name = subscriptionForm.name.trim();
      const url = subscriptionForm.url.trim();
      const content = subscriptionForm.content.trim();
      if (!name || (!url && !content)) {
        setSubscriptionError("请填写名称，并至少提供订阅 URL 或粘贴内容。");
        return;
      }
      await api.createSubscription({ name, url: url || undefined, content: content || undefined });
      setSubscriptionForm({ name: "", url: "", content: "" });
      await loadSubscriptions();
    } catch (error) {
      setSubscriptionError(error instanceof Error ? error.message : "订阅源创建失败");
    }
  }

  async function refreshSubscription(id: string) {
    setRefreshingSubscription(id);
    setSubscriptionError(undefined);
    try {
      await api.refreshSubscription(id);
      await Promise.all([loadSubscriptions(), load()]);
    } catch (error) {
      setSubscriptionError(error instanceof Error ? error.message : "订阅刷新失败");
    } finally {
      setRefreshingSubscription(undefined);
    }
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

      {direction === "remote" && (
        <section className="panel subscription-panel">
          <div className="list-header compact">
            <div>
              <h2>
                <Rss size={18} />
                订阅源
              </h2>
              <p>保存常用订阅，手动刷新后新增节点会先进入草稿。</p>
            </div>
          </div>
          <form className="subscription-form" onSubmit={createSubscription}>
            <label>
              名称
              <input value={subscriptionForm.name} onChange={(event) => setSubscriptionForm((form) => ({ ...form, name: event.target.value }))} placeholder="机场 A / 自用配置" />
            </label>
            <label>
              订阅 URL
              <input value={subscriptionForm.url} onChange={(event) => setSubscriptionForm((form) => ({ ...form, url: event.target.value }))} placeholder="https://example.com/sub" />
            </label>
            <label className="wide">
              粘贴内容
              <textarea
                value={subscriptionForm.content}
                onChange={(event) => setSubscriptionForm((form) => ({ ...form, content: event.target.value }))}
                placeholder="支持 vmess/vless/trojan/ss 链接、base64 订阅、Clash YAML、Sing-box JSON"
              />
            </label>
            <button className="primary small" type="submit">
              <Plus size={16} />
              保存订阅源
            </button>
          </form>
          {subscriptionError && <div className="error-box">{subscriptionError}</div>}
          {subscriptions.length > 0 && (
            <table className="subscription-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>来源</th>
                  <th>最近刷新</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((subscription) => (
                  <tr key={subscription.id}>
                    <td>{subscription.name}</td>
                    <td>{subscriptionSourceLabel(subscription)}</td>
                    <td>{subscription.lastRefreshAt ? new Date(subscription.lastRefreshAt).toLocaleString() : "未刷新"}</td>
                    <td>
                      <StatusBadge status={subscription.lastRefreshStatus ?? "never"} />
                      {subscription.lastRefreshMessage && <span className="muted inline-message">{subscription.lastRefreshMessage}</span>}
                    </td>
                    <td>
                      <button className="ghost small" onClick={() => refreshSubscription(subscription.id)} disabled={refreshingSubscription === subscription.id}>
                        <RefreshCw size={16} />
                        刷新
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

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
