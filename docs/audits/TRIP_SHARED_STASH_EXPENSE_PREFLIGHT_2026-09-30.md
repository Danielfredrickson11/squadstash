# Trip Shared-Stash-Funded Expense — Architecture Preflight (4F.0)

Date: 2026-09-30
Baseline HEAD: `c48bd60` ("Migrate Firebase Functions runtime to Node 22")
Status: **ARCHITECTURE + AUDIT ONLY — NOT YET IMPLEMENTED**

This document is the sole artifact of Checkpoint 4F.0. No app/component/domain/
service/function/Rules code was modified to produce it. No production
financial write, Expense create/reverse/correct, or Shared Stash balance
mutation was performed. Nothing was deployed, committed, or pushed.

---

## 1. Executive Summary

Today, a Trip Expense can only be `paymentSource: "member_out_of_pocket"` —
the Expense Create UI hardcodes this value, and `recordTripExpense`'s backend
validator explicitly rejects any other payment source. A member who spends
from the Trip's **Shared Stash** (the group's pooled savings, funded via
`recordSavingsTransaction`) to cover a group cost today has no way to record
that as an Expense at all — the two systems (Shared-Stash ledger and Trip
Expenses/Splits/Settlements) are completely disconnected for this case.

This preflight designs the complete accounting/write model for a Shared
Stash-funded Expense: a new trusted, atomic, idempotent write path that in
**one Firestore transaction** creates the Expense, withdraws the funds from
the Shared Stash ledger, and updates the Trip's cached ledger balance — with
zero pairwise member debt, a symmetric atomic reversal, and no Firestore
Rules or index changes required.

