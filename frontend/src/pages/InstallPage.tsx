import { useEffect, useState } from "react";
import { Check, Clipboard, Database, LogIn, ServerCog } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { InstallStatus } from "../types";

export function InstallPage() {
  const [status, setStatus] = useState<InstallStatus>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.installStatus().then(setStatus);
  }, []);

  async function copyPasswordCommand() {
    if (!status) return;
    await navigator.clipboard.writeText(status.passwordCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const steps = status?.steps ?? [];
  const deployCommands = ["mkdir -p proxy-control-center && cd proxy-control-center", "cp deploy/.env.example .env", "docker compose up -d"];
  const completed = [
    "生成 .env 与随机密钥",
    "创建本地数据目录，便于备份迁移",
    "执行数据库迁移",
    "创建唯一管理员账号",
    "启动前端、后端、PostgreSQL、Redis"
  ];

  return (
    <div className="install-page">
      <aside className="install-sidebar">
        <div className="brand">
          <div className="logo">P</div>
          <div>
            <strong>Proxy Center</strong>
            <span>极简节点控制台</span>
          </div>
        </div>
        <div className="mode-card">
          <ServerCog size={24} />
          <strong>小白模式</strong>
          <span>只显示必要信息</span>
          <span>密钥不会在页面展示</span>
          <span>登录后开始配置节点</span>
        </div>
      </aside>

      <main className="install-main">
        <header className="install-topbar">
          <div>
            <h1>首次安装完成</h1>
            <p>服务已启动，数据库、缓存和管理员账号已自动初始化</p>
          </div>
          <span className="pill success">{status?.serverMode ?? "Loading"}</span>
        </header>

        <section className="install-grid">
          <div className="panel install-status-panel">
            <h2>
              <Database size={22} />
              安装状态
            </h2>
            <p>当前服务已经可以使用，下一步进入登录页。</p>
            <div className="install-steps">
              {steps.map((step, index) => (
                <div key={step.key} className="install-step">
                  <span>{index + 1}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.message}</p>
                  </div>
                </div>
              ))}
            </div>
            <dl className="kv install-kv">
              <dt>管理员账号</dt>
              <dd>{status?.adminUsername ?? "admin"}</dd>
              <dt>数据目录</dt>
              <dd>{status?.dataDir ?? "加载中"}</dd>
              <dt>存储模式</dt>
              <dd>{status?.storageDriver ?? "加载中"}</dd>
            </dl>
            <div className="form-actions">
              <Link className="primary" to={status?.loginPath ?? "/login"}>
                <LogIn size={18} />
                进入登录页
              </Link>
              <button className="ghost" onClick={copyPasswordCommand} disabled={!status}>
                <Clipboard size={18} />
                {copied ? "已复制命令" : "复制查看密码命令"}
              </button>
            </div>
          </div>

          <div className="panel install-command-panel">
            <h2>一键部署命令</h2>
            <p>适合没有运维经验的用户，手动部署时按部署 README 操作。</p>
            <pre className="command-box">
              {deployCommands.map((command) => (
                <code key={command}>{command}</code>
              ))}
            </pre>
            <h2>安装脚本自动完成</h2>
            <div className="install-checklist">
              {completed.map((item) => (
                <div key={item}>
                  <Check size={17} />
                  <span>{item}</span>
                </div>
              ))}
            </div>
            <div className="notice">如果 `ADMIN_PASSWORD` 为空，随机密码只会出现在容器日志中一次。</div>
          </div>
        </section>
      </main>
    </div>
  );
}
