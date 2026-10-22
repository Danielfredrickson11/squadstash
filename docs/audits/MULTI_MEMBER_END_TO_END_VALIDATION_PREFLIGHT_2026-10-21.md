# Multi-Member Full End-to-End Validation — Preflight

**Status: PREFLIGHT / VALIDATION ARCHITECTURE ONLY. Not implemented. Not committed.**

**Revision note (this pass):** this revision corrects a hidden-id contradiction in the
original draft (the financial replay strategy named `contributeReal`/`withdrawReal`/
`spendSharedStashReal` — helpers that generate their own `clientRequestId` internally —
as the vehicle for *exact-same-request* idempotent replay, which those helpers cannot
perform), makes the membership-acceptance and initial-zero-allocation checks executable
with concrete, named query strategies, promotes the zero-`tripExpenseSplits` check from
optional to mandatory, and adds explicit `ownershipModelVersion`/deterministic-transaction-
id/exact-linkage/replay/rejection/regression-command/stability-run requirements. See the
revision log at the bottom for the full list.

This document prepares **5C.7 — Full Multi-Member End-to-End Validation**. It does not
implement anything, does not touch production, and does not modify any production
source, Rules, or existing test/harness file.

5C.4, 5C.5, and 5C.6 are complete and committed (`160e32b6e5176fdf7e74a7c249cfa0c10db17bc7`).
5C.7's job is narrower than any of them: prove that the already-completed multi-member
financial architecture behaves correctly as **one continuous healthy lifecycle**, using
real local emulators and real production code paths throughout. It introduces no new
product behavior.

## 1. Baseline

- Branch: `claude/milestone-3-personal-savings-mvp`
- HEAD: `160e32b6e5176fdf7e74a7c249cfa0c10db17bc7`
- Local HEAD == origin HEAD: confirmed
- Working tree: clean except this document

## 2. Documents and source inspected

**Read in full:**
- `docs/audits/MULTI_MEMBER_SPENDING_WITHDRAWAL_PREFLIGHT_2026-10-20.md` — the frozen
  5C.4/5C.5 architecture, including its own §18/§28 reference backbone (the exact chain
  this checkpoint now owns) and its exact callable contracts/invariants (§3-§17).
- `docs/audits/MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md` — the frozen
  5C.6 architecture (reconciliation admin tool, control/attempt model, Rules closure).

**Inspected (committed test/harness sources, read-only):**
- `tests/integration/helpers/financialFixtures.ts` — `createAcceptedTwoMemberTrip` is
  reused unchanged for real membership setup only. `contributeReal`/`withdrawReal`/
  `spendSharedStashReal` are **not** reused for the chain's financial operations — each
  one internally calls `generateSavingsClientRequestId()`/`generateExpenseClientRequestId()`
  itself, so the caller never has access to the exact `clientRequestId` it used, which
  makes exact-same-request idempotent replay impossible through them. (Corrected this
  pass — see the revision note.)
- `src/services/firebase/savingsTransactions.ts` — confirmed
  `recordSavingsTransaction(input)` (the real client wrapper) and
  `generateSavingsClientRequestId()` are both directly exported and usable from a test
  file with no wrapper of their own.
- `src/services/firebase/expenses.ts` — confirmed `recordSharedStashExpense(input)` and
  `generateExpenseClientRequestId()` are both directly exported, and
  `fetchExpenseSplitsForExpense(tripId, expenseId)` is an existing, real,
  client-readable function (not a trusted-only collection).
- `tests/integration/helpers/trustedInspection.ts` — confirmed exported:
  `getTrustedInspectionEnv`, `inspectTrip`, `inspectInvitation`, `inspectAcceptance`,
  `countAcceptancesFor`, `ownershipRowExists`. `inspectAcceptance` takes a known
  acceptance-document id (not usable without deriving that composite id); `countAcceptancesFor(tripId, uid)`
  returns only a count, not the full document fields the chain needs to verify
  (`termsDocId`/`acceptedTermsVersion`/`acceptedAt`). Neither is sufficient alone for
  §10's acceptance-evidence check below — the exact LOCAL query strategy (§10) uses
  `getTrustedInspectionEnv` directly, exactly as the checkpoint itself specifies, adding
  no new export to this file.
