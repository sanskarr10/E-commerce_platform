import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, useAuth } from '@shop/shared';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { status, login, register } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  if (status === 'authenticated') return <Navigate to={from} replace />;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    setBusy(true);
    setError(null);
    try {
      if (isRegister) await register(email, password, String(form.get('full_name')));
      else await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, null, 'Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const fe = error?.fieldErrors ?? {};
  return (
    <form className="panel narrow" onSubmit={(e) => void submit(e)} noValidate>
      <h1>{isRegister ? 'Create your account' : 'Sign in'}</h1>
      {error && Object.keys(fe).length === 0 && <div className="alert" role="alert">{error.message}</div>}
      {isRegister && (
        <label>Full name
          <input name="full_name" autoComplete="name" required aria-invalid={!!fe.full_name} />
          {fe.full_name && <span className="field-error">{fe.full_name}</span>}
        </label>
      )}
      <label>Email
        <input name="email" type="email" autoComplete="email" required aria-invalid={!!fe.email} />
        {fe.email && <span className="field-error">{fe.email}</span>}
      </label>
      <label>Password
        <input name="password" type="password" autoComplete={isRegister ? 'new-password' : 'current-password'} required aria-invalid={!!fe.password} />
        {isRegister && !fe.password && <span className="muted">At least 8 characters, with a letter and a digit.</span>}
        {fe.password && <span className="field-error">{fe.password}</span>}
      </label>
      <button type="submit" disabled={busy}>{busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}</button>
      <p className="muted switch">
        {isRegister ? <>Already have an account? <Link to="/login">Sign in</Link></> : <>New here? <Link to="/register">Create an account</Link></>}
      </p>
    </form>
  );
}
