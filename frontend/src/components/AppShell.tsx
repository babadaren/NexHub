import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Activity, Clock, Home, LogOut, Monitor, Search, Server, Settings, Shield, User, Zap } from "lucide-react";
import { api } from "../api";
import type { AdminUser } from "../types";

const nav = [
  { to: "/dashboard", label: "总览", icon: Home },
  { to: "/remote-nodes", label: "远端节点", icon: Server },
  { to: "/local-nodes", label: "本地节点", icon: Monitor },
  { to: "/realtime", label: "实时监控", icon: Activity },
  { to: "/history", label: "历史摘要", icon: Clock },
  { to: "/settings", label: "系统设置", icon: Settings }
];

const titleMap: Record<string, { title: string; subtitle: string }> = {
  "/dashboard": { title: "总览", subtitle: "用最少步骤完成远端节点和本地节点配置" },
  "/remote-nodes": { title: "远端节点", subtitle: "管理本机要连接出去的节点" },
  "/local-nodes": { title: "本地节点", subtitle: "管理别人连接本机的入口" },
  "/realtime": { title: "实时监控", subtitle: "查看速率、延迟、连接数和短期事件" },
  "/history": { title: "历史摘要", subtitle: "查看每日聚合、测试趋势和流量摘要" },
  "/settings": { title: "系统设置", subtitle: "只有管理员和部署维护，不做用户/权限管理" }
};

export function AppShell({ user, onLogout }: { user: AdminUser; onLogout: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const basePath = `/${location.pathname.split("/")[1] || "dashboard"}`;
  const meta = titleMap[basePath] ?? {
    title: location.pathname.includes("new") ? "节点向导" : "节点详情",
    subtitle: "所有状态和操作集中在一个页面"
  };

  async function logout() {
    await api.logout();
    onLogout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">P</div>
          <div>
            <strong>Proxy Center</strong>
            <span>极简节点控制台</span>
          </div>
        </div>
        <nav className="nav">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.label} to={item.to} className={({ isActive }) => (isActive && !item.to.includes("?") ? "active" : "")}>
                <Icon size={20} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="mode-card">
          <Shield size={24} />
          <strong>小白模式</strong>
          <span>只显示必填项</span>
          <span>高级参数默认折叠</span>
          <span>一键测试后保存</span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
          <label className="search">
            <Search size={18} />
            <input placeholder="搜索节点 / 配置 / 日志" />
            <kbd>⌘K</kbd>
          </label>
          <span className="pill success">Production</span>
          {user.mustChangePassword && (
            <button className="warning-action" onClick={() => navigate("/settings")}>
              <Shield size={17} />
              修改初始密码
            </button>
          )}
          <button className="ghost" onClick={() => navigate("/settings")}>
            <User size={17} />
            {user.username}
          </button>
          <button className="ghost icon" onClick={logout} title="退出登录">
            <LogOut size={17} />
          </button>
          <button className="primary small" onClick={() => navigate(basePath === "/local-nodes" ? "/local-nodes/new" : "/remote-nodes/new")}>
            <Zap size={16} />
            一键测试
          </button>
        </header>
        <Outlet />
      </main>
    </div>
  );
}
