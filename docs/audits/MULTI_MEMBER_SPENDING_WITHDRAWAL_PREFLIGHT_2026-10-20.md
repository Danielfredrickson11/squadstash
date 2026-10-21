# Multi-Member Shared Stash Spending + Ownership-Based Withdrawal — Preflight

**Status: PREFLIGHT / ARCHITECTURE FREEZE ONLY. Not implemented. Not committed.**

**Revision note (this pass):** this revision corrects a harness-scope contradiction, removes an unproven "PASS" expectation around withdrawal reconciliation, reframes archived-Trip withdrawal as a positive contract, moves the combined multi-step scenario out of 5C.4/5C.5's own PASS criteria into the 5C.7 backbone, and scopes 5C.4 to initialized-Trip behavior only. See the revision log at the bottom of this document for the full list of corrected statements.

This document combines preparation for two separate roadmap checkpoints:

- **5C.4 — Multi-Member Shared Stash Spending**
- **5C.5 — Ownership-Based Withdrawals**

They remain separate checkpoints with separate PASS criteria (§25/§26). Nothing in
this document authorizes implementing either one.

---

## 1. Baseline

- Branch: `claude/milestone-3-personal-savings-mvp`
- HEAD at the start of this preflight: `c329e6a3ea23a8abb6b058b284da78b29313d9bf`
- Working tree: clean
- Local HEAD == origin HEAD: confirmed

## 2. Source files inspected

**Architecture/audit docs read in full or targeted-searched:**
- `docs/audits/TRIP_WALLET_MILESTONE_PREFLIGHT_2026-10-06.md`
- `docs/audits/TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md`
- `docs/audits/TRIP_WALLET_OWNERSHIP_MIGRATION_PREFLIGHT_2026-10-10.md` (2538 lines — searched for invariant/state-machine language rather than read linearly)
- `docs/audits/TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md`
- `docs/audits/TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md`
- `docs/audits/TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md` (confirmed: predates the ownership model entirely — no ownership-state invariants live here)
- `docs/audits/TRIP_INVITATION_INTEGRATION_PREFLIGHT_2026-10-19.md` (own prior knowledge — authored the committed harness it describes)

**Current implementation read in full:**
- `functions/src/domain/tripOwnershipModel.ts`
- `functions/src/domain/tripMemberOwnership.ts`
- `functions/src/domain/tripOwnershipAccounting.ts`
- `functions/src/domain/tripOwnershipAllocation.ts`
- `functions/src/callables/recordSavingsTransaction.ts`
- `functions/src/callables/recordSharedStashExpense.ts`
- `functions/src/callables/reverseSharedStashExpense.ts`
- `functions/src/callables/reverseTripExpense.ts`
- `functions/src/callables/reverseTripSettlement.ts`
- `functions/src/callables/createTrip.ts` (targeted: confirmed new-Trip ownership initialization)
- `functions/src/callables/acceptTripInvitation.ts` (targeted: confirmed the financial-authorization gate)
- `functions/src/domain/tripOwnershipMigrationState.ts`
- `src/services/firebase/expenses.ts`
- `src/services/firebase/savingsTransactions.ts`
- `functions/test/tripOwnershipAccounting.ts`, `tripOwnershipAllocation.ts`, `tripMemberOwnership.ts`, `tripOwnershipModel.ts`, `recordSavingsTransactionCore.ts`, `recordSavingsTransactionOwnership.ts`, `recordSharedStashExpenseCore.ts`, `recordSharedStashExpenseOwnership.ts`
- `tests/integration/**` (the committed 5C.3D-B harness — own prior authorship)

**Skimmed for purpose only (not deeply analyzed — reversal/migration internals are 5C.6 scope):** `functions/src/domain/tripOwnershipMigrationDigest.ts`, `functions/src/domain/tripOwnershipMigrationReplay.ts`.

No file path was assumed before searching; all callable/domain locations were confirmed via `find`/`grep` against the actual repository.

---

## 3. Current callable contracts (exact, as implemented today)

### 3.1 `recordSharedStashExpense` (pooled Shared Stash spend)

File: `functions/src/callables/recordSharedStashExpense.ts`. Core signature:
```ts
recordSharedStashExpenseCore(db: Firestore, authUid: string, rawInput: unknown): Promise<RecordSharedStashExpenseResult>
```
**Input** (wire-allowed keys only; anything else is `invalid-argument` before any read):
```ts
{
  tripId: string;
  amountMinor: number;        // positive safe integer
  currency: "USD";            // only legal value today
  description: string;        // non-empty, trimmed, <=500 chars
  category?: string;          // <=100 chars
  occurredAt?: string;        // ISO-8601 with explicit timezone
  clientRequestId: string;    // /^[A-Za-z0-9_-]{1,128}$/, doubles as the Expense doc id
  replacesExpenseId?: string; // valid Firestore doc id
}
```
**Output:**
```ts
{ expenseId: string; sharedStashTransactionId: string }
```
**Authorization:** `isCurrentTripMember` — `tripData.memberIds.includes(uid) || tripData.ownerId === uid`, read fresh inside the transaction. Membership alone is the entire gate; invitation/acceptance status is not separately consulted at this layer (per `TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md` §6/§7: "memberIds remains the single, sole source of truth every existing financial callable ... already consults").

**Client wrapper:** `src/services/firebase/expenses.ts`:
```ts
export async function recordSharedStashExpense(input: RecordSharedStashExpenseInput): Promise<RecordSharedStashExpenseResult>
```
with the same field shape (minus wire-level ISO conversion — `occurredAt` is a `Date` client-side).

### 3.2 `reverseSharedStashExpense`

```ts
{ expenseId: string; reversalReason?: string; clientRequestId: string } -> { expenseId: string; refundTransactionId: string }
```
`tripId` is never client-supplied — derived server-side from the Expense. Authorization: the Trip's current `ownerId` OR the Expense's original `createdBy`, provided that uid is still a current Trip member. Rejects an Expense whose `paymentSource !== "shared_stash"`.

### 3.3 `recordSavingsTransaction` (contribution **and** withdrawal — one callable)

File: `functions/src/callables/recordSavingsTransaction.ts`. Input:
```ts
{
  resourceType: "bucket" | "trip";
  resourceId: string;
  memberUid: string;
  type: "contribution" | "withdrawal";   // withdrawal is NEVER a negative amountMinor
  amountMinor: number;                   // always > 0, regardless of type
  currency: string;
  note?: string;
  occurredAt?: string;
  clientRequestId: string;
}
```
Output: `{ transactionId: string; balanceMinor: number }`.