- `tests/integration/helpers/ownershipInspection.ts` — confirmed every read-only
  inspection primitive 5C.7 needs already exists: `inspectOwnership`,
  `inspectAllOwnershipRows`, `inspectOwnershipBalancesForTrip`, `inspectExpense`,
  `inspectSavingsTransaction`, `inspectAllocation`, `findSavingsTransactionsLinkedToExpense`,
  `findOwnershipAllocationsForExpense`. (Its remaining exports —
  `setTripOwnershipModelState`, `setTripArchived`, `setTripLedgerBalanceDrift`, the
  reconciliation-attempt/control inspectors, `deleteOwnershipRow`,
  `createRogueOwnershipRow`, `corruptOwnershipAllocationAmount` — are all corruption/
  drift-only helpers 5C.7's healthy chain has no legitimate reason to call.) No
  dedicated reader exists for `tripOwnershipAllocations` *count-only* queries (the
  initial zero-allocation check) — §10 below freezes a LOCAL query using
  `getTrustedInspectionEnv` directly, exactly as the checkpoint specifies, rather than
  adding a new export here.
- `tests/integration/helpers/reconciliationFixtures.ts` — re-exports
  `financialFixtures.ts`'s real-callable helpers unchanged; its own additions
  (`runReconcileCli`, `runMigrationCli`, every `*Real` corruption helper) are
  5C.6-specific and not needed by, and not imported by, a healthy-chain scenario.
- `tests/integration/sharedStashSpending.emulator.test.ts`, `ownershipWithdrawal.emulator.test.ts`
  (5C.4/5C.5) and `reconciliationHardening.emulator.test.ts`, `reconciliationRecovery.emulator.test.ts`
  (5C.6) — confirmed the exact fixture/assertion idioms (trusted inspection after every
  real callable call, `signInAs` role-switching, exact-object assertions, local
  `captureFinancialSnapshot`-style helpers) this checkpoint reuses rather than reinvents.

No repository file other than this preflight document was edited. No production
system was accessed.

---

## 3. No-new-product-behavior boundary

**Determination: NO production code change is required for 5C.7.**

Every callable, domain primitive, and state-machine rule the chained scenario below
depends on — Trip creation already `"initialized"`, real invitation/acceptance,
lazy ownership-row creation, proportional Shared-Stash depletion with exact integer
division, the personal withdrawal ceiling, the aggregate invariant — is already
implemented and already unit/Core-tested, confirmed directly against source in this
pass and in the two documents read in full (§2). 5C.7 is a wiring/E2E proof against a
stable, frozen backend, exactly as the 5C.4/5C.5 preflight's own §18/§28 anticipated.

**Frozen — NO EXPECTED CHANGE:**
```
functions/src/**
firestore.rules
app/**
src/**
```
If implementation later reveals a genuine missing capability, that is a STOP condition
for the implementation pass, not a reason to silently expand 5C.7's own scope.

---

## 4. Central chained lifecycle (frozen, verbatim from the 5C.4/5C.5 preflight's §18/§28)

```
A. owner creates Trip (ownershipModelState: "initialized" immediately)
B. member accepted via real invitation flow -> memberIds includes member; no ownership row yet
C. owner contributes 7000
D. member contributes 3000 (lazy row creation)
E. assert owner=7000, member=3000, aggregate=10000
F. pooled Shared Stash expense of 2500 (divides evenly)
G. assert owner=5250, member=2250, aggregate=7500
H. member personal withdrawal of 1000
I. assert owner=5250, member=1250, aggregate=6500
```
This exact chain is the central 5C.7 scenario. Every intermediate number was already
independently re-derived against the real algorithms in the 5C.4/5C.5 preflight (§7/§12
of that document) — this preflight does not re-derive them again, only re-confirms they
remain correct against the now-committed 5C.6 code (which never altered any of these
primitives — confirmed in §20 of the 5C.6 preflight: `tripOwnershipAccounting.ts`,
`tripOwnershipModel.ts`, `tripMemberOwnership.ts` are all in that document's own
**REUSE UNCHANGED** list).

## 5. Real membership setup contract

The chain uses the already-proven real sequence, exactly as 5C.4/5C.5/5C.6 already do —
**no manual seeding of `memberIds`, membership-acceptance evidence, terms acceptance, or
ownership rows**:

```
owner: createAndSignInUser -> createRealTrip -> publishRealTerms -> createRealInvitation
member: createAndSignInUser -> signInAs -> acceptTripInvitation
```
via `createAcceptedTwoMemberTrip` (`financialFixtures.ts`, reused unchanged — **this is
the only `financialFixtures.ts` helper the chain uses**; see §7-§9 for why every
financial operation instead calls the real client wrapper directly). Immediately after
this resolves:
- member's uid is present in `Trip.memberIds`
- member has **zero economic ownership** — genuinely no `tripMemberOwnership` row (not a
  row at `0`) — confirmed by `createAcceptedTwoMemberTrip`'s own documented behavior and
  independently re-confirmed by `acceptTripInvitation`'s write set (membership-acceptance
  and `trips.memberIds` only, never `tripMemberOwnership`)
- no ownership row is ever fabricated by this preflight's test design

## 6. Initial Trip-state contract

Before any financial activity, require (via trusted inspection, read-only):
```
ownershipModelState == "initialized"
ownershipModelVersion == 1
ledgerBalanceMinor == 0
saved == 0
zero tripMemberOwnership rows for this Trip
zero tripOwnershipAllocations records for this Trip
```
`ownershipModelVersion == 1` is frozen as the exact literal value (matching
`CURRENT_TRIP_OWNERSHIP_MODEL_VERSION` in `functions/src/domain/tripOwnershipModel.ts`)
rather than an imported constant — this is a deliberate, intentional schema-regression
assertion: the root integration test does not import Functions domain source (a separate
compiled TypeScript project with no shared import path, exactly as every other
cross-package field in this codebase is already duplicated-by-value rather than
cross-imported), and a future bump of the real constant without a corresponding,
deliberate update to this literal is exactly the kind of drift this assertion exists to
catch.

This holds trivially for a Trip created via the real `createTrip` callable — confirmed
directly: `createTrip.ts` sets `ownershipModelState: "initialized"` /
`ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION` (`== 1` today) at creation
time, with no legacy history. **No migration fixture of any kind is used for the central
chain** — the legacy→initialized migration path was already exhaustively proven in
5C.6's own `migrateTripOwnership` test suite and its real-migration-CLI integration tests
(`reconciliationRecovery.emulator.test.ts`), and re-exercising it here would duplicate
already-frozen evidence rather than add new proof value.

**Zero-allocation check, made executable (corrected this pass):** a LOCAL helper inside
the new `multiMemberLifecycle.emulator.test.ts`, using `getTrustedInspectionEnv`
directly (no change to `trustedInspection.ts` or `ownershipInspection.ts`):
```ts
async function countAllocationsForTrip(tripId: string): Promise<number> {
  const env = await getTrustedInspectionEnv();
  let size = 0;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore()
      .collection("tripOwnershipAllocations")
      .where("tripId", "==", tripId)
      .get();
    size = snap.size;
  });
  return size;
}
```
Required `== 0` before any financial activity. After the Shared-Stash spend (§8), the
already-existing `inspectAllocation`/`findOwnershipAllocationsForExpense`
(`ownershipInspection.ts`) are used for the exact single-record evidence/linkage check —
this local helper is used only for the *count* check, both before (`0`) and, as part of
the replay proof (§13), immediately after the Shared-Stash spend replay (still `1`, never
`2`).

## 7. Contribution-phase checkpoints (financial-wrapper strategy corrected this pass)

