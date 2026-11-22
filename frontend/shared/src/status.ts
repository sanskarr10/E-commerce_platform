import type { OrderStatus } from './types';

/** The happy path, in order. CANCELLED branches off it at the first two steps. */
export const ORDER_STEPS: OrderStatus[] = ['PENDING', 'STOCK_RESERVED', 'PAID', 'SHIPPED', 'DELIVERED'];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'Order placed',
  STOCK_RESERVED: 'Items reserved',
  PAID: 'Payment confirmed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

export const STATUS_HINT: Record<OrderStatus, string> = {
  PENDING: 'We are checking stock.',
  STOCK_RESERVED: 'Your items are set aside. Taking payment.',
  PAID: 'Paid. The shop will ship it next.',
  SHIPPED: 'On its way.',
  DELIVERED: 'Delivered.',
  CANCELLED: 'This order was cancelled.',
};

const CANCEL_REASON: Record<string, string> = {
  out_of_stock: 'Some items ran out of stock. You were not charged.',
  payment_failed: 'Your payment was declined. Reserved items were released and you were not charged.',
};

export function cancelMessage(reason: string | null): string {
  return (reason && CANCEL_REASON[reason]) || 'This order was cancelled. You were not charged.';
}

/** Orders still moving through the checkout saga: worth polling until they settle. */
export function isSettling(status: OrderStatus): boolean {
  return status === 'PENDING' || status === 'STOCK_RESERVED';
}

export function isFinal(status: OrderStatus): boolean {
  return status === 'DELIVERED' || status === 'CANCELLED';
}

/** Payment tokens understood by the mock provider (see README). */
export const TEST_PAYMENT_METHODS = [
  { token: 'tok_success', label: 'Test card, approved', hint: 'The payment goes through.' },
  { token: 'tok_decline', label: 'Test card, declined', hint: 'The bank refuses it, so the order is cancelled and the stock released.' },
  { token: 'tok_insufficient', label: 'Test card, insufficient funds', hint: 'Declined for lack of funds.' },
  { token: 'tok_flaky', label: 'Test card, provider hiccup', hint: 'The payment provider fails once and the retry succeeds.' },
] as const;
