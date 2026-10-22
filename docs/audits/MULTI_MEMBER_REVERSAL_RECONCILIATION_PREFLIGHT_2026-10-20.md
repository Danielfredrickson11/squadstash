# Multi-Member Reversal / Reconciliation Hardening — Preflight

**Status: PREFLIGHT / ARCHITECTURE ONLY. Not implemented. Not committed.**

**Revision note (this pass):** this revision fixes a hard concurrency defect in the
previous revision's multi-attempt audit design: a query that happens to return zero
attempt documents is not a deterministic contention point and cannot safely serialize
concurrent repair starts. A separate, canonical, fixed-id control document is introduced
for exactly that purpose, mirroring how `tripOwnershipMigrationState/{tripId}`'s own fixed
id already gives migration its single contention point. Two directly-related
corrections follow from this: the attempt phase model gains a terminal `"failed"` phase
(so a terminal failure preserves its own audit record while still freeing the Trip for a
later, independent repair attempt), and finalization must now also own the control
document. A third, independent correction reverses the `lastUpdatedBy` decision: on
reflection, `Trip.lastUpdatedAt` is now also left unchanged, following
`migrateTripOwnership.ts`'s own precedent exactly (it touches neither field at
finalization) — writing a fresh timestamp paired with a stale actor uid would be
misleading, and this repository has no system-actor convention to pair it with instead.
See §23 for the full list.

This document prepares **5C.6 — Reversal / Reconciliation Hardening**. It does not
implement anything, does not touch production, and does not begin **5C.7 — Full
Multi-Member End-to-End Validation**.

## 1. Baseline

- Branch: `claude/milestone-3-personal-savings-mvp`
- HEAD: `84af82a54503dd2003091e4029a894d204c2d25e`
- Local HEAD == origin HEAD: confirmed
- Working tree: clean except this document

## 2. Documents and source reviewed

Same as the three prior revisions. This pass is a pure architecture refinement of the
already-audited design — no new source files were read, since the correction is about
the *shape* of the new tool's own concurrency control, not about re-verifying existing
callables/domain files already confirmed in prior passes.

---

## 3. Frozen current state machine

Unchanged — see §3 of the original audit.

## 4. FROZEN: recovery-tool architecture

Unchanged: a separate tool, `functions/src/admin/reconcileTripOwnership.ts`, never an
extension of `migrateTripOwnership.ts`.

## 5. FROZEN: the replay / authoritative-allocation contract

Unchanged from the prior revision — `tripOwnershipMigrationReplay.ts` stays completely
untouched; reconciliation performs independent reconstruction via its unchanged
`buildLogicalEvents`/`orderLogicalEvents`/`replayLogicalEvents`, then separately compares
the result against the complete persisted allocation set, exactly as frozen previously.

## 6. FROZEN: both allocation provenances are in scope

Unchanged — `"original"` and `"migrated"` are both immutable, both validated, neither
ever rewritten or recreated.

## 7. FROZEN: zero-ownership-row semantics

Unchanged — a legitimate zero-balance row is retained, never deleted; only a row with no
supporting replay history at all is a deletable rogue row.

---

## 8. CORRECTED: concurrency control — a canonical control document, not a query

**The defect being fixed**: the prior revision's acquisition contract was "query every
attempt document for this Trip; if none are active, create a new one." A query result of
"zero rows" is not itself a lock — two concurrent transactions can each independently
observe zero active attempts and each proceed to create its own new attempt document,
because they are reading from (and writing to) *different* document ids
(`{tripId}_{attemptId}`, a fresh random id each time). This does not give reconciliation
the same single, deterministic per-Trip contention point `migrateTripOwnership.ts`
already gets for free from its own fixed-id `tripOwnershipMigrationState/{tripId}`
document, where two concurrent transactions are *forced* to contend on the exact same
document and Firestore's own transaction semantics resolve the race.

**Fix: a second, new, fixed-id collection exists purely to serialize attempts — it is
never the audit history itself.**

**`tripOwnershipReconciliationControl/{tripId}`** — exactly one document per Trip,
mutable coordination state (unlike the permanent, append-only
`tripOwnershipReconciliationAttempts` records):
```
tripId
activeAttemptId:          string | null
lastCompletedAttemptId:   string | null
updatedAt:                Timestamp
```
Strictly validated (fail closed on any malformed shape, same discipline every other
trusted-state document in this codebase already applies).

