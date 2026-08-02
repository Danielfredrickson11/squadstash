import { formatCurrency } from '../format';

// These assertions assume the runtime's default Intl locale resolves to
// en-US, which is true for this repository's local/dev/CI environments.
describe('formatCurrency', () => {
  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('formats a whole dollar amount', () => {
    expect(formatCurrency(5)).toBe('$5.00');
  });

  it('formats and rounds a decimal amount to two places', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('formats large amounts with thousands separators', () => {
    expect(formatCurrency(1000000)).toBe('$1,000,000.00');
  });

  it('formats negative amounts', () => {
    expect(formatCurrency(-5)).toBe('-$5.00');
  });
});