**A withdrawal is selected by `type: "withdrawal"` on this same callable — there is no separate withdrawal callable and no sign-based withdrawal.**

**Authorization, in exact order** (`recordSavingsTransaction.ts:168-189`):
1. Idempotent-replay check (bypasses everything below on an exact match).
2. `parentData.memberIds.includes(input.memberUid)` → else `permission-denied`, `"memberUid is not a current member of this resource."`
3. `authUid === input.memberUid` → else `permission-denied`, `"You may only record a savings transaction for yourself."`

**There is no uid/target selector distinct from `memberUid`.** The callable always and only operates on the authenticated caller's own economic ownership. The file's own header comment freezes this as deliberate: *"Owner-on-behalf recording ... is intentionally NOT permitted right now ... until a future group-sharing milestone adds trusted, accepted membership."*

**Client wrapper:** `src/services/firebase/savingsTransactions.ts`:
```ts
export async function recordSavingsTransaction(input: RecordSavingsTransactionInput): Promise<RecordSavingsTransactionResult>
```
No separate "withdraw" wrapper exists — callers pass `type: "withdrawal"`.

---

## 4. Current ownership data model (exact, as implemented today)

**Collection `tripMemberOwnership`** — doc id `{tripId}_{uid}` (delimiter `_`, via `tripMemberOwnershipId`). Fields:
```ts
{ id: string; tripId: string; uid: string; ownershipMinor: number /* >= 0, safe integer */; lastUpdatedAt: Timestamp }
```
This is a **cache**, not the source of truth for history — rows are read/written via `tx.update`/`tx.create` only, never `tx.set`.

**Collection `tripOwnershipAllocations`** — doc id = the id of the originating Shared-Stash withdrawal transaction (not composite). Immutable once written. Fields:
```ts
{
  id, tripId, expenseId, withdrawalTransactionId,
  allocations: Array<{uid: string; amountMinor: number}>,  // strictly ascending-uid order, no zero entries
  amountMinor, currency, createdAt,
  provenance: "original" | "migrated"   // + migratedAt if "migrated"
}
```

**Trip-level ownership state** — `Trip.ownershipModelState: "legacy" | "migrating" | "initialized" | "needs_reconciliation"` (absent is a *second, equally valid* persisted representation of `"legacy"` — not merely a default). `Trip.ownershipModelVersion` is a positive safe integer once `"initialized"`/`"needs_reconciliation"`, absent otherwise. `CURRENT_TRIP_OWNERSHIP_MODEL_VERSION = 1` today (Functions-side only, no client mirror).

**Legal transitions** (`isValidTripOwnershipModelTransition`): `legacy → migrating → initialized ⇄ needs_reconciliation` (the last pair both ways, version unchanged). Every other pair — including anything back to `legacy` — is illegal, by design, permanently (no "give up" escape hatch).

**`classifyOwnershipMutationGate`** is the single decision point every ownership-aware callable consults, collapsing the 4-state classification into: `"legacy"`, `"blocked"` (migrating + needs_reconciliation, identically), `"initialized"` (only if version also matches current), `"fail_closed"` (corrupt / unsupported version).

**New Trips start `"initialized"` immediately, with no migration step.** Confirmed directly: `functions/src/callables/createTrip.ts:179-180` sets `ownershipModelState: "initialized"` / `ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION` at creation time — there is no legacy history to migrate for a brand-new Trip, so the admin migration tool (`functions/src/admin/migrateTripOwnership.ts`) is irrelevant to any Trip created fresh during this preflight's fixtures. **This resolves what would otherwise be a blocking open question for the two-member fixture (§6): no migration step is needed before the canonical fixture's financial operations can run.**

**`acceptTripInvitation` requires the gate to be exactly `"initialized"`** (not merely non-blocked) before letting a new uid become financially authorized (`acceptTripInvitation.ts:302-310`, `failed-precondition`, `"This trip's ownership model is not ready to accept a new financially-authorized member."`). Since every new Trip is already `"initialized"` at creation, this is satisfied trivially for the canonical fixture.

**Scope note (corrected this pass):** 5C.4/5C.5 target `"initialized"`-Trip behavior exclusively. `"legacy"` pooled-spend/withdrawal behavior already has prior Core/unit coverage and exists only for historical compatibility with Trips that predate the ownership model — it is documented here as background, never as a 5C.4/5C.5 PASS requirement (see §10, §24, §25).

---

## 5. Frozen invariants (verbatim, with source)

- **Economic ownership ≠ membership** — `TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md` §4: *"Concept B (ownership) is not a restatement of Concept A (aggregate) and must never collapse into it — that collapse is precisely today's bug."*
- **Accepted member may start at zero ownership** — same doc §19: *"New member joins: initial ownership is `0` until their own first contribution ... a row is created lazily on first contribution, or could be created eagerly at `0` — either is fine since the §9 algorithm treats 'no row' and 'row at 0' identically."*
- **Ownership row may be absent until first contribution** — confirmed by implementation: `recordSavingsTransaction.ts` lazily `tx.create`s the row only on a contribution against a missing row; a withdrawal against a missing row is rejected outright and never creates one.
- **Trip aggregate == sum of member ownership** — §7 of the same doc (quoted exactly): *"`Trip.ledgerBalanceMinor == sum over every uid that has ever held a tripMemberOwnership record for this Trip of that uid's current ownershipMinor`"* — deliberately scoped to every uid with history, not merely current `memberIds`. **This invariant is proactively verified today only on two specific write paths (the contribution-missing-row lazy-create gate, and the Shared-Stash-Expense depletion path) — not on every withdrawal. See §17 and §26 for why this is a frozen, deliberately-deferred gap, not a defect this preflight is asked to close.**
- **No negative ownership balance** — same §7: *"`tripMemberOwnership[tripId_uid].ownershipMinor >= 0` — never negative."*
- **Integer minor units, no floating point** — §15/§9: *"every ownership figure ... in integer minor units throughout, with the exact same no-float discipline ... No floating point appears anywhere in this algorithm."* Confirmed in code: all allocation arithmetic is `BigInt`, never `Number` multiplication.
- **Pooled spending depletes ownership proportionally** — implemented via `computeSharedStashDepletionAllocation` (floor + largest-remainder, confirmed in code, §8 below).
- **Allocation uses integer units; largest-remainder; ascending-uid tie-break** — confirmed in code (`tripOwnershipAccounting.ts`): `byLargestRemainder` sort, ties broken by `byUidAscending`.
- **Personal withdrawal cannot exceed member ownership** — `applyMemberWithdrawal`: `amountMinor > currentOwnershipMinor` → reject (strictly greater; exact-equal succeeds).
- **Personal withdrawal cannot exceed Trip aggregate** — the pre-existing `applyLedgerTransition` aggregate check runs independently and unconditionally, regardless of ownership state.
- **Owner gets no special withdrawal override** — §11 of the withdrawal doc (quoted exactly): *"5B preserves this — an owner may not withdraw another member's ownership."* Confirmed in code: no uid-selector exists; `authUid` must equal `memberUid`.
- **`migrating` is financial-write quiescence** — same doc, Amendment preamble: *"no new ownership-affecting mutation of any kind may proceed while a Trip is migrating — only exact idempotent replay of something that already committed beforehand."*
- **`needs_reconciliation` blocks financial writes** — §12A.5: *"identical rejection behavior to `'migrating'` ... reject every new mutation, permit only exact replay ... until trusted reconciliation tooling repairs the state."*
- **`initialized` at the current version is required for normal multi-member finance** — `classifyOwnershipMutationGate` only returns `"initialized"` when the state is `"initialized"` **and** the version matches `CURRENT_TRIP_OWNERSHIP_MODEL_VERSION`; any other combination is `"blocked"` or `"fail_closed"`.

