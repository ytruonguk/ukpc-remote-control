import type { ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { getToken } from './api';
import { DevicesPage } from './pages/Devices';
import { FleetPage } from './pages/Fleet';
import { LoginPage } from './pages/Login';
import { RemotePage } from './pages/Remote';
import { SessionsPage } from './pages/Sessions';

function Guard({ children }: { children: ReactNode }) {
  const loc = useLocation();
  if (!getToken()) {
    const next = encodeURIComponent(loc.pathname + loc.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return children;
}

export function App() {
  return (
    <div className="layout">
      {getToken() && (
        <nav className="nav">
          <NavLink to="/devices">Devices</NavLink>
          <NavLink to="/sessions">Sessions</NavLink>
          <NavLink to="/fleet">Fleet</NavLink>
        </nav>
      )}
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/devices" element={<Guard><DevicesPage /></Guard>} />
        <Route path="/d/:deviceId" element={<Guard><RemotePage /></Guard>} />
        <Route path="/sessions" element={<Guard><SessionsPage /></Guard>} />
        <Route path="/fleet" element={<Guard><FleetPage /></Guard>} />
        <Route path="*" element={<Navigate to="/devices" replace />} />
      </Routes>
    </div>
  );
}
