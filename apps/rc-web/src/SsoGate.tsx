import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, setToken } from './api';

// The sign-in token is single use, so an effect that runs twice (React StrictMode in
// development) must not exchange it twice: share one request per token.
const exchanges = new Map<string, Promise<{ token: string }>>();

function exchange(ssoToken: string, deviceId: string) {
  let pending = exchanges.get(ssoToken);
  if (!pending) {
    pending = api<{ token: string }>('/auth/sso', {
      method: 'POST',
      body: JSON.stringify({ token: ssoToken, deviceId }),
    });
    exchanges.set(ssoToken, pending);
  }
  return pending;
}

/**
 * Deep link from the MDM console: /d/:deviceId?token=<single-use token>.
 * Exchanges the token for a session, then reopens the page without the token in the URL.
 * Without a token it renders its children untouched.
 */
export function SsoGate({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const { deviceId = '' } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const ssoToken = params.get('token');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ssoToken) return;
    let active = true;
    exchange(ssoToken, deviceId)
      .then((res) => {
        if (!active) return;
        setToken(res.token);
        nav(`/d/${encodeURIComponent(deviceId)}`, { replace: true });
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [ssoToken, deviceId, nav]);

  if (!ssoToken) return children;
  if (failed) {
    // Fall back to the normal login, minus the spent token
    const next = encodeURIComponent(`${loc.pathname}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <div className="card">Signing in…</div>;
}
