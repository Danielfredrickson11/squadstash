// Checkpoint 6.7B1: the shared trusted transaction core for Trip
// membership departure. Both public callables - leaveTrip and
// removeTripMember - delegate here rather than duplicating this
// financial transaction logic (the checkpoint's own explicit
// preference for "an internal shared implementation" over duplicating
// a single trusted-callable's worth of gates twice).
//
// This file performs every Firestore read/write the departure needs;
// the deterministic id and memberIds-reconstruction math are delegated
// to the pure domain module tripMembershipDeparture.ts, the Shared-
// Stash ownership math to tripOwnershipAccounting.ts, and the ownership/
// expense-balance/ledger lifecycle classification to their own existing
// domain modules - this file never duplicates any of that logic, only
// orchestrates it.
//
// Scope (6.7B1 only): leaveTrip / removeTripMember backend only. NO
// former-member residual withdrawal, NO residual funds listing, NO
// client wiring, NO ownership transfer, NO owner leave, NO rejoin -
// all explicitly deferred.
import {FieldValue} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {
  tripMembershipDepartureId,
  validateCanonicalMemberIds,
  removeMemberFromCanonicalMemberIds,
  isWellFormedDepartureMatchCandidate,
} from "../domain/tripMembershipDeparture";
import type {DepartureType} from "../domain/tripMembershipDeparture";
import {classifyOwnershipMutationGate} from "../domain/tripOwnershipModel";
import {classifyLedgerInitialization} from "../domain/savingsLedger";
import {
  tripMemberOwnershipId,
  isValidOwnershipMinor,
} from "../domain/tripMemberOwnership";
import {
  reconcileOwnershipAgainstAggregate,
} from "../domain/tripOwnershipAccounting";
import type {MemberOwnershipBalance} from "../domain/tripOwnershipAccounting";
import {
  classifyExpenseBalanceMutationGate,
} from "../domain/tripExpenseBalanceModel";
import {
  tripExpenseBalanceId,
  isValidNetBalanceMinor,
} from "../domain/tripExpenseBalanceStore";

export type TripMembershipDepartureResult = {
  tripId: string;
  uid: string;
  departureType: DepartureType;
};

export type TripMembershipDepartureRequest =
  | {kind: "leave"; tripId: string}
  | {kind: "remove"; tripId: string; targetUid: string};

/**
 * True if uid is a current member of the Trip (memberIds or ownerId),
 * LENIENTLY - a malformed (non-array) memberIds is treated as empty, so
 * only the independent ownerId fallback can authorize in that case.
 * Deliberately malformed-safe, exactly mirroring the established
 * `isCurrentTripMember` convention already duplicated per-file
 * throughout every other trusted financial callable (e.g.
 * reverseTripExpense.ts) - this is an AUTHORIZATION pre-check only; it
 * never substitutes for the separate, STRICT canonical memberIds
 * validation this departure transaction performs before ever disclosing
 * malformed-shape details or mutating membership.
 * @param {FirebaseFirestore.DocumentData} tripData The Trip document
 *   data.
 * @param {string} uid The uid to check.
 * @return {boolean} True if uid is a current Trip member.
 */
function isLenientlyCurrentMember(
  tripData: FirebaseFirestore.DocumentData,
  uid: string
): boolean {
  const memberIds = Array.isArray(tripData.memberIds) ? tripData.memberIds : [];
  return memberIds.includes(uid) || tripData.ownerId === uid;
}

/**
 * Executes a trusted Trip membership departure (leave or remove) in a
 * single Firestore transaction. See this file's own header comment for
 * the overall architecture; see the inline step comments below for the
 * exact read/validate/write ordering this implements.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or
 *   prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {TripMembershipDepartureRequest} request The departure being
 *   requested - either the caller leaving, or the Trip owner removing
 *   `targetUid`.
 * @return {Promise<TripMembershipDepartureResult>} The resulting (or
 *   idempotently replayed) departure.
 */
