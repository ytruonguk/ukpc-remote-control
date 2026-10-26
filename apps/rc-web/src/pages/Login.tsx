import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, getToken, setToken } from '../api';

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const next = params.get('next') || '/devices';

  useEffect(() => {
    if (getToken()) nav(next, { replace: true });
  }, [nav, next]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      const res = await api<{ token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setToken(res.token);
      nav(next);
    } catch {
      setErr('Login failed');
    }
  }

  return (
    <div className="login-page">
      <form className="card grid login-card" onSubmit={onSubmit}>
        <h1>Remote Control</h1>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
        {err && <div className="err">{err}</div>}
        <button type="submit">Login</button>
      </form>
    </div>
  );
}
