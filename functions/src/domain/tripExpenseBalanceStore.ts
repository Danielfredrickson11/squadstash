// Checkpoint 6.7A: the shared transaction helper that actually applies
// already-computed tripExpenseBalance deltas (see tripExpenseBalance.ts
// for the pure math) to Firestore - the one place every expense-balance-
// affecting callable calls into, so the read-validate-apply pattern is
// never duplicated four times. This file DOES import Firestore types
// (unlike tripExpenseBalance.ts, which is deliberately Firebase-free) -
// it is the Firestore-touching half of the split the checkpoint asked
// for.
//
// This helper never decides whether it is safe to mutate the aggregate
// at all (expense-balance-model state, Trip archive state, caller
// authorization) - the calling callable must have already confirmed
// `classifyExpenseBalanceMutationGate(...).kind === "initialized"`
// before ever calling this. It also never trusts a client-provided
// aggregate value - every read row is independently shape-validated
// before any delta is applied.
import {FieldValue} from "firebase-admin/firestore";
import type {Firestore, Transaction} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {ID_DELIMITER, assertNoDelimiter} from "./tripCompositeId";
import type {NormalizedBalanceDelta} from "./tripExpenseBalance";

// Persisted tripExpenseBalances/{tripId}_{uid} document shape (6.7A).
// Backend-authoritative only - firestore.rules closes every client
// read/write unconditionally (no concrete client read need exists; the
// existing UI already computes balances from live Expense/Split/
// Settlement history for display, entirely independent of this
// aggregate).
export type TripExpenseBalance = {
  id: string;
  tripId: string;
  uid: string;
  netBalanceMinor: number;
  // Timestamp once read back - see tripMemberOwnership.ts's own
  // identical convention for why this stays loosely typed here.
  updatedAt: unknown;
};

/**
 * Deterministic tripExpenseBalances document id - mirrors
 * tripMemberOwnershipId's own exact convention (an empty tripId/uid is
 * rejected outright, before the shared delimiter guard even runs).
 * @param {string} tripId The Trip's document id.
 * @param {string} uid The member's uid.
 * @return {string} The deterministic balance document id.
 */
export function tripExpenseBalanceId(tripId: string, uid: string): string {
  if (tripId.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "tripId must be a non-empty string."
    );
  }
  if (uid.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "uid must be a non-empty string."
    );
  }
  assertNoDelimiter(tripId, "tripId");
  assertNoDelimiter(uid, "uid");
  return `${tripId}${ID_DELIMITER}${uid}`;
}

/**
 * True if `value` is a valid `netBalanceMinor` - any safe integer
 * (unlike ownershipMinor, this is SIGNED: positive means owed money,
 * negative means owing money, zero means settled).
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a valid netBalanceMinor.
 */
export function isValidNetBalanceMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Reads, shape-validates, and applies a set of already-computed,
 * zero-summing balance deltas to `tripExpenseBalances` rows, inside the
 * CALLER's own existing Firestore transaction. An absent row starts
 * from 0 - this is only ever safe to call once the caller has already
 * confirmed the Trip's expense-balance model is "initialized" (this
 * function performs no such check itself - single responsibility).
 * Retains an explicit row even if its resulting value is exactly 0
 * (Checkpoint 6.7A's own frozen "never delete a balance row merely
 * because it reaches zero" invariant) - this function unconditionally
 * writes every touched row, zero or not.
 * @param {Transaction} tx The caller's own active Firestore transaction.
 * @param {Firestore} db Admin SDK Firestore instance.
 * @param {string} tripId The Trip these deltas belong to.
 * @param {NormalizedBalanceDelta[]} deltas The already-computed,
 *   zero-summing deltas to apply.
 * @return {Promise<void>}
 */
export async function applyTripExpenseBalanceDeltas(
  tx: Transaction,
  db: Firestore,
  tripId: string,
  deltas: NormalizedBalanceDelta[]
): Promise<void> {
  const entries = deltas.map((delta) => ({
    delta,
    ref: db
      .collection("tripExpenseBalances")
      .doc(tripExpenseBalanceId(tripId, delta.uid)),
  }));

  // All reads happen before any write, inside this same transaction -
  // Firestore transactions require this ordering; Promise.all over
  // several tx.get() calls is a supported, standard pattern (only
  // writes must be serialized after every read).
  const snaps = await Promise.all(entries.map((e) => tx.get(e.ref)));

  for (let i = 0; i < entries.length; i++) {
    const {delta, ref} = entries[i];
    const snap = snaps[i];

    let current = 0;
    if (snap.exists) {
      const data = snap.data() as FirebaseFirestore.DocumentData;
      if (
        data.tripId !== tripId ||
        data.uid !== delta.uid ||
        !isValidNetBalanceMinor(data.netBalanceMinor)
      ) {
        throw new HttpsError(
          "failed-precondition",
          `tripExpenseBalances row for "${delta.uid}" on this trip is ` +
            "malformed."
        );
      }
      current = data.netBalanceMinor;
    }

    const next = current + delta.deltaMinor;
    if (!Number.isSafeInteger(next)) {
      throw new HttpsError(
        "failed-precondition",
        `Balance overflow applying a delta for "${delta.uid}" on this trip.`
      );
    }

    tx.set(ref, {
      tripId,
      uid: delta.uid,
      netBalanceMinor: next,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}