**`tripOwnershipReconciliationAttempts/{tripId}_{attemptId}` is kept exactly as frozen in
the prior revision** — the permanent, immutable, multi-attempt audit history. The
control document and the attempt-history collection are two distinct responsibilities: the
control document says *which attempt (if any) is currently active*; the attempt
collection permanently records *every attempt that was ever made*, succeeded or failed.

---

## 9. FROZEN: control-document acquisition contract

Every `apply`-mode reconciliation start uses **one transaction** that reads both
`trips/{tripId}` and `tripOwnershipReconciliationControl/{tripId}` — because every
concurrent starter is forced to read and write the *same* control document, there is
exactly one deterministic contention point per Trip.

**Fresh case** (control document does not exist): the same transaction must also prove
there are **zero** `tripOwnershipReconciliationAttempts` documents for this Trip — control
absence alone is not sufficient, because the control document becomes permanent
coordination state once first created, and a missing control alongside existing attempt
history means that state was deleted or corrupted out-of-band, never a genuine first-ever
reconciliation. This attempt-history read is a pure integrity check, never a concurrency
lock — the fixed-id control document (§8) remains the sole serialization point. Only when
both hold — control absent **and** attempt-history count is zero — is this the valid
first-ever reconciliation start for the Trip: the Trip must be `needs_reconciliation` at
the supported version; create a fresh random `attemptId`; create the attempt document
(`phase: "locked"`, …); create the control document with `activeAttemptId: attemptId`,
`lastCompletedAttemptId: null` — all in the same transaction.

If the control document is absent **but** one or more attempt-history documents exist for
the Trip, acquisition fails closed with anomaly code **`missing_reconciliation_control`**
— coordination state is treated as corrupted, never silently recreated.

**Existing control, no active attempt** (`activeAttemptId === null`, Trip still
`needs_reconciliation`): create a fresh attempt document; update the *same* control
document's `activeAttemptId` to the new id — still one transaction.

**Existing active attempt** (`activeAttemptId !== null`): read that exact attempt
document, validate it strictly; if it is a valid, non-terminal attempt, resume it; **a
second active attempt is never created.**

**`lastCompletedAttemptId` referential integrity** (checked whenever the control document
exists and `lastCompletedAttemptId !== null`): the referenced attempt document must exist,
must belong to the same `tripId`, must have the exact referenced `attemptId`, must have
`phase === "completed"`, and must have a valid completed-phase shape. `lastCompletedAttemptId
=== null` is valid whenever the Trip has never yet completed a reconciliation — including a
history containing only failed attempts; it is never required to point at the most recent
failed attempt, since failed attempts remain permanently available through the attempt
collection itself, not through this pointer.

**Impossible/corrupted control pairings fail closed, never self-healed**:
`activeAttemptId` points to a missing attempt document; `activeAttemptId` points to an
already-terminal attempt (either `"completed"` or `"failed"`); `activeAttemptId` equals
`lastCompletedAttemptId`; `lastCompletedAttemptId` points to anything other than a valid
`"completed"` attempt (missing, active, failed, or malformed); `tripId` mismatches between
the control document and any attempt it names; the control document's own shape is
malformed; a referenced attempt's own shape is malformed; the control document claims an
active repair while the Trip itself is not `needs_reconciliation`; the control document is
absent while attempt-history exists (`missing_reconciliation_control`, above). Every one of
these is reported as a control-state anomaly requiring manual review — never silently
repaired by this acquisition logic itself.

---

## 10. CORRECTED: attempt phase model — adding a terminal `"failed"` phase

The three-phase model (`"locked"` / `"reconstructed"` / `"completed"`) cannot represent a
failed attempt without either overwriting that attempt's own evidence or leaving the Trip
permanently stuck. Corrected:

```
phase: "locked" | "reconstructed" | "completed" | "failed"
```
`"completed"` and `"failed"` are both **terminal** — neither is ever reused, resumed, or
overwritten.

For `phase === "failed"`: `failedAt: Timestamp` is required; `failureReasonCode: string`
(non-empty) is required; `failureDetail` (a free-text string) is **optional** — it may be
present or absent, consistent with `migrateTripOwnership.ts`'s own
`MigrationAuditResult.anomalies[].detail` style.

