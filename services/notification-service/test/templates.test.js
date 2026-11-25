import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMoney, render } from '../src/templates.js';

const base = { order_id: '5f3c1d52-8d3e-4a52-9a52-0c6a0d3f9b10' };

describe('templates', () => {
  it('formats money from minor units', () => {
    assert.equal(formatMoney(249900), '₹2,499');
    assert.equal(formatMoney(49950), '₹499.50');
  });
  it('writes a confirmation with the short order reference and total', () => {
    const { title, body } = render('order.confirmed', { ...base, total_minor: 249900, currency: 'INR' });
    assert.equal(title, 'Payment received');
    assert.match(body, /#5f3c1d52/);
    assert.match(body, /₹2,499/);
  });
  it('writes shipped and delivered messages', () => {
    assert.equal(render('order.shipped', base).title, 'Your order has shipped');
    assert.equal(render('order.delivered', base).title, 'Your order was delivered');
  });
  it('explains each cancellation reason and falls back safely', () => {
    assert.match(render('order.cancelled', { ...base, reason: 'out_of_stock' }).body, /ran out of stock/);
    assert.match(render('order.cancelled', { ...base, reason: 'payment_failed' }).body, /declined/);
    assert.match(render('order.cancelled', { ...base, reason: 'something_new' }).body, /not charged/);
    assert.match(render('order.cancelled', { ...base, reason: null }).body, /not charged/);
  });
  it('refuses unknown types', () => {
    assert.throws(() => render('order.exploded', base), /no template/);
  });
});
