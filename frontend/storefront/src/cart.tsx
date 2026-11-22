import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { Product } from '@shop/shared';

export interface CartLine {
  product_id: number;
  sku: string;
  name: string;
  price_minor: number;
  currency: string;
  quantity: number;
  /** Stock when added: used as a soft cap in the UI. The server is still the authority. */
  stock: number;
  category: string | null;
}

export type CartAction =
  | { type: 'add'; product: Product; quantity?: number }
  | { type: 'set'; productId: number; quantity: number }
  | { type: 'remove'; productId: number }
  | { type: 'clear' };

export const MAX_PER_LINE = 20;

export function cartReducer(lines: CartLine[], action: CartAction): CartLine[] {
  switch (action.type) {
    case 'add': {
      const { product } = action;
      const cap = Math.min(MAX_PER_LINE, Math.max(product.stock, 0));
      const existing = lines.find((l) => l.product_id === product.id);
      if (existing) {
        return lines.map((l) =>
          l.product_id === product.id ? { ...l, stock: product.stock, quantity: Math.min(cap, l.quantity + (action.quantity ?? 1)) } : l,
        );
      }
      if (cap < 1) return lines;
      return [
        ...lines,
        {
          product_id: product.id,
          sku: product.sku,
          name: product.name,
          price_minor: product.price_minor,
          currency: product.currency,
          quantity: Math.min(cap, action.quantity ?? 1),
          stock: product.stock,
          category: product.category?.slug ?? null,
        },
      ];
    }
    case 'set':
      return action.quantity < 1
        ? lines.filter((l) => l.product_id !== action.productId)
        : lines.map((l) =>
            l.product_id === action.productId
              ? { ...l, quantity: Math.min(action.quantity, MAX_PER_LINE, Math.max(l.stock, 1)) }
              : l,
          );
    case 'remove':
      return lines.filter((l) => l.product_id !== action.productId);
    case 'clear':
      return [];
  }
}

export const cartCount = (lines: CartLine[]) => lines.reduce((n, l) => n + l.quantity, 0);
export const cartTotal = (lines: CartLine[]) => lines.reduce((n, l) => n + l.quantity * l.price_minor, 0);

const KEY = 'cart.v1';

function load(): CartLine[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as CartLine[]).filter((l) => l && l.product_id && l.quantity > 0) : [];
  } catch {
    return [];
  }
}

interface CartValue {
  lines: CartLine[];
  count: number;
  total: number;
  dispatch: (action: CartAction) => void;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, dispatch] = useReducer(cartReducer, undefined, load);
  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(lines));
    } catch {
      // private mode: the cart still works for this tab
    }
  }, [lines]);
  const value = useMemo(() => ({ lines, count: cartCount(lines), total: cartTotal(lines), dispatch }), [lines]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart must be used inside <CartProvider>');
  return value;
}
