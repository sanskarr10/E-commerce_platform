import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, formatMoney, STATUS_LABEL, useAuth, type Order, type OrderStatus } from '@shop/shared';

const STATUSES: OrderStatus[] = ['PENDING', 'STOCK_RESERVED', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

export function OrdersPage() {
  const { endpoints } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ['admin-orders', status, page], queryFn: () => endpoints.orders.adminList({ status: status || undefined, page, page_size: 15 }), refetchInterval: 5000 });
  const advance = useMutation({
    mutationFn: ({ order, to }: { order: Order; to: 'ship' | 'deliver' }) => (to === 'ship' ? endpoints.orders.ship(order.id) : endpoints.orders.deliver(order.id)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-orders'] }),
  });
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.page_size)) : 1;
  return (
    <>
      <div className="head">
        <h1>Orders</h1>
        <label className="inline-label">Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
      </div>
      {advance.error && <div className="alert" role="alert">{advance.error instanceof ApiError ? advance.error.message : 'Could not update the order.'}</div>}
      {list.isError && <div className="alert" role="alert">{list.error.message}</div>}
      {list.data && list.data.items.length === 0 && <p className="muted">No orders{status ? ' with this status' : ''}.</p>}
      {list.data && list.data.items.length > 0 && (
        <table className="dense">
          <thead><tr><th>Order</th><th>Placed</th><th>Items</th><th>Status</th><th className="num">Total</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {list.data.items.map((o) => (
              <tr key={o.id}>
                <td title={o.id}>{o.id.slice(0, 8)}</td>
                <td>{new Date(o.created_at).toLocaleString()}</td>
                <td>{o.items.reduce((n, i) => n + i.quantity, 0)}</td>
                <td><span className={`pill ${o.status.toLowerCase()}`}>{STATUS_LABEL[o.status]}</span>{o.cancel_reason && <span className="muted"> ({o.cancel_reason})</span>}</td>
                <td className="num">{formatMoney(o.total_minor, o.currency)}</td>
                <td className="row-actions">
                  {o.status === 'PAID' && <button type="button" disabled={advance.isPending} onClick={() => advance.mutate({ order: o, to: 'ship' })} aria-label={`Ship order ${o.id.slice(0, 8)}`}>Ship</button>}
                  {o.status === 'SHIPPED' && <button type="button" disabled={advance.isPending} onClick={() => advance.mutate({ order: o, to: 'deliver' })} aria-label={`Mark order ${o.id.slice(0, 8)} delivered`}>Mark delivered</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pages > 1 && (
        <div className="pager">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted">Page {page} of {pages}</span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </>
  );
}
