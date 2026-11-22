import type { Product } from '@shop/shared';
import { cartCount, cartReducer, cartTotal, MAX_PER_LINE, type CartLine } from './cart';

const p = (over: Partial<Product> = {}): Product => ({
  id: 1, sku: 'S1', name: 'Thing', description: null, price_minor: 1000, currency: 'INR', stock: 5,
  category: { id: 1, name: 'Books', slug: 'books' }, image_url: null, is_active: true, created_at: '', updated_at: '', ...over,
});

describe('cartReducer', () => {
  it('adds a product and merges repeats', () => {
    let lines = cartReducer([], { type: 'add', product: p() });
    lines = cartReducer(lines, { type: 'add', product: p() });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(2);
    expect(lines[0]!.category).toBe('books');
  });
  it('never exceeds stock', () => {
    let lines: CartLine[] = [];
    for (let i = 0; i < 10; i++) lines = cartReducer(lines, { type: 'add', product: p({ stock: 3 }) });
    expect(lines[0]!.quantity).toBe(3);
  });
  it('never exceeds the per-line maximum', () => {
    const lines = cartReducer([], { type: 'add', product: p({ stock: 500 }), quantity: 99 });
    expect(lines[0]!.quantity).toBe(MAX_PER_LINE);
  });
  it('ignores out-of-stock products', () => {
    expect(cartReducer([], { type: 'add', product: p({ stock: 0 }) })).toEqual([]);
  });
  it('sets quantity within bounds and removes at zero', () => {
    const start = cartReducer([], { type: 'add', product: p() });
    expect(cartReducer(start, { type: 'set', productId: 1, quantity: 4 })[0]!.quantity).toBe(4);
    expect(cartReducer(start, { type: 'set', productId: 1, quantity: 50 })[0]!.quantity).toBe(5);
    expect(cartReducer(start, { type: 'set', productId: 1, quantity: 0 })).toEqual([]);
  });
  it('removes and clears', () => {
    const start = cartReducer(cartReducer([], { type: 'add', product: p() }), { type: 'add', product: p({ id: 2 }) });
    expect(cartReducer(start, { type: 'remove', productId: 1 })).toHaveLength(1);
    expect(cartReducer(start, { type: 'clear' })).toEqual([]);
  });
  it('totals', () => {
    const lines = cartReducer(cartReducer([], { type: 'add', product: p(), quantity: 2 }), { type: 'add', product: p({ id: 2, price_minor: 500 }) });
    expect(cartCount(lines)).toBe(3);
    expect(cartTotal(lines)).toBe(2500);
  });
});
