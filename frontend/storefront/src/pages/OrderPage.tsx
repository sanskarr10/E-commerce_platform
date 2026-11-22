import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { formatMoney, isFinal, useAuth } from '@shop/shared';
import { OrderTracker } from '../components/OrderTracker';

export const POLL_MS = 1500;

export function OrderPage() {
  const { id = '' } = useParams();
  const { endpoints } = useAuth();
  const q = useQuery({
    queryKey: ['orders', id],
    queryFn: () => endpoints.orders.get(id),
    // Keep asking while the backend saga is still working or the shop has yet to ship; stop at a final state.
    refetchInterval: (query) => (query.state.data && isFinal(query.state.data.status) ? false : POLL_MS),
  });

  if (q.isPending) return <p className="muted" role="status">Loading order…</p>;
  if (q.isError) return <div className="alert" role="alert">{q.error.message} <Link to="/orders">My orders</Link></div>;
  const o = q.data;
  return (
    <>
      <h1>Order {o.id.slice(0, 8)}</h1>
      <div className="checkout">
        <OrderTracker order={o} />
        <section className="panel">
          <h2>Items</h2>
          <ul className="plain">
            {o.items.map((i) => (
              <li key={i.product_id}><span>{i.quantity} × {i.name}</span><span className="price">{formatMoney(i.unit_price_minor * i.quantity, o.currency)}</span></li>
            ))}
          </ul>
          <p className="sum"><strong>Total</strong><span className="price">{formatMoney(o.total_minor, o.currency)}</span></p>
          <p className="muted">Placed {new Date(o.created_at).toLocaleString()}</p>
        </section>
      </div>
    </>
  );
}
