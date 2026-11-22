import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@shop/shared';

/** Everything except /login lives behind this: signed in AND an admin. */
export function Shell() {
  const { status, user, logout } = useAuth();
  if (status === 'loading') return <p className="muted pad" role="status">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/login" replace state={{ denied: true }} />;
  return (
    <div className="shell">
      <aside>
        <p className="brand">Shop admin</p>
        <nav aria-label="Sections">
          <NavLink to="/products">Products</NavLink>
          <NavLink to="/categories">Categories</NavLink>
          <NavLink to="/orders">Orders</NavLink>
          <NavLink to="/payments">Payments</NavLink>
        </nav>
        <div className="foot">
          <span className="muted">{user.email}</span>
          <button type="button" className="secondary" onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>
      <main><Outlet /></main>
    </div>
  );
}
