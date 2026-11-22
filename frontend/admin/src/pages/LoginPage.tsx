import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError, useAuth } from '@shop/shared';

export function LoginPage() {
  const { user, login, logout } = useAuth();
  const denied = (useLocation().state as { denied?: boolean } | null)?.denied;
  const [error, setError] = useState<string | null>(denied ? 'This account is not an administrator.' : null);
  const [busy, setBusy] = useState(false);

  if (user?.role === 'admin') return <Navigate to="/products" replace />;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const me = await login(String(form.get('email')), String(form.get('password')));
      if (me.role !== 'admin') {
        await logout();
        setError('This account is not an administrator.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel login" onSubmit={(e) => void submit(e)}>
      <h1>Admin sign in</h1>
      {error && <div className="alert" role="alert">{error}</div>}
      <label>Email<input name="email" type="email" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <button type="submit" disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</button>
    </form>
  );
}
