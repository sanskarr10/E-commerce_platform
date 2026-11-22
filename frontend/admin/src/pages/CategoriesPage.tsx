import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, useAuth } from '@shop/shared';

export function CategoriesPage() {
  const { endpoints } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const list = useQuery({ queryKey: ['categories'], queryFn: () => endpoints.products.categories() });
  const create = useMutation({
    mutationFn: (n: string) => endpoints.products.createCategory(n),
    onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['categories'] }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (name.trim()) create.mutate(name.trim()); };
  return (
    <>
      <h1>Categories</h1>
      <form className="inline" onSubmit={submit}>
        <label>New category<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button type="submit" disabled={create.isPending}>Add category</button>
      </form>
      {create.error && <div className="alert" role="alert">{create.error instanceof ApiError ? create.error.message : 'Could not add the category.'}</div>}
      {list.isError && <div className="alert" role="alert">{list.error.message}</div>}
      <table className="dense">
        <thead><tr><th>Name</th><th>Slug</th></tr></thead>
        <tbody>{list.data?.map((c) => <tr key={c.id}><td>{c.name}</td><td className="muted">{c.slug}</td></tr>)}</tbody>
      </table>
    </>
  );
}
