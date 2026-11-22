import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth, type ProductFilters } from '@shop/shared';
import { ProductTile } from '../components/ProductTile';
import { categoryClass } from '../components/ProductTile';

const PAGE_SIZE = 8;

export function Catalog() {
  const { endpoints } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const sort = (params.get('sort') ?? 'newest') as NonNullable<ProductFilters['sort']>;
  const inStock = params.get('in_stock') === '1';
  const page = Number(params.get('page') ?? 1) || 1;
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);

  const update = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    if (!('page' in next)) merged.delete('page');
    setParams(merged);
  };

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => endpoints.products.categories(), staleTime: 5 * 60_000 });
  const products = useQuery({
    queryKey: ['products', { q, category, sort, inStock, page }],
    queryFn: () => endpoints.products.list({ q, category, sort, in_stock: inStock || undefined, page, page_size: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const pages = products.data ? Math.max(1, Math.ceil(products.data.total / products.data.page_size)) : 1;

  return (
    <>
      <h1>Catalog</h1>
      <form role="search" className="filters" onSubmit={(e) => { e.preventDefault(); update({ q: draft.trim() }); }}>
        <label className="grow">
          <span className="sr-only">Search products</span>
          <input type="search" placeholder="Search products" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <label>
          <span className="sr-only">Sort</span>
          <select value={sort} onChange={(e) => update({ sort: e.target.value === 'newest' ? '' : e.target.value })}>
            <option value="newest">Newest</option>
            <option value="price_asc">Price, low to high</option>
            <option value="price_desc">Price, high to low</option>
            <option value="name">Name</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={inStock} onChange={(e) => update({ in_stock: e.target.checked ? '1' : '' })} /> In stock only
        </label>
        <button type="submit">Search</button>
      </form>

      <div className="chips" role="group" aria-label="Categories">
        <button type="button" className={`chip ${!category ? 'on' : ''}`} aria-pressed={!category} onClick={() => update({ category: '' })}>All</button>
        {categories.data?.map((c) => (
          <button key={c.id} type="button" className={`chip ${categoryClass(c.slug)} ${category === c.slug ? 'on' : ''}`} aria-pressed={category === c.slug} onClick={() => update({ category: c.slug })}>
            {c.name}
          </button>
        ))}
      </div>

      {products.isError && <div className="alert" role="alert">{products.error.message} <button type="button" className="link" onClick={() => void products.refetch()}>Try again</button></div>}
      {products.isPending && <p className="muted" role="status">Loading products…</p>}
      {products.data && products.data.items.length === 0 && (
        <p>No products match. <button type="button" className="link" onClick={() => setParams({})}>Clear filters</button></p>
      )}
      <div className="grid" aria-busy={products.isFetching}>
        {products.data?.items.map((p) => <ProductTile key={p.id} product={p} />)}
      </div>
      {pages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>Previous</button>
          <span className="muted">Page {page} of {pages}</span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}>Next</button>
        </nav>
      )}
    </>
  );
}
