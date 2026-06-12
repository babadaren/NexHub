import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, Copy, Globe2, Power, QrCode, RefreshCw, RotateCw, Save, Square, Trash2 } from "lucide-react";
import { api } from "../api";
import type { Direction, NodeConfig, NodeRealtime, NodeTestResult, PublicCheckResult, SharePayload } from "../types";
import { StatusBadge } from "../components/Status";
import { TrafficChart } from "../components/Charts";

export function NodeDetailPage({ direction }: { direction: Direction }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [node, setNode] = useState<(NodeConfig & { tests: NodeTestResult[]; realtime: NodeRealtime }) | undefined>();
  const [testing, setTesting] = useState(false);
  const [share, setShare] = useState<SharePayload | undefined>();
  const [publicCheck, setPublicCheck] = useState<PublicCheckResult | undefined>();
  const [localAction, setLocalAction] = useState<"restart" | "public-check" | undefined>();
  const [editForm, setEditForm] = useState({ name: "", address: "", port: "", configText: "{}" });
  const [editMessage, setEditMessage] = useState("");
  const [stopOpen, setStopOpen] = useState(false);
  const [stopText, setStopText] = useState("");
  const [stopMessage, setStopMessage] = useState("");
  const [stopping, setStopping] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleteMessage, setDeleteMessage] = useState("");
  const [deleting, setDeleting] = useState(false);

  const load = () => id && api.node(direction, id).then(setNode);
  useEffect(() => {
    load();
  }, [id, direction]);

  useEffect(() => {
    if (!node) return;
    setEditForm({
      name: node.name,
      address: String(direction === "remote" ? node.config.server ?? node.config.host ?? "" : node.config.listenHost ?? ""),
      port: String(node.config.port ?? node.config.listenPort ?? ""),
      configText: JSON.stringify(node.config, null, 2)
    });
    setEditMessage("");
  }, [node?.id, direction]);

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
    setShare(data);
    if (data.subscription) await navigator.clipboard?.writeText(data.subscription);
  }

  async function rotateShare() {
    if (!id || direction !== "local") return;
    const data = await api.rotateShareNode(id);
    setShare(data);
    if (data.subscription) await navigator.clipboard?.writeText(data.subscription);
    await load();
  }

  async function restartLocal() {
    if (!id || direction !== "local") return;
    setLocalAction("restart");
    try {
      await api.restartLocalNode(id);
      await load();
    } finally {
      setLocalAction(undefined);
    }
  }

  async function runPublicCheck() {
    if (!id || direction !== "local") return;
    setLocalAction("public-check");
    try {
      const result = await api.publicCheckLocalNode(id);
      setPublicCheck(result);
    } finally {
      setLocalAction(undefined);
    }
  }

  async function copyText(value: string) {
    await navigator.clipboard?.writeText(value);
  }

  async function saveEdit() {
    if (!id || !node) return;
    const currentNode = node;
    setEditMessage("");
    let config: Record<string, unknown>;
    try {
      const parsed = JSON.parse(editForm.configText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setEditMessage("配置 JSON 必须是对象");
        return;
      }
      config = parsed as Record<string, unknown>;
    } catch {
      setEditMessage("配置 JSON 格式不正确");
      return;
    }
    if (direction === "remote") {
      config.server = editForm.address || config.server;
      config.port = Number(editForm.port || config.port || 443);
    } else {
      config.listenHost = editForm.address || config.listenHost || "0.0.0.0";
      config.listenPort = Number(editForm.port || config.listenPort || config.port || 20001);
    }
    const updated = await api.updateNode(direction, id, {
      name: editForm.name.trim() || currentNode.name,
      config
    });
    setNode((current) => current && { ...current, ...updated });
    setEditMessage("节点配置已保存为草稿，请重新一键测试或使用启用按钮确认。");
    await load();
  }

  async function toggleEnabled() {
    if (!id || !node) return;
    const currentNode = node;
    setEditMessage("");
    const updated = currentNode.enabled ? await api.disableNode(direction, id) : await api.enableNode(direction, id);
    setNode((current) => current && { ...current, ...updated });
    setEditMessage(updated.enabled ? "节点已启用" : "节点已停用");
    await load();
  }

  async function confirmStop() {
    if (!id || stopText !== "STOP") return;
    setStopMessage("");
    setStopping(true);
    try {
      await api.stopLocalNode(id);
      setStopOpen(false);
      setStopText("");
      await load();
    } catch (error) {
      setStopMessage(error instanceof Error ? error.message : "停止失败，请稍后重试。");
    } finally {
      setStopping(false);
    }
  }

  async function confirmDelete() {
    if (!id || !node || deleteText !== "DELETE") return;
    setDeleteMessage("");
    setDeleting(true);
    try {
      await api.deleteNode(direction, id);
      navigate(direction === "remote" ? "/remote-nodes" : "/local-nodes", { replace: true });
    } catch (error) {
      setDeleteMessage(error instanceof Error ? error.message : "删除失败，请稍后重试。");
    } finally {
      setDeleting(false);
    }
  }

  if (!node) return <div className="panel">正在加载节点详情...</div>;

  const latest = node.tests[0];
  const shareQrText = share?.qrPayload ?? "";
  const shareSingBox = share ? JSON.stringify(share.singBox, null, 2) : "";
  const externalAddress = String(node.config.server ?? node.config.sharePublicHost ?? node.config.publicHost ?? (direction === "local" ? "跟随当前访问地址" : "未配置"));
  const stopClientCount = Number(node.realtime.activeConnections ?? node.safeSummary.clients ?? 0);

  return (
    <div className="page detail-page">
      <section className="detail-grid">
        <div className="panel node-status-card">
          <h2>节点状态</h2>
          <strong>{node.name}</strong>
          <div className="tag-row">
            <StatusBadge status={node.status} />
            <span className="tag">{node.protocol.toUpperCase()}</span>
            <span className="tag green">{direction === "local" ? "本地入口" : "远端节点"}</span>
          </div>
          <p>{direction === "remote" ? `地址：${node.safeSummary.server}:${node.safeSummary.port}` : `监听：${node.safeSummary.listen}`}</p>
        </div>

        <div className="panel node-status-card">
          <h2>连接信息</h2>
          <p>外部地址：{externalAddress}</p>
          <p>内部地址：{String(node.safeSummary.listen ?? `${node.config.listenHost ?? "0.0.0.0"}:${node.config.listenPort ?? node.config.port ?? 443}`)}</p>
          <p>订阅链接：{direction === "local" ? (share?.subscription ? "已生成" : "点击分享后生成") : "不适用"}</p>
        </div>

        <div className="actions-bar">
          <button className="primary" onClick={runTest} disabled={testing}>
            <RefreshCw size={18} />
            {testing ? "测试中..." : "一键测试"}
          </button>
          <button className="ghost" onClick={() => copyText(JSON.stringify(node.config, null, 2))}>
            <Copy size={18} />
            复制配置
          </button>
          <button className="ghost" onClick={saveEdit}>
            <Save size={18} />
            保存修改
          </button>
          <button className="ghost" onClick={toggleEnabled}>
            <Power size={18} />
            {node.enabled ? "停用" : "启用"}
          </button>
          <button
            className="danger"
            onClick={() => {
              setDeleteOpen(true);
              setDeleteText("");
              setDeleteMessage("");
            }}
          >
            <Trash2 size={18} />
            删除
          </button>
          {direction === "local" && (
            <>
              <button className="ghost" onClick={runPublicCheck} disabled={localAction === "public-check"}>
                <Globe2 size={18} />
                {localAction === "public-check" ? "检测中..." : "公网检测"}
              </button>
              <button className="ghost" onClick={restartLocal} disabled={localAction === "restart"}>
                <RotateCw size={18} />
                {localAction === "restart" ? "重启中..." : "重启"}
              </button>
              <button className="ghost" onClick={copyShare}>
                <QrCode size={18} />
                生成分享
              </button>
              <button className="ghost" onClick={rotateShare}>
                <RefreshCw size={18} />
                轮换链接
              </button>
              <button
                className="danger"
                onClick={() => {
                  setStopOpen(true);
                  setStopText("");
                  setStopMessage("");
                }}
              >
                <Square size={18} />
                停止
              </button>
            </>
          )}
        </div>

        {deleteOpen && (
          <div className="panel danger-confirm-panel">
            <h2>确认删除节点</h2>
            <p>删除后只移除节点配置，审计记录和历史摘要会保留。确认要删除时请输入 DELETE。</p>
            <dl className="kv">
              <dt>节点</dt>
              <dd>{node.name}</dd>
              <dt>协议</dt>
              <dd>{node.protocol.toUpperCase()}</dd>
              <dt>类型</dt>
              <dd>{direction === "remote" ? "远端节点" : "本地入口"}</dd>
            </dl>
            <label>
              确认文本
              <input value={deleteText} onChange={(event) => setDeleteText(event.target.value)} placeholder="DELETE" />
            </label>
            {deleteMessage && <div className="error-box">{deleteMessage}</div>}
            <div className="form-actions">
              <button className="danger" onClick={confirmDelete} disabled={deleteText !== "DELETE" || deleting}>
                <Trash2 size={18} />
                {deleting ? "删除中..." : "确认删除"}
              </button>
              <button className="ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>
                取消
              </button>
            </div>
          </div>
        )}

        <div className="panel edit-panel">
          <h2>编辑节点配置</h2>
          <p>保存后请重新一键测试；测试失败会保留为草稿。</p>
          <div className="advanced-fields">
            <label>
              节点名称
              <input value={editForm.name} onChange={(event) => setEditForm((form) => ({ ...form, name: event.target.value }))} />
            </label>
            <label>
              {direction === "remote" ? "服务器地址" : "监听地址"}
              <input value={editForm.address} onChange={(event) => setEditForm((form) => ({ ...form, address: event.target.value }))} />
            </label>
            <label>
              端口
              <input value={editForm.port} onChange={(event) => setEditForm((form) => ({ ...form, port: event.target.value }))} />
            </label>
          </div>
          <label>
            完整配置 JSON
            <textarea className="config-editor" value={editForm.configText} onChange={(event) => setEditForm((form) => ({ ...form, configText: event.target.value }))} />
          </label>
          {editMessage && <div className={editMessage.includes("不正确") || editMessage.includes("必须") ? "error-box" : "notice"}>{editMessage}</div>}
        </div>

        {direction === "local" && stopOpen && (
          <div className="panel stop-confirm-panel">
            <h2>确认停止本地节点</h2>
            <p>停止后，当前接入客户端会断开。确认要停止时请输入 STOP。</p>
            <dl className="kv">
              <dt>节点</dt>
              <dd>{node.name}</dd>
              <dt>协议</dt>
              <dd>{node.protocol.toUpperCase()}</dd>
              <dt>接入客户端</dt>
              <dd>{Number.isFinite(stopClientCount) ? stopClientCount : 0}</dd>
            </dl>
            <label>
              确认文本
              <input value={stopText} onChange={(event) => setStopText(event.target.value)} placeholder="STOP" />
            </label>
            {stopMessage && <div className="error-box">{stopMessage}</div>}
            <div className="form-actions">
              <button className="danger" onClick={confirmStop} disabled={stopText !== "STOP" || stopping}>
                <Square size={18} />
                {stopping ? "停止中..." : "确认停止"}
              </button>
              <button className="ghost" onClick={() => setStopOpen(false)} disabled={stopping}>
                取消
              </button>
            </div>
          </div>
        )}

        {direction === "local" && publicCheck && (
          <div className="panel public-check-panel">
            <h2>
              <Globe2 size={22} />
              公网可达性检测
            </h2>
            <dl className="kv">
              <dt>公网 IP</dt>
              <dd>{publicCheck.publicIp}</dd>
              <dt>DNS</dt>
              <dd>{publicCheck.dns}</dd>
              <dt>端口</dt>
              <dd>{publicCheck.port}</dd>
              <dt>IPv6</dt>
              <dd>{publicCheck.ipv6}</dd>
              <dt>NAT 类型</dt>
              <dd>{publicCheck.natType}</dd>
            </dl>
            <p className={publicCheck.reachable ? "notice success-notice" : "notice security-notice"}>{publicCheck.suggestion}</p>
          </div>
        )}

        {direction === "local" && share && (
          <div className="panel share-panel">
            <h2>
              <QrCode size={22} />
              分享本地节点
            </h2>
            <div className="share-warning">
              <AlertTriangle size={18} />
              分享链接包含连接凭据，只发送给可信设备。轮换链接后旧订阅链接会立即失效。
            </div>
            <div className="share-grid">
              <div className="qr-box">
                <QrCode size={64} />
                <strong>二维码载荷</strong>
                <span>{shareQrText}</span>
                <button className="ghost small" onClick={() => copyText(shareQrText)}>
                  <Copy size={16} />
                  复制二维码内容
                </button>
              </div>
              <div className="share-copy-list">
                {share.subscription && <ShareCopyItem title="订阅链接" value={share.subscription} onCopy={copyText} />}
                <ShareCopyItem title="单节点 URI" value={share.link} onCopy={copyText} />
                <ShareCopyItem title="Clash 配置" value={share.clash} onCopy={copyText} multiline />
                <ShareCopyItem title="Sing-box 配置" value={shareSingBox} onCopy={copyText} multiline />
              </div>
            </div>
            <p className="muted">{share.message}</p>
          </div>
        )}

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
          <dl className="kv">
            <dt>当前连接数</dt>
            <dd>{node.realtime.activeConnections}</dd>
            <dt>最近延迟</dt>
            <dd>{node.realtime.latencyMs ? `${node.realtime.latencyMs} ms` : "暂无"}</dd>
            <dt>更新时间</dt>
            <dd>{node.realtime.updatedAt ? new Date(node.realtime.updatedAt).toLocaleString() : "暂无实时上报"}</dd>
          </dl>
          <p className="muted">客户端明细依赖代理核心实时上报；没有上报时只展示聚合连接数。</p>
        </div>
      </section>
    </div>
  );
}

function ShareCopyItem({ title, value, onCopy, multiline = false }: { title: string; value: string; onCopy: (value: string) => void; multiline?: boolean }) {
  return (
    <div className="share-copy-item">
      <div>
        <strong>{title}</strong>
        {multiline ? <pre>{value}</pre> : <span>{value}</span>}
      </div>
      <button className="ghost small" onClick={() => onCopy(value)}>
        <Copy size={16} />
        复制
      </button>
    </div>
  );
}
