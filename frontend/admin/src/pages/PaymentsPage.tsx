import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoney, useAuth } from '@shop/shared';

export function PaymentsPage() {
  const { endpoints } = useAuth();
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['admin-payments', status], queryFn: () => endpoints.payments.adminList({ status: status || undefined, page_size: 30 }) });
  return (
    <>
      <div className="head">
        <h1>Payments</h1>
        <label className="inline-label">Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option><option value="SUCCEEDED">Succeeded</option><option value="FAILED">Failed</option><option value="PENDING">Pending</option>
          </select>
        </label>
      </div>
      {list.isError && <div className="alert" role="alert">{list.error.message}</div>}
      {list.data && list.data.items.length === 0 && <p className="muted">No payments{status ? ' with this status' : ''}.</p>}
      {list.data && list.data.items.length > 0 && (
        <table className="dense">
          <thead><tr><th>Payment</th><th>Order</th><th>Status</th><th>Reason</th><th>Date</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {list.data.items.map((p) => (
              <tr key={p.id}>
                <td title={p.id}>{p.id.slice(0, 8)}</td><td title={p.order_id}>{p.order_id.slice(0, 8)}</td>
                <td><span className={`pill ${p.status === 'SUCCEEDED' ? 'paid' : p.status === 'FAILED' ? 'cancelled' : ''}`}>{p.status.toLowerCase()}</span></td>
                <td className="muted">{p.failure_reason ?? ''}</td>
                <td>{new Date(p.created_at).toLocaleString()}</td>
                <td className="num">{formatMoney(p.amount_minor, p.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