**No blocking discrepancy found** between the docs' frozen invariants and the current implementation for any of the above — every invariant cited is backed by code that enforces it today, not merely a design intention, with the one deliberate, documented gap called out above (withdrawal-path drift detection — §17/§26). One terminology correction from the original roadmap-prompt's hypothesis: there is no state called `"current"` — the actual fourth value is `"legacy"`.

---

## 6. Canonical two-member fixture

Reusing the real, already-proven 5C.3D flow (`createAndSignInUser` → `createRealTrip` → `publishRealTerms` → `createRealInvitation` → `acceptTripInvitation`) to reach real, accepted, financially-authorized two-member state — no manual seeding of `memberIds`.

```
owner:  real Auth-emulator user, creates the Trip (ownershipModelState: "initialized" immediately — §4)
member: real Auth-emulator user, invited and accepts via the real, proven acceptTripInvitation flow
```
Immediately after acceptance: member is in `memberIds`, **no `tripMemberOwnership` row exists for member yet** (acceptance never touches ownership rows — confirmed by `TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md` §13: *"the acceptance transaction's write set touches only tripInvitations, tripMembershipAcceptances, and trips.memberIds/lastUpdatedAt/lastUpdatedBy — never tripMemberOwnership"*). This absence is preserved, not forced to a zero row, per §5's authorization.

Contributions (via the real `recordSavingsTransaction` client wrapper, `type: "contribution"`):
```
owner contributes:  7000 minor units ($70.00)
member contributes: 3000 minor units ($30.00)
```
Member's first contribution proves lazy ownership creation exactly as frozen (`recordSavingsTransaction.ts:324-330`, `tx.create`).

Expected state after both contributions:
```
owner ownership  = 7000
member ownership = 3000
total ownership  = 10000
Trip aggregate (ledgerBalanceMinor) = 10000
```
Confirmed consistent with `applyLedgerTransition`/lazy-create mechanics — no discrepancy with the task's assumed numbers.

**Important constraint for later sections:** these are *real* Auth-emulator-generated uids (random alphanumeric strings), not strings the test can choose. Any fixture requiring a specific uid to win an ascending-uid tie-break (§8) must compare the two real uids lexically **at runtime** and assert whichever is smaller wins — never hardcode "owner always wins the tie."

---

## 7. 5C.4 primary spend case

Starting from §6's state (owner=7000, member=3000, aggregate=10000), a Shared Stash expense of **2500**, created via the real `recordSharedStashExpense` client wrapper:

```
base_owner  = floor(2500 * 7000 / 10000) = 1750, remainder = 0
base_member = floor(2500 * 3000 / 10000) = 750,  remainder = 0
remaining cents = 2500 - (1750 + 750) = 0   -- divides exactly, no tie-break needed here
```

**Expected depletion:** owner −1750, member −750. **Expected remaining ownership:** owner = 5250, member = 2250. **Expected remaining aggregate:** 7500. Invariant: 5250 + 2250 = 7500.

**This matches the actual implementation's integer-allocation logic exactly** — confirmed via `computeSharedStashDepletionAllocation`'s BigInt floor-division formula; this particular ratio (7000:3000 against 2500) happens to divide evenly for both participants, so no remainder-ranking or tie-break is exercised by this case (that is covered separately in §8). The task's hand-computed expected values are correct and require no adjustment.

**This case ends inside 5C.4 — it is not chained into a withdrawal here.** See §18/§28 for why the further withdrawal step is reserved for 5C.7.

---

## 8. 5C.4 rounding / largest-remainder / tie-break case

The primary fixture (§7) divides evenly and cannot exercise the tie-break rule. A **separate**, deliberately minimal fixture is needed, mirroring the already-frozen Core-level unit test pattern (`tripOwnershipAccounting.ts`: `a=1,b=1,c=1,expense=1`) reduced to two real members:

