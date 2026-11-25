import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@shop/shared';
import { useCart } from '../cart';

export function Layout() {
  const { user, status, logout, endpoints } = useAuth();
  const { count } = useCart();
  // A quiet poll keeps the badge fresh without any push infrastructure.
  const unread = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => endpoints.notifications.list({ unread: true, page_size: 1 }),
    enabled: !!user,
    refetchInterval: 15_000,
    select: (page) => page.unread,
  });
  return (
    <>
      <a href="#main" className="skip">Skip to content</a>
      <header className="bar">
        <Link to="/" className="brand">Shop</Link>
        <nav aria-label="Main">
          <NavLink to="/" end>Catalog</NavLink>
          {user && <NavLink to="/orders">My orders</NavLink>}
          {user && (
            <NavLink to="/notifications">
              Notifications
              {!!unread.data && <span className="badge" aria-label={`${unread.data} unread`}>{unread.data}</span>}
            </NavLink>
          )}
          <NavLink to="/cart">Cart{count > 0 && <span className="badge" aria-label={`${count} items`}>{count}</span>}</NavLink>
        </nav>
        <div className="who">
          {status === 'loading' ? null : user ? (
            <>
              <span className="muted">{user.full_name}</span>
              <button type="button" className="secondary" onClick={() => void logout()}>Sign out</button>
            </>
          ) : (
            <Link to="/login" className="btn secondary">Sign in</Link>
          )}
        </div>
      </header>
      <main id="main"><Outlet /></main>
    </>
  );
}
