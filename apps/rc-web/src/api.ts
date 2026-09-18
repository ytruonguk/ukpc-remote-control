const TOKEN_KEY = 'rc.token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function dropSessionKeepalive(id: string) {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  void fetch(`/api/sessions/${id}`, { method: 'DELETE', headers, keepalive: true }).catch(() => undefined);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    if (!path.startsWith('/auth/')) window.location.href = '/login';
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.code ?? res.statusText), { status: res.status, body });
  }
  return res.json() as Promise<T>;
}
