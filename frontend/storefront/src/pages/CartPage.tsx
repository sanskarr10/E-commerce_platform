import { Link } from 'react-router-dom';
import { formatMoney } from '@shop/shared';
import { MAX_PER_LINE, useCart } from '../cart';

export function CartPage() {
  const { lines, total, dispatch } = useCart();
  if (lines.length === 0) {
    return (
      <>
        <h1>Your cart</h1>
        <p>Your cart is empty. <Link to="/">Browse the catalog</Link></p>
      </>
    );
  }
  return (
    <>
      <h1>Your cart</h1>
      <table className="lines">
        <thead><tr><th>Item</th><th>Quantity</th><th className="num">Price</th><th><span className="sr-only">Remove</span></th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.product_id}>
              <td><Link to={`/products/${l.product_id}`}>{l.name}</Link><br /><span className="muted">{l.sku}</span></td>
              <td>
                <label className="qty">
                  <span className="sr-only">Quantity for {l.name}</span>
                  <input type="number" min={1} max={Math.min(MAX_PER_LINE, l.stock)} value={l.quantity}
                    onChange={(e) => dispatch({ type: 'set', productId: l.product_id, quantity: Number(e.target.value) || 1 })} />
                </label>
              </td>
              <td className="num price">{formatMoney(l.price_minor * l.quantity, l.currency)}</td>
              <td><button type="button" className="link" onClick={() => dispatch({ type: 'remove', productId: l.product_id })} aria-label={`Remove ${l.name}`}>Remove</button></td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={2}>Total</td><td className="num price">{formatMoney(total, lines[0]?.currency)}</td><td /></tr></tfoot>
      </table>
      <p><Link to="/checkout" className="btn">Checkout</Link></p>
    </>
  );
}
