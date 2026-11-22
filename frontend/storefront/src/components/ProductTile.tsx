import { Link } from 'react-router-dom';
import { formatMoney, type Product } from '@shop/shared';
import { useCart } from '../cart';

const GLYPH: Record<string, string> = {
  electronics: 'M4 7h16v10H4zM9 20h6',
  books: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM8 17h11',
  'home-kitchen': 'M5 11h14v8H5zM8 11V7h8v4',
  clothing: 'M8 4l-5 4 3 3 2-1v10h8V10l2 1 3-3-5-4a4 4 0 0 1-8 0z',
};

export function categoryClass(slug: string | null | undefined) {
  return slug ? `cat-${slug}` : 'cat-none';
}

export function CategoryMark({ slug }: { slug: string | null | undefined }) {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={(slug && GLYPH[slug]) || 'M12 3l8 4.5v9L12 21l-8-4.5v-9z'} />
    </svg>
  );
}

export function ProductTile({ product }: { product: Product }) {
  const { dispatch, lines } = useCart();
  const inCart = lines.find((l) => l.product_id === product.id)?.quantity ?? 0;
  const out = product.stock < 1;
  const slug = product.category?.slug;
  return (
    <article className="tile">
      <Link to={`/products/${product.id}`} className={`tile-chip ${categoryClass(slug)}`} aria-label={`${product.name}, details`}>
        <CategoryMark slug={slug} />
        <span className="tile-sku">{product.sku}</span>
      </Link>
      <div className="tile-body">
        <h3><Link to={`/products/${product.id}`}>{product.name}</Link></h3>
        <p className="muted tile-cat">{product.category?.name ?? 'Uncategorised'}</p>
        <div className="tile-foot">
          <span className="price">{formatMoney(product.price_minor, product.currency)}</span>
          {out ? (
            <span className="muted">Out of stock</span>
          ) : (
            <button type="button" onClick={() => dispatch({ type: 'add', product })} aria-label={`Add ${product.name} to cart`}>
              {inCart ? `Add another (${inCart})` : 'Add to cart'}
            </button>
          )}
        </div>
        {!out && product.stock <= 5 && <p className="low-stock">Only {product.stock} left</p>}
      </div>
    </article>
  );
}
