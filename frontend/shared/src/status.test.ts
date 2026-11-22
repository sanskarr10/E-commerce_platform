import { cancelMessage, isFinal, isSettling, ORDER_STEPS } from './status';

it('orders the happy path', () => {
  expect(ORDER_STEPS).toEqual(['PENDING', 'STOCK_RESERVED', 'PAID', 'SHIPPED', 'DELIVERED']);
});
it('knows which states keep changing by themselves', () => {
  expect(isSettling('PENDING')).toBe(true);
  expect(isSettling('STOCK_RESERVED')).toBe(true);
  expect(isSettling('PAID')).toBe(false);
});
it('knows final states', () => {
  expect(isFinal('CANCELLED')).toBe(true);
  expect(isFinal('SHIPPED')).toBe(false);
});
it('explains cancellations in plain words', () => {
  expect(cancelMessage('out_of_stock')).toMatch(/ran out of stock/);
  expect(cancelMessage('payment_failed')).toMatch(/declined/);
  expect(cancelMessage(null)).toMatch(/cancelled/);
});
