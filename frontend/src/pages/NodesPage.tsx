import { Link } from "react-router-dom";
import { Plus, RefreshCw, Rss, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Direction, NodeConfig, SubscriptionRefreshLog, SubscriptionSource } from "../types";
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
  const [subscriptionLog, setSubscriptionLog] = useState<SubscriptionRefreshLog | undefined>();
  const [subscriptionForm, setSubscriptionForm] = useState({
    name: "",
    url: "",
    content: "",
    autoRefresh: false,
    refreshCron: "0 3 * * *",
    autoEnableNewNodes: false,
    allowPrivateNetwork: false
  });
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
      await api.createSubscription({
        name,
        url: url || undefined,
        content: content || undefined,
        sourceType: content ? "content" : "url",
        autoRefresh: subscriptionForm.autoRefresh,
        refreshCron: subscriptionForm.autoRefresh ? subscriptionForm.refreshCron.trim() || "0 3 * * *" : undefined,
        autoEnableNewNodes: subscriptionForm.autoEnableNewNodes,
        allowPrivateNetwork: subscriptionForm.allowPrivateNetwork
      });
      setSubscriptionForm({ name: "", url: "", content: "", autoRefresh: false, refreshCron: "0 3 * * *", autoEnableNewNodes: false, allowPrivateNetwork: false });
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

  async function toggleSubscriptionAutoRefresh(subscription: SubscriptionSource) {
    setSubscriptionError(undefined);
    try {
      await api.updateSubscription(subscription.id, {
        autoRefresh: !subscription.autoRefresh,
        refreshCron: subscription.refreshCron ?? "0 3 * * *"
      });
      await loadSubscriptions();
    } catch (error) {
      setSubscriptionError(error instanceof Error ? error.message : "订阅源更新失败");
    }
  }

  async function removeSubscription(subscription: SubscriptionSource) {
    if (!window.confirm(`删除订阅源 ${subscription.name}？已导入节点不会被删除。`)) return;
    setSubscriptionError(undefined);
    try {
      await api.deleteSubscription(subscription.id);
      if (subscriptionLog?.subscription.id === subscription.id) setSubscriptionLog(undefined);
      await loadSubscriptions();
    } catch (error) {
      setSubscriptionError(error instanceof Error ? error.message : "订阅源删除失败");
    }
  }

  async function showSubscriptionLog(id: string) {
    setSubscriptionError(undefined);
    try {
      setSubscriptionLog(await api.subscriptionRefreshLog(id));
    } catch (error) {
      setSubscriptionError(error instanceof Error ? error.message : "刷新日志读取失败");
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
            <label className="checkbox-row">
              <input type="checkbox" checked={subscriptionForm.autoRefresh} onChange={(event) => setSubscriptionForm((form) => ({ ...form, autoRefresh: event.target.checked }))} />
              自动刷新
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={subscriptionForm.autoEnableNewNodes} onChange={(event) => setSubscriptionForm((form) => ({ ...form, autoEnableNewNodes: event.target.checked }))} />
              测试通过后自动启用新节点
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={subscriptionForm.allowPrivateNetwork} onChange={(event) => setSubscriptionForm((form) => ({ ...form, allowPrivateNetwork: event.target.checked }))} />
              允许内网订阅地址
            </label>
            <label>
              Cron
              <input
                value={subscriptionForm.refreshCron}
                onChange={(event) => setSubscriptionForm((form) => ({ ...form, refreshCron: event.target.value }))}
                placeholder="0 3 * * *"
                disabled={!subscriptionForm.autoRefresh}
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
                  <th>刷新策略</th>
                  <th>导入策略</th>
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
                    <td>{subscription.autoRefresh ? subscription.refreshCron ?? "0 3 * * *" : "手动"}</td>
                    <td>{subscription.autoEnableNewNodes ? "测试后启用" : "新增为草稿"}{subscription.allowPrivateNetwork ? " / 允许内网" : ""}</td>
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
                      <button className="ghost small" onClick={() => toggleSubscriptionAutoRefresh(subscription)}>
                        {subscription.autoRefresh ? "关闭自动" : "开启自动"}
                      </button>
                      <button className="ghost small" onClick={() => showSubscriptionLog(subscription.id)}>
                        日志
                      </button>
                      <button className="danger small" onClick={() => removeSubscription(subscription)}>
                        <Trash2 size={16} />
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {subscriptionLog && (
            <div className="subscription-log">
              <div className="list-header compact">
                <div>
                  <h3>{subscriptionLog.subscription.name} 刷新日志</h3>
                  <p>最近刷新审计和实时事件。</p>
                </div>
                <button className="ghost small" onClick={() => setSubscriptionLog(undefined)}>
                  关闭
                </button>
              </div>
              <div className="import-preview-list">
                {subscriptionLog.audits.length === 0 ? (
                  <p className="muted">暂无刷新日志。</p>
                ) : (
                  subscriptionLog.audits.slice(0, 6).map((audit) => (
                    <div key={audit.id} className="import-preview-item">
                      <strong>{audit.action}</strong>
                      <span>{new Date(audit.createdAt).toLocaleString()}</span>
                      <span>{audit.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
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
                    <div className="name-cell">
                      <Link to={`/${direction}-nodes/${node.id}`}>{node.name}</Link>
                      {direction === "remote" && node.sourceMissing && <span className="tag warning small">订阅缺失</span>}
                    </div>
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
