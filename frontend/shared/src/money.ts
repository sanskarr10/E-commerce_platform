/** Prices are integers in minor units (paise, cents). Formatting is the only place they become decimals. */
export function formatMoney(minor: number, currency = 'INR', locale = 'en-IN'): string {
  const exponent = new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
  const value = minor / 10 ** exponent;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    // Whole amounts read cleaner without ".00" (₹2,499), real fractions are kept (₹499.50).
    minimumFractionDigits: Number.isInteger(value) ? 0 : exponent,
    maximumFractionDigits: exponent,
  }).format(value);
}

/** Parses what a person types ("499", "499.5", "1,299.00") into minor units, or null if it is not a price. */
export function parseMoney(input: string, exponent = 2): number | null {
  const cleaned = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  if (fraction.length > exponent) return null;
  return Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, '0') || 0);
}
