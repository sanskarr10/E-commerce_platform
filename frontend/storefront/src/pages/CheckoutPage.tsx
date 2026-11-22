import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, checkoutKey, clearCheckoutKey, formatMoney, TEST_PAYMENT_METHODS, useAuth } from '@shop/shared';
import { useCart } from '../cart';

export function CheckoutPage() {
  const { endpoints } = useAuth();
  const { lines, total, dispatch } = useCart();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [method, setMethod] = useState<string>(TEST_PAYMENT_METHODS[0].token);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  // Once the order exists the cart is emptied; that must not bounce the person back to /cart.
  const placedRef = useRef(false);

  if (lines.length === 0 && !placedRef.current) return <Navigate to="/cart" replace />;

  const place = async () => {
    const body = { items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })), payment_method: method };
    // Same cart + same method => same key, so a double click or a retry after a timeout can never create a second order.
    const key = checkoutKey(body);
    setBusy(true);
    setError(null);
    try {
      const { order } = await endpoints.orders.place(body, key);
      placedRef.current = true;
      clearCheckoutKey();
      void qc.invalidateQueries({ queryKey: ['orders'] });
      navigate(`/orders/${order.id}`, { replace: true });
      dispatch({ type: 'clear' });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, null, 'Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const chosen = TEST_PAYMENT_METHODS.find((m) => m.token === method);
  return (
    <>
      <h1>Checkout</h1>
      <div className="checkout">
        <section className="panel">
          <h2>Order summary</h2>
          <ul className="plain">
            {lines.map((l) => (
              <li key={l.product_id}><span>{l.quantity} × {l.name}</span><span className="price">{formatMoney(l.price_minor * l.quantity, l.currency)}</span></li>
            ))}
          </ul>
          <p className="sum"><strong>Total</strong><span className="price">{formatMoney(total, lines[0]?.currency)}</span></p>
          <Link to="/cart">Edit cart</Link>
        </section>
        <section className="panel">
          <h2>Payment</h2>
          <p className="muted">This demo uses a mock payment provider. Pick a test card to see how each outcome plays out.</p>
          <fieldset>
            <legend className="sr-only">Test payment method</legend>
            {TEST_PAYMENT_METHODS.map((m) => (
              <label key={m.token} className="radio">
                <input type="radio" name="method" value={m.token} checked={method === m.token} onChange={() => setMethod(m.token)} /> {m.label}
              </label>
            ))}
          </fieldset>
          <p className="muted">{chosen?.hint}</p>
          {error && <div className="alert" role="alert">{error.message}</div>}
          <button type="button" disabled={busy} onClick={() => void place()}>{busy ? 'Placing order…' : `Pay ${formatMoney(total, lines[0]?.currency)}`}</button>
        </section>
      </div>
    </>
  );
}
