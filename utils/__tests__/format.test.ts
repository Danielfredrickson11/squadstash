import { formatCurrency, parseDollarsToMinorUnits } from '../format';

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

describe('parseDollarsToMinorUnits', () => {
  it('parses a whole dollar amount', () => {
    expect(parseDollarsToMinorUnits('12')).toBe(1200);
  });

  it('parses one decimal place', () => {
    expect(parseDollarsToMinorUnits('12.3')).toBe(1230);
  });

  it('parses two decimal places', () => {
    expect(parseDollarsToMinorUnits('12.34')).toBe(1234);
  });

  it('parses a sub-dollar amount', () => {
    expect(parseDollarsToMinorUnits('0.01')).toBe(1);
  });

  it('trims surrounding whitespace', () => {
    expect(parseDollarsToMinorUnits(' 12.34 ')).toBe(1234);
  });

  it('rejects an empty string', () => {
    expect(parseDollarsToMinorUnits('')).toBeNull();
  });

  it('rejects a whitespace-only string', () => {
    expect(parseDollarsToMinorUnits(' ')).toBeNull();
  });

  it('rejects zero', () => {
    expect(parseDollarsToMinorUnits('0')).toBeNull();
  });

  it('rejects zero with decimals', () => {
    expect(parseDollarsToMinorUnits('0.00')).toBeNull();
  });

  it('rejects a negative whole amount', () => {
    expect(parseDollarsToMinorUnits('-1')).toBeNull();
  });

  it('rejects a negative decimal amount', () => {
    expect(parseDollarsToMinorUnits('-1.00')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parseDollarsToMinorUnits('abc')).toBeNull();
  });

  it('rejects more than two decimal places', () => {
    expect(parseDollarsToMinorUnits('12.345')).toBeNull();
  });

  it('rejects multiple decimal points', () => {
    expect(parseDollarsToMinorUnits('1.2.3')).toBeNull();
  });

  it('rejects an amount whose minor-unit result exceeds Number.MAX_SAFE_INTEGER', () => {
    expect(parseDollarsToMinorUnits('100000000000000000')).toBeNull();
  });
});
