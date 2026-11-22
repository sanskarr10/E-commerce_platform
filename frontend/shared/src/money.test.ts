import { formatMoney, parseMoney } from './money';

describe('formatMoney', () => {
  it('formats whole rupees without decimals', () => {
    expect(formatMoney(249900)).toBe('₹2,499');
  });
  it('keeps real fractions', () => {
    expect(formatMoney(49950)).toBe('₹499.50');
  });
  it('uses the currency exponent', () => {
    expect(formatMoney(1999, 'USD', 'en-US')).toBe('$19.99');
  });
});

describe('parseMoney', () => {
  it.each([
    ['499', 49900],
    ['499.5', 49950],
    ['1,299.00', 129900],
    [' 0.99 ', 99],
  ])('parses %s', (input, expected) => expect(parseMoney(input)).toBe(expected));

  it.each(['', 'abc', '-5', '1.234', '1..2'])('rejects %j', (input) => expect(parseMoney(input)).toBeNull());
});
