/** Words a customer reads. Kept in one place so tone stays consistent and tests can pin it. */
export function formatMoney(minor, currency = 'INR') {
  const exponent = new Intl.NumberFormat('en-IN', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const value = minor / 10 ** exponent;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : exponent,
    maximumFractionDigits: exponent,
  }).format(value);
}

export const shortId = (orderId) => orderId.slice(0, 8);

const CANCEL_REASONS = {
  out_of_stock: 'Some items ran out of stock. You were not charged.',
  payment_failed: 'Your payment was declined. Reserved items were released and you were not charged.',
};

/** Returns { title, body } for an order event. */
export function render(type, data) {
  const ref = `#${shortId(data.order_id)}`;
  switch (type) {
    case 'order.confirmed':
      return {
        title: 'Payment received',
        body: `Your order ${ref} for ${formatMoney(data.total_minor, data.currency)} is confirmed. We will tell you when it ships.`,
      };
    case 'order.shipped':
      return { title: 'Your order has shipped', body: `Order ${ref} is on its way.` };
    case 'order.delivered':
      return { title: 'Your order was delivered', body: `Order ${ref} has been delivered. Enjoy!` };
    case 'order.cancelled':
      return {
        title: 'Your order was cancelled',
        body: `Order ${ref} was cancelled. ${CANCEL_REASONS[data.reason] ?? 'You were not charged.'}`,
      };
    default:
      throw new Error(`no template for ${type}`);
  }
}
