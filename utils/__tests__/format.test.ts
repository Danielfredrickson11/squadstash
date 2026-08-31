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

  describe('with allowZero: true (Starting Balance)', () => {
    it('accepts "0" as 0', () => {
      expect(parseDollarsToMinorUnits('0', { allowZero: true })).toBe(0);
    });

    it('accepts "0.00" as 0', () => {
      expect(parseDollarsToMinorUnits('0.00', { allowZero: true })).toBe(0);
    });

    it('still parses a whole dollar amount', () => {
      expect(parseDollarsToMinorUnits('12', { allowZero: true })).toBe(1200);
    });

    it('still parses one decimal place', () => {
      expect(parseDollarsToMinorUnits('12.3', { allowZero: true })).toBe(1230);
    });

    it('still parses two decimal places', () => {
      expect(parseDollarsToMinorUnits('12.34', { allowZero: true })).toBe(1234);
    });

    it('still rejects a negative amount', () => {
      expect(parseDollarsToMinorUnits('-1', { allowZero: true })).toBeNull();
    });

    it('still rejects more than two decimal places', () => {
      expect(parseDollarsToMinorUnits('12.345', { allowZero: true })).toBeNull();
    });
  });
});
