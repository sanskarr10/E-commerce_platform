import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, formatMoney, parseMoney, useAuth, type Product } from '@shop/shared';

interface Draft {
  id?: number;
  sku: string;
  name: string;
  description: string;
  price: string;
  stock: string;
  category_id: string;
  is_active: boolean;
}

const empty: Draft = { sku: '', name: '', description: '', price: '', stock: '0', category_id: '', is_active: true };

export function ProductsPage() {
  const { endpoints } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');

  const products = useQuery({ queryKey: ['admin-products', q, page], queryFn: () => endpoints.products.list({ q, page, page_size: 15, sort: 'name' }) });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => endpoints.products.categories() });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-products'] });
  const fail = (e: unknown) => setError(e instanceof ApiError ? e : new ApiError(0, null, 'Something went wrong. Try again.'));

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const price = parseMoney(d.price);
      if (price === null || price < 1) throw new ApiError(422, null, 'Price must be a positive amount', { price: 'Enter a price like 499 or 499.50' });
      const common = { name: d.name.trim(), description: d.description.trim() || null, price_minor: price, category_id: d.category_id ? Number(d.category_id) : null, is_active: d.is_active };
      if (d.id) return endpoints.products.update(d.id, common);
      return endpoints.products.create({ ...common, sku: d.sku.trim(), stock: Number(d.stock) || 0 });
    },
    onSuccess: (p) => { setEditing(null); setError(null); setNotice(`Saved ${p.name}`); void refresh(); },
    onError: fail,
  });
  const stock = useMutation({
    mutationFn: ({ id, delta }: { id: number; delta: number }) => endpoints.products.adjustStock(id, delta),
    onSuccess: () => { setNotice('Stock updated'); setError(null); void refresh(); },
    onError: fail,
  });
  const archive = useMutation({
    mutationFn: (p: Product) => endpoints.products.archive(p.id),
    onSuccess: (_d, p) => { setNotice(`Archived ${p.name}`); setError(null); void refresh(); },
    onError: fail,
  });

  const adjust = (p: Product) => {
    const raw = window.prompt(`Change stock for ${p.name} (current ${p.stock}). Enter +10 or -3`, '+10');
    const delta = Number(raw);
    if (raw && Number.isInteger(delta) && delta !== 0) stock.mutate({ id: p.id, delta });
  };
  const fe = error?.fieldErrors ?? {};
  const onSubmit = (e: FormEvent) => { e.preventDefault(); if (editing) save.mutate(editing); };
  const set = (patch: Partial<Draft>) => setEditing((d) => (d ? { ...d, ...patch } : d));
  const pages = products.data ? Math.max(1, Math.ceil(products.data.total / products.data.page_size)) : 1;

  return (
    <>
      <div className="head">
        <h1>Products</h1>
        <button type="button" onClick={() => { setEditing(empty); setError(null); setNotice(''); }}>New product</button>
      </div>
      {notice && <div className="alert ok" role="status">{notice}</div>}
      {error && !editing && <div className="alert" role="alert">{error.message}</div>}

      {editing && (
        <form className="panel form" onSubmit={onSubmit} aria-label={editing.id ? 'Edit product' : 'New product'}>
          <h2>{editing.id ? 'Edit product' : 'New product'}</h2>
          {error && Object.keys(fe).length === 0 && <div className="alert" role="alert">{error.message}</div>}
          <div className="cols">
            <label>SKU<input value={editing.sku} disabled={!!editing.id} required onChange={(e) => set({ sku: e.target.value })} />{fe.sku && <span className="field-error">{fe.sku}</span>}</label>
            <label>Name<input value={editing.name} required onChange={(e) => set({ name: e.target.value })} />{fe.name && <span className="field-error">{fe.name}</span>}</label>
            <label>Price (₹)<input inputMode="decimal" value={editing.price} required onChange={(e) => set({ price: e.target.value })} />{fe.price && <span className="field-error">{fe.price}</span>}</label>
            {!editing.id && <label>Opening stock<input type="number" min={0} value={editing.stock} onChange={(e) => set({ stock: e.target.value })} /></label>}
            <label>Category
              <select value={editing.category_id} onChange={(e) => set({ category_id: e.target.value })}>
                <option value="">None</option>
                {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={editing.is_active} onChange={(e) => set({ is_active: e.target.checked })} /> Visible in the shop</label>
          </div>
          <label>Description<textarea rows={3} value={editing.description} onChange={(e) => set({ description: e.target.value })} /></label>
          <div className="actions">
            <button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save product'}</button>
            <button type="button" className="secondary" onClick={() => { setEditing(null); setError(null); }}>Cancel</button>
          </div>
        </form>
      )}

      <form role="search" className="filters" onSubmit={(e) => e.preventDefault()}>
        <label><span className="sr-only">Search products</span><input type="search" placeholder="Search products" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></label>
      </form>
      {products.isError && <div className="alert" role="alert">{products.error.message}</div>}
      {products.isPending && <p className="muted" role="status">Loading…</p>}
      {products.data && (
        <table className="dense">
          <thead><tr><th>SKU</th><th>Name</th><th>Category</th><th className="num">Price</th><th className="num">Stock</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {products.data.items.map((p) => (
              <tr key={p.id} className={p.is_active ? '' : 'archived'}>
                <td>{p.sku}</td><td>{p.name}</td><td>{p.category?.name ?? '-'}</td>
                <td className="num">{formatMoney(p.price_minor, p.currency)}</td>
                <td className={`num ${p.stock <= 5 ? 'low' : ''}`}>{p.stock}</td>
                <td>{p.is_active ? 'Active' : 'Archived'}</td>
                <td className="row-actions">
                  <button type="button" className="link" onClick={() => adjust(p)} aria-label={`Adjust stock for ${p.name}`}>Stock</button>
                  <button type="button" className="link" aria-label={`Edit ${p.name}`} onClick={() => { setError(null); setNotice(''); setEditing({ id: p.id, sku: p.sku, name: p.name, description: p.description ?? '', price: String(p.price_minor / 100), stock: String(p.stock), category_id: p.category ? String(p.category.id) : '', is_active: p.is_active }); }}>Edit</button>
                  {p.is_active && <button type="button" className="link" aria-label={`Archive ${p.name}`} onClick={() => { if (window.confirm(`Archive ${p.name}? It will disappear from the shop.`)) archive.mutate(p); }}>Archive</button>}
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