export async function executeTripMembershipDeparture(
  db: Firestore,
  authUid: string,
  request: TripMembershipDepartureRequest
): Promise<TripMembershipDepartureResult> {
  const tripId = request.tripId;
  const targetUid = request.kind === "leave" ? authUid : request.targetUid;
  const departureType: DepartureType =
    request.kind === "leave" ? "left" : "removed";

  const departureRef = db
    .collection("tripMembershipDepartures")
    .doc(tripMembershipDepartureId(tripId, targetUid));
  const tripRef = db.collection("trips").doc(tripId);

  return db.runTransaction(async (tx) => {
    // A. Read the deterministic departure record FIRST, before the Trip
    // is ever read - mirrors reverseTripExpense.ts's own "idempotent
    // replay resolved immediately, independent of the parent Trip"
    // principle (6.7A precedent). An EXACT match (same tripId/uid/
    // departureType/departedByUid) is this caller's own already-
    // committed departure - return success immediately, without
    // requiring the caller to still be a current member (the whole
    // point of a successful departure is that they no longer are).
    //
    // A non-exact match (wrong type, wrong actor, or malformed stored
    // data) deliberately does NOT throw here - falling through lets the
    // ordinary authorization/validity pipeline below produce the
    // correct outcome without ever acting as an information oracle
    // (§27): an unrelated caller who guesses tripId/targetUid learns
    // nothing beyond the ordinary "not a current member"/"permission-
    // denied" a genuinely-already-departed target would produce
    // anyway, once Trip.memberIds no longer lists them.
    const departureSnap = await tx.get(departureRef);
    if (departureSnap.exists) {
      const data = departureSnap.data() as FirebaseFirestore.DocumentData;
      if (
        isWellFormedDepartureMatchCandidate(data) &&
        data.tripId === tripId &&
        data.uid === targetUid &&
        data.departureType === departureType &&
        data.departedByUid === authUid
      ) {
        return {tripId, uid: targetUid, departureType};
      }
    }
    const departureAlreadyExists = departureSnap.exists;

    // B. Read the Trip - the first and only point in this transaction a
    // Trip document is ever read.
    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) {
      throw new HttpsError(
        "not-found",
        "No trip found for the given tripId."
      );
    }
    const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;

    // C. LENIENT authorization (malformed-memberIds-safe) - reached
    // WITHOUT ever having inspected memberIds' own canonical validity.
    // An unauthorized caller's outcome never depends on whether the
    // Trip's membership data happens to also be malformed.
    if (request.kind === "leave") {
      if (!isLenientlyCurrentMember(tripData, authUid)) {
        throw new HttpsError(
          "permission-denied",
          "You are not a member of this trip."
        );
      }
      if (authUid === tripData.ownerId) {
        throw new HttpsError(
          "failed-precondition",
          "The Trip owner cannot leave this trip."
        );
      }
    } else {
      if (authUid !== tripData.ownerId) {
        throw new HttpsError(
          "permission-denied",
          "Only the Trip owner may remove a member."
        );
      }
      if (targetUid === tripData.ownerId || targetUid === authUid) {
        throw new HttpsError(
          "failed-precondition",
          "The Trip owner cannot be removed."
        );
      }
      if (!isLenientlyCurrentMember(tripData, targetUid)) {
        throw new HttpsError(
          "failed-precondition",
          "That person is not a current member of this trip."
        );
      }
    }

    // D. NOW, for an authorized caller only: STRICT canonical memberIds
    // validation (§8). Departure is not a membership-repair operation -
    // malformed membership fails closed rather than being deduplicated,
    // repaired, or normalized.
    const canonicalResult = validateCanonicalMemberIds(
      tripData.ownerId,
      tripData.memberIds
    );
    if (!canonicalResult.ok) {
      throw new HttpsError(
        "failed-precondition",
        "This trip's membership data is malformed and cannot be safely " +
          "changed."
      );
    }

    // E. Defensive: a departure event already exists at this exact
    // deterministic id but did not match the replay check in step A.
    // Structurally unreachable given this operation's own atomicity
    // (step J commits the Trip membership change and the departure
    // event together) - current membership data contradicting an
    // existing departure record would mean something has already gone
    // wrong upstream. Never repaired, never overwritten - fails closed.
    if (departureAlreadyExists) {
      throw new HttpsError(
        "failed-precondition",
        "This membership has already ended."
      );
    }

    // F. Required financial model states (§10) - departure is allowed
    // only when BOTH systems are trusted and at their currently-
    // supported version. Neither system is auto-migrated or repaired
    // here.
    const ownershipGate = classifyOwnershipMutationGate(
      tripData.ownershipModelState,
      tripData.ownershipModelVersion
    );
    if (ownershipGate.kind === "legacy" || ownershipGate.kind === "blocked") {
      throw new HttpsError(
        "failed-precondition",
        "This trip's Shared Stash ownership model is not yet ready for " +
          "departure."
      );
    }
    if (ownershipGate.kind === "fail_closed") {
      throw new HttpsError(
        "failed-precondition",
        "This trip has an unsupported or corrupt Shared Stash ownership " +
          "model state."
      );
    }

    const expenseBalanceGate = classifyExpenseBalanceMutationGate(
      tripData.expenseBalanceModelState,
      tripData.expenseBalanceModelVersion
    );
    if (
      expenseBalanceGate.kind === "legacy" ||
      expenseBalanceGate.kind === "blocked"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This trip's expense-balance model is not yet ready for " +
          "departure."
      );
    }
    if (expenseBalanceGate.kind === "fail_closed") {
      throw new HttpsError(
        "failed-precondition",
        "This trip has an unsupported or corrupt expense-balance model " +
          "state."
      );
    }

    // G. Trusted Trip ledger state (§11) - required already-initialized
    // and valid; never bootstrapped or repaired here.
    const ledgerState = classifyLedgerInitialization(tripData);
    if (ledgerState.kind !== "initialized") {
      throw new HttpsError(
        "failed-precondition",
        "This trip's trusted Shared Stash ledger is not in a valid " +
          "state for departure."
      );
    }
    const ledgerBalanceMinor = ledgerState.currentBalanceMinor;

    // H. Full Shared Stash ownership-set validation (§12) + target-zero
    // gate (§13). Never trusts a single missing/zero row in isolation -
    // the COMPLETE set must first be proven to reconcile against the
    // Trip's own trusted ledger before a missing target row is ever
    // treated as zero.
    const ownershipSnap = await tx.get(
      db.collection("tripMemberOwnership").where("tripId", "==", tripId)
    );
    const ownershipBalances: MemberOwnershipBalance[] = [];
    const seenOwnershipUids = new Set<string>();
    for (const doc of ownershipSnap.docs) {
      const d = doc.data();
      if (
        typeof d.uid !== "string" ||
        d.uid.length === 0 ||
        d.tripId !== tripId ||
        doc.id !== tripMemberOwnershipId(tripId, d.uid) ||
        !isValidOwnershipMinor(d.ownershipMinor) ||
        seenOwnershipUids.has(d.uid)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This trip's Shared Stash ownership records are malformed and " +
            "cannot be safely verified."
        );
      }
      seenOwnershipUids.add(d.uid);
      ownershipBalances.push({uid: d.uid, ownershipMinor: d.ownershipMinor});
    }
    const ownershipReconciles =
      ownershipBalances.length === 0 ?
        ledgerBalanceMinor === 0 :
        reconcileOwnershipAgainstAggregate(
          ledgerBalanceMinor,
          ownershipBalances
        ).ok;
    if (!ownershipReconciles) {
      throw new HttpsError(
        "failed-precondition",
        "This trip's Shared Stash ownership records are inconsistent " +
          "and cannot be safely verified."
      );
    }
    const targetOwnershipMinor =
      ownershipBalances.find((b) => b.uid === targetUid)?.ownershipMinor ?? 0;
    if (targetOwnershipMinor > 0) {
      throw new HttpsError(
        "failed-precondition",
        "This member still has funds in this trip's Shared Stash - " +
          "withdraw them before leaving."
      );
    }

    // I. Full social expense-balance-set validation (§14) + target-
    // net-zero gate (§15). Same "complete set must reconcile before a
    // missing row is trusted as zero" discipline as step H - the signed
    // aggregate must sum to EXACTLY zero, computed in BigInt throughout
    // (overflow-safe regardless of row count or magnitude).
    const balanceSnap = await tx.get(
      db.collection("tripExpenseBalances").where("tripId", "==", tripId)
    );
    const seenBalanceUids = new Set<string>();
    let balanceSumBig = BigInt(0);
    let targetNetBalanceMinor = 0;
    for (const doc of balanceSnap.docs) {
      const d = doc.data();
      if (
        typeof d.uid !== "string" ||
        d.uid.length === 0 ||
        d.tripId !== tripId ||
        doc.id !== tripExpenseBalanceId(tripId, d.uid) ||
        !isValidNetBalanceMinor(d.netBalanceMinor) ||
        seenBalanceUids.has(d.uid)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This trip's expense-balance records are malformed and " +
            "cannot be safely verified."
        );
      }
      seenBalanceUids.add(d.uid);
      balanceSumBig += BigInt(d.netBalanceMinor);
      if (d.uid === targetUid) {
        targetNetBalanceMinor = d.netBalanceMinor;
      }
    }
    if (balanceSumBig !== BigInt(0)) {
      throw new HttpsError(
        "failed-precondition",
        "This trip's expense-balance records are inconsistent and " +
          "cannot be safely verified."
      );
    }
    // Checkpoint 6.7B1 §15: never distinguish the sign - owed money and
    // owing money both block departure identically, for both leave and
    // remove.
    if (targetNetBalanceMinor !== 0) {
      throw new HttpsError(
        "failed-precondition",
        "This member has an unsettled balance on this trip - settle up " +
          "before leaving."
      );
    }

    // J. Reconstruct memberIds (§9) - never a blind arrayRemove.
    const removalResult = removeMemberFromCanonicalMemberIds(
      tripData.ownerId,
      canonicalResult.memberIds,
      targetUid
    );
    if (!removalResult.ok) {
      throw new HttpsError(
        "failed-precondition",
        "Unable to safely remove this member from the trip's " +
          "membership list."
      );
    }

    // K. Writes - the departure record is created in the SAME
    // transaction that removes the uid from Trip.memberIds (§6): these
    // two states must never diverge. `tx.create` (not `tx.set`) gives
    // an additional, atomic "fails if it already exists" guarantee at
    // commit time, on top of the explicit read-based check in step A/E.
    tx.update(tripRef, {
      memberIds: removalResult.newMemberIds,
      lastUpdatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: authUid,
    });

    const departureData: Record<string, unknown> = {
      tripId,
      uid: targetUid,
      departureType,
      departedByUid: authUid,
      departedAt: FieldValue.serverTimestamp(),
      tripTitleSnapshot:
        typeof tripData.title === "string" ? tripData.title : "",
    };
    if (typeof tripData.currency === "string" && tripData.currency.length > 0) {
      departureData.currencySnapshot = tripData.currency;
    }
    tx.create(departureRef, departureData);

    return {tripId, uid: targetUid, departureType};
  });
}