For every other phase: `failedAt`, `failureReasonCode`, and `failureDetail` are all
**forbidden** (the same strict required/forbidden-per-phase discipline
`validateMigrationStateShape` already applies to migration's own document).

`"completed"` requires `completedAt`, and explicitly forbids every failure-only field
(`failedAt`/`failureReasonCode`/`failureDetail`) — the two terminal shapes are mutually
exclusive, never both present.

---

## 11. FROZEN: failure / retry control semantics

When an active `apply` attempt encounters a terminal failure — its own frozen evidence
can no longer safely be completed (examples: authoritative-history/allocation corruption
discovered at reconstruction; a stale source-history digest, stale allocation digest, or
mismatched reconstruction target discovered at finalization; materialization that cannot
be proven to equal the frozen target) — the attempt is preserved, never discarded:
- The attempt document is written to `phase: "failed"` with `failedAt`/
  `failureReasonCode` (and `failureDetail` if used).
- In the **same transaction**, the control document's `activeAttemptId` is atomically
  cleared to `null`.
- The Trip remains `needs_reconciliation`. No financial history, allocation record, or
  ownership row is rewritten by a failed attempt.

A later operator run — after whatever caused the failure has been independently
corrected — then creates a **brand-new** attempt (§9's "no active attempt" case), because
the control document's `activeAttemptId` is now `null` again. The prior failed attempt's
record remains permanently auditable, exactly like a completed one, and is never
overwritten or reused.

**Dry-run writes nothing** under any circumstance, and therefore creates **no** attempt
document and **no** control document — this is unchanged from the general principle that
dry-run never has any persisted side effect.

---

## 12. CORRECTED: finalization must also own the control document

Finalization's own re-verification set (§13 of the prior revision, carried forward)
gains one more required read and one more required proof, and its atomic write set gains
the matching control-document update:

**Before any finalization write**, finalization additionally reads and validates
`tripOwnershipReconciliationControl/{tripId}` and requires
**`control.activeAttemptId === <this attempt's own attemptId>`** — proving no other
attempt has since superseded this one. Any mismatch aborts finalization with no write at
all (the same "re-verify everything fresh, inside the one commit transaction" standard
`finalizeMigration` already applies, extended to cover this new document too).

**On successful finalization, atomically** (one transaction, as before): write the
repaired `Trip.ledgerBalanceMinor`/`Trip.saved`; transition
`ownershipModelState: needs_reconciliation -> initialized`, retaining the identical
version; mark the current attempt `phase: "completed"`, `completedAt`; **and** update the
control document: `activeAttemptId: null`, `lastCompletedAttemptId: <this attemptId>`,
`updatedAt`. **No prior attempt document is ever touched** — this guarantees a later,
independent reconciliation episode can occur without erasing or rewriting the record of
this one.

---

## 13. CORRECTED: finalization must re-prove the locked financial basis

The attempt document already freezes `lockedFinancialBasis` at `"locked"` time, but the
prior revision's finalization checklist never explicitly re-proved it. Corrected:
**before finalization may write the repaired aggregate**, it freshly re-derives the
Trip's current financial basis (the same canonical shape/derivation migration's own
`buildLockedFinancialBasis` already uses) and proves it still matches the locked value —
proving no unexpected Trip-level financial/currency-basis change occurred between
acquisition and finalization. This check is named **`lockedFinancialBasisMatches`** in
the finalization evidence result, mirroring `finalizeMigration`'s own identically-named
evidence field exactly. As with every other evidence field in this model, **no success
may ever be inferred for a check that was not reached** — an early failure leaves this
field `null`/unset, never a fabricated `true`.

Finalization's complete re-verification set, in order, is therefore: Trip is still
`needs_reconciliation` at the supported version; the reconciliation attempt is still
valid and not already terminal; **`lockedFinancialBasisMatches`** (this section);
`sourceHistoryDigestMatches`; `validatedAllocationDigestMatches`; `exactOwnershipOutputMatches`;
the independently re-derived aggregate equals `Σ(expected ownership)`; and
**`control.activeAttemptId` still equals this attempt's own id** (§12). Only once every
one of these passes does the atomic write in §12 occur.

---

## 14. CORRECTED: `lastUpdatedAt` / `lastUpdatedBy` — neither is touched

The prior revision froze "write `lastUpdatedAt`, leave `lastUpdatedBy` unchanged." On
reflection this is corrected: writing a fresh `lastUpdatedAt` timestamp while leaving a
stale, unrelated human `lastUpdatedBy` uid in place creates a misleading pair — it reads
as if that uid just acted on the Trip, when in fact a trusted Admin-SDK tool did.

**Direct precedent, unchanged from the earlier confirmation**: `migrateTripOwnership.ts`'s
own finalization write to the Trip document touches **neither** field at all.

**Frozen: reconciliation's finalization leaves both `Trip.lastUpdatedAt` and
`Trip.lastUpdatedBy` completely unchanged.** No synthetic/invented system-actor uid is
ever written — this repository has no such convention and none is introduced for this
milestone. Full attribution for *why* and *when* a repair happened — or failed — lives
entirely in the reconciliation-attempt record: `attemptId`, `startedAt`, `completedAt` /
`failedAt` + `failureReasonCode` as appropriate.

---

## 15. FROZEN: automatic-repair history size limit

Unchanged: `AUTOMATIC_RECONCILIATION_HISTORY_LIMIT = 2000`, its own independently-declared
constant, reusing migration's already-proven value with no conflict found.

## 16. FROZEN: admin-tool execution-target safety guard

Unchanged: the new tool implements its own independent guard (dry-run default, emulator
detection, exact production project + confirm-echo for apply, no implicit fallback),
never sharing code with `migrateTripOwnership.ts`.

## 17. FROZEN: Rules consequence — both collections

Two trusted-only collections now require an explicit closed block each, consistent with
this Rules file's own established convention (confirmed: no generic catch-all deny block
exists; every trusted-only collection gets its own explicit block):
```
match /tripOwnershipReconciliationAttempts/{attemptId} {
  allow get, list: if false;
  allow create, update, delete: if false;
}
match /tripOwnershipReconciliationControl/{tripId} {
  allow get, list: if false;
  allow create, update, delete: if false;
}
```
Two new Rules test files: `tests/firestore-rules/tripOwnershipReconciliationAttempts.rules.test.js`
and `tests/firestore-rules/tripOwnershipReconciliationControl.rules.test.js`, mirroring
the existing `tripOwnershipMigrationState.rules.test.js` template. Not edited in this
pass — frozen for the implementation phase only.

