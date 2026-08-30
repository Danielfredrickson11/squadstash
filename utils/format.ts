export const formatCurrency = (n: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n);

// Deterministic dollars-string -> integer minor-units parser for the
// app's two-decimal money inputs. Avoids floating-point arithmetic (e.g.
// Math.round(Number(input) * 100), which can misround values like 1.005
// due to binary decimal representation) by parsing the whole and
// fractional parts as separate digit strings and combining them as
// integers - the input string is never converted to a Number as a whole
// decimal value. Returns null for anything that isn't a clean positive
// amount with at most 2 decimal places (empty, zero, negative, malformed,
// too many decimals, or an unsafe-integer result), rather than silently
// coercing malformed input.
export function parseDollarsToMinorUnits(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const [wholePart, fractionPart = ""] = trimmed.split(".");
  const paddedFraction = (fractionPart + "00").slice(0, 2);
  const minorUnits = Number(wholePart) * 100 + Number(paddedFraction);

  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) return null;
  return minorUnits;
}
