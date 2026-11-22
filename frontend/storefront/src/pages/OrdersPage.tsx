import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatMoney, STATUS_LABEL, useAuth } from '@shop/shared';

export function OrdersPage() {
  const { endpoints } = useAuth();
  const q = useQuery({ queryKey: ['orders', 'mine'], queryFn: () => endpoints.orders.mine(1, 20) });
  return (
    <>
      <h1>My orders</h1>
      {q.isPending && <p className="muted" role="status">Loading…</p>}
      {q.isError && <div className="alert" role="alert">{q.error.message}</div>}
      {q.data && q.data.items.length === 0 && <p>No orders yet. <Link to="/">Browse the catalog</Link></p>}
      {q.data && q.data.items.length > 0 && (
        <table className="lines">
          <thead><tr><th>Order</th><th>Placed</th><th>Status</th><th className="num">Total</th></tr></thead>
          <tbody>
            {q.data.items.map((o) => (
              <tr key={o.id}>
                <td><Link to={`/orders/${o.id}`}>{o.id.slice(0, 8)}</Link></td>
                <td>{new Date(o.created_at).toLocaleDateString()}</td>
                <td><span className={`pill ${o.status.toLowerCase()}`}>{STATUS_LABEL[o.status]}</span></td>
                <td className="num price">{formatMoney(o.total_minor, o.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
