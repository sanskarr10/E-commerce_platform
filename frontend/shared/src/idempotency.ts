import type { PlaceOrderBody } from './endpoints';

const STORAGE_KEY = 'checkout-attempt';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Same cart and payment method always produce the same fingerprint, whatever order the lines are in. */
export function fingerprint(body: PlaceOrderBody): string {
  const lines = new Map<number, number>();
  for (const item of body.items) lines.set(item.product_id, (lines.get(item.product_id) ?? 0) + item.quantity);
  const sorted = [...lines.entries()].sort(([a], [b]) => a - b);
  return JSON.stringify({ lines: sorted, method: body.payment_method });
}

/**
 * The Idempotency-Key for the checkout the person is on.
 *
 * It is kept in sessionStorage and reused for as long as the cart does not change, so a double click,
 * a timeout followed by a retry, or a page reload in the middle of paying all send the SAME key and the
 * server returns the original order instead of creating a second one. Changing the cart starts a new key.
 */
export function checkoutKey(body: PlaceOrderBody, makeId: () => string = () => crypto.randomUUID()): string {
  const print = fingerprint(body);
  const store = storage();
  try {
    const saved = store?.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as { print: string; key: string };
      if (parsed.print === print && parsed.key) return parsed.key;
    }
  } catch {
    // unreadable: fall through and make a new key
  }
  const key = makeId();
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify({ print, key }));
  } catch {
    // storage blocked: the key still works for this attempt, just not across a reload
  }
  return key;
}

/** Call once the order exists, so the next purchase of the same cart is a new order. */
export function clearCheckoutKey(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // nothing to clear
  }
}
