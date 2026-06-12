import { useEffect, useState } from "react";
import { Activity, Download, HardDrive, KeyRound, RotateCcw, Router, ShieldCheck } from "lucide-react";
import { api } from "../api";
import type { AdminUser, BackupSummary, SystemSettings, SystemStatus } from "../types";

export function SettingsPage({ user, onUserChange }: { user: AdminUser; onUserChange: (user: AdminUser) => void }) {
  const [status, setStatus] = useState<SystemStatus>();
  const [settings, setSettings] = useState<SystemSettings>();
  const [retentionForm, setRetentionForm] = useState({ realtimeTtlHours: "6", dailySummaryDays: "180", auditLogDays: "365" });
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    api.systemStatus().then(setStatus);
    api.systemSettings().then((value) => {
      setSettings(value);
      setRetentionForm({
        realtimeTtlHours: String(value.retention?.realtimeTtlHours ?? 6),
        dailySummaryDays: String(value.retention?.dailySummaryDays ?? 180),
        auditLogDays: String(value.retention?.auditLogDays ?? 365)
      });
    });
    api.backups().then(setBackups);
  }, []);

  function showError(error: unknown, fallback: string) {
    setMessage(error instanceof Error ? error.message : fallback);
  }

  async function backup() {
    try {
      const result = await api.backup();
      setMessage(`${result.message}，大小 ${formatBytes(result.sizeBytes)}`);
      setBackups(await api.backups());
    } catch (error) {
      showError(error, "备份失败");
    }
  }

  async function restoreBackup(file: string) {
    const confirmed = window.confirm("恢复会用该备份替换当前配置。系统会先自动创建一份恢复前备份。确认继续？");
    if (!confirmed) return;
    try {
      const result = await api.restoreBackup(file);
      setMessage(`${result.message}，恢复前备份：${result.preRestoreFile}`);
      const [nextStatus, nextBackups] = await Promise.all([api.systemStatus(), api.backups()]);
      setStatus(nextStatus);
      setBackups(nextBackups);
    } catch (error) {
      showError(error, "恢复失败");
    }
  }

  async function updateCheck() {
    try {
      const result = await api.updateCheck();
      setMessage(result.upToDate ? `当前已是最新版本 ${result.current}` : `发现新版本 ${result.latest}`);
    } catch (error) {
      showError(error, "更新检查失败");
    }
  }

  async function restartSystem() {
    const confirmed = window.confirm("将重启代理核心运行时，不会重启管理后台。确认继续？");
    if (!confirmed) return;
    try {
      const result = await api.restartSystem();
      setMessage(result.result.message ?? (result.result.skipped ? "当前为 render-only 模式，代理核心重启已跳过" : "代理核心已重启"));
      setStatus(await api.systemStatus());
    } catch (error) {
      showError(error, "代理核心重启失败");
      setStatus(await api.systemStatus());
    }
  }

  async function saveRetentionSettings() {
    const realtimeTtlHours = Number(retentionForm.realtimeTtlHours);
    const dailySummaryDays = Number(retentionForm.dailySummaryDays);
    const auditLogDays = Number(retentionForm.auditLogDays);
    if (![realtimeTtlHours, dailySummaryDays, auditLogDays].every((value) => Number.isInteger(value) && value > 0)) {
      setMessage("数据保留时间必须是大于 0 的整数");
      return;
    }
    try {
      const next = await api.updateSystemSettings({
        ...settings,
        retention: {
          ...settings?.retention,
          realtimeTtlHours,
          dailySummaryDays,
          auditLogDays
        }
      });
      setSettings(next);
      setMessage("数据保留策略已保存");
    } catch (error) {
      showError(error, "数据保留策略保存失败");
    }
  }

  async function changePassword() {
    if (password.length < 8) {
      setMessage("密码至少 8 位");
      return;
    }
    try {
      await api.changePassword(password);
      onUserChange(await api.me());
      setPassword("");
      setMessage("密码已修改");
    } catch (error) {
      showError(error, "密码修改失败");
    }
  }

  return (
    <div className="page">
      {user.mustChangePassword && (
        <div className="notice security-notice">
          当前仍在使用首次随机管理员密码。请先设置一个新的管理员密码，再继续配置节点。
        </div>
      )}
      <section className="settings-grid">
        <div className="panel">
          <h2>管理员账号</h2>
          <p>系统只有一个管理员账号</p>
          <dl className="kv">
            <dt>账号</dt>
            <dd>{user.username}</dd>
            <dt>登录邮箱</dt>
            <dd>{user.email || "可选"}</dd>
            <dt>密码</dt>
            <dd>已设置</dd>
          </dl>
          <label>
            新密码
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" />
          </label>
          <button className="primary" onClick={changePassword}>
            <KeyRound size={18} />
            修改密码
          </button>
        </div>

        <div className="panel">
          <h2>
            <Activity size={22} />
            部署状态
          </h2>
          <p>{status?.ready ? "所有关键依赖可用" : "存在需要处理的部署项"}</p>
          <dl className="kv">
            <dt>整体状态</dt>
            <dd>
              <span className={`status ${status?.ready ? "normal" : "warning"}`}>{status?.status ?? "加载中"}</span>
            </dd>
            <dt>App</dt>
            <dd>{status?.deployment.app ?? "加载中"}</dd>
            <dt>PostgreSQL</dt>
            <dd>{status?.deployment.postgres ?? "加载中"}</dd>
            <dt>Redis</dt>
            <dd>{status?.deployment.redis ?? "加载中"}</dd>
            <dt>代理核心</dt>
            <dd>{status?.deployment.engine ?? "加载中"}</dd>
            <dt>核心模式</dt>
            <dd>{String(status?.engine?.runtime?.mode ?? "加载中")}</dd>
            <dt>核心进程</dt>
            <dd>{status?.engine?.runtime?.running ? `运行中 #${String(status.engine.runtime.pid ?? "")}` : "未运行"}</dd>
            <dt>版本</dt>
            <dd>{status?.version ?? "0.1.0"}</dd>
          </dl>
          <div className="form-actions">
            <button className="primary" onClick={updateCheck}>
              <RotateCcw size={18} />
              检查更新
            </button>
            <button className="ghost" onClick={backup}>
              <Download size={18} />
              备份数据
            </button>
            <button className="ghost" onClick={restartSystem}>
              <RotateCcw size={18} />
              重启代理核心
            </button>
          </div>
        </div>

        <div className="panel">
          <h2>
            <HardDrive size={22} />
            存储与备份
          </h2>
          <p>生产环境建议使用本地目录挂载，便于整目录迁移</p>
          <dl className="kv">
            <dt>存储驱动</dt>
            <dd>{status?.storage.driver ?? "加载中"}</dd>
            <dt>数据目录</dt>
            <dd>{status?.storage.dataDir ?? "加载中"}</dd>
            <dt>备份目录</dt>
            <dd>{status?.storage.backupDir ?? "加载中"}</dd>
            <dt>磁盘占用</dt>
            <dd>{formatDisk(status)}</dd>
            <dt>最近备份</dt>
            <dd>{backupSummaryText(status)}</dd>
          </dl>
          {status?.backups.error && (
            <div className="notice danger-notice">
              {status.backups.error.message}：{status.backups.error.suggestion}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>
            <Router size={22} />
            本地端口边界
          </h2>
          <p>Docker bridge 模式只能启用已映射到宿主机的监听端口</p>
          <dl className="kv">
            <dt>TCP 端口段</dt>
            <dd>{status?.ports.localTcpPortRange ?? "加载中"}</dd>
            <dt>UDP 端口段</dt>
            <dd>{status?.ports.localUdpPortRange ?? "加载中"}</dd>
            <dt>核心配置</dt>
            <dd>{String(status?.engine?.currentPath ?? "尚未生成")}</dd>
            <dt>上次渲染</dt>
            <dd>{formatDate(status?.engine?.lastRenderAt)}</dd>
          </dl>
        </div>
      </section>

      {message && <div className="notice">{message}</div>}

      <section className="panel table-panel">
        <h2>
          <Activity size={22} />
          健康检查
        </h2>
        <table>
          <thead>
            <tr>
              <th>检查项</th>
              <th>状态</th>
              <th>说明</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(status?.checks ?? {}).map(([name, check]) => (
              <tr key={name}>
                <td>{checkLabel(name)}</td>
                <td>
                  <span className={`status ${check.status === "ok" ? "normal" : "error"}`}>{check.status}</span>
                </td>
                <td>{check.message}</td>
                <td>{check.detail || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel table-panel">
        <h2>
          <Download size={22} />
          最近备份
        </h2>
        {status?.backups.error ? (
          <p className="empty-state">{status.backups.error.message}。{status.backups.error.suggestion}</p>
        ) : backups.length === 0 ? (
          <p>暂无备份。点击“备份数据”后会在数据目录生成备份文件。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>文件</th>
                <th>创建时间</th>
                <th>大小</th>
                <th>节点/订阅</th>
                <th>说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr key={backup.file}>
                  <td>{backup.file}</td>
                  <td>{new Date(backup.createdAt).toLocaleString()}</td>
                  <td>{formatBytes(backup.sizeBytes)}</td>
                  <td>
                    {backup.manifest.state.nodes} / {backup.manifest.state.subscriptions}
                  </td>
                  <td>{backup.containsSecrets ? "包含密钥和节点凭据，请妥善保管" : "不含敏感信息"}</td>
                  <td>
                    <button className="ghost small" onClick={() => restoreBackup(backup.file)}>
                      恢复
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel table-panel">
        <h2>
          <ShieldCheck size={22} />
          数据保留策略
        </h2>
        <div className="retention-form">
          <label>
            实时数据 TTL（小时）
            <input value={retentionForm.realtimeTtlHours} onChange={(event) => setRetentionForm((form) => ({ ...form, realtimeTtlHours: event.target.value }))} />
          </label>
          <label>
            每日摘要保留（天）
            <input value={retentionForm.dailySummaryDays} onChange={(event) => setRetentionForm((form) => ({ ...form, dailySummaryDays: event.target.value }))} />
          </label>
          <label>
            审计日志保留（天）
            <input value={retentionForm.auditLogDays} onChange={(event) => setRetentionForm((form) => ({ ...form, auditLogDays: event.target.value }))} />
          </label>
          <button className="primary small" onClick={saveRetentionSettings}>
            保存策略
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>数据类型</th>
              <th>存储位置</th>
              <th>保留时间</th>
              <th>用途</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>管理员账号</td>
              <td>PostgreSQL</td>
              <td>长期</td>
              <td>登录</td>
              <td>单管理员，无权限表</td>
            </tr>
            <tr>
              <td>节点配置</td>
              <td>PostgreSQL</td>
              <td>长期</td>
              <td>生成代理配置</td>
              <td>保存版本与测试摘要</td>
            </tr>
            <tr>
              <td>实时速率/延迟</td>
              <td>Redis</td>
              <td>{settings?.retention?.realtimeTtlHours ?? retentionForm.realtimeTtlHours}小时</td>
              <td>监控页面</td>
              <td>高频写入，不落盘长期化</td>
            </tr>
            <tr>
              <td>在线客户端</td>
              <td>Redis</td>
              <td>15分钟 TTL</td>
              <td>实时状态</td>
              <td>心跳刷新</td>
            </tr>
            <tr>
              <td>每日流量摘要</td>
              <td>PostgreSQL</td>
              <td>{settings?.retention?.dailySummaryDays ?? retentionForm.dailySummaryDays}天</td>
              <td>历史查看</td>
              <td>只存聚合，不存秒级明细</td>
            </tr>
            <tr>
              <td>审计日志</td>
              <td>PostgreSQL</td>
              <td>{settings?.retention?.auditLogDays ?? retentionForm.auditLogDays}天</td>
              <td>排障追踪</td>
              <td>记录关键操作，不保存明文凭据</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDisk(status: SystemStatus | undefined) {
  if (!status) return "加载中";
  if (status.disk.error) return status.disk.error;
  return `${formatBytes(status.disk.usedBytes ?? 0)} / ${formatBytes(status.disk.totalBytes ?? 0)} (${status.disk.usedPercent ?? 0}%)`;
}

function backupSummaryText(status: SystemStatus | undefined) {
  if (!status) return "加载中";
  if (status.backups.error) return `${status.backups.error.code}：${status.backups.error.message}`;
  return status.backups.latest ? `${status.backups.latest.file} · ${formatBytes(status.backups.latest.sizeBytes)}` : "暂无";
}

function formatDate(value: string | undefined) {
  return value ? new Date(value).toLocaleString() : "暂无";
}

function checkLabel(value: string) {
  const labels: Record<string, string> = {
    app: "应用进程",
    database: "数据库",
    redis: "Redis",
    migrations: "数据库迁移",
    engine: "代理核心"
  };
  return labels[value] ?? value;
}
