// Pure logical-request/idempotency helpers for the Personal Savings
// money-action controller (Milestone 3 Checkpoint 3D). No Firestore, no
// React - only plain fact comparison, matching
// functions/src/callables/recordSavingsTransaction.ts's storedFactsMatch
// exactly for the fields this client ever sends (resourceId, memberUid,
// type, amountMinor, note - currency/occurredAt are also compared
// server-side, but this UI never varies currency independently of the
// Bucket, and never sends occurredAt, so neither needs to be tracked as
// a separate fact here).
//
// Extracted from the pre-3D resolveClientRequestId in
// app/(tabs)/buckets/index.tsx, generalized to include `note`: the
// backend's storedFactsMatch DOES compare note on replay (confirmed by
// reading recordSavingsTransaction.ts directly), so a client-side
// idempotency comparison that ignored note would incorrectly reuse a
// clientRequestId across two logically different requests (same amount,
// different note) and receive a confusing "already-exists" rejection
// from the backend instead of submitting a fresh request.
import { parseDollarsToMinorUnits } from "../../utils/format";

export type MoneyActionFacts = {
  resourceId: string;
  memberUid: string;
  type: "contribution" | "withdrawal";
  amountMinor: number;
  note: string | undefined;
};

export type PendingMoneyActionRequest = MoneyActionFacts & {
  clientRequestId: string;
};

// Resolves the actual amountMinor a submission will use (Checkpoint 3D
// review follow-up). A selected quick-amount preset (e.g. $20/$50/$100 -
// see components/buckets/MoneyActionSheet.tsx) carries its own canonical
// integer minor-unit value directly and is used AS-IS, never re-derived
// from a dollar-string round trip through amountText. amountText is only
// ever parsed when no preset is selected - i.e. once the user has
// manually edited the amount field, which must clear any prior preset
// selection (see the controller's setAmountText).
export function resolveAmountMinor(
  amountText: string,
  presetAmountMinor: number | null
): number | null {
  if (presetAmountMinor !== null) return presetAmountMinor;
  return parseDollarsToMinorUnits(amountText);
}

// Trims a raw note field to the exact value the backend will store: a
// blank/whitespace-only note is normalized to undefined (omitted from
// the wire payload entirely) rather than sent as an empty or
// whitespace-only string, matching "optional, omitted when blank" per
// the existing RecordSavingsTransactionInput/service contract.
export function normalizeTransactionNote(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// True if two fact sets describe the same logical submission - every
// field the backend's storedFactsMatch compares for this client's
// inputs, none omitted.
export function moneyActionFactsEqual(
  a: MoneyActionFacts,
  b: MoneyActionFacts
): boolean {
  return (
    a.resourceId === b.resourceId &&
    a.memberUid === b.memberUid &&
    a.type === b.type &&
    a.amountMinor === b.amountMinor &&
    (a.note ?? undefined) === (b.note ?? undefined)
  );
}

// Returns the clientRequestId to use for this submission: reuses the
// previous attempt's id if the retained pending request has the exact
// same facts (a retry of a failed submit), otherwise generates a fresh
// id via the supplied generator and replaces the pending record (a
// genuinely new logical request - a different Bucket, action type,
// amount, or note). Mirrors the pre-3D resolveClientRequestId's exact
// contract, generalized to include note and to accept the id generator
// as a parameter so this stays framework/Firestore-free and directly
// unit-testable.
export function resolveMoneyActionClientRequestId(
  pendingRef: { current: PendingMoneyActionRequest | null },
  facts: MoneyActionFacts,
  generateClientRequestId: () => string
): string {
  const pending = pendingRef.current;
  if (pending && moneyActionFactsEqual(pending, facts)) {
    return pending.clientRequestId;
  }

  const clientRequestId = generateClientRequestId();
  pendingRef.current = { ...facts, clientRequestId };
  return clientRequestId;
}
