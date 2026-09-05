export const formatCurrency = (n: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n);

// Duck-typed rather than importing Firestore's Timestamp type - keeps this
// file dependency-free (matching its existing zero-import convention) and
// testable with plain Dates, while still accepting a real Firestore
// Timestamp as-is (Milestone 2A's PersistedTimestamp), since both expose
// toDate().
type TimestampLike = Date | { toDate: () => Date };

// Formats a savingsTransactions timestamp (occurredAt or createdAt) for
// display (Milestone 3 Checkpoint 3C) - never renders a raw Firestore
// Timestamp object, and never throws on a missing/malformed value; an
// absent, non-Date-like, or invalid value deterministically falls back to
// "Unknown date" rather than producing "Invalid Date" or crashing the
// transaction row that called this.
export function formatTransactionTimestamp(
  value: TimestampLike | null | undefined
): string {
  if (!value) return "Unknown date";

  const date = value instanceof Date ? value : value.toDate();
  if (Number.isNaN(date.getTime())) return "Unknown date";

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Deterministic dollars-string -> integer minor-units parser for the
// app's two-decimal money inputs. Avoids floating-point arithmetic (e.g.
// Math.round(Number(input) * 100), which can misround values like 1.005
// due to binary decimal representation) by parsing the whole and
// fractional parts as separate digit strings and combining them as
// integers - the input string is never converted to a Number as a whole
// decimal value. Returns null for anything that isn't a clean amount with
// at most 2 decimal places (empty, negative, malformed, too many
// decimals, or an unsafe-integer result), rather than silently coercing
// malformed input.
//
// allowZero defaults to false so existing contribution/withdrawal call
// sites (which must reject a $0 amount) are unaffected - Starting Balance
// parsing (Milestone 2B Checkpoint 4G-2), which must accept an explicit
// $0, passes { allowZero: true } instead. A single parameterized function
// rather than a second near-duplicate parser, since the regex/whole-
// fraction-split/safe-integer logic is identical between both callers -
// only the "reject exactly zero" branch differs.
export function parseDollarsToMinorUnits(
  input: string,
  { allowZero = false }: { allowZero?: boolean } = {}
): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const [wholePart, fractionPart = ""] = trimmed.split(".");
  const paddedFraction = (fractionPart + "00").slice(0, 2);
  const minorUnits = Number(wholePart) * 100 + Number(paddedFraction);

  if (!Number.isSafeInteger(minorUnits)) return null;
  if (allowZero ? minorUnits < 0 : minorUnits <= 0) return null;
  return minorUnits;
}
