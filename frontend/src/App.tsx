import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Suspense, lazy, useEffect, useState } from "react";
import { api, clearToken, getToken } from "./api";
import type { AdminUser } from "./types";
import { AppShell } from "./components/AppShell";

const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const NodesPage = lazy(() => import("./pages/NodesPage").then((module) => ({ default: module.NodesPage })));
const NodeWizardPage = lazy(() => import("./pages/NodeWizardPage").then((module) => ({ default: module.NodeWizardPage })));
const NodeDetailPage = lazy(() => import("./pages/NodeDetailPage").then((module) => ({ default: module.NodeDetailPage })));
const RealtimePage = lazy(() => import("./pages/RealtimePage").then((module) => ({ default: module.RealtimePage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const HistoryPage = lazy(() => import("./pages/HistoryPage").then((module) => ({ default: module.HistoryPage })));
const InstallPage = lazy(() => import("./pages/InstallPage").then((module) => ({ default: module.InstallPage })));

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
      .catch(() => {
        clearToken();
        setUser(undefined);
      })
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return <div className="boot">正在连接后端...</div>;

  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/install" element={<InstallPage />} />
        <Route path="/login" element={<LoginPage onLogin={setUser} />} />
        <Route
          path="/"
          element={
            <RequireAuth user={user}>
              <AppShell user={user!} onLogout={() => setUser(undefined)} />
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
          <Route path="history" element={<HistoryPage />} />
          <Route path="settings" element={<SettingsPage user={user!} onUserChange={setUser} />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

function RouteLoading() {
  return <div className="boot">正在加载页面...</div>;
}