```
owner ownership  = 1
member ownership = 1
expense          = 1
```
Hand-computed expected allocation:
```
total = 2
base_owner  = floor(1*1/2) = 0, remainder = (1*1) mod 2 = 1
base_member = floor(1*1/2) = 0, remainder = (1*1) mod 2 = 1
remaining cents = 1 - (0+0) = 1   -- exactly one unit to award, both remainders tie exactly
```
**Tie-break rule (confirmed in code, `tripOwnershipAccounting.ts`, `byLargestRemainder` → `byUidAscending`):** the lexicographically smaller uid receives the 1 remaining unit; the other participant receives **no allocation entry at all** (not a zero entry — the implementation never emits a zero-valued entry). Total depletion equals the expense exactly (1 = 1); no unit created or lost (enforced three times over — inside the allocation function, inside `applySharedStashDepletion`'s independent global re-check, and inside the persisted-record validator).

**Because the two participants are real Auth-emulator uids whose values are not chosen by the test (§6's constraint), the E2E assertion must read both real uids after sign-up, determine at runtime which is lexically smaller, and assert that one — not a fixed role name — receives the allocation entry.** This is a deliberate, correct design, not a workaround: the tie-break *rule* (ascending uid) is fully deterministic and already proven exhaustively at the Core/unit level (`tripOwnershipAccounting.ts`); the E2E's job is to prove this rule is correctly *wired end-to-end* against real persisted data, not to re-derive its correctness from scratch.

---

## 9. 5C.4 spender-identity invariance

Confirmed directly from the call site (`recordSharedStashExpense.ts`): `applySharedStashDepletion(input.amountMinor, balances)` takes **only** the amount and the ownership-balance array — `authUid` is passed nowhere into the allocation computation. `createdBy`/`memberUid`/`recordedBy` on the persisted Expense/withdrawal record are set to the caller's uid for audit/display purposes only (and are explicitly documented, per the 2026-09-30 preflight §5, as *"not personal attribution"* once `linkedExpenseId` is present).

**Fixture:** run the identical starting ownership (§6 or §8) through `recordSharedStashExpense` twice in two independent Trips — once with the owner as caller, once with the member as caller (both are current members, so both are authorized) — and assert the resulting depletion allocation is identical in both cases for identical starting ratios/amount. This matches the implementation exactly: spender identity affects only `createdBy`/`memberUid` bookkeeping, never the economic split.

---

## 10. 5C.4 authorization / state failure matrix

| Case | Code | Message (exact) | In 5C.4 PASS scope? |
|---|---|---|---|
| Non-member calls `recordSharedStashExpense` | `permission-denied` | `"You must be a current member of this Trip to record an expense."` | Yes |
| Invited-but-not-accepted user calls it | Same as non-member — **no separate "invited" check exists**; invitation/acceptance status is irrelevant to this callable, which only ever reads `memberIds`/`ownerId`. | Yes |
| Accepted member calls it | Succeeds (subject to every other gate below). | Yes |
| Archived Trip | `failed-precondition` | `"This trip is archived and no longer accepts new expenses."` (checked only *after* membership authorization, per the code's own explicit ordering comment — never leaks archive state to an unauthorized caller) | Yes |
| `migrating` Trip | `failed-precondition` | `"This trip's ownership model is currently being migrated or reconciled; new Shared Stash expenses are temporarily unavailable."` | Yes |
| `needs_reconciliation` Trip | **Identical** code/message to `migrating` — the gate collapses both states; the callable does not distinguish them in its own error text. | Yes |
| Insufficient ownership on an `"initialized"` Trip | `failed-precondition` | `"Insufficient Shared Stash ownership to fund this expense."` — **fixture must set aggregate == sum(ownership) exactly** (e.g. owner=100, expense=101) to exercise genuine insufficiency rather than triggering the drift-detection case below. | Yes |
| Malformed/invalid amount | `invalid-argument` | `"amountMinor must be a positive safe integer."` (validated before any Firestore read) | Yes |
| Corrupted aggregate ≠ sum(ownership) on an `"initialized"` Trip, detected mid-spend | `failed-precondition`, **and the Trip transitions `initialized → needs_reconciliation`**, zero financial mutation | distinct failure mode from plain insufficient-ownership — confirmed by existing Core-level test (`recordSharedStashExpenseOwnership.ts`: aggregate=1000, ownership-sum=900, expense=100 → rejected, Trip flagged `needs_reconciliation`, nothing written) | Yes — this detection **already exists** on the Shared-Stash-Expense path specifically (unlike the withdrawal path — §17/§26), so proving it is in scope for 5C.4. |
| Insufficient aggregate on a `"legacy"` Trip (no ownership rows at all) | `failed-precondition` | `"Insufficient Shared Stash balance for this expense."` or `"No member has positive Shared Stash ownership - this expense cannot be funded."` | **No — background only.** Per §4's scope note, 5C.4 targets `"initialized"`-Trip behavior exclusively; legacy pooled-spend behavior already has prior Core/unit coverage and is documented here for completeness, not as a 5C.4 emulator PASS requirement. |

No partial mutation occurs on any rejected case — every write happens inside one `db.runTransaction`.

---

## 11. 5C.4 persisted evidence after a successful spend

All within one atomic transaction:

- **`tripExpenses/{clientRequestId}`**: `tripId, payerUid: null, createdBy: authUid, amountMinor, currency: "USD", description, splitStrategy: "equal", paymentSource: "shared_stash", sharedStashTransactionId, status: "active", createdAt: serverTimestamp(), creationRequest` (+ optional `category`/`occurredAt`/`replacesExpenseId`). `payerUid` is always `null` — "the group fund paid, not a member."
- **`savingsTransactions/{withdrawalId}`** (id = deterministic `sha256([clientRequestId, "shared-stash-withdrawal"])`): `resourceType: "trip", resourceId: tripId, memberUid: authUid, recordedBy: authUid, amountMinor, currency, type: "withdrawal", createdAt: serverTimestamp(), reversalOf: null, linkedExpenseId: clientRequestId`.
- **`trips/{tripId}`**: `ledgerBalanceMinor` (decreased by the expense amount), `lastUpdatedAt`, `lastUpdatedBy: authUid`, `saved` (mirrored dollars).
- **`tripOwnershipAllocations/{withdrawalId}`** (only for `"initialized"` Trips, via `tx.create`, immutable): `tripId, expenseId, withdrawalTransactionId, amountMinor, currency, allocations: [...], provenance: "original", createdAt`. This is the companion audit/allocation record the task asked about — it exists, and reversal (**deferred to 5C.6, §27**) restores from this exact record rather than recomputing.
- **`tripMemberOwnership/{tripId}_{uid}`** rows for every participating member: `ownershipMinor` (new value), `lastUpdatedAt` — via `tx.update` (rows must already exist; a zero-ownership member is excluded from `balances` entirely and untouched).
- **Idempotency:** `clientRequestId` doubles as the Expense doc id; a replay is detected by `stored.createdBy === authUid` + an exact `creationRequest` match, then defensively re-verified against the full persisted field set before returning the cached result as a no-op.

The E2E must read these documents back via trusted inspection (not recompute expected math in the test and stop there) — matching the existing 5C.3D-B pattern of trusted, Rules-bypassing post-condition reads.

---

## 12. 5C.5 primary withdrawal case

From §6's state (owner=7000, member=3000, aggregate=10000), member withdraws **1200** via `recordSavingsTransaction({type: "withdrawal", memberUid: member.uid, amountMinor: 1200, ...})`:

```
applyMemberWithdrawal(3000, 1200): 1200 <= 3000 -> ok, newOwnership = 1800
applyLedgerTransition(10000, "withdrawal", 1200) -> 8800
```
**Expected:** member ownership = 1800, owner ownership = 7000 (untouched), aggregate = 8800. **Confirmed consistent with the actual implementation** — only the withdrawing member's row changes.

**This case starts fresh from §6 — it does not chain after §7's spend.** 5C.4 and 5C.5 each get their own independent fixture instance (a fresh Trip per scenario file), so neither checkpoint's result depends on the other having run. The chained version (contribute → spend → withdraw in one Trip) is reserved for 5C.7 (§18/§28).

---

## 13. 5C.5 exact ownership ceiling

- Withdraw less than ownership: succeeds (trivial case of the general check).
- Withdraw **exactly** ownership: succeeds — `applyMemberWithdrawal` rejects only `amountMinor > currentOwnershipMinor` (strictly greater); equal is permitted.
- Withdraw ownership **+ 1**: rejected, `failed-precondition` (`applyMemberWithdrawal` → `{ok: false, reason: "insufficient_ownership"}`; the callable's own message is the shared ceiling-rejection text — confirmed in existing Core tests at this exact boundary).
- **When withdrawing exactly the full ownership, the row is kept at `0` — never deleted.** Confirmed directly: the write path is `tx.update(ref, {ownershipMinor: newOwnershipMinor, ...})`; there is no delete call anywhere in this file for a `tripMemberOwnership` row. This is the implementation's actual, already-frozen behavior, not a choice this preflight is imposing.

---

## 14. 5C.5 ownership+1 failure (restated precisely)

Already covered in §13 — restated here per the task's own numbering: a withdrawal of `ownership + 1` is rejected with `failed-precondition`, zero mutation (the transaction never reaches any write), and the member's ownership row is unchanged.

---

## 15. 5C.5 no-owner-override proof

`recordSavingsTransaction` always operates on `request.auth.uid` matched against `input.memberUid` — there is **no** uid/target selector in the input schema distinct from `memberUid`. The authorization order is: membership check (`memberIds.includes(memberUid)`) → self-only check (`authUid === memberUid`). An owner attempting to withdraw on another member's behalf by setting `memberUid` to that other member's uid is rejected at the self-only check (`permission-denied`, `"You may only record a savings transaction for yourself."`) — this runs for **every** caller including the Trip owner; there is no owner-specific bypass anywhere in the code. The file's own header comment freezes this as an explicit, named product decision, not an oversight.

---

## 16. 5C.5 zero-ownership-member proof

A newly accepted member with no prior contribution has **no** `tripMemberOwnership` row at all (not a row at `0` — genuinely absent, per §6). Attempting any positive withdrawal against a missing row hits `recordSavingsTransaction.ts`'s explicit missing-row-withdrawal branch:
```ts
} else if (input.type === "withdrawal") {
  throw new HttpsError("failed-precondition", "This withdrawal exceeds your own Shared Stash ownership.");
}
```
**A missing row is never treated as zero-but-creatable, nor as unlimited — it is rejected outright, and critically, a withdrawal attempt never lazily creates a row** (only a contribution does). Existing Core-level test confirms the row still does not exist afterward and no transaction document was created. This is the direct link from the 5C.3D membership proof (a real, accepted, zero-ownership member) to the ownership model's own zero-ownership handling.

---

## 17. 5C.5 withdrawal state/authorization failure matrix (corrected this pass)

| Case | Code | Message (exact) | In 5C.5 PASS scope? |
|---|---|---|---|
| Non-member withdrawal | `permission-denied` | `"memberUid is not a current member of this resource."` (checked *before* the self-only check) | Yes |
| Invited-only (not yet accepted) user withdrawal | Same as non-member — not yet in `memberIds`, same rejection. | Yes |
| `migrating` Trip | `failed-precondition` | `"This trip's ownership model is currently being migrated or reconciled; new savings activity is temporarily unavailable."` | Yes |
| `needs_reconciliation` Trip | Identical to `migrating` (same gate, same message). | Yes |
| `ownership + 1` | `failed-precondition`, `insufficient_ownership` reason (§13/§14) | Yes |
| Aggregate insufficient (independently of ownership ceiling) | `failed-precondition` — confirmed as an **independent** check: an existing Core test exercises ownership=1000 (would permit the withdrawal) against a smaller Trip aggregate, and the aggregate check still rejects. Both checks are enforced, never short-circuited by the other passing. | Yes |
| `amount <= 0` / malformed amount | `invalid-argument` — validated before any Firestore read | Yes |
| **Archived Trip, member has positive ownership, withdraws within ceiling** | **Succeeds.** This is a positive, intentional lifecycle contract, not an omission: the archive guard in `recordSavingsTransaction.ts` applies only to *new contributions* on a `trip` resource (code comment: "withdrawals continue through every existing invariant unchanged"). A member may still withdraw their own ownership from an archived Trip, subject to the ordinary ceiling + aggregate checks — matching the existing wind-down model (an archived Trip stops accepting new pooled activity but does not trap existing members' money). **5C.5 must positively prove this succeeds, not merely note archive as inapplicable.** | Yes — as a positive success case |
| Existing-row withdrawal against a Trip where the aggregate no longer equals the true sum of all ownership rows (corruption/drift) | **No enforced rejection exists today.** `recordSavingsTransaction`'s withdrawal branch checks only (a) the acting member's own row against the ceiling and (b) the aggregate's own independent `applyLedgerTransition` check — it never re-queries the full ownership set to verify `aggregate == sum(all ownership)` before allowing a withdrawal against an *existing* row (that reconciliation check exists only on the contribution-missing-row lazy-create path and on the Shared-Stash-Expense depletion path — see §5/§26). | **No — explicitly out of scope and MUST NOT be tested as a PASS case.** Deliberately constructing this corrupted precondition and then asserting the current (unverified) withdrawal behavior as "correct" would freeze an unreviewed gap as a product contract. This is frozen instead as **KNOWN HARDENING GAP — DEFERRED TO 5C.6** (§27). |

Zero partial mutation on every rejected case (single transaction).

---

## 18. Reference / future 5C.7 backbone (NOT part of 5C.4/5C.5)

**This section is retained for its correct, independently-verified arithmetic, but the scenario it describes is explicitly NOT executed, implemented, or required for either 5C.4 or 5C.5's PASS criteria.** It is reference material for the future 5C.7 — Full Multi-Member End-to-End Validation — checkpoint, which owns the first full chained financial lifecycle. See §28 for the authoritative deferral statement.

```
A. owner creates Trip (ownershipModelState: "initialized" immediately)
B. member accepted via real invitation flow -> memberIds includes member; no ownership row yet
C. owner contributes 7000
D. member contributes 3000 (lazy row creation)
E. assert owner=7000, member=3000, aggregate=10000
F. pooled Shared Stash expense of 2500 (divides evenly, §7)
G. assert owner=5250, member=2250, aggregate=7500
H. member personal withdrawal of 1000
   applyMemberWithdrawal(2250, 1000) -> 1000 <= 2250 -> ok, newOwnership = 1250
   applyLedgerTransition(7500, "withdrawal", 1000) -> 6500
I. assert owner=5250, member=1250, aggregate=6500
```
**Final invariant:** 5250 + 1250 = 6500. Every intermediate number was independently recomputed against the actual algorithms (BigInt floor-division allocation, `applyMemberWithdrawal`, `applyLedgerTransition`), not merely copied from a prompt. No reversal performed. Every step this scenario depends on (membership acceptance, lazy ownership creation, proportional depletion with exact division, personal withdrawal ceiling) is confirmed implemented and tested today — which is exactly why it is useful as a *future* backbone, not why it belongs inside either single-checkpoint's own scope now.

---

## 19. Chosen emulator harness architecture (corrected this pass — contradiction resolved)

**Prior contradiction:** the previous revision of this document simultaneously claimed financial tests should "reuse `jest.integration.config.js` and modify the existing sequencer `ORDER`" and that "no existing committed harness file needs to change." Those cannot both be true — `tests/integration/helpers/sequencer.js` and `jest.integration.config.js` are both already committed, invitation-specific files (5C.3D-B), and modifying either one's `ORDER`/`testMatch` to accommodate financial scenarios would be a real, tracked change to the existing invitation integration surface.

**Corrected recommendation: a fully dedicated, parallel financial integration surface. The existing invitation-specific files are reused strictly unchanged — never edited — and a new, independent config/sequencer/runner is added instead.**

- `jest.integration.config.js`, `tests/integration/helpers/sequencer.js`, `tests/integration/runTripInvitationIntegration.cjs`, and `tests/integration/zzz_summary.emulator.test.ts` remain **exactly as committed**. They are the invitation suite's own files and are not touched by this checkpoint.
- A new `jest.financial-integration.config.js` is added, independently constructed from the **same base preset** (`jest-expo/jest-preset`) and the same generic transform/setup logic `jest.integration.config.js` already uses — rather than `require`-ing and spreading `jest.integration.config.js`'s own exported object. Spreading that sibling config's exports would also inherit its hardcoded `testMatch` (the invitation-only glob) and its reference to the invitation-specific sequencer, both of which would have to be immediately overridden — fragile coupling for no real benefit over independently declaring the same few generic lines. The new config sets its own `testMatch` (financial test files only), its own `testSequencer` (`financialSequencer.js`, §22), and preserves the same `120000` `testTimeout` and the same `jestSetup.js` (XHR polyfill) `setupFiles` entry, reused unchanged.
- The genuinely reusable, invitation-agnostic helpers — `firebaseIntegrationTestEnv.ts` (demo project id, loopback emulator targets, the hardened independent-signal guard), `fixtures.ts`, `trustedInspection.ts`, `assertions.ts`, `jestSetup.js` — are imported by the new financial test files exactly as committed, with zero edits.

**Corrected statement on file-change scope:** implementing this will require **one** new line in `package.json` (a new script). The prior claim of "0 existing files changed" was incorrect and is withdrawn — see §22/§23 for the exact, now-consistent file-scope list. Production source, Functions source, Firestore Rules, and every existing file under `tests/integration/` remain unchanged; they are only ever *added to*, never edited.

## 20. Frozen financial test order

Dedicated sequencer `tests/integration/helpers/financialSequencer.js`, mirroring the existing invitation sequencer's pattern but with its own `ORDER`:

```
1. tests/integration/integrationGuard.test.ts   (reused unmodified — see note below)
2. tests/integration/sharedStashSpending.emulator.test.ts
3. tests/integration/zzz_5c4_summary.emulator.test.ts
4. tests/integration/ownershipWithdrawal.emulator.test.ts
5. tests/integration/zzz_5c5_summary.emulator.test.ts
```
with `bail: 1` on the dedicated financial config, exactly as the invitation config already uses it.

**Note on step 1:** `tests/integration/integrationGuard.test.ts` is a pure, emulator-free unit test with no financial or invitation-specific content — it only exercises `resolveIntegrationGuard`. Including it in the financial config's `testMatch` (unmodified, not duplicated) is optional but recommended: it is cheap, and it re-proves the same fail-closed guard before any real emulator work starts under the *new* config/runner, rather than assuming the invitation suite's own prior proof of that guard still applies to a separately-invoked process. It requires no change to the file itself — only an additional `testMatch` entry in the new financial config.

**Consequence of this ordering, exactly as intended:**
- If 5C.4's own scenarios fail, `bail: 1` stops the run before `zzz_5c4_summary` — no `"5C.4: PASS"` line, and the run never reaches 5C.5's files at all.
- If 5C.4 passes, `"5C.4: PASS"` prints from its own dedicated summary file.
- If 5C.5's scenarios later fail (a separate run, or the same run continuing past step 3), 5C.4's already-printed `"5C.4: PASS"` remains truthfully earned — it is not retroactively invalidated by a later 5C.5 failure, and `"5C.5: PASS"` simply never prints.
- There is **no single final banner printing both milestones together.** Two separate summary files, two separate lines, matching §25/§26's separate PASS criteria exactly.

## 21. Emulator topology

Auth + Firestore + Functions, identical to 5C.3D-B. Project remains **`demo-squadstash-5c3d`** — no new demo id is justified; this is the same repository, same emulator convention, and reusing one id keeps the guard's independent-signal checks meaningful across every integration surface rather than fragmenting them. No production project involved at any point.

## 22. Membership-fixture strategy

**Recommendation: full real invitation-acceptance fixture (Option A), reusing `setupOwnerTripTermsInvitation` + a real `acceptTripInvitation` call — not a trusted local shortcut.**

5C.4/5C.5 are financial tests, not another invitation-UX test, but the financial authorization boundary for every callable in this preflight (§3, §10, §17) is `memberIds`, and the *only* way `memberIds` gains a second uid through a real, trusted path is the already-proven 5C.3D acceptance flow. A trusted local fixture helper that hand-seeds `memberIds` would be faster, but it risks silently constructing a membership state the real system can never actually produce (e.g. skipping the ownership-model `"initialized"`-gate check `acceptTripInvitation` itself performs at line 302-310) — and since that gate is cheap and already proven correct by 5C.3D-B, there is no real cost to reusing it. The existing `tests/integration/helpers/fixtures.ts` already provides every primitive needed (`setupOwnerTripTermsInvitation`, `signInAs`), **reused unchanged**; only one new call (`acceptTripInvitation`) needs to be sequenced after it per scenario, inside the new `financialFixtures.ts` helper — not a new fixture-construction mechanism and not an edit to `fixtures.ts` itself.

---

## 23. Proposed implementation file scope (not authorized to build yet)

**MODIFY:**
- `package.json` — one new script line (§24).

**ADD:**
- `jest.financial-integration.config.js`
- `tests/integration/helpers/financialSequencer.js`
- `tests/integration/runMultiMemberFinancialIntegration.cjs`
- `tests/integration/helpers/financialFixtures.ts`
- `tests/integration/helpers/ownershipInspection.ts` — the current `trustedInspection.ts` has `ownershipRowExists` but no ownership-*value* or allocation-record reader; one is needed for §11's persisted-evidence assertions.
- `tests/integration/sharedStashSpending.emulator.test.ts` — 5C.4 scenarios (§7-§10).
- `tests/integration/ownershipWithdrawal.emulator.test.ts` — 5C.5 scenarios (§12-§17).
- `tests/integration/zzz_5c4_summary.emulator.test.ts` — prints `"5C.4: PASS"` only, gated by the sequencer (§20).
- `tests/integration/zzz_5c5_summary.emulator.test.ts` — prints `"5C.5: PASS"` only, gated by the sequencer (§20).

**REUSE UNCHANGED (no edits):**
- `firebase.json`
- `jest.config.js`
- `jest.integration.config.js`
- `tests/integration/helpers/firebaseIntegrationTestEnv.ts`
- `tests/integration/helpers/fixtures.ts`
- `tests/integration/helpers/trustedInspection.ts`
- `tests/integration/helpers/assertions.ts`
- `tests/integration/helpers/jestSetup.js`
- `tests/integration/helpers/sequencer.js`
- `tests/integration/runTripInvitationIntegration.cjs`
- `tests/integration/zzz_summary.emulator.test.ts`

**NO EXPECTED CHANGE:** `firebase.ts`, `firestore.rules`, `functions/src/**`, `app/**`, `src/**`, or any existing invitation integration behavior.

**If implementation later proves an existing shared helper truly must change, STOP for review before changing it** — nothing in this preflight authorizes editing any file in the "REUSE UNCHANGED" list.

## 24. Proposed npm command / runner

```
npm run test:multi-member-financial-integration
```
mirroring the existing durable runner pattern exactly: `npm --prefix functions run build && node tests/integration/runMultiMemberFinancialIntegration.cjs`. The new runner independently sets `FUNCTIONS_DISCOVERY_TIMEOUT=30` on its own child environment (not inherited from, or shared with, the invitation runner's process) and invokes:
```
firebase emulators:exec --project demo-squadstash-5c3d --only auth,firestore,functions \
  "jest --config jest.financial-integration.config.js --runInBand"
```
Functions are built first, exactly as the invitation integration script already does. No production fallback, no new demo project id, no new emulator ports.

## 25. Separate 5C.4 PASS criteria (rewritten)

5C.4 PASS requires, independently of 5C.5:
- Accepted two-member `"initialized"`-Trip fixture (§6), built via the real invitation-acceptance flow.
- 7000/3000 → spend 2500 → 5250/2250/7500 (§7), exact.
- Exact persisted allocation record, read back by trusted inspection, not merely recomputed in-test (§11).
- Integer allocation sum exact (allocated total == expense amount, every time).
- Tie-break case (§8) proven using real runtime uid lexical ordering, not a hardcoded role.
- Caller/spender identity does not alter allocation (§9), proven both directions.
- Non-member / invited-only calls denied (§10).
- Archived Trip denied (§10).
- `migrating` Trip denied (§10).
- `needs_reconciliation` Trip denied (§10).
- Insufficient ownership on an `"initialized"` Trip denied (§10).
- Invalid amount denied (§10).
- The existing Shared-Stash aggregate-vs-ownership drift detection proven (§10) — this check **already exists** on this specific path and is in scope.
- Zero partial financial mutation on every rejected case.
- Prints `"5C.4: PASS"` from its own dedicated summary file (§20) — never combined with 5C.5's.

**Explicitly NOT a 5C.4 PASS requirement:** legacy-mode (`"legacy"`/absent ownership state) pooled-spending behavior (§4 scope note, §10) — already covered at the Core/unit level; and the §18 chained multi-step scenario (reserved for 5C.7, §28).

## 26. Separate 5C.5 PASS criteria (rewritten)

5C.5 PASS requires, independently of 5C.4:
- Accepted member starts at zero/absent ownership (§6/§16).
- Zero/absent-ownership positive withdrawal denied, no row created (§16).
- First contribution lazily creates the ownership row (§6).
- Withdrawal below ownership succeeds (§13).
- Exact-ownership withdrawal succeeds; resulting row remains at `0`, never deleted (§13/§14).
- Withdrawal of `ownership + 1` denied (§13/§14).
- Owner cannot withdraw another member's ownership (§15).
- Non-member / invited-only withdrawal denied (§17).
- `migrating` Trip denied (§17).
- `needs_reconciliation` Trip denied (§17).
- Independent aggregate insufficiency denied, even when the per-member ceiling alone would have permitted it (§17).
- **Archived Trip valid self-withdrawal succeeds** — proven as an intentional, positive wind-down-model assertion (§17), not skipped and not mislabeled "not applicable."
- Only the withdrawing member's own ownership changes; no other member's row is touched (§12/§15).
- Zero partial mutation on every rejected case.
- Prints `"5C.5: PASS"` from its own dedicated summary file (§20) — never combined with 5C.4's.

**Explicitly NOT a 5C.5 PASS criterion:** pre-existing aggregate-vs-full-ownership-set corruption detection on the withdrawal path (§17). No such check exists in the current implementation for a withdrawal against an already-existing row, and this preflight does not authorize either (a) inventing that check during 5C.5, or (b) deliberately corrupting the precondition and asserting today's unverified behavior as a correct, frozen contract. It is deferred to 5C.6 (§27).

One checkpoint failing must never mark the other complete — achieved structurally by keeping them in separate test files with separate final banners under one shared `bail: 1` sequencer (§20), exactly as 5C.3D-B's `zzz_summary` pattern already demonstrates is reliable.

## 27. Deferred to 5C.6 (expanded this pass)

Inventoried, not analyzed in depth, not test-designed here:
- **Withdrawal-path reconciliation hardening (newly frozen as explicitly deferred this pass):** whether an existing-row personal withdrawal must query the complete ownership set and independently verify `Trip.ledgerBalanceMinor == sum(all ownershipMinor)` before applying the withdrawal — today it does not. A parallel question for contributions: whether an existing-row contribution (as opposed to the already-checked missing-row lazy-create path) needs an analogous verification. 5C.6 must determine and harden:
  - whether that verification should be added to either/both paths;
  - how a detected drift transitions `initialized → needs_reconciliation` atomically and durably for a withdrawal (the `recordSharedStashExpense` depletion path already has a working pattern for this — a `{kind: "success" | "reconciliation_failed"}` sentinel/co-transaction approach — but `recordSavingsTransaction`'s current return/throw contract does not support it without a broader restructuring, per the code's own explicit deferral comment);
  - how such a state-flip survives an otherwise-aborted financial operation, matching the existing idempotent-replay guarantees.
- `reverseSharedStashExpense` — full reversal correctness (restores from the immutable `tripOwnershipAllocations` record via `restoreSharedStashDepletion`, never recomputes split; gated by the same `migrating`/`needs_reconciliation` block; authorized to Trip owner or original `createdBy`).
- `reverseTripExpense` / `reverseTripSettlement` — out-of-pocket expense and settlement reversal (neither calls the ownership-model gate at all; `reverseTripSettlement`'s authorization is narrower — only the settlement's own `toUid`, no owner override).
- Contribution-reversal interactions with ownership (no contribution-reversal callable was found in this pass — flagged as an open question, not resolved here).
- Reconciliation-failure hardening and the full `needs_reconciliation → initialized` repair path (`migrateTripOwnership.ts`, `tripOwnershipMigrationDigest.ts`, `tripOwnershipMigrationReplay.ts`) — skimmed for purpose only.
- Corrupted-allocation reversal and partial-historical-state recovery.
- The member-removal/exit policy noted by `TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md` §19 (financial membership cannot be removed while holding positive ownership) — relevant context, not this checkpoint's job to test.

## 28. Deferred to 5C.7 (expanded this pass)

The §18 combined scenario (owner/member accepted → contributions 7000/3000 → pooled expense 2500 → member withdrawal 1000 → final 5250/1250/6500) is the candidate financial backbone for this future checkpoint. **It is explicitly NOT executed, implemented, or required in 5C.4 or 5C.5** — both checkpoints use their own independent, freshly-created Trip fixtures (§7, §12) and prove their own operation type in isolation.

5C.7 — Full Multi-Member End-to-End Validation — will combine, in one chained lifecycle:
```
membership
terms acceptance
contributions
Shared Stash spending
ownership withdrawal
reversal/reconciliation
authorization
final invariant verification
```
using §18's numbers as a starting reference point, extended with whatever reversal/reconciliation steps 5C.6 ends up hardening.

## 29. Blockers / open questions

- **No blocking discrepancy was found** between the frozen architecture docs and the current implementation for anything this preflight needed to freeze test numbers against.
- **Open, non-blocking question:** whether a dedicated contribution-reversal callable exists or is planned — not found in this pass; flagged for whoever scopes 5C.6.
- **Open, non-blocking question:** `functions/src/domain/tripExpenseSplits.ts` was confirmed unrelated to Shared Stash expenses (not imported by `recordSharedStashExpense.ts`) — fine for this preflight's purposes, but worth confirming it stays that way if `recordTripExpense` (out-of-pocket) is ever touched by a future checkpoint.
- **Design note, not a blocker:** achieving the ascending-uid tie-break deterministically in a real-Auth-emulator E2E (§8) requires runtime uid comparison rather than a hardcoded winner — this is a test-authoring detail to get right during implementation, not an architectural gap.
- **Resolved this pass (previously an open contradiction):** the harness-scope contradiction described in §19's revision note is now resolved by freezing a fully dedicated financial config/sequencer/runner.

## 30. GO / STOP recommendation

**GO** to proceed toward implementing 5C.4 and 5C.5 as two separate checkpoints, using the file scope/command proposed in §23/§24, once each is separately authorized. Every callable contract, data model field, state-machine value, allocation algorithm, and authorization rule this preflight needed was found already implemented and already unit/Core-tested for the `"initialized"`-Trip, non-reversal scope these two checkpoints actually own — this is a wiring/E2E-proof task against a stable, frozen backend, not new backend design. Implementing it will require exactly one new `package.json` script line; no production source, Rules, Functions source, or any existing committed harness file needs to change.

---

## Revision log (this pass)

1. **Harness-scope contradiction fixed** (§19): the document no longer proposes modifying `jest.integration.config.js` or `tests/integration/helpers/sequencer.js`. A fully separate `jest.financial-integration.config.js` + `financialSequencer.js` + `runMultiMemberFinancialIntegration.cjs` is frozen instead. The false "0 existing files change" claim is withdrawn — `package.json` requires one new line.
2. **Financial test order frozen** (§20): explicit 5-step sequencer order with `bail: 1`, two separate summary files/banners, never one combined banner.
3. **Withdrawal reconciliation gap reclassified** (§17/§27): no longer implied as an accepted 5C.5 correctness contract; frozen as `KNOWN HARDENING GAP — DEFERRED TO 5C.6`, with the specific open questions 5C.6 must resolve spelled out.
4. **Archived-Trip withdrawal reframed** (§17/§26): from "not applicable" to an explicit, positive 5C.5 PASS requirement proving the wind-down model.
5. **Combined scenario moved out of 5C.4/5C.5** (§18/§28): retained as reference arithmetic only, explicitly not part of either checkpoint's implementation or PASS criteria, reassigned to 5C.7.
6. **5C.4 scoped to `"initialized"`-Trip behavior only** (§4/§10/§25): legacy-mode pooled-spend behavior marked background-only, not a PASS requirement.
7. **File scope corrected** (§23) to the exact MODIFY/ADD/REUSE-UNCHANGED split, matching §19's resolved architecture.
8. **Runner/command frozen** (§24) with its own independent `FUNCTIONS_DISCOVERY_TIMEOUT=30` and its own config file reference.
9. **PASS criteria rewritten** (§25/§26) to match every correction above.
10. Stale cross-reference in §11 (previously pointed at the wrong section number for "reversal, deferred") corrected to point at §27.
11. **(Consistency cleanup pass)** Four stale cross-references that said `§27` while actually discussing the future 5C.7 combined/backbone scenario (§18's withdrawal-step note, the primary-withdrawal-case note, the §18 section's own lead-in, and the 5C.4-PASS-exclusions note) were corrected to point at §28, where the 5C.7 deferral actually lives. Every remaining `§27` reference was individually re-checked and confirmed to legitimately concern 5C.6/reconciliation/reversal, and was left unchanged. No architecture or content changed — this was a cross-reference-numbering fix only.

**Nothing beyond this document was created or modified.**
