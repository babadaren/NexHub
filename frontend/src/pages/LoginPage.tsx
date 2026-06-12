import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Server } from "lucide-react";
import { api } from "../api";
import type { AdminUser } from "../types";

export function LoginPage({ onLogin }: { onLogin: (user: AdminUser) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const user = await api.login(username, password);
      onLogin(user);
      navigate(user.mustChangePassword ? "/settings" : "/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">
          <Server size={30} />
        </div>
        <h1>Proxy Center</h1>
        <p>单管理员登录</p>
        <label>
          管理员账号
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          密码
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="查看后端日志中的首次密码" />
        </label>
        {error && <div className="error-box">{error}</div>}
        <button className="primary" disabled={loading}>
          <Lock size={18} />
          {loading ? "登录中..." : "登录"}
        </button>
      </form>
    </div>
  );
}
