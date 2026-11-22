import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { formatMoney, useAuth } from '@shop/shared';
import { useCart } from '../cart';
import { CategoryMark, categoryClass } from '../components/ProductTile';

export function ProductPage() {
  const { id = '' } = useParams();
  const { endpoints } = useAuth();
  const { dispatch } = useCart();
  const q = useQuery({ queryKey: ['product', id], queryFn: () => endpoints.products.get(id) });

  if (q.isPending) return <p className="muted" role="status">Loading…</p>;
  if (q.isError) return <div className="alert" role="alert">{q.error.message} <Link to="/">Back to catalog</Link></div>;
  const p = q.data;
  const out = p.stock < 1;
  return (
    <article className="detail">
      <div className={`detail-chip ${categoryClass(p.category?.slug)}`}><CategoryMark slug={p.category?.slug} /><span>{p.sku}</span></div>
      <div>
        <p className="muted"><Link to={p.category ? `/?category=${p.category.slug}` : '/'}>{p.category?.name ?? 'Catalog'}</Link></p>
        <h1>{p.name}</h1>
        <p className="price big">{formatMoney(p.price_minor, p.currency)}</p>
        {p.description && <p>{p.description}</p>}
        <p className={out ? 'low-stock' : 'muted'}>{out ? 'Out of stock' : p.stock <= 5 ? `Only ${p.stock} left` : 'In stock'}</p>
        <button type="button" disabled={out} onClick={() => dispatch({ type: 'add', product: p })}>Add to cart</button>
      </div>
    </article>
  );
}