## 18. Explicit 5C.7 deferrals

Unchanged.

## 19. Proposed emulator test architecture

Unchanged recommendation — see §20's exact file list for the control-document additions
folded in.

---

## 20. Exact future implementation file scope (no file in two categories)

**MODIFY:**
```
functions/src/callables/recordSavingsTransaction.ts
functions/test/recordSavingsTransactionOwnership.ts
firestore.rules
package.json
tests/integration/helpers/ownershipInspection.ts
```

**ADD:**
```
functions/src/admin/reconcileTripOwnership.ts
functions/test/reconcileTripOwnership.ts
functions/src/domain/tripOwnershipReconciliationAttempt.ts
functions/test/tripOwnershipReconciliationAttempt.ts
functions/src/domain/tripOwnershipReconciliationControl.ts
functions/test/tripOwnershipReconciliationControl.ts
tests/firestore-rules/tripOwnershipReconciliationAttempts.rules.test.js
tests/firestore-rules/tripOwnershipReconciliationControl.rules.test.js
jest.reconciliation-integration.config.js
tests/integration/helpers/reconciliationSequencer.js
tests/integration/runMultiMemberReconciliationIntegration.cjs
tests/integration/helpers/reconciliationFixtures.ts
tests/integration/reconciliationHardening.emulator.test.ts
tests/integration/sharedStashReversalHardening.emulator.test.ts
tests/integration/nonOwnershipReversalRegression.emulator.test.ts
tests/integration/reconciliationRecovery.emulator.test.ts
tests/integration/zzz_5c6_summary.emulator.test.ts
```
`tripOwnershipReconciliationControl.ts` (+ test) is a **new, separate** domain file from
`tripOwnershipReconciliationAttempt.ts` (+ test) — attempt history and concurrency
control are distinct responsibilities (§8), each owning its own type, strict validator,
and canonical document-id helper.

