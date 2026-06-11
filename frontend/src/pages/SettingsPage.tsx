import { useEffect, useState } from "react";
import { Download, KeyRound, RotateCcw, ShieldCheck } from "lucide-react";
import { api } from "../api";
import type { AdminUser } from "../types";

export function SettingsPage({ user }: { user: AdminUser }) {
  const [status, setStatus] = useState<{ version: string; deployment: Record<string, string>; ports: Record<string, string> }>();
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    api.systemStatus().then(setStatus);
  }, []);

  async function backup() {
    const result = await api.backup();
    setMessage(result.message);
  }

  async function updateCheck() {
    const result = await api.updateCheck();
    setMessage(result.upToDate ? `当前已是最新版本 ${result.current}` : `发现新版本 ${result.latest}`);
  }

  async function changePassword() {
    if (password.length < 8) {
      setMessage("密码至少 8 位");
      return;
    }
    await api.changePassword(password);
    setPassword("");
    setMessage("密码已修改");
  }

  return (
    <div className="page">
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
          <h2>部署状态</h2>
          <p>Docker 一键部署，自动初始化</p>
          <dl className="kv">
            <dt>App</dt>
            <dd>{status?.deployment.app ?? "加载中"}</dd>
            <dt>PostgreSQL</dt>
            <dd>{status?.deployment.postgres ?? "加载中"}</dd>
            <dt>Redis</dt>
            <dd>{status?.deployment.redis ?? "加载中"}</dd>
            <dt>代理核心</dt>
            <dd>{status?.deployment.engine ?? "加载中"}</dd>
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
          </div>
        </div>
      </section>

      {message && <div className="notice">{message}</div>}

      <section className="panel table-panel">
        <h2>
          <ShieldCheck size={22} />
          数据保留策略
        </h2>
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
              <td>6小时</td>
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
              <td>180天</td>
              <td>历史查看</td>
              <td>只存聚合，不存秒级明细</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
