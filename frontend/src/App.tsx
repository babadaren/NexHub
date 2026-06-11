import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { api, getToken } from "./api";
import type { AdminUser } from "./types";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { NodesPage } from "./pages/NodesPage";
import { NodeWizardPage } from "./pages/NodeWizardPage";
import { NodeDetailPage } from "./pages/NodeDetailPage";
import { RealtimePage } from "./pages/RealtimePage";
import { SettingsPage } from "./pages/SettingsPage";

function RequireAuth({ user, children }: { user?: AdminUser; children: React.ReactNode }) {
  const location = useLocation();
  if (!getToken()) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!user) return <div className="boot">正在加载控制台...</div>;
  return children;
}

export function App() {
  const [user, setUser] = useState<AdminUser | undefined>();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setChecked(true);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => setUser(undefined))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return <div className="boot">正在连接后端...</div>;

  return (
    <Routes>
      <Route path="/login" element={<LoginPage onLogin={setUser} />} />
      <Route
        path="/"
        element={
          <RequireAuth user={user}>
            <AppShell user={user!} />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="remote-nodes" element={<NodesPage direction="remote" />} />
        <Route path="remote-nodes/new" element={<NodeWizardPage direction="remote" />} />
        <Route path="remote-nodes/:id" element={<NodeDetailPage direction="remote" />} />
        <Route path="local-nodes" element={<NodesPage direction="local" />} />
        <Route path="local-nodes/new" element={<NodeWizardPage direction="local" />} />
        <Route path="local-nodes/:id" element={<NodeDetailPage direction="local" />} />
        <Route path="realtime" element={<RealtimePage />} />
        <Route path="settings" element={<SettingsPage user={user!} />} />
      </Route>
    </Routes>
  );
}