**REUSE UNCHANGED:**
```
functions/src/callables/recordSharedStashExpense.ts
functions/src/callables/reverseSharedStashExpense.ts
functions/src/callables/reverseTripExpense.ts
functions/src/callables/reverseTripSettlement.ts
functions/src/admin/migrateTripOwnership.ts
functions/src/domain/tripOwnershipModel.ts
functions/src/domain/tripOwnershipAccounting.ts
functions/src/domain/tripOwnershipAllocation.ts
functions/src/domain/tripMemberOwnership.ts
functions/src/domain/savingsLedger.ts
functions/src/domain/tripOwnershipMigrationState.ts
functions/src/domain/tripOwnershipMigrationDigest.ts
functions/src/domain/tripOwnershipMigrationReplay.ts
functions/test/recordSharedStashExpenseCore.ts
functions/test/recordSharedStashExpenseOwnership.ts
functions/test/reverseSharedStashExpenseCore.ts
functions/test/reverseSharedStashExpenseOwnership.ts
functions/test/reverseTripExpenseCore.ts
functions/test/reverseTripSettlementCore.ts
functions/test/tripOwnershipAllocation.ts
functions/test/tripOwnershipAccounting.ts
functions/test/tripOwnershipModel.ts
functions/test/migrateTripOwnership.ts
functions/test/migrateTripOwnershipPostMigrationCompatibility.ts
functions/test/tripOwnershipMigrationDigest.ts
functions/test/tripOwnershipMigrationReplay.ts
functions/test/tripOwnershipMigrationState.ts
jest.integration.config.js
jest.financial-integration.config.js
tests/integration/helpers/firebaseIntegrationTestEnv.ts
tests/integration/helpers/fixtures.ts
tests/integration/helpers/trustedInspection.ts
tests/integration/helpers/assertions.ts
tests/integration/helpers/jestSetup.js
tests/integration/helpers/sequencer.js
tests/integration/helpers/financialSequencer.js
tests/integration/helpers/financialFixtures.ts
tests/integration/runTripInvitationIntegration.cjs
tests/integration/runMultiMemberFinancialIntegration.cjs
every existing 5C.3D-B and 5C.4/5C.5 test file
```

**NO EXPECTED CHANGE:**
```
app/**
src/**
every existing callable not named above
```

---

## 21. Revised 5C.6 PASS checklist

**A–C** (reconciliation hardening on `recordSavingsTransaction`, Shared-Stash reversal
regression, non-ownership reversal regression) — unchanged from the prior revision.

**D. Recovery / finalization** (corrected/expanded this pass — the concurrency claim is
replaced, not merely appended to):
- Replaces the prior revision's concurrency criterion entirely: **two concurrent fresh
  `apply` starts for the same Trip must contend through the exact same canonical
  `tripOwnershipReconciliationControl/{tripId}` document** — exactly one `activeAttemptId`
  ever exists at a time; neither caller independently creates a second live attempt; the
  losing/retried caller resolves by observing and resuming the already-active attempt,
  never by creating another one. (The prior claim that a zero-result attempt-history
  query alone serializes concurrent starts is explicitly withdrawn as incorrect.)
- Malformed control document → fail closed.
- `activeAttemptId` pointing to a missing attempt → fail closed.
- `activeAttemptId` pointing to an already-terminal attempt → fail closed.
- Control absent and zero attempt-history documents exist for the Trip → valid first-ever
  attempt creation.
- Control absent but one or more attempt-history documents exist for the Trip → fail
  closed (`missing_reconciliation_control`).
- `lastCompletedAttemptId` referencing a valid `"completed"` attempt → accepted.
- `lastCompletedAttemptId` referencing a missing attempt → fail closed.
- `lastCompletedAttemptId` referencing a failed attempt → fail closed.
- `lastCompletedAttemptId` referencing an active (non-terminal) attempt → fail closed.
- `activeAttemptId` equal to `lastCompletedAttemptId` → fail closed.
- Successful finalization clears `activeAttemptId`, sets `lastCompletedAttemptId`, and
  leaves every prior attempt record untouched.
- A later, independent drift episode creates a brand-new attempt.
- A failed attempt is permanently retained, exactly as a completed one is.
- After a failed attempt's `activeAttemptId` is cleared, a later run may create a new
  attempt (the underlying issue having been independently resolved).
- Every materialization chunk re-proves `control.activeAttemptId` still equals the
  current attempt's id before writing any derived ownership row — a stale/superseded
  attempt can never continue materializing.
- Finalization re-proves `lockedFinancialBasisMatches` before writing the repaired
  aggregate, with no success ever inferred for an unreached check.
- Native/migrated/mixed-provenance repair, missing/corrupt-evidence-of-either-provenance,
  replay disagreement, zero-row retention, rogue-row removal, history-limit refusal,
  dry-run-writes-nothing, execution-target guard tests, archived-Trip repair, and
  `migrateTripOwnership.ts`'s continued refusal of `needs_reconciliation` — all unchanged
  from the prior revision.

**E–G** (idempotency/retry, corrupted-evidence fail-closed behavior, zero-partial-
mutation matrix) — unchanged.

A distinct `"5C.6: PASS"` banner, never combined with `"5C.4: PASS"`/`"5C.5: PASS"`.