**This preflight explicitly reverses a prior architectural decision.** Both
`TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md` and
`TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md` recommended (and
generalized, respectively) a deliberately **non-atomic, two-step,
client-orchestrated** design for this exact feature ("client calls
`recordSavingsTransaction` first, then `recordTripExpense`... if step 2
fails, the withdrawal still happened and the ledger remains true;
reconcilable later"). This checkpoint's own constraints require the opposite:
**one atomic trusted backend operation**. Section 3 documents this
supersession explicitly; it is not a silent overwrite.

---

## 2. Current-State Audit

### 2.1 Documents reviewed
- `docs/audits/TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md`
- `docs/audits/TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md`
- `docs/audits/TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md`
- `docs/audits/TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md`
- `docs/audits/TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md`

### 2.2 Source files reviewed
- `src/types/domain/expense.ts`, `src/types/domain/savingsTransaction.ts`,
  `src/types/domain/trip.ts`
- `functions/src/callables/recordSavingsTransaction.ts`,
  `recordTripExpense.ts`, `reverseTripExpense.ts`
- `functions/src/domain/tripExpenseSplits.ts`, `src/domain/tripExpenseSplits.ts`
- `src/domain/savingsBalance.ts`
- `src/services/firebase/savingsTransactions.ts`
- `app/(tabs)/trips/[tripId]/index.tsx` (Shared Stash Add Money/Withdraw UI)
- `app/(tabs)/trips/[tripId]/expenses/create.tsx`, `[expenseId].tsx`
- `firestore.rules` (lines 297–443), `firestore.indexes.json`

### 2.3 What already exists
- `Expense.paymentSource` is already a discriminated union with a
  `shared_stash` variant reserving a `sharedStashTransactionId` field —
  **the type was already designed for this**, but no write path populates it.
- `recordTripExpense.ts` explicitly rejects any `paymentSource !==
  "member_out_of_pocket"` at input validation — shared_stash is a hard no-op
  on the existing callable today.
- `SavingsTransaction` already supports `resourceType: "trip"` withdrawals
  (used today only by the Trip's own self-attributed "Withdraw" button, never
  linked to an Expense).
- Both `savingsTransactions` and `tripExpenses`/`tripExpenseSplits` Firestore
  Rules already fully deny client `create`/`update`/`delete` — any new
  write path is necessarily a new trusted callable using the Admin SDK.
- `recordTripExpense.ts` already proves one `runTransaction()` can
  atomically span `tripExpenses` + `tripExpenseSplits` + a correction-link
  update to an old Expense — i.e. there is no technical barrier to a
  transaction that also includes `savingsTransactions` + `trips` writes.

### 2.4 What is currently blocking the feature
- No callable accepts `paymentSource: "shared_stash"`.
- No deterministic link exists between an Expense and a withdrawal.
- No UI affordance exists to choose Shared Stash as a payment source.
- The two prior audits' own recommended design (two-step, client-orchestrated)
  is incompatible with this checkpoint's atomicity mandate and must not be
  implemented as previously written.

---

## 3. Atomicity Decision (supersedes 2026-09-13 / 2026-09-17)

**FROZEN: One atomic `db.runTransaction()`** spanning, in a single commit:
read Trip (membership/archive/balance) → idempotency check (Expense id +
derived withdrawal id) → write `tripExpenses` → write `savingsTransactions`
withdrawal → update `trips.ledgerBalanceMinor`/`saved`. No step is allowed to
observably succeed without the others.

**Why the prior two-step design is rejected:** a client-orchestrated
"withdraw, then create Expense" sequence leaves a window where the
withdrawal succeeded but the Expense never exists — the group's money is
gone from the Shared Stash with no Expense record to explain it, recoverable
only through manual reconciliation. That was an acceptable trade-off for the
*original* non-financial-domain feature set those audits covered; it is not
acceptable for a feature whose entire purpose is "the group's pooled money
was spent on X." This checkpoint's constraints state the requirement
directly, and `recordTripExpense.ts`'s own existing multi-collection
transaction proves it is technically straightforward.

This supersession applies **only** to the *create* sequence's internal
steps. It does not change the already-separate-and-still-valid pattern of
Expense creation and Expense reversal being two distinct trusted callables
(see §12/§14) — that separation is about distinct user actions, not about
one action's internal steps being split across an unsafe gap.

---

## 4. Ledger Accounting Primitive

`recordSavingsTransaction.ts` conflates pure ledger arithmetic (init balance,
legacy-migration, overdraft check, new-balance computation) with
product-specific authorization (self-only, membership, archive-on-
contribution, currency match) in one function body.

**FROZEN: defer extraction, duplicate first — but duplicate the full
canonical behavior, not a simplified approximation of it.** Re-reading
`recordSavingsTransaction.ts`'s current implementation (`functions/src/
callables/recordSavingsTransaction.ts:220-328`) confirms the Trip
ledger-balance transition is **not** a bare `ledgerBalanceMinor -
amountMinor`. The canonical behavior `recordSharedStashExpense` must
reproduce exactly, for the same pre-transaction Trip state, is:

1. **Idempotent-replay check first.** Read the transaction doc at the
   (derived) id before anything else. An exact-fact replay returns the
   already-committed `ledgerBalanceMinor` as-is; a different-request
   collision is rejected (`already-exists`) before any ledger logic runs.
2. **Ledger-state classification**, based on which of
   `ledgerOpeningBalanceMinor` / `ledgerBalanceMinor` exist on the Trip
   document:
   - **Both present (already-initialized Trip):** both must be safe,
     non-negative integers or the write is rejected
     (`failed-precondition`); `currentBalanceMinor = ledgerBalanceMinor`.
   - **Neither present (legacy/uninitialized Trip):** first query
     `savingsTransactions` for this `resourceId` (limit 1) — if any exist,
     reject (`failed-precondition`: history exists but no initialized
     ledger state, a corruption guard). If none exist, derive a legacy
     opening balance from the Trip's legacy dollars field (`saved ?? 0`),
     validate it is a finite number `>= 0`, convert to minor units via
     `Math.round(legacyDollars * 100)`, and validate the result is a safe
     integer. This becomes both `currentBalanceMinor` and the
     `ledgerOpeningBalanceMinor` to persist on this same write (ledger
     initialization happens exactly once, on the first transaction against
     an uninitialized Trip).
   - **Exactly one of the two present (partial/corrupt state):** reject
     (`failed-precondition`) unconditionally — never guessed or
     auto-repaired.
3. **Currency resolution/validation:** resolve the Trip's effective currency
   from its own `currency` field if present (must be a non-empty string),
   defaulting to `"USD"` only if the field is entirely absent; reject if the
   request's currency does not match exactly.
4. **Balance transition:** `newBalanceMinor = currentBalanceMinor +
   signedDelta` (a withdrawal is a negative delta); reject
   (`failed-precondition`) if the result is not a safe integer or is
   negative ("insufficient funds").
5. **Cached-field synchronization on write:** the Trip document update must
   set `ledgerBalanceMinor: newBalanceMinor`, `lastUpdatedAt`,
   `lastUpdatedBy`, **and** the legacy dollars mirror field `saved:
   newBalanceMinor / 100` — and, only on first initialization (step 2's
   "neither present" branch), also persist `ledgerOpeningBalanceMinor`.

**Frozen invariant:** `recordSharedStashExpense` must produce exactly the
same canonical starting-balance interpretation and Trip
cached-balance-field synchronization that the existing Trip withdrawal path
(`recordSavingsTransaction`) would produce for the same pre-transaction Trip
state — including both already-initialized and legacy/uninitialized Trips,
and including the `saved`/`ledgerOpeningBalanceMinor` mirror-field writes,
not merely the `ledgerBalanceMinor` integer itself.

Extracting a shared primitive now would require touching the already-
deployed, production `recordSavingsTransaction.ts` in the same change that
introduces a brand-new, untested callable — unnecessary combined regression
risk. 4F.1 therefore duplicates this full canonical sequence (not a
simplified subset of it) inline. Once the new callable exists and both call
sites can be refactored together under full test coverage, a future
checkpoint (proposed as 4F.5, see §24) should extract a pure
`applySavingsLedgerTransition(parentData, type, amountMinor, currency)`
helper — covering steps 2–5 above — shared by both. This mirrors the
"smallest robust fix first" approach already used in 4E.8.

---

## 5. `SavingsTransaction` Attribution Semantics for Group-Funded Spend

Confirmed by audit: `deriveMemberSavingsBalanceMinor` (src/domain/
savingsBalance.ts) filters transactions by `memberUid` to compute **personal**
per-member contribution/withdrawal totals, and the existing Shared Stash
Add Money/Withdraw UI (`app/(tabs)/trips/[tripId]/index.tsx`) explicitly
comments that `memberUid` is "self-attributed... never a client-chosen other
member." `memberUid` is a load-bearing personal-attribution field today, not
a free-form "who recorded this" field — that role already belongs to the
separate `recordedBy` field.

Setting `memberUid` to the Expense creator's uid for a group-funded
withdrawal would corrupt that member's personal contribution/withdrawal
totals, falsely implying they personally withdrew money they merely recorded
spending on behalf of the group — exactly the failure mode this checkpoint
warns against.

**FROZEN (Option D — discriminator field, not a schema-breaking nullable
migration):**
- Add a new optional field `linkedExpenseId?: string` to
  `SavingsTransactionBase`. Its presence is the authoritative signal that a
  transaction is Expense-linked/institutional spend, not personal activity.
  Absence (every existing historical transaction) means "ordinary personal
  transaction," preserving full backward compatibility.
- `memberUid` remains required (no nullable migration, no ripple into every
  existing reader). For a Shared-Stash-Expense withdrawal, it is populated
  with the Expense creator's uid — but this value is explicitly documented
  as **not personal attribution** whenever `linkedExpenseId` is present.
- `deriveMemberSavingsBalanceMinor` must be updated (future implementation
  checkpoint, not this one) to exclude any transaction with a non-null
  `linkedExpenseId` from personal per-member sums, so group-funded spend
  never pollutes an individual's contribution/withdrawal history.
- Any future "member-earmarked/attributable funds" feature can introduce its
  own discriminator without colliding with this one, since `memberUid`'s
  existing meaning for ordinary transactions is left untouched.

Options considered and rejected: (A) reuse `memberUid` as the creator with no
discriminator — rejected, the exact falsehood this checkpoint warns against;
(B) make `memberUid` nullable — rejected for this checkpoint, a larger,
riskier type/schema migration than the problem requires; (C) a bare
`source: "member" | "trip_expense"` enum with no reverse link — rejected in
favor of D, which gives the same discriminator *and* a queryable reverse
link for free.

---

## 6. Expense ↔ Ledger Linkage

**FROZEN:**
- The Expense's own document id continues to be the client-supplied
  `clientRequestId` (unchanged from `recordTripExpense`'s existing
  convention).
- The withdrawal's `savingsTransactions` document id is **deterministically
  derived**, server-side, from that same `clientRequestId`:
  `sha256(JSON.stringify([clientRequestId, "shared-stash-withdrawal"]))` —
  the exact pattern `splitDocumentId` already establishes
  (`functions/src/domain/tripExpenseSplits.ts:396`) for deriving one
  deterministic child id from a parent id plus a discriminant.
- The client never supplies or sees a separate "Shared Stash transaction id"
  input — this closes, by construction, any risk of a client forging an
  arbitrary `sharedStashTransactionId`.
- Forward link: the Expense's `sharedStashTransactionId` field (already
  reserved in `src/types/domain/expense.ts`) is populated with this derived
  id.
- Reverse link: the withdrawal's new `linkedExpenseId` field (§5) is
  populated with the Expense's id (= the original `clientRequestId`).

---

## 7. Request-ID Strategy

**FROZEN:** a single client-generated `clientRequestId` represents the whole
logical "create this Shared-Stash Expense" operation — identical in spirit to
every other trusted callable in this codebase. It becomes the Expense's own
document id; the withdrawal's id is deterministically derived from it
(§6). A retried submit with the same `clientRequestId` is naturally
idempotent: both document ids are identical on retry, so the transaction's
own idempotency check (§9) classifies it as an exact replay rather than a
new write.

---

## 8. Insufficient Funds / Overdraft

**FROZEN: backend-authoritative, transaction-internal rejection.** Inside the
same atomic transaction, after reading the Trip's current
`ledgerBalanceMinor`, the withdrawal is rejected (no writes committed) if it
would drive the balance negative — mirroring `recordSavingsTransaction`'s
existing overdraft behavior exactly. Any client-side balance display is
advisory only, exactly as today's Shared Stash Add Money/Withdraw UI already
treats it; the backend check is the only one that matters for correctness.

---

## 9. Authorization — **FROZEN (final)**

Ordinary Expense creation (`recordTripExpense`) permits **any current Trip
member** to create an Expense, regardless of who is the payer.

Correction from the initial draft: this preflight previously stated that a
more restrictive alternative would require inventing a new "organizer"
role. That was a factual error. The Trip model already has an ownership
concept — `ownerId` (`src/types/domain/trip.ts`) — and
`reverseTripExpense.ts` already uses it today (`tripData.ownerId ===
authUid`, one half of its existing `isOwner || isOriginalCreatorStillMember`
reversal-authority check; `isCurrentTripMember` also treats `ownerId` as an
automatic member alongside `memberIds`). The accurate description of the
restrictive alternative is: **restrict Shared-Stash Expense creation to the
Trip's existing `ownerId`** — not inventing any new role, organizer,
admin, or approver concept.

**FROZEN: any current Trip member may create a Shared-Stash-funded
Expense.** This is now a final product decision, not an open question:

- This matches existing ordinary Expense-creation authorization exactly —
  no new rule, no new concept, consistent with every other Trip write.
- SquadStash's Shared Stash is an application-level ledger/bookkeeping
  record: this callable records that pooled Trip funds were used for a
  purchase. It does not itself move money through a bank or payment rail,
  so the consequence of a broader authorization rule is bookkeeping
  accuracy, not custody of real funds.
- Restricting creation to `ownerId` may be reconsidered later if SquadStash
  introduces actual custody, real payment execution, approval workflows, or
  more granular Trip roles — none of which exist today and none of which
  belong in Checkpoint 4F.
- No new `organizer`, `createdBy-as-organizer`, admin, approver, or role
  system is introduced by this feature. `ownerId` already exists and is
  already used elsewhere (`reverseTripExpense.ts`), but 4F deliberately does
  not use it to gate creation.

There are **zero remaining HUMAN PRODUCT DECISION REQUIRED items** in this
preflight after this correction.

---

## 10. Archived-Trip Behavior

Already settled precedent: contributions and new Expense creation are
archive-gated; withdrawals, Settlement creation/reversal, and Expense
reversal are not (all are "resolving existing facts," not new spending).

**FROZEN:** creating a **new** Shared-Stash Expense is new spending, exactly
like ordinary out-of-pocket Expense creation — it is **archive-gated**
(rejected once `archivedAt` is set). This is distinct from, and must not be
confused with, the already-settled rule that an ordinary Shared-Stash
**withdrawal** (not tied to a new Expense) remains available on an archived
Trip so a nonzero balance can still be brought to zero. Reversal of a
Shared-Stash Expense is not archive-gated, consistent with all other
reversal paths.

---

## 11. Are Splits Required for Shared-Stash Expenses?

Explicitly deferred by `TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md`
and `TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md` to this preflight.

`ExpenseSplit` exists solely to represent a debt edge: "participant owes
payer." A Shared-Stash Expense has no personal payer to be owed — the group
fund already paid in full, and nobody owes anybody as a result. Forcing a
split into this schema would require inventing a meaningless "owed to the
group" sentinel with no corresponding settlement action (you cannot "settle
up" with the Shared Stash; the money already left the pool, permanently).

**FROZEN: no `tripExpenseSplits` documents are created for a
`shared_stash` Expense.** `useTripBalances`'s debt engine (4E.4) consumes
only `tripExpenseSplits` + `settlements` as its two input sources — a
Shared-Stash Expense with zero splits therefore contributes exactly zero
entries to the pairwise debt graph, by construction (see §13 for the
mathematical verification). If a future enhancement wants to show "who
benefited" from group spending for reporting purposes, that is new,
separate, non-debt metadata and out of this checkpoint's scope.

---

## 12. Pairwise Debt — Zero-Debt Verification

Per §11, a Shared-Stash Expense writes zero `tripExpenseSplits` documents.
`useTripBalances` (the sole consumer of Expense debt data, per 4E.4) only
aggregates debt from `tripExpenseSplits` rows. A document set with zero
members contributes the empty sum to every pairwise aggregation. Therefore a
Shared-Stash Expense contributes **exactly zero** pairwise member debt,
mathematically, by construction — not by a special case the balance engine
needs to know about.

---

## 13. Reversal / Refund Design

**FROZEN: one atomic `db.runTransaction()`**, mirroring `reverseTripExpense`'s
existing structure, that in a single commit: marks the original
`tripExpenses` document reversed (same field convention as
`reverseTripExpense` today) and writes an offsetting **contribution**
`savingsTransactions` document of equal amount back into the Shared Stash.

**Correction from the initial draft:** the reversal does **not** restore the
Trip's `ledgerBalanceMinor` "to exactly its pre-withdrawal value." That
wording was incorrect whenever any unrelated Shared Stash activity occurred
between the original withdrawal and its reversal. Example: starting balance
$1,000 → Shared-Stash Expense −$200 → $800 → an unrelated later
contribution +$100 → $900 → reverse the Expense → correct result is
**$1,100**, not a restored $1,000.

**Frozen invariant:** a Shared-Stash Expense reversal removes exactly the
original Expense withdrawal's net ledger effect **once**, by adding the
original Expense amount back to the Trip's **current** canonical ledger
balance — read fresh, inside the reversal transaction, via the same
ledger-state read §4 describes — never by storing or restoring an old
absolute balance snapshot. All unrelated transactions that occurred before
or after the original Expense, in either direction, are preserved exactly
as they already are; the reversal only ever applies its own single
offsetting delta on top of whatever the current balance happens to be at
reversal time.

The refund document's id is deterministically derived from the reversal's
own `clientRequestId` (same scheme as §6); its `reversalOf` field is set to
the original withdrawal's id — the **first real use** of `reversalOf`,
which exists on the type today but is always written `null` by every
current write path. Exact-replay idempotency (per §7/§16) ensures a retried
reversal request never applies the refund twice. No Splits exist to reverse
(per §11).

---

## 14. Reversal Authority

**FROZEN:** identical to `reverseTripExpense`'s existing rule —
`isOwner || isOriginalCreatorStillMember`. No new authority rule is
introduced; this preflight found no reason a Shared-Stash Expense's reversal
should be governed differently from any other Expense's reversal.

---

## 15. Correction Workflow

**FROZEN:** correction remains **reverse, then create** — two separate
trusted calls (reverse the old Shared-Stash Expense atomically per §13, then
create a new one atomically per §3), exactly mirroring the existing
out-of-pocket Expense correction pattern from
`TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md`. This is **not**
in tension with §3's atomicity mandate: §3 rejects splitting *one logical
create operation's own internal steps* across an unsafe gap; it does not
require merging two genuinely separate user-initiated actions (reverse,
create-replacement) into one mega-transaction. If the reversal half succeeds
but the create half fails, the Trip is left in a well-defined "reversed, not
yet replaced" state — the same recoverable state ordinary Expense correction
already tolerates today.

---

## 16. Ambiguous-Outcome / Idempotency Recovery

**FROZEN: reuse, don't reinvent.** The exact ambiguous-replay classification
pattern already proven three times — Expense reversal, Settlement creation
(4E.6A), Settlement reversal (4E.7) — via the generic
`reduceReversalOutcome` / `isDefinitiveDifferentRequestFailure` domain
helpers should be extended to cover Shared-Stash Expense create/reverse
rather than a fourth bespoke copy. The new callable's error responses should
distinguish "exact replay" from "different-request collision" using the same
shape those helpers already expect.

---

## 17. UI Flow Design Contract (for the eventual implementation checkpoint)

- The Add Expense form's payment-source control (today hardcoded to
  `member_out_of_pocket`) gains a `shared_stash` option.
- Selecting it hides payer-selection and the split editor entirely (no
  splits are collected or sent, per §11) and instead shows the Trip's
  current Shared Stash balance plus an insufficient-funds-blocking
  affordance (advisory; backend is authoritative per §8).
- Expense Detail/History rows must render a Shared-Stash Expense visibly
  differently from a member-paid one — e.g. "Paid from Shared Stash" rather
  than "Paid by Daniel" — since there is no personal payer to name.
- The linked Shared Stash transaction-history row must render as something
  like "Spent on <description>" (using `linkedExpenseId`), never as "Daniel
  withdrew $X" — directly avoiding the misleading-personal-attribution
  failure mode §5 exists to prevent.
- Reversal/correction UI reuses the existing `ReverseExpenseDialog`-style
  pattern unchanged; only the underlying callable differs.

---

## 18. Privacy Boundary

**FROZEN: no new privacy surface.** A Shared-Stash Expense and its linked
withdrawal are visible to exactly the same Trip-membership-gated audience as
any other Expense or SavingsTransaction already is (`resourceId`/Trip
membership scoping is unchanged). No cross-Trip or cross-member data leak is
introduced by this feature.

---

## 19. Firestore Rules Impact

**FROZEN: none.** Confirmed by direct reading of `firestore.rules`
(lines 297–443): `savingsTransactions` already has unconditional
`allow create: if false` / `allow update, delete: if false` (reads gated by
`canAccessParent`), and `tripExpenses`/`tripExpenseSplits` already have
unconditional `allow create, update, delete: if false` (reads gated by
`canAccessTripById`). A new trusted callable using the Admin SDK bypasses
Rules entirely, exactly like every other trusted write path in this
codebase. No Rules file changes are required or proposed.

---

## 20. Firestore Index Impact

**FROZEN: none.** The new withdrawal document uses the exact same
`(resourceType, resourceId, createdAt)` shape every existing
`savingsTransactions` query already relies on
(`firestore.indexes.json`'s single composite index for that collection) —
`resourceType: "trip"`, `resourceId: tripId` is already a value this index
covers. The Expense document is just another row in `tripExpenses`/
`tripExpenseSplits` using existing query shapes unchanged. No new index is
required.

---

## 21. Failure Matrix — Creation

| Failure point | Behavior |
|---|---|
| Caller not a current Trip member | Reject before any read of Trip financial state (anti-enumeration — matches existing `recordTripExpense`/`recordSavingsTransaction` ordering where authorization never leaks resource state) |
| Trip archived | Reject (archive-gated, §10) |
| Exact replay (`clientRequestId` matches a prior successful create) | Idempotent no-op success — return the original result |
| Different-request collision (`clientRequestId` reused with different facts) | Reject as a definitive different-request failure (same classification §16 reuses) |
| Trip ledger in a partial/corrupt initialization state (exactly one of `ledgerOpeningBalanceMinor`/`ledgerBalanceMinor` present) | Reject (`failed-precondition`), no partial write (§4) |
| Uninitialized Trip with pre-existing `savingsTransactions` history | Reject (`failed-precondition`) — ambiguous legacy state, never auto-repaired (§4) |
| Insufficient Shared Stash balance (from either an already-initialized or freshly-legacy-derived starting balance) | Reject atomically, no partial write (§4, §8) |
| Any step fails inside the transaction | Entire transaction aborts — no Expense, no withdrawal, no ledger change ever becomes visible (§3) |
| Transient network/Firestore error after commit, before client sees response | Client must retry with the **same** `clientRequestId` — resolves via the exact-replay path, never a double withdrawal |

## 22. Failure Matrix — Reversal

| Failure point | Behavior |
|---|---|
| Caller lacks reversal authority | Reject before any state is read (§14) |
| Expense already reversed, exact-replay reversal request | Idempotent no-op success |
| Expense already reversed, different-request reversal collision | Reject as definitive different-request failure (§16) |
| Any step fails inside the transaction | Entire reversal aborts — Expense remains un-reversed, no refund ever becomes visible (§13) |
| Unrelated Shared Stash activity occurred between the original withdrawal and the reversal | Refund still applies the original Expense amount against the *current* balance at reversal time; unrelated activity is preserved exactly, never overwritten by a restored historical snapshot (§13) |
| Correction's create-half fails after reverse-half succeeded | Trip left in "reversed, not yet replaced" — same recoverable state ordinary correction already tolerates (§15) |

---

## 23. Phased Test Plan

1. **Unit** — deterministic id derivation (§6), overdraft rejection (§4/§8),
   archive-gating (§10), zero-split invariant (§11), `linkedExpenseId`
   discriminator population (§5).
2. **Unit** — `deriveMemberSavingsBalanceMinor` excludes `linkedExpenseId`-
   tagged transactions from personal attribution sums (§5, a required
   accompanying domain-layer change).
3. **Unit/integration — canonical ledger-state preservation (§4):**
   a. an already-initialized Trip (`ledgerOpeningBalanceMinor` and
      `ledgerBalanceMinor` both present) withdraws correctly from its
      existing `ledgerBalanceMinor`;
   b. a legacy/uninitialized Trip (neither field present, no prior
      `savingsTransactions` history) correctly derives its starting balance
      from `saved` and persists `ledgerOpeningBalanceMinor` on this same
      write, exactly as `recordSavingsTransaction` would;
   c. insufficient funds is rejected from each applicable starting-state
      shape (already-initialized and freshly-legacy-derived);
   d. after a successful create, the Trip's cached fields
      (`ledgerBalanceMinor`, `saved`, and — only on first init —
      `ledgerOpeningBalanceMinor`) are consistent with the existing savings
      ledger contract.
4. **Integration (emulator)** — full atomic create: Expense + withdrawal +
   Trip ledger update all appear together or not at all; exact-replay
   idempotency; different-request collision rejection; insufficient-funds
   rejection leaves zero writes; a partial/corrupt ledger-init state is
   rejected without writes.
5. **Integration (emulator)** — full atomic reversal: refund applies the
   original Expense amount against the Trip's *current* balance at
   reversal time; `reversalOf` correctly set; exact-replay and collision
   handling match §16.
6. **Integration (emulator) — intervening-transaction reversal test:**
   create a Shared-Stash Expense, then perform an unrelated valid Shared
   Stash transaction (e.g. a contribution), then reverse the Expense.
   Assert the final balance equals the current balance *immediately before
   the reversal* plus the original Expense amount — explicitly **not**
   the historical balance that existed immediately before the Expense was
   first created.
7. **Rules tests** — explicit negative-path confirmation that direct client
   writes to both collections remain denied (no Rules changes, but existing
   coverage should be re-run, not assumed).
8. **UI** — `useTripBalances` with a Shared-Stash Expense present in the
   fixture set resolves to zero added pairwise debt (§12); BalanceRow/
   SettlementRow render unaffected.
9. **UI** — Shared-Stash-Expense row and linked Shared-Stash history row
   render per §17's design contract (no "Daniel withdrew" misattribution).

---

## 24. Proposed Implementation Checkpoint Sequence

- **4F.1 — `recordSharedStashExpense` callable.** New dedicated trusted
  callable (§1 choice: dedicated callable, not branching
  `recordTripExpense`, matching the established "one callable per distinct
  write shape" convention used 6 times already). Implements §3/§5/§6/§8/
  §9(default A)/§10/§11. Functions-only change; **no deploy** as part of
  this checkpoint — deployment is a separate, explicit, human-approved step
  per this codebase's existing deployment discipline.
- **4F.2 — `reverseSharedStashExpense` callable (or extend
  `reverseTripExpense`).** Implements §13/§14/§16. Functions-only; no
  deploy.
- **4F.3 — Client service + domain layer.** `src/services/firebase/
  sharedStashExpenses.ts`-equivalent wrapper(s), `deriveMemberSavingsBalanceMinor`
  update (§5), request-id helpers mirroring existing patterns. No backend
  change; no deploy.
- **4F.4 — UI: Shared Stash as a payment source.** Implements §17 in Add
  Expense form, Expense Detail, and Shared Stash history rows. No backend
  change.
- **4F.5 — Ledger accounting primitive extraction (optional/deferred).**
  Only once 4F.1–4F.4 are stable: extract the shared pure helper proposed in
  §4, refactoring `recordSavingsTransaction` and the new callable together
  under full regression coverage.
- **Deployment discipline:** no checkpoint in this sequence may run
  `firebase deploy` as a side effect of implementation or testing. Each
  deploys only after its own explicit human-approved deploy checkpoint,
  exactly as every prior Milestone 4 callable (`recordTripExpense`,
  `reverseTripExpense`, `recordTripSettlement`, `reverseTripSettlement`) was
  deployed as its own separate, explicit step.

---

## 25. FROZEN 4F DECISIONS

1. **Trusted callable shape** — FROZEN: new dedicated `recordSharedStashExpense`
   callable (Option B), not an extension of `recordTripExpense`. (§1)
2. **Create atomicity** — FROZEN: one atomic `runTransaction()` spanning
   Expense + withdrawal + Trip ledger update; supersedes the 2026-09-13/
   2026-09-17 non-atomic design. (§3)
3. **Ledger accounting primitive** — FROZEN: duplicate the full canonical
   ledger-state/transition logic now (idempotent-replay check, both-
   present/neither-present/partial-state classification, legacy-balance
   derivation, currency resolution, overdraft rejection, and
   `ledgerBalanceMinor`/`saved`/`ledgerOpeningBalanceMinor` cached-field
   synchronization) — not a simplified subtraction — and extract a shared
   pure helper only in a later checkpoint (4F.5). (§4)
4. **`SavingsTransaction` attribution semantics** — FROZEN: add
   `linkedExpenseId?: string` discriminator; keep `memberUid` required but
   documented as non-personal-attribution when the discriminator is present;
   update `deriveMemberSavingsBalanceMinor` to exclude linked transactions.
   (§5)
5. **Expense ↔ ledger linkage** — FROZEN: withdrawal id deterministically
   derived server-side from the Expense's `clientRequestId` via the
   `splitDocumentId`-style sha256 scheme; forward link via
   `sharedStashTransactionId`, reverse link via `linkedExpenseId`. (§6)
6. **Request-id strategy** — FROZEN: single client-supplied
   `clientRequestId` for the whole logical create; all derived ids are
   server-computed from it. (§7)
7. **Insufficient-funds behavior** — FROZEN: backend-authoritative,
   transaction-internal rejection; no partial writes. (§8)
8. **Authorization** — FROZEN (final): any current Trip member may create a
   Shared-Stash-funded Expense, matching existing Expense-creation
   authorization exactly. The Trip's existing `ownerId` field is not used
   to restrict creation in 4F; no new organizer/role/approval system is
   introduced. (§9)
9. **Archived-Trip behavior** — FROZEN: new Shared-Stash Expense creation is
   archive-gated like ordinary Expense creation; reversal is not. (§10)
10. **Splits required or optional** — FROZEN: no `tripExpenseSplits` are
    created for Shared-Stash Expenses. (§11)
11. **Pairwise debt** — FROZEN/VERIFIED: exactly zero, by construction, since
    no splits exist to aggregate. (§12)
12. **Reversal/refund design** — FROZEN: one atomic transaction; an
    offsetting contribution adds the original Expense amount back against
    the Trip's *current* canonical balance at reversal time exactly once —
    never a restored historical snapshot, and never disturbing unrelated
    transactions that occurred before or after the original Expense; first
    real use of `reversalOf`. (§13)
13. **Reversal authority** — FROZEN: identical to `reverseTripExpense`'s
    existing `isOwner || isOriginalCreatorStillMember` rule. (§14)
14. **Correction workflow** — FROZEN: reverse-then-create, two separate
    atomic calls, mirroring existing Expense correction; not a merged
    mega-transaction. (§15)
15. **Ambiguous-outcome/idempotency recovery** — FROZEN: reuse the existing
    `reduceReversalOutcome`/`isDefinitiveDifferentRequestFailure` pattern,
    not a new bespoke copy. (§16)
16. **UI source-selection behavior** — FROZEN: new `shared_stash` option in
    the Add Expense form hides payer/split UI entirely; Expense/history rows
    render distinctly from member-paid Expenses. (§17)
17. **Privacy boundary** — FROZEN: no new privacy surface; existing
    Trip-membership scoping is unchanged and sufficient. (§18)
18. **Rules changes** — FROZEN: none required; both collections are already
    fully client-write-closed. (§19)
19. **Index changes** — FROZEN: none required; new writes reuse existing
    query shapes and the existing composite index. (§20)
20. **Future attributable-funds compatibility** — FROZEN: the
    `linkedExpenseId` discriminator approach is forward-compatible with any
    future member-earmarked-funds feature, since it does not repurpose
    `memberUid`'s existing meaning. (§5, §20 of narrative above)

---

## 26. Risks Not Otherwise Called Out

- Implementing 4F.1 touches no currently-deployed callable, so regression
  risk to production `recordTripExpense`/`recordSavingsTransaction` is zero
  until 4F.5 (the deferred primitive extraction) is undertaken.
- The canonical ledger-state logic duplicated into 4F.1 (§4) is the most
  intricate part of this feature; its three-way classification
  (already-initialized / legacy-uninitialized / partial-corrupt) and the
  `saved`/`ledgerOpeningBalanceMinor` mirror-field writes must be copied
  precisely, not approximated, or a legacy Trip could silently derive the
  wrong starting balance.
- Authorization (§9) is now final and requires no further product input
  before 4F.1 begins.

---

## Validation

```
git diff --check        → (clean; no whitespace errors)
git diff --stat         → (no tracked files changed)
git diff --name-status  → (no tracked files changed)
git status --short      → ?? docs/audits/TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md
```

No production financial write was performed. No Expense or SavingsTransaction
was created, reversed, or corrected. No production Shared Stash balance was
modified. Nothing was deployed. Nothing was committed. Nothing was pushed.

CHECKPOINT 4F.0 SHARED-STASH EXPENSE PREFLIGHT READY FOR HUMAN ARCHITECTURE REVIEW
DO NOT COMMIT.
DO NOT PUSH.
DO NOT DEPLOY.
STOP.