**Corrected strategy:** the chain calls the real `recordSavingsTransaction` client
wrapper (`src/services/firebase/savingsTransactions.ts`) **directly** — never
`contributeReal` — generating each request's `clientRequestId` explicitly in the test
with `generateSavingsClientRequestId()` and retaining the complete request object, so it
can be replayed byte-for-byte unchanged later (§13). No Core function is ever called
directly, and no financial document is ever written directly to Firestore by the test —
every write still goes through the real callable via the real client wrapper.

```ts
const ownerContributionRequestId = generateSavingsClientRequestId();
const ownerContributionRequest = {
  resourceType: "trip" as const, resourceId: tripId, memberUid: owner.uid,
  type: "contribution" as const, amountMinor: 7000, currency: "USD",
  clientRequestId: ownerContributionRequestId,
};
const ownerContributionResult = await recordSavingsTransaction(ownerContributionRequest);
// ... signInAs(member.email) ...
const memberContributionRequestId = generateSavingsClientRequestId();
const memberContributionRequest = {
  resourceType: "trip" as const, resourceId: tripId, memberUid: member.uid,
  type: "contribution" as const, amountMinor: 3000, currency: "USD",
  clientRequestId: memberContributionRequestId,
};
const memberContributionResult = await recordSavingsTransaction(memberContributionRequest);
```

