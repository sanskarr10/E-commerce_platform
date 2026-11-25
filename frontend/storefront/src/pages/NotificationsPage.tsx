import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '@shop/shared';

export function NotificationsPage() {
  const { endpoints } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['notifications', 'list'], queryFn: () => endpoints.notifications.list({ page_size: 50 }) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({ mutationFn: (id: string) => endpoints.notifications.markRead(id), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => endpoints.notifications.readAll(), onSuccess: refresh });

  return (
    <>
      <div className="head-row">
        <h1>Notifications</h1>
        {!!list.data?.unread && (
          <button type="button" className="secondary" disabled={readAll.isPending} onClick={() => readAll.mutate()}>
            Mark all read
          </button>
        )}
      </div>
      {list.isPending && <p className="muted" role="status">Loading…</p>}
      {list.isError && <div className="alert" role="alert">{list.error.message}</div>}
      {(markRead.isError || readAll.isError) && <div className="alert" role="alert">Could not update. Try again.</div>}
      {list.data && list.data.items.length === 0 && (
        <p>Nothing yet. Updates about your orders show up here. <Link to="/">Browse the catalog</Link></p>
      )}
      <ul className="notes">
        {list.data?.items.map((n) => (
          <li key={n.id} className={n.read_at ? 'note read' : 'note'}>
            <div>
              <strong>{n.title}</strong>
              <p>{n.body}</p>
              <span className="muted">{new Date(n.created_at).toLocaleString()} · <Link to={`/orders/${n.order_id}`}>View order</Link></span>
            </div>
            {!n.read_at && (
              <button type="button" className="link" disabled={markRead.isPending} onClick={() => markRead.mutate(n.id)} aria-label={`Mark "${n.title}" as read`}>
                Mark read
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
