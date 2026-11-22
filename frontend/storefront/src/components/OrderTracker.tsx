import { cancelMessage, ORDER_STEPS, STATUS_HINT, STATUS_LABEL, type OrderDetail } from '@shop/shared';

/** The checkout saga made visible: each step lights up as the backend services finish their part. */
export function OrderTracker({ order }: { order: OrderDetail }) {
  const cancelled = order.status === 'CANCELLED';
  const reached = new Set(order.history.map((h) => h.to_status));
  const current = ORDER_STEPS.indexOf(order.status);
  const when = (status: string) => {
    const h = order.history.find((x) => x.to_status === status);
    return h ? new Date(h.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  };
  return (
    <section aria-label="Order progress" className="tracker">
      <ol>
        {ORDER_STEPS.map((step, i) => {
          const done = reached.has(step) && (cancelled ? step !== order.status : i < current);
          const active = !cancelled && i === current;
          const state = done ? 'done' : active ? (order.status === 'DELIVERED' ? 'done' : 'active') : 'todo';
          return (
            <li key={step} className={`step ${state}`} aria-current={active ? 'step' : undefined}>
              <span className="dot" aria-hidden="true" />
              <div>
                <strong>{STATUS_LABEL[step]}</strong>
                <span className="muted">{state === 'todo' ? '' : when(step)}</span>
                {active && <p className="muted">{STATUS_HINT[step]}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {cancelled && (
        <div className="alert" role="status">
          <strong>Cancelled.</strong> {cancelMessage(order.cancel_reason)}
        </div>
      )}
    </section>
  );
}