After BOTH commits, require (trusted inspection):
- `Trip.ledgerBalanceMinor == 10000`
- `Trip.saved == 100`
- owner `tripMemberOwnership` row exists, `ownershipMinor == 7000`
- member `tripMemberOwnership` row exists, `ownershipMinor == 3000` (lazily created by
  this exact contribution — the first write of any kind to this uid's ownership row)
- `sum(ownershipMinor) == 10000 == Trip.ledgerBalanceMinor`
- both `ownershipMinor` values are non-negative safe integers
- **deterministic transaction-id evidence (corrected this pass):**
  `ownerContributionResult.transactionId === ownerContributionRequestId` and
  `memberContributionResult.transactionId === memberContributionRequestId` — then
  `inspectSavingsTransaction(ownerContributionRequestId)`/
  `inspectSavingsTransaction(memberContributionRequestId)` each return the exact
  persisted document (`resourceType: "trip"`, `resourceId: tripId`, the correct
  `memberUid`/`recordedBy`, `type: "contribution"`, the correct `amountMinor`)
- `ownershipModelState` remains `"initialized"`, `ownershipModelVersion` remains `1`
- `countAllocationsForTrip(tripId) == 0` (no Shared-Stash activity has occurred yet)

## 8. Shared-Stash spend-phase checkpoint (financial-wrapper strategy corrected this pass)

One real Shared-Stash Expense via the real `recordSharedStashExpense` client wrapper
(`src/services/firebase/expenses.ts`) called **directly** — never `spendSharedStashReal`
— with an explicit `clientRequestId` from `generateExpenseClientRequestId()`, the
complete request object retained for replay (§13):
```ts
const sharedStashRequestId = generateExpenseClientRequestId();
const sharedStashRequest = {
  tripId, amountMinor: 2500, currency: "USD" as const,
  description: "5C.7 pooled Shared Stash spend", clientRequestId: sharedStashRequestId,
};
const sharedStashResult = await recordSharedStashExpense(sharedStashRequest);
// sharedStashResult: { expenseId: string; sharedStashTransactionId: string }
```
This exact ratio (7000:3000 against 2500) divides evenly — confirmed in the 5C.4/5C.5
preflight's own §7 — so **no largest-remainder tie-break is exercised by the central
chain**; the tie-break rule itself was already separately, exhaustively proven at the
Core/unit level (`tripOwnershipAccounting.ts`) and at the 5C.4 emulator level
(`sharedStashSpending.emulator.test.ts`'s own dedicated tie-break fixture, read in §2) —
5C.7 does not re-derive or re-prove that rule.

Frozen exact expected economics:
```
pre-spend ownership:  owner 7000, member 3000
depletion:             owner 1750, member 750
post-spend ownership: owner 5250, member 2250
Trip aggregate:        7500
```
Required persisted-evidence checks (trusted inspection, every one read back from
Firestore, never merely recomputed in-test):
- `inspectExpense(sharedStashResult.expenseId)`: `paymentSource: "shared_stash"`,
  `amountMinor: 2500`, `status: "active"`,
  `sharedStashTransactionId === sharedStashResult.sharedStashTransactionId`
- **exact Shared-Stash linkage (corrected this pass — exact ids, never document counts
  alone):**
  - `expense.sharedStashTransactionId === sharedStashResult.sharedStashTransactionId`
  - the linked `savingsTransactions` withdrawal, read via
    `inspectSavingsTransaction(sharedStashResult.sharedStashTransactionId)`: exists,
    `type: "withdrawal"`, `amountMinor: 2500`,
    `linkedExpenseId === sharedStashResult.expenseId`
  - the allocation record, read via `inspectAllocation(sharedStashResult.sharedStashTransactionId)`:
    its own document id equals `sharedStashResult.sharedStashTransactionId`,
    `expenseId === sharedStashResult.expenseId`, `tripId === fixture.tripId`
- `tripOwnershipAllocations/{sharedStashResult.sharedStashTransactionId}`:
  `amountMinor == 2500`, `allocations` summing exactly to `2500`, the two entries exactly
  `{owner: 1750, member: 750}` (in strictly ascending-uid order — real Auth-emulator
  uids, compared lexically at runtime, never a hardcoded role), `provenance == "original"`
- both `tripMemberOwnership` rows: owner `5250`, member `2250`
- `Trip.ledgerBalanceMinor == 7500`
- `ownershipModelState` remains `"initialized"`, `ownershipModelVersion` remains `1`

**Zero-pairwise-debt check — MANDATORY (corrected this pass; no longer optional):** a
Shared-Stash-funded Expense must create zero `tripExpenseSplits` documents (no personal
payer, no reimbursement edge — frozen in the 5C.4/5C.5 preflight §11/§15). Proven with
zero new helper code, via the existing, real, client-readable
`fetchExpenseSplitsForExpense(tripId, sharedStashResult.expenseId)`
(`src/services/firebase/expenses.ts`): require the result is exactly `[]`. This is a
required PASS item (§21, item N), not an optional/included-if-clean one.

## 9. Personal-withdrawal-phase checkpoint (financial-wrapper strategy corrected this pass)

The member performs one real personal withdrawal via the real `recordSavingsTransaction`
client wrapper called **directly** — never `withdrawReal` — with an explicit
`clientRequestId`, the request object retained for replay (§13):
```ts
const memberWithdrawalRequestId = generateSavingsClientRequestId();
const memberWithdrawalRequest = {
  resourceType: "trip" as const, resourceId: tripId, memberUid: member.uid,
  type: "withdrawal" as const, amountMinor: 1000, currency: "USD",
  clientRequestId: memberWithdrawalRequestId,
};
const memberWithdrawalResult = await recordSavingsTransaction(memberWithdrawalRequest);
```
Frozen exact expected economics:
```
member: 2250 -> 1250
owner:  remains 5250 (untouched)
Trip aggregate: 7500 -> 6500
```
Required final-state checks:
- member `ownershipMinor == 1250`
- owner `ownershipMinor == 5250` (byte-for-byte unchanged from §8 — the withdrawal must
  touch no other member's row)
- `sum(ownershipMinor) == 6500 == Trip.ledgerBalanceMinor`
- `Trip.saved == 65`
- `ownershipModelState` remains `"initialized"`, `ownershipModelVersion` remains `1`
- **deterministic transaction-id evidence (corrected this pass):**
  `memberWithdrawalResult.transactionId === memberWithdrawalRequestId`, then
  `inspectSavingsTransaction(memberWithdrawalRequestId)` returns the exact persisted
  document, linked to no Expense (`linkedExpenseId` absent — this is an ordinary personal
  withdrawal, not a Shared-Stash event)

## 10. End-to-end persisted audit-chain strategy

5C.7 must prove the final state **arose from the correct persisted transaction chain**,
not merely that the final numbers happen to match.

**Membership-acceptance evidence, made executable (corrected this pass):** a LOCAL
helper inside `multiMemberLifecycle.emulator.test.ts`, using `getTrustedInspectionEnv`
directly (no change to `trustedInspection.ts`):
```ts
async function findAcceptanceFor(
  tripId: string,
  uid: string
): Promise<Record<string, unknown>[]> {
  const env = await getTrustedInspectionEnv();
  let docs: Record<string, unknown>[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore()
      .collection("tripMembershipAcceptances")
      .where("tripId", "==", tripId)
      .where("uid", "==", uid)
      .get();
    docs = snap.docs.map((d) => d.data());
  });
  return docs;
}
```
Called with `(fixture.tripId, fixture.member.uid)`: require **exactly one** result, and
verify on that one document: `tripId === fixture.tripId`, `uid === fixture.member.uid`,
`termsDocId === fixture.termsV1Id`, `acceptedTermsVersion` is a positive safe integer,
`acceptedAt` is present. Additionally require `Trip.memberIds` contains the member's uid
**exactly once** (`memberIds.filter((u) => u === member.uid).length === 1`).

At minimum, the scenario inspects and cross-links:
- the Trip document itself (final `ledgerBalanceMinor`/`saved`/`ownershipModelState`/
  `ownershipModelVersion`)
- the acceptance-evidence document above (confirming the SAME uid that later
  contributes/withdraws is the one that actually accepted, and that `memberIds` reflects
  it exactly once)
- owner's and member's `tripMemberOwnership` rows (final values, per §9)
- both contribution `savingsTransactions` documents, by their exact deterministic ids
  (§7)
- the Shared-Stash `tripExpenses` document, its linked withdrawal `savingsTransactions`
  document, and its `tripOwnershipAllocations` record, cross-linked by exact id (§8)
- the personal-withdrawal `savingsTransactions` document, by its exact deterministic id
  (§9)

This linkage-consistency check is what distinguishes "the final numbers matched" from
"the final numbers arose from the correct chain" — a regression that produced the right
final totals through the wrong internal linkage (e.g. a withdrawal accidentally linked to
the wrong Expense, or an allocation record at the wrong id) would still be caught.

## 11. Running invariant-check strategy

One invariant helper, invoked after every healthy-state checkpoint (A through F in the
checkpoint's own numbering — initial Trip creation, member acceptance, owner
contribution, member contribution, Shared-Stash spend, personal withdrawal):
```
Trip.ledgerBalanceMinor == sum(every tripMemberOwnership row's ownershipMinor for this Trip)
```
plus, independently at each checkpoint:
- every present `ownershipMinor` is a non-negative safe integer
- a uid with no row at all (before its first contribution) contributes `0` to the sum by
  construction — never fabricated as an explicit zero row
- `ownershipModelState` is exactly `"initialized"` (never `"migrating"` or
  `"needs_reconciliation"`) at every one of these checkpoints — the healthy chain must
  never silently drift into a blocked/reconciliation state
- `ownershipModelVersion` is exactly `1` at every one of these checkpoints

This reuses `inspectOwnershipBalancesForTrip` + `inspectTrip` (both already-existing,
unchanged helpers) — no new assertion primitive is needed; only a small local helper
function inside the one new test file that calls those two and performs the sum/
non-negativity/version check, mirroring `ownershipWithdrawal.emulator.test.ts`'s own
`captureFinancialSnapshot` idiom exactly (read in §2) rather than inventing a new pattern.

## 12. Spender-identity decision

**Decision: A — the central chain uses the owner as spender only; it does not duplicate
the chain with the member as spender.**

Rationale: 5C.4 already independently and exhaustively proved spender-identity
invariance (`recordSharedStashExpense.ts`'s `applySharedStashDepletion` call takes only
the amount and the ownership-balance array — `authUid` is never passed into the economic
computation; confirmed directly against source in the 5C.4/5C.5 preflight §9, and proven
at the emulator level by `sharedStashSpending.emulator.test.ts`'s own dedicated
same-ratio-different-caller fixture). Duplicating the entire chain with the member as
spender would not exercise any code path the dedicated 5C.4 test does not already cover,
and would turn 5C.7 from "one deterministic chained lifecycle" into two divergent chains
with no corresponding increase in proof value. 5C.7's own stated purpose — one continuous
lifecycle, not another independent-case subsystem suite — is best served by picking a
single, fixed spender role.

## 13. Idempotency spot-check scope (strengthened this pass)

**Decision: perform exact replay immediately after each of the three real financial
commits in the chain** (owner contribution, Shared-Stash spend, member withdrawal) — not
a fourth separate idempotency suite, and not every conflicting-payload case already
covered by the committed Core/unit/5C.4/5C.5/5C.6 test suites (explicitly out of scope
here, per the checkpoint's own instruction not to retest every prior-milestone conflict
case).

Because the chain now calls the real client wrappers directly with an explicitly
generated and retained `clientRequestId` (§7-§9) — never `contributeReal`/
`spendSharedStashReal`/`withdrawReal`, each of which generates a *hidden* id internally
and therefore cannot be replayed with the exact same request — **exact replay is now
genuinely executable**: the test re-submits the identical, already-retained request
object (`ownerContributionRequest`, `sharedStashRequest`, `memberWithdrawalRequest`)
through the identical real client wrapper, as the identical caller.

For each of the three operations, immediately after its original successful commit:
- capture the complete ownership snapshot (owner + member `ownershipMinor`) and Trip
  financial state (`ledgerBalanceMinor`, `saved`, `ownershipModelState`,
  `ownershipModelVersion`) **before** issuing the replay call
- call the identical real client wrapper again with the **exact same, already-retained**
  request object (same `clientRequestId`, same every other field, same caller)
- require the replay result `toEqual` the original result exactly
  (`ownerContributionResult`/`sharedStashResult`/`memberWithdrawalResult`)
- require the ownership snapshot and Trip financial state are **byte-for-byte unchanged**
  by the replay (captured again immediately after, `toEqual` the before-snapshot)
- require `ownershipModelState`/`ownershipModelVersion` are unchanged
- require no duplicate artifact: for the two `recordSavingsTransaction` replays,
  `inspectSavingsTransaction` at the same deterministic id still returns exactly one
  document, unchanged; for the Shared-Stash replay specifically, require **exactly one**
  linked `savingsTransactions` withdrawal (via
  `findSavingsTransactionsLinkedToExpense(sharedStashResult.expenseId)`, length `1`) and
  **exactly one** `tripOwnershipAllocations` record for the Expense (via
  `findOwnershipAllocationsForExpense(sharedStashResult.expenseId)`, length `1` — and
  `countAllocationsForTrip(tripId)` for the whole Trip also still `1`, never `2`)

This is the narrower set the checkpoint itself invites if three full replay checks would
make the chain materially harder to reason about — but three is not materially harder:
each replay is a single extra call immediately following an already-necessary assertion
block, reusing the exact request object/caller context already retained in scope at that
point in the test, adding no new fixture machinery.

## 14. Final rejection spot-check (strengthened this pass)

After the final healthy state (`owner 5250`, `member 1250`, `aggregate 6500`), one
narrowly-chosen rejection: **member attempts a withdrawal of `1251`** (exactly
`ownership + 1`, matching the frozen ceiling boundary already proven at the Core/unit and
5C.5-emulator levels — this is a wiring re-proof against the chain's actual accumulated
state, not a new boundary case), via a **new** `clientRequestId`
(`generateSavingsClientRequestId()`) — never reusing the withdrawal request from §9.

Before the call, capture the complete snapshot: owner `ownershipMinor`, member
`ownershipMinor`, the complete `tripMemberOwnership` row set for the Trip,
`Trip.ledgerBalanceMinor`, `Trip.saved`, `ownershipModelState`, `ownershipModelVersion`.

Call the real `recordSavingsTransaction` directly with the new request id. Require:
- `functions/failed-precondition` (exact code, via `expectCallableErrorCode`)
- the entire captured snapshot is `toEqual` unchanged after the rejection — owner remains
  `5250`, member remains `1250`, `Trip.ledgerBalanceMinor` remains `6500`, `saved` remains
  `65`, `ownershipModelState` remains `"initialized"`, `ownershipModelVersion` remains `1`
- `inspectSavingsTransaction(rejectedRequestId)` is `undefined` — no document was ever
  created for the rejected request

This is the one rejection the checkpoint asks for — no larger rejection matrix is added;
every other rejection case (non-member, archived, migrating, needs_reconciliation,
invalid amount, etc.) already has dedicated, passing coverage in the 5C.4/5C.5/5C.6
emulator suites and is not re-tested here.

## 15. Reversal boundary

**Frozen: no reversal is included in the 5C.7 central chain.** 5C.6 already validated
reversal/reconciliation semantics exhaustively, including a real Shared-Stash reversal's
exact economic restoration and idempotent replay
(`sharedStashReversalHardening.emulator.test.ts`). Adding a reversal to the required
backbone would change the already-frozen final expected state (`5250/1250/6500`), which
is the one fixed target every other section of this document depends on. Reversal
evidence is inherited from 5C.6's own independent, already-passing suite — 5C.7 does not
re-run or duplicate it.

## 16. Reconciliation boundary

**Frozen: the central Trip is never deliberately corrupted, never transitioned to
`needs_reconciliation`, and `reconcileTripOwnership` is never run against it.** 5C.6
already separately validated the full repair lifecycle, including native/migrated/mixed-
provenance recovery and interrupted-materialization resume
(`reconciliationRecovery.emulator.test.ts`). 5C.7's entire purpose is the opposite claim:
proving a Trip that is never corrupted stays healthy through a real multi-step lifecycle.
Forcing reconciliation into this suite would conflate two already-separately-proven
properties into one test and add no new evidence.

## 17. Archive boundary

**Frozen: the central Trip is never archived.** Archived-Trip behavior (new-contribution
blocking, existing-member withdrawal permissiveness) was already proven as its own
positive contract at the 5C.5-emulator level (`ownershipWithdrawal.emulator.test.ts`,
confirmed in the 5C.4/5C.5 preflight §17). 5C.7 is the ordinary healthy active-Trip
lifecycle only.

## 18. Chosen harness architecture

**Decision: dedicated milestone isolation (Option B)** — a new, independent
`jest.multi-member-e2e.config.js` + sequencer + runner + two test files, mirroring the
already-proven 5C.4/5C.5 and 5C.6 harness pattern exactly, never editing
`jest.integration.config.js`, `jest.financial-integration.config.js`,
`jest.reconciliation-integration.config.js`, or any of their sequencers/runners/summary
files. The added overhead (one config, one sequencer, one runner, two test files) is the
same small, fixed shape every prior milestone already paid, and keeps 5C.7's own
`bail: 1` / summary banner fully independent — a 5C.7 failure must never block or
retroactively invalidate the already-earned `"5C.4: PASS"`/`"5C.5: PASS"`/`"5C.6: PASS"`
banners, and vice versa.

Proposed files (names exactly as the checkpoint itself proposed, confirmed consistent
with the existing naming convention):
```
jest.multi-member-e2e.config.js
tests/integration/helpers/multiMemberE2ESequencer.js
tests/integration/runMultiMemberE2EIntegration.cjs
tests/integration/multiMemberLifecycle.emulator.test.ts
tests/integration/zzz_5c7_summary.emulator.test.ts
```
Runner topology mirrors every existing runner exactly: project `demo-squadstash-5c3d`,
emulators `auth,firestore,functions` only, `FUNCTIONS_DISCOVERY_TIMEOUT=30` set on the
runner's own child environment, `jest --config jest.multi-member-e2e.config.js --runInBand`,
`bail: 1` on the dedicated config. The summary file prints only `"5C.7: PASS"` — the
5C.4/5C.5/5C.6 summary files and banners are never modified.

Sequencer order (mirroring `financialSequencer.js`/`reconciliationSequencer.js`'s own
pattern):
```
1. tests/integration/integrationGuard.test.ts (reused unmodified)
2. tests/integration/multiMemberLifecycle.emulator.test.ts
3. tests/integration/zzz_5c7_summary.emulator.test.ts
```

**Frozen exact `package.json` script (corrected this pass — named precisely, not merely
described):**
```json
"test:multi-member-e2e-integration": "npm --prefix functions run build && node tests/integration/runMultiMemberE2EIntegration.cjs"
```
This is the **one** `package.json` change in the entire future implementation (§20) —
mirroring `test:multi-member-financial-integration`/
`test:multi-member-reconciliation-integration`'s own exact script shape.

## 19. Fixture reuse

**Confirmed: no new shared-helper-file change is required.** Every primitive the central
chain needs already exists, unchanged:
- `createAcceptedTwoMemberTrip` (`financialFixtures.ts`) — membership setup only (§5).
  `contributeReal`/`withdrawReal`/`spendSharedStashReal` are **not** used by the chain
  (corrected this pass — §7-§9); the chain instead calls `recordSavingsTransaction`/
  `recordSharedStashExpense` (the real client wrappers) and
  `generateSavingsClientRequestId`/`generateExpenseClientRequestId` directly.
- `inspectTrip`, `getTrustedInspectionEnv` (`trustedInspection.ts`)
- `inspectOwnership`, `inspectOwnershipBalancesForTrip`, `inspectExpense`,
  `inspectSavingsTransaction`, `inspectAllocation`, `findSavingsTransactionsLinkedToExpense`,
  `findOwnershipAllocationsForExpense` (`ownershipInspection.ts`)
- `expectCallableErrorCode` (`assertions.ts`)
- `fetchExpenseSplitsForExpense` (`src/services/firebase/expenses.ts`, the real client
  wrapper — used directly for §8's now-mandatory pairwise-debt check)
- `signInAs` (`fixtures.ts`)

**`reconciliationFixtures.ts` is not imported by the new test file at all** — every one
of its own additions beyond its unchanged re-exports from `financialFixtures.ts` is
corruption/control/attempt/migration-only machinery with no legitimate role in a healthy
chain (§16/§15). No change to it is proposed or required.

**Exactly three small local helper functions are justified, each kept LOCAL inside
`multiMemberLifecycle.emulator.test.ts` itself — none factored into any shared helper
file, and none requiring a change to `trustedInspection.ts` or
`ownershipInspection.ts`:**
- `captureInvariantSnapshot(tripId)` — combines `inspectTrip` +
  `inspectOwnershipBalancesForTrip` into one `{ledgerBalanceMinor, saved,
  ownershipModelState, ownershipModelVersion, ownership}` object (§11/§13/§14),
  mirroring `ownershipWithdrawal.emulator.test.ts`'s own already-committed
  `captureFinancialSnapshot` local-helper pattern exactly.
- `findAcceptanceFor(tripId, uid)` — the exact query named in §10, using
  `getTrustedInspectionEnv` directly.
- `countAllocationsForTrip(tripId)` — the exact query named in §6, using
  `getTrustedInspectionEnv` directly.

Each is a plain, local, read-only query function with no side effects and no exported
surface — not a fixture-construction mechanism, and not a duplicate of any existing
shared helper's responsibility.

## 20. Exact future implementation file scope

**MODIFY:**
```
package.json   (one new script line — §18 — mirroring every prior milestone's own addition)
```

**ADD:**
```
jest.multi-member-e2e.config.js
tests/integration/helpers/multiMemberE2ESequencer.js
tests/integration/runMultiMemberE2EIntegration.cjs
tests/integration/multiMemberLifecycle.emulator.test.ts
tests/integration/zzz_5c7_summary.emulator.test.ts
```

**Total future changed files: 6 (1 modified + 5 added).** No helper file is modified. No
production source is modified.

**REUSE UNCHANGED:**
```
all production source (functions/src/**, firestore.rules, app/**, src/**)
all 5C.3D/5C.4/5C.5/5C.6 test/harness sources, including:
  tests/integration/helpers/financialFixtures.ts
  tests/integration/helpers/ownershipInspection.ts
  tests/integration/helpers/reconciliationFixtures.ts (not even imported)
  tests/integration/helpers/firebaseIntegrationTestEnv.ts
  tests/integration/helpers/fixtures.ts
  tests/integration/helpers/trustedInspection.ts
  tests/integration/helpers/assertions.ts
  tests/integration/helpers/jestSetup.js
  tests/integration/helpers/sequencer.js
  tests/integration/helpers/financialSequencer.js
  tests/integration/helpers/reconciliationSequencer.js
  tests/integration/integrationGuard.test.ts
  tests/integration/sharedStashSpending.emulator.test.ts
  tests/integration/ownershipWithdrawal.emulator.test.ts
  tests/integration/reconciliationHardening.emulator.test.ts
  tests/integration/sharedStashReversalHardening.emulator.test.ts
  tests/integration/nonOwnershipReversalRegression.emulator.test.ts
  tests/integration/reconciliationRecovery.emulator.test.ts
  every existing runner/config/summary file (jest.integration.config.js,
  jest.financial-integration.config.js, jest.reconciliation-integration.config.js, and
  their three runners/summaries)
```

**NO EXPECTED CHANGE:**
```
functions/src/**
firestore.rules
app/**
src/**
```

No file appears in two categories. Inspection found no genuine missing helper — every
item in §19 already exists exactly as needed; the only additions are the five new
milestone-isolated files plus the three test-local functions named in §19 (which live
inside one of those five new files, not in any shared/reused file).

## 21. Exact 5C.7 PASS checklist (expanded this pass)

- **A.** Trusted second-member authorization via the real invitation/acceptance flow —
  no manual `memberIds` seeding.
- **B.** Newly accepted member starts at zero/absent economic ownership — no fabricated
  row.
- **C.** Owner contributes 7000 via the real `recordSavingsTransaction` wrapper, called
  directly with an explicit, retained `clientRequestId`; persisted and reflected in
  ownership/aggregate.
- **D.** Member contributes 3000 via the same direct-wrapper pattern; lazily creates the
  member's ownership row; persisted and reflected in ownership/aggregate.
- **E.** Ownership/aggregate exactly `7000/3000/10000` after both contributions.
- **F.** One real pooled Shared-Stash spend of `2500`, via the real
  `recordSharedStashExpense` wrapper called directly with an explicit, retained
  `clientRequestId`.
- **G.** Persisted depletion exactly `1750/750`, exact allocation record
  (`amountMinor: 2500`, entries summing to `2500`, `provenance: "original"`).
- **H.** Ownership/aggregate exactly `5250/2250/7500` after the spend.
- **I.** Member personal withdrawal of `1000` via the real `recordSavingsTransaction`
  wrapper called directly with an explicit, retained `clientRequestId`; only the member's
  own row changes.
- **J.** Final ownership/aggregate exactly `5250/1250/6500`.
- **K.** `Trip.saved == 65` in the final state.
- **L.** The running invariant (`ledgerBalanceMinor == Σ ownershipMinor`, every value
  non-negative) holds after every healthy financial step (A/creation through the final
  withdrawal).
- **M.** No ownership value is ever negative at any checkpoint.
- **N.** All of the following persisted-evidence/linkage facts hold exactly (not merely
  as document counts):
  - exact membership-acceptance evidence for the member + `fixture.termsV1Id` (§10),
    and `Trip.memberIds` contains the member's uid **exactly once**
  - zero `tripOwnershipAllocations` records before any financial activity (§6)
  - `ownershipModelVersion == 1` at every healthy checkpoint (§6/§11)
  - deterministic `transactionId`/`clientRequestId` equality for all three savings
    operations (§7/§9)
  - **mandatory** zero `tripExpenseSplits` for the Shared-Stash Expense (§8)
  - exact Shared-Stash cross-links: `expense.sharedStashTransactionId`, the linked
    withdrawal's own id, and the allocation's own id are all equal to
    `sharedStashResult.sharedStashTransactionId`; `withdrawal.linkedExpenseId ===
    expense.id`; `allocation.expenseId === expense.id`; `allocation.tripId ===
    fixture.tripId` (§8)
- **O.** `ownershipModelState` remains exactly `"initialized"` throughout — never
  `"migrating"`/`"needs_reconciliation"` at any point in the healthy chain.
- **P.** The three idempotency spot checks (owner contribution, Shared-Stash spend,
  member withdrawal) each: replay to a result exactly equal to the original, leave the
  complete ownership/ledger/state snapshot byte-for-byte unchanged, and create zero
  duplicate artifacts — for the Shared-Stash replay specifically, exactly one linked
  withdrawal and exactly one allocation record remain (§13).
- **Q.** The final ownership-ceiling rejection (member withdraws `1251` with a NEW
  request id) fails closed with exactly `functions/failed-precondition`, leaves the
  entire captured snapshot (`5250/1250/6500`, `saved == 65`, state, version) completely
  unchanged, and creates no `savingsTransactions` document at the rejected request id
  (§14).
- **R.** The existing 5C.3D/5C.4/5C.5/5C.6 integration suites remain independently
  passing (not replaced, not modified) — see §22.
- **S.** The initial 5C.7 suite run passes in full, AND three additional fresh
  stability runs each independently pass in full (§22) — each exits `0`, each prints a
  distinct `"5C.7: PASS"` banner, and each leaves no lingering `java`/`node` emulator
  process running.

## 22. Regression expectations (corrected this pass)

After a future 5C.7 implementation pass, require fresh reruns of:
- 5C.3D invitation integration (`npm run test:trip-invitation-integration`)
- 5C.4/5C.5 financial integration (`npm run test:multi-member-financial-integration`)
- 5C.6 reconciliation integration (`npm run test:multi-member-reconciliation-integration`)
- `npm run typecheck`
- `npm run lint`
- root Jest, run as exactly **`npm test -- --silent`** (corrected this pass — never
  `npm test -- --runInBand` as a PASS requirement; `--runInBand` is not part of the root
  Jest contract and is not required to reproduce the established baseline). Established
  baseline to match: **38 suites, 1131 tests, 1 snapshot, exit 0.**
- Functions (`firebase emulators:exec --only firestore "npm --prefix functions test"`)
- Rules (`npm run test:rules`)

**Then, once the initial 5C.7 run and every regression above passes, three additional
fresh stability runs of the 5C.7 suite itself are required:**
```
npm run test:multi-member-e2e-integration
npm run test:multi-member-e2e-integration
npm run test:multi-member-e2e-integration
```
Each run must independently: start fresh emulators, print `"5C.7: PASS"`, pass every
5C.7 test, exit `0`, shut emulators down automatically, and leave no lingering
`java`/`node` emulator process running. No `--forceExit` under any circumstance — a run
that does not exit cleanly on its own is a genuine defect to diagnose, never papered
over.

5C.7 must not replace or supersede any earlier milestone's own evidence — each milestone
keeps its own independent PASS banner and its own independently-rerunnable suite.

## 23. Production boundary

**5C.7 is local-emulator validation only.** No production project, no production
Firestore/Auth/Functions access, no production financial transaction, under any
circumstance, for any part of 5C.7. 5C.7's completion must never be interpreted as, or
substituted for, the previously-frozen production rollout gate covering
`acceptTripInvitation`, `getTripInvitationPreview`, and the 5C.2 Rules closure — that
remains a separate, independently-controlled decision, untouched by this checkpoint.

## 24. Blockers / open questions

**None.** Every callable contract, data-model field, state-machine value, and
authorization rule the central chain depends on was confirmed already implemented,
already unit/Core-tested, and already unmodified through 5C.6 (both source documents'
own `REUSE UNCHANGED` lists independently confirm this for every primitive involved).
Every fixture/inspection primitive 5C.7 needs already exists unchanged (§19) — no shared
helper file requires a change; the exact-replay and acceptance/allocation-evidence
checks that were previously unexecutable through hidden-id helpers are now fully
executable through the direct-real-wrapper strategy frozen in this revision (§7-§10,
§13).

## 25. GO / STOP recommendation

**GO** to proceed toward implementing 5C.7 once separately authorized, using the exact
file scope (§20), chained lifecycle (§4), checkpoint-by-checkpoint economics (§7-§9),
invariant/audit-chain strategy (§10/§11), idempotency/rejection spot checks (§13/§14),
exact package script (§18), and PASS checklist (§21) frozen in this document. This is a
pure wiring/E2E proof against an already-stable, already-frozen backend — no production
source change is required, and none is authorized by this document.

---

## Revision log (this pass)

1. **Financial-wrapper/idempotency contradiction fixed** (§2/§7-§9/§13/§19): the chain no
   longer uses `contributeReal`/`withdrawReal`/`spendSharedStashReal` (each of which
   generates its own hidden `clientRequestId`) for any operation requiring exact replay.
   The chain now calls `recordSavingsTransaction`/`recordSharedStashExpense` (the real
   client wrappers) directly, with explicit ids from `generateSavingsClientRequestId`/
   `generateExpenseClientRequestId`, retaining each full request object for byte-exact
   replay. `createAcceptedTwoMemberTrip` remains the only `financialFixtures.ts` helper
   the chain uses, scoped to membership setup only.
2. **Membership-acceptance evidence made executable** (§10): a LOCAL `findAcceptanceFor`
   query helper (using `getTrustedInspectionEnv` directly) replaces an unexecutable
   reference to evidence with no concrete query strategy; exactly-one-result and exact-
   field checks frozen; `memberIds`-contains-exactly-once check added.
3. **Initial zero-allocation check made executable** (§6): a LOCAL `countAllocationsForTrip`
   query helper (using `getTrustedInspectionEnv` directly) added; required `== 0` before
   financial activity.
4. **Zero-pairwise-debt check promoted from optional to mandatory** (§8/§21): every
   "optional"/"included-if-clean" qualifier removed; `fetchExpenseSplitsForExpense`
   returning `[]` is now a required PASS item.
5. **`ownershipModelVersion == 1` frozen explicitly** (§6/§7/§9/§11/§14/§21) as a literal
   value (deliberate schema-regression assertion), checked at every healthy checkpoint.
6. **Deterministic transaction-id evidence added** (§7/§9/§21): each savings result's
   `transactionId` is required to equal its own request's `clientRequestId`, with the
   exact persisted document re-read at that id.
7. **Exact Shared-Stash linkage frozen** (§8/§21): `expense.sharedStashTransactionId`,
   the linked withdrawal's id, and the allocation's id are all required equal to
   `sharedStashResult.sharedStashTransactionId`; `withdrawal.linkedExpenseId`/
   `allocation.expenseId`/`allocation.tripId` checks added — never document counts
   alone.
8. **All three replay proofs strengthened** (§13/§21): before/after snapshot capture
   added; exact result equality required; for the Shared-Stash replay specifically,
   exactly-one-linked-withdrawal and exactly-one-allocation checks added.
9. **Final rejection strengthened** (§14/§21): new request id required (never reusing
   §9's); full economic/state/version snapshot captured before and required unchanged
   after; `inspectSavingsTransaction(rejectedRequestId)` required `undefined`.
10. **Root Jest regression command corrected** (§22): `npm test -- --silent` frozen as
    the exact command, with the established baseline (38/1131/1 snapshot/exit 0) stated
    explicitly; `npm test -- --runInBand` explicitly withdrawn as a PASS requirement.
11. **Three additional fresh 5C.7 stability runs added** (§21/§22), mirroring 5C.4/5C.5's
    and 5C.6's own already-established stability-run precedent exactly.
12. **Exact `package.json` script frozen** (§18): `test:multi-member-e2e-integration`
    named and defined precisely, not merely described.
13. **Six-file future implementation scope reconfirmed unchanged** (§20): 1 modified + 5
    added, no helper file modified, no production file modified.
14. **PASS checklist expanded** (§21) to explicitly require every item above, while
    preserving the exact central economics (`7000/3000/10000 -> spend 2500 ->
    5250/2250/7500 -> withdraw 1000 -> 5250/1250/6500`) unchanged throughout.

**Nothing beyond this document was created or modified.**
