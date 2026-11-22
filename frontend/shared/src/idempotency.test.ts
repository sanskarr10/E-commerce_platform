import { checkoutKey, clearCheckoutKey, fingerprint } from './idempotency';

const body = { items: [{ product_id: 1, quantity: 2 }, { product_id: 2, quantity: 1 }], payment_method: 'tok_success' };

describe('fingerprint', () => {
  it('ignores line order and merges duplicate lines', () => {
    const shuffled = { ...body, items: [{ product_id: 2, quantity: 1 }, { product_id: 1, quantity: 1 }, { product_id: 1, quantity: 1 }] };
    expect(fingerprint(shuffled)).toBe(fingerprint(body));
  });
  it('changes with quantity or payment method', () => {
    expect(fingerprint({ ...body, payment_method: 'tok_decline' })).not.toBe(fingerprint(body));
    expect(fingerprint({ ...body, items: [{ product_id: 1, quantity: 3 }] })).not.toBe(fingerprint(body));
  });
});

describe('checkoutKey', () => {
  it('reuses the key while the cart is unchanged (double click, retry, reload)', () => {
    let n = 0;
    const make = () => `key-${++n}`;
    expect(checkoutKey(body, make)).toBe('key-1');
    expect(checkoutKey(body, make)).toBe('key-1');
  });
  it('makes a new key when the cart changes', () => {
    let n = 0;
    const make = () => `key-${++n}`;
    checkoutKey(body, make);
    expect(checkoutKey({ ...body, payment_method: 'tok_decline' }, make)).toBe('key-2');
  });
  it('makes a new key after the order was placed', () => {
    let n = 0;
    const make = () => `key-${++n}`;
    checkoutKey(body, make);
    clearCheckoutKey();
    expect(checkoutKey(body, make)).toBe('key-2');
  });
  it('survives corrupt storage', () => {
    window.sessionStorage.setItem('checkout-attempt', '{nope');
    expect(checkoutKey(body, () => 'fresh')).toBe('fresh');
  });
});