---

## 22. Blockers / open questions

**None.** The concurrency defect is fixed with a genuine, deterministic fixed-id
contention point; the phase model now correctly represents a failed-but-auditable
attempt without blocking future repair; finalization's control-document and
locked-financial-basis checks close the two remaining gaps in its own re-verification
set; and the `lastUpdatedAt`/`lastUpdatedBy` policy now matches `migrateTripOwnership.ts`'s
own precedent exactly, with no invented convention.

## 23. GO / STOP recommendation

**GO.** The concurrency model is now genuinely safe (a real fixed-id lock, not a query
result), every terminal outcome (completed or failed) is permanently auditable without
blocking future repair, finalization's re-verification set is complete, and no file
appears in more than one scope category. 5C.6 is ready to be scoped into an
implementation pass once separately authorized.

---

## 24. Status

PREFLIGHT / ARCHITECTURE ONLY. Not implemented. Not committed.

## 25. Carried forward unchanged from prior revisions

- The corrupted-allocation lifecycle-state decision (§12 of the second revision).
- The zero-partial-mutation four-category matrix.
- The archived-Trip reconciliation finding (allowed, no special-casing).
- The contribution-reversal wording correction (documented absence, nothing built).
- The replay/allocation independent-validation contract (§5 above).
- Both-provenance support (§6 above).
- Zero-row retention (§7 above).

## 26. Revision log (this pass)

1. **Concurrency defect fixed** (§8/§9): a canonical, fixed-id
   `tripOwnershipReconciliationControl/{tripId}` document replaces the query-based "zero
   active attempts" check as the actual serialization point.
2. **Attempt phase model gains `"failed"`** (§10), terminal, with
   `failedAt`/`failureReasonCode` (+ optional `failureDetail`), mutually exclusive with
   `"completed"`'s own fields.
3. **Failure/retry semantics frozen** (§11): a terminal failure preserves its attempt
   record and atomically clears the control document's active pointer, freeing the Trip
   for a later, independent attempt without rewriting any financial history.
4. **Finalization now also owns the control document** (§12): requires
   `control.activeAttemptId === this attempt's id` before any write; on success, clears
   the pointer and records `lastCompletedAttemptId`; never touches a prior attempt.
5. **Finalization now explicitly re-proves `lockedFinancialBasisMatches`** (§13), named
   identically to migration's own equivalent evidence field.
6. **`lastUpdatedAt`/`lastUpdatedBy` policy reversed** (§14): neither field is touched by
   reconciliation finalization, matching `migrateTripOwnership.ts`'s own precedent
   exactly — the prior revision's "write `lastUpdatedAt` only" decision is withdrawn.
7. **New domain file added** (§20): `tripOwnershipReconciliationControl.ts` (+ test),
   kept separate from `tripOwnershipReconciliationAttempt.ts` (+ test).
8. **Rules/test scope expanded** (§17/§20) to close both new collections.
9. **PASS criteria's concurrency claim replaced, not merely appended to** (§21) — the
   incorrect "query alone serializes" claim is explicitly withdrawn.

## 27. Revision log (cleanup pass)

10. **Migration collection name typo fixed** (§8): the incorrect migration-state
    collection name is corrected to the actual `tripOwnershipMigrationState` collection.
11. **"Control missing" hardened against existing attempt history** (§9): first-ever
    acquisition now also proves zero `tripOwnershipReconciliationAttempts` documents exist
    for the Trip; control absent with existing history fails closed as
    `missing_reconciliation_control` rather than being treated as a fresh start.
12. **`lastCompletedAttemptId` given an explicit referential-integrity contract** (§9): must
    resolve to an existing, same-Trip, exact-id, valid `"completed"` attempt; `null` is
    valid whenever no reconciliation has yet succeeded, including a history of only failed
    attempts.
13. **Control-pairing invariants expanded** (§9): added `activeAttemptId` equal to
    `lastCompletedAttemptId`, and `lastCompletedAttemptId` pointing to anything other than a
    completed attempt, to the existing fail-closed list.
14. **`failureDetail` wording disambiguated** (§10): restated as unconditionally optional
    for `phase === "failed"` and forbidden for every other phase — removing the earlier
    "required exactly when failed" phrasing that could be misread as mandatory.
15. **PASS criteria extended** (§21) to cover the first-ever-start history check and every
    new `lastCompletedAttemptId`/`activeAttemptId` pairing invariant.

**Nothing beyond this document was created or modified.**
