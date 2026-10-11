# Trip Wallet Ownership Migration / Backfill Preflight — 2026-10-10

**Status:** Architecture / preflight only. No production Firestore write,
no migration run, no migration tooling, no source-code change, no Rules
change, no index change, and no deployment were performed to produce this
document.

**Baseline:** HEAD `7d9fcc147c0db95d63ae56870e9d8c50233a9454` ("Integrate
Trip ownership into financial callables"), branch
`claude/milestone-3-personal-savings-mvp`, clean working tree. Checkpoints
5B.1 (schema/Rules), 5B.1A, 5B.2/5B.2A (pure math), 5B.3/5B.3A/5B.3B
(state-aware callable integration) are committed, pushed, and deployed to
production per `firebase functions:list`. The three ownership-aware
callables — `recordSavingsTransaction`, `recordSharedStashExpense`,
`reverseSharedStashExpense` — are live and already branch on
`Trip.ownershipModelState`/`ownershipModelVersion` for every new
mutation. **Hardened by Checkpoint 5B.4A.1, item 10:** no Trip has been
intentionally migrated through this workflow, and no repository-
supported migration mechanism currently exists — but actual production
Trip document states have **not** been exhaustively enumerated; this
document infers nothing about real Firestore contents it has not
queried. The migration tool itself always classifies each target Trip
from a fresh, authoritative Firestore read at run time and fails closed
on anything other than a genuinely eligible state (§4) — it never
assumes a Trip is legacy merely because no code path in this repository
currently writes anything else. 5C (second financially-authorized
member) remains blocked.

**Amendment 5B.4A.1 (2026-10-11):** this document has been hardened after
the original 5B.4A pass identified sixteen corrections, all addressed in
place rather than as a separate addendum, given the extent of the
changes: (1) the ledger-bootstrap classification now correctly evaluates
the legacy `saved` value through `deriveLegacyLedgerInitialization` when
both ledger fields are absent, rather than treating absence as an
automatic zero (§5); (2) a Shared-Stash Expense reversal's logical-event
timestamp is corrected to `refund.createdAt`/`Expense.reversedAt`, never
the Expense's own original `createdAt` (§7/§10); (3) same-timestamp
ordinary-event ordering is substantially narrowed — a same-uid
contribution+withdrawal tie now fails closed rather than being treated
as commutative (§7); (4)-(5) the out-of-band-mutation defense is
replaced with a canonical source-history digest, re-verified inside the
finalization transaction, superseding a `createdAt`-only watermark that
could not detect edits/deletions/backdated inserts (§16A/§22); (6) a
bounded-automatic-migration rule is frozen — large Trips fail closed
rather than receiving a weakened integrity check (§16/§16A); (7)
finalization now requires an exact canonical-digest match over the full
expected ownership and allocation sets, not merely a sum/count (§16A/§22);
(8) a *fresh* lock finding pre-existing ownership/allocation output is
now its own distinct, conservative failure, separate from the *resumed*-
migration overwrite rule (§19); (9) the in-flight-transaction-race proof
is restated in concurrency-mode-independent terms (§17); (10) the
baseline no longer asserts unobserved production Trip states (§2, this
section); (11) the lock/finalization Trip-document writes are reduced to
exactly the two already-frozen fields, with all bookkeeping moved to the
migration-state document (§16/§22); (12) member-out-of-pocket Expense
wording is corrected to "fetched and classified, never acted upon"
rather than "never read" (§3/§6/§32); (13) the migration-state field list
is fully re-justified, field by field (§16A). All other findings from
the original 5B.4A pass are preserved unchanged.

**Amendment 5B.4A.2 (2026-10-11):** this document has been hardened a
second time, addressing two final state-machine details the 5B.4A.1
pass left incomplete: (1) the locked opening-balance/aggregate snapshot
is **not** redundant with a bare aggregate check, since
`ledgerOpeningBalanceMinor`/`ledgerBalanceMinor`/Trip `currency` (or the
legacy-`saved`-derived opening balance for an uninitialized Trip) are
Trip-document fields the source-history digest cannot see at all — a
canonical `lockedFinancialBasis` object is now captured at lock time and
independently re-verified at finalization (§16A/§22); (2) the migration-
state document now carries an explicit `phase` lifecycle
(`"locked"` → `"reconstructed"` → `"completed"`, §16B) rather than
inferring reconstruction progress from which optional digest fields
happen to be present — no migration output may be written while
`phase === "locked"`, the frozen digests are written only as part of the
atomic `"locked" -> "reconstructed"` transition, and `phase ===
"completed"` is written only inside the same transaction that
initializes the Trip. §19's resume-semantics table and §22's finalization
pseudocode are both rewritten to be explicitly phase-aware; two new
manual-review reason codes (`locked_financial_basis_mismatch`,
`invalid_migration_state_phase`) and their corresponding tests are
added. All findings from the 5B.4A/5B.4A.1 passes not named above are
preserved unchanged.

**Primary sources of truth:** `docs/audits/
TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md` (as hardened by
its 5B.0A/5B.0B amendments and its §23 implementation-refinement
amendment) — read in full for this document and treated as binding,
frozen, and **not re-litigated** except where this document explicitly
proposes a new, additive 5B.4B schema requirement. Also read in full:
every file named in this checkpoint's §1, plus the actual persisted
schemas (`src/types/domain/trip.ts`, `src/types/domain/
savingsTransaction.ts`, `src/types/domain/expense.ts`, `src/types/domain/
common.ts`), `firestore.indexes.json`, `firestore.rules`'s relevant
match blocks, `firebase.json`, `.firebaserc`, and `functions/src/
index.ts`.

---

## 1. Executive Decision

**Migration is feasible, but only as a deliberately narrow, single-Trip,
dry-run-first, source-code-driven Admin SDK tool — never a callable,
never a bulk sweep, never "best effort."** This document freezes the
exact algorithm, the exact lock/finalization transactions, the exact
fail-closed conditions, and the exact resumability model 5B.4B must
implement. It also identifies **two genuine, unresolved architectural
gaps** in the current schema — out-of-band mutation of historical
`savingsTransactions`/`tripExpenses` documents, and out-of-band mutation
of Trip-level ledger/bootstrap/currency fields, which are **independent**
risks neither protection substitutes for (§16A) — and proposes the
minimal additive fix for each as a **new 5B.4B schema requirement**, not
implemented here: a canonical source-history digest (Amendment 5B.4A.1)
and a canonical locked financial basis (Amendment 5B.4A.2), both
re-verified exactly inside the finalization transaction (§16A/§22),
governed by an explicit three-phase migration-state lifecycle (§16B)
rather than inferred progress.

No blocker in this document prevents 5B.4B from proceeding. Every
identified risk has either (a) an existing, already-frozen architectural
answer this document re-confirms from source, or (b) a concrete,
minimal, additive proposal below.

---

## 2. Existing Production Safety State After 5B.3

Re-confirmed from source at this exact HEAD (not assumed from prior
documents):

- `recordSavingsTransactionCore`'s "trip" branch, `recordSharedStashExpenseCore`,
  and `reverseSharedStashExpenseCore` all call
  `classifyOwnershipMutationGate(tripData.ownershipModelState,
  tripData.ownershipModelVersion)` (`functions/src/domain/
  tripOwnershipModel.ts`) immediately after their own existing
  authentication/membership/idempotent-replay handling, and:
  - `"legacy"` → proceeds with today's exact aggregate-only behavior,
    zero ownership-collection reads or writes.
  - `"blocked"` (`"migrating"` or `"needs_reconciliation"`) → rejects
    every genuinely new mutation with `failed-precondition`, with zero
    writes, confirmed by this session's own 5B.3/5B.3A test suites.
  - `"initialized"` at `CURRENT_TRIP_OWNERSHIP_MODEL_VERSION` → full
    ownership-aware behavior (ceiling enforcement, proportional
    depletion, exact-allocation restoration).
  - `"fail_closed"` (corrupt or unsupported version) → rejects, never
    falls back to legacy.
- **Exact replay always bypasses this gate entirely** — in all three
  callables, the idempotent-replay branch (keyed by `clientRequestId`/
  `expenseId` + a normalized request-snapshot comparison) is structurally
  positioned *before* any Trip-state classification and returns early
  without calling the gate at all. A **conflicting** payload reusing the
  same id is caught by the pre-existing mismatch check (`already-exists`,
  or the reversal path's "already been reversed") — also before the
  gate. Both facts are proven by this repository's own 5B.3A test suites
  (`functions/test/record*OwnershipTest.ts` equivalents), not assumed.
- `recordSharedStashExpense` additionally: (a) requires the canonical
  `tripOwnershipAllocations/{withdrawalId}` to be absent before creating
  one, scoped **only** to the `"initialized"` branch (5B.3B fixed a real
  bug where this check had originally been unconditional and would have
  blocked legacy operations on a stray/stale allocation document); (b)
  on an aggregate-vs-ownership reconciliation mismatch, queues a
  `"needs_reconciliation"` state transition and returns a sentinel so the
  state write survives a transaction that otherwise aborts the Expense.
- No code path anywhere writes `ownershipModelState = "migrating"` in
  production source (confirmed by grep across `functions/src/callables/
  *.ts`) — only test fixtures ever set it.
- No code path mutates `memberIds` in any of the three callables
  (confirmed by grep — every `memberIds` reference is a local read).

**Conclusion:** the deployed *code* already correctly treats every Trip
it ever sees as legacy unless a real `ownershipModelState` field says
otherwise, already blocks nothing it shouldn't, and already fails closed
everywhere this document needs it to — this is a statement about the
callables' own logic, confirmed from source, not a claim about what
every actual production Firestore document currently contains (§10
hardening; see the baseline note above). 5B.4B's job is purely
additive: a tool that reads this same history and, for one Trip at a
time, proves the invariant and writes the two already-frozen fields —
and that tool itself must classify each target Trip fresh, every run,
rather than lean on any assumption about the fleet as a whole.

---

## 3. Actual Legacy Financial Schemas Discovered

Read directly from `src/types/domain/*.ts` (never assumed from this
checkpoint's own prompt):

### `Trip` (`src/types/domain/trip.ts`)

Every field except `id` is optional — `mapTripDocument` (client reads)
picks fields individually with no defaulting. Relevant fields:
`ownerId?`, `memberIds?: string[]`, `currency?: string` (defaults to
`"USD"` via `resolveEffectiveCurrency` when absent), `saved?: number`
(legacy dollar-denominated display cache), `ledgerOpeningBalanceMinor?:
number`, `ledgerBalanceMinor?: number` (the two-field ledger-
initialization pair — both present-and-valid, or both absent, or
"partial_corrupt"), `archivedAt?: PersistedTimestamp | null`,
`archivedBy?: string | null` (presence/absence of `archivedAt` **is**
archive status — no separate status field), `ownershipModelState?:
TripOwnershipModelState`, `ownershipModelVersion?: number`.

### `SavingsTransaction` (`src/types/domain/savingsTransaction.ts`)

One collection (`savingsTransactions`) for both `"contribution"` and
`"withdrawal"`, discriminated by `type`. **`createdAt: PersistedTimestamp`
is required and server-generated** (`FieldValue.serverTimestamp()`,
confirmed in all three callables' write sites) — never client-supplied,
never absent. **`occurredAt?: PersistedTimestamp` is optional and
user-chosen** (a plain `Date` at input time, converted to a `Timestamp`
at the write boundary) — it represents when the user says the money
actually moved, and carries **no ordering guarantee relative to
`createdAt`** (a user may backdate it). `reversalOf: string | null` is
always present (never omitted) — `null` for an ordinary transaction, the
original transaction's id for a reversal/refund. `linkedExpenseId?:
string` is present **only** on a Shared-Stash-Expense-linked transaction
(the original withdrawal `recordSharedStashExpense` writes, or the
offsetting refund `reverseSharedStashExpense` writes) — its presence is
the **authoritative discriminator** that this transaction represents
institutional, group-funded activity, never a personal
contribution/withdrawal, regardless of what `memberUid` says.
`resourceType: "bucket" | "trip"`, `resourceId: string` — Trip ownership
migration only ever concerns `resourceType === "trip"` rows for the
target `resourceId`.

### `Expense` (`src/types/domain/expense.ts`)

`tripExpenses/{expenseId}` (trip-only, never bucket-scoped).
`paymentSource: "member_out_of_pocket" | "shared_stash"` — the Trip-scoped
Expense scan (§6/§21) necessarily fetches every Expense for the Trip
regardless of `paymentSource` (a `.where("tripId","==",tripId)` query
has no way to exclude one payment source at the Firestore level without
an additional field filter this document does not propose adding).
**Corrected by Checkpoint 5B.4A.1, item 12:** migration therefore *does*
observe `"member_out_of_pocket"` Expense documents as part of this scan
— it classifies each one only far enough to confirm its `paymentSource`
and immediately discard it from any further processing. It never
participates in ownership arithmetic, is never mutated, and its
existence never triggers a read of `tripExpenseSplits` or any
settlement record — those collections are never queried by this tool at
all, for any Expense, regardless of payment source (§32). The precise,
implementation-honest claim is: *fetched and classified, never acted
upon* — not *never read*.
A `"shared_stash"` Expense always has `payerUid: null` and
`sharedStashTransactionId` **required and present** (the audit's own
4A.1 amendment explicitly removed any "half-linked" possibility — there
is no persisted state where `paymentSource === "shared_stash"` and this
field is empty). `status: "active" | "reversed"` — a reversed Expense
additionally carries `reversedAt`, `reversedBy`, `reversalReason?`, and
(for a `"shared_stash"` Expense specifically) `refundTransactionId` —
all **trusted, server-computed output**, written atomically by the same
transaction that flips `status`. `createdAt: PersistedTimestamp` is
required/server-generated, exactly like `SavingsTransaction`.
`replacesExpenseId?`/`replacedByExpenseId?` are the 4C.3D
correction-chain links — **migration must read and preserve these as
inert audit metadata only; they never affect ownership arithmetic**,
since a "correction" is simply reverse-then-create-new, and each of
those two steps is independently replayed as an ordinary reversal and an
ordinary Shared-Stash Expense creation respectively (confirmed:
`recordSharedStashExpenseCore` with `replacesExpenseId` set performs
**no different ownership effect** than an ordinary creation — the
correction-link fields are pure audit/authorization metadata, written in
the same transaction, with zero bearing on the depletion math).

### Ledger initialization (`functions/src/domain/savingsLedger.ts`)

`classifyLedgerInitialization(parentData)` returns exactly one of:
`{kind:"initialized", currentBalanceMinor}` (both ledger fields present
and valid), `{kind:"invalid_initialized_state"}` (both present, one
invalid), `{kind:"uninitialized"}` (both absent), `{kind:
"partial_corrupt"}` (exactly one present). `deriveLegacyLedgerInitialization
(legacyDollars)` converts a legacy `saved` dollar value to minor units
(`Math.round(legacyDollars * 100)`), used **only** the first time a Trip
with no prior `savingsTransactions` history writes its first ledger
transaction. **Corrected by Checkpoint 5B.4A.1, item 1:** `{kind:
"uninitialized"}` (both fields absent) does **not** mean "this Trip has
no money" — it means the real opening balance has not yet been
*computed and cached* from the Trip's own legacy `saved` field, exactly
as `recordSavingsTransactionCore`'s/`recordSharedStashExpenseCore`'s own
first-write bootstrap logic already does. Migration must run the
*identical* classification — `classifyLedgerInitialization` followed,
in the uninitialized case, by the same history-emptiness guard and the
same `deriveLegacyLedgerInitialization` call those callables already
perform — never a parallel/simplified conversion, and never an
assumption that "uninitialized" is synonymous with "zero." See §5's
full decision table.

### Firestore Rules / Indexes (actual current state)

`firestore.rules` closes `tripMemberOwnership` and
`tripOwnershipAllocations` to every client write unconditionally
(`create/update/delete: if false`), confirmed unchanged through 5B.1–
5B.3B. `firestore.indexes.json` contains exactly three composite
indexes: `buckets`/`trips` (both: `memberIds CONTAINS, createdAt DESC,
__name__ DESC` — Trip-list queries, irrelevant to migration) and
**`savingsTransactions`: `resourceType ASC, resourceId ASC, createdAt
DESC, __name__ DESC`** — this index already exists in production and
already supports a chronologically-ordered, equality-filtered scan of a
single Trip's `savingsTransactions` history with **no new index
required**. `tripExpenses` has **no** composite index today — the
existing client query (`src/services/firebase/expenses.ts`,
`fetchTripExpenses`) fetches by `.where("tripId","==",tripId)` alone,
with **no `orderBy`**, and sorts in memory. This is a direct, concrete
precedent this document adopts for migration (§7/§19): fetch
`tripExpenses` the same index-free way, sort deterministically in
memory, and additionally do the same (index-free) for
`savingsTransactions` rather than depend on the existing composite index
remaining exactly as-is — migration should introduce **zero** coupling
to any index's continued existence.

---

## 4. Migration Eligibility Rules

A Trip is **eligible to attempt automatic migration** if and only if,
read fresh inside the lock-acquisition transaction:

1. The Trip document exists.
2. `classifyTripOwnershipModelState(state, version)` returns exactly
   `{kind: "legacy"}` (covers both absent-state and explicit `"legacy"`
   string, per the frozen §12A.1 equivalence — re-confirmed unchanged in
   `tripOwnershipModel.ts` at this HEAD). Any other classification
   (`"migrating"`, `"initialized"`, `"needs_reconciliation"`, or
   `"corrupt"`) rejects lock acquisition outright (§3's own hard gate —
   "never acquire the lock twice").
3. **Hardened by 5B.4A.1, item 1:** §5's full ledger-bootstrap
   classification (re-using `classifyLedgerInitialization`/
   `deriveLegacyLedgerInitialization` verbatim, covering the
   already-initialized, uninitialized-with-zero-legacy-balance, and
   uninitialized-with-history cases together — not merely a two-way
   initialized/uninitialized split) resolves to **Case A** or
   **Case A-equivalent** (no ambiguity, no inconsistency). Any other
   outcome from that table (`invalid_ledger_state`,
   `uninitialized_ledger_with_history`, Case C/C-equivalent) excludes
   the Trip from automatic migration.
4. Bounded history size (§16A) — the Trip's full ownership-relevant
   history (every `savingsTransactions` + `tripExpenses` document for
   this Trip) is within the safe automatic-migration bound. A Trip
   exceeding it is `REQUIRES_MANUAL_REVIEW`
   (`history_exceeds_automatic_migration_limit`) **before** the lock is
   ever attempted (§16A) — never a partially-scanned, partially-locked
   attempt.
5. `Array.isArray(tripData.memberIds)` (malformed `memberIds` is a
   structural corruption the rest of migration cannot reason about
   safely, even though migration's own ownership set is **not** derived
   from `memberIds` — see §11).

A Trip satisfying all five is `SAFE_TO_MIGRATE`; a Trip not already
excluded by item 2 (which is a hard `already-exists`-style rejection, not
a review classification) but failing item 3, 4, or 5 is
`REQUIRES_MANUAL_REVIEW` (§26).

---

## 5. Legacy Opening-Balance Policy — Fail Closed, Now Including the Full Ledger-Bootstrap Classification (Hardened by Checkpoint 5B.4A.1, Item 1)

The original preflight's §16.1 already froze the *attribution* question
exactly, and nothing in the current schema changes that answer: **no
record anywhere in this repository's schema attributes a pre-ledger
`saved`/`ledgerOpeningBalanceMinor` value to any specific uid.**
Re-verified directly from source for this document:

- `Trip` carries no provenance field for `saved`/`ledgerOpeningBalanceMinor`
  at all — `deriveLegacyLedgerInitialization` takes a bare dollar number
  and returns a bare minor-unit number; it never touches or knows about
  `memberIds`, `ownerId`, or any creator field.
- No membership-change audit log exists anywhere in this schema (grep
  confirms no `membershipHistory`/`membershipLog`/equivalent collection).
- `createTripInvitation`/`publishTripTerms`/`tripMembershipAcceptance`
  (5A/5A.1/5A.2) are all strictly **later-than-opening-balance** concepts
  — they establish *future* accepted membership, never retroactive proof
  of who caused a pre-existing `saved` value to become nonzero.

**Corrected by Checkpoint 5B.4A.1, item 1:** the *original* version of
this section treated `ledgerOpeningBalanceMinor` absent as automatically
equivalent to a zero opening balance. That is wrong under this
repository's own actual ledger-bootstrap behavior — `classifyLedgerInitialization`
has **four** outcomes, not two, and "both fields absent" does **not**
mean "no money" if a legacy `Trip.saved` value exists; it means
"the real opening balance has not been *computed* yet," and migration
must compute it the exact same way the production bootstrap already
does, never inventing a parallel conversion. **Migration's full
ledger-bootstrap classification, reusing
`classifyLedgerInitialization`/`deriveLegacyLedgerInitialization`
verbatim — never a new parallel scheme:**

| `classifyLedgerInitialization(tripData)` result | Migration's classification |
|---|---|
| `{kind: "initialized"}`, `ledgerOpeningBalanceMinor == 0` | **Case A** — no ambiguity, eligible (subject to the history checks in §4/§6-8). |
| `{kind: "initialized"}`, `ledgerOpeningBalanceMinor > 0` | **Case C** — ambiguous historical ownership (Case B remains unreachable for any existing Trip, re-confirmed below). `REQUIRES_MANUAL_REVIEW` (`positive_ambiguous_opening_balance`). Never attributed to the current owner/creator/sole-member. |
| `{kind: "invalid_initialized_state"}` or `{kind: "partial_corrupt"}` | Already excluded at eligibility (§4, item 3). `REQUIRES_MANUAL_REVIEW` (`invalid_ledger_state`). |
| `{kind: "uninitialized"}`, **and** `savingsTransactions` history already exists for this Trip | **Structurally inconsistent with current trusted ledger behavior** — re-confirmed from source: `recordSavingsTransactionCore`'s own `"uninitialized"` branch runs a `historySnap.empty` guard and *throws* `"Resource has savingsTransactions history but no initialized ledger state."` the moment it finds any — a production Trip can never legitimately reach this exact combination through any trusted write path. Migration **never** reconstructs it as though the opening balance were zero. `REQUIRES_MANUAL_REVIEW` (`uninitialized_ledger_with_history`) — a dedicated, distinct reason code, never folded into Case C. |
| `{kind: "uninitialized"}`, no history, `deriveLegacyLedgerInitialization(tripData.saved ?? 0)` reports `{ok: false}` | Malformed/unsafe legacy `saved` value. `REQUIRES_MANUAL_REVIEW` (`invalid_ledger_state`). |
| `{kind: "uninitialized"}`, no history, derived `initOpeningMinor == 0` | **Case A-equivalent** — the Trip genuinely has never held any money at all (zero legacy balance, zero transaction history). Eligible. |
| `{kind: "uninitialized"}`, no history, derived `initOpeningMinor > 0` | **Case C-equivalent** — the absence of the two ledger fields does **not** erase a positive legacy `saved` amount; this is exactly as ambiguous as a persisted positive `ledgerOpeningBalanceMinor` would be, for the identical reason (no provenance record exists for it either way). `REQUIRES_MANUAL_REVIEW` (`positive_ambiguous_opening_balance`). |

**Why Case B remains unreachable for any existing Trip, re-confirmed,
not re-litigated:** current `memberIds` having exactly one entry is
explicitly **not** proof of historical sole ownership — no membership-
change audit log exists, and nothing in this schema distinguishes "this
Trip always had one member" from "this Trip once had more and the rest
left." This holds identically whether the positive opening balance is
found via the already-initialized path or derived fresh from a legacy
`saved` value — the provenance gap is the same gap either way.

---

## 6. Historical Source-of-Truth Records

| Record type | Collection | Required fields migration reads | Sign convention | Ownership effect | Aggregate effect | Institutional (Shared Stash) spending? |
|---|---|---|---|---|---|---|
| Ordinary contribution | `savingsTransactions` (`resourceType=="trip"`, `type=="contribution"`, `linkedExpenseId` absent) | `memberUid`, `amountMinor`, `currency`, `createdAt`, `reversalOf` (must be `null`) | `+amountMinor` to `memberUid` | `memberUid ownership += amountMinor` | `+amountMinor` | No |
| Ordinary withdrawal | `savingsTransactions` (`type=="withdrawal"`, `linkedExpenseId` absent) | same as above | `-amountMinor` from `memberUid` | `memberUid ownership -= amountMinor` | `-amountMinor` | No |
| Shared-Stash Expense withdrawal | `savingsTransactions` (`type=="withdrawal"`, `linkedExpenseId` present, `reversalOf==null`) | `amountMinor`, `currency`, `linkedExpenseId` → the `tripExpenses` doc, whose own `sharedStashTransactionId` must equal this document's own id | `-amountMinor` from the **pool**, proportionally | **Every currently-positive-ownership holder, proportionally** (§9 of the original preflight's algorithm) — **never** `memberUid` alone | `-amountMinor` | **Yes** |
| Shared-Stash Expense refund | `savingsTransactions` (`type=="contribution"`, `linkedExpenseId` present, `reversalOf` = the original withdrawal's id) | `amountMinor`, `currency`, `reversalOf`, `linkedExpenseId`, **`createdAt`** (the reversal's own logical-event timestamp — §7 hardening, never the original Expense's `createdAt`) | `+amountMinor` restored to the **original allocation's exact per-member deltas** | Restore exactly the original Expense's reconstructed allocation — **never recompute** | `+amountMinor` | **Yes** (reversal of institutional spending) |
| Shared-Stash Expense (the `tripExpenses` doc itself) | `tripExpenses` (`paymentSource=="shared_stash"`) | `amountMinor`, `currency`, `sharedStashTransactionId`, `status`, `createdAt` (creation-event timestamp only), **`reversedAt`/`refundTransactionId` if reversed** (the reversal-event timestamp/linkage — §7 hardening) | N/A directly — drives the withdrawal above | N/A directly | N/A directly | **Yes** — the authoritative record of *why* the withdrawal happened, and (once reversed) *when* the reversal itself occurred |
| Member-out-of-pocket Expense | `tripExpenses` (`paymentSource=="member_out_of_pocket"`) | `paymentSource` only (fetched incidentally by the Trip-scoped Expense scan, §12 hardening — immediately classified and discarded) | — | **None** | **None** | No — fetched, classified by `paymentSource`, then ignored; **never** acted upon (§32) |
| `tripExpenseSplits` | `tripExpenseSplits` | — | — | **None** | **None** | No — **never queried by ownership migration under any circumstance** |
| `tripSettlements` | (settlement collection) | — | — | **None** | **None** | No — **never queried by ownership migration under any circumstance** |

**Idempotency/document identity, re-confirmed:** every `savingsTransactions`
document's own id is either a client-supplied `clientRequestId`
(ordinary contribution/withdrawal) or a deterministic SHA-256 hash of
`[clientRequestId, "shared-stash-withdrawal"]` /
`[clientRequestId, "shared-stash-refund"]` (`deriveSharedStashWithdrawalId`/
`deriveSharedStashRefundId`, both duplicated-by-design across the two
callables per this project's own established per-file-duplication
convention). Migration never needs to derive these ids itself — it only
ever needs to **read** the ids these documents already carry
(`linkedExpenseId`, `reversalOf`, `Expense.sharedStashTransactionId`),
never recompute them.

**Explicit classification of every observed `reversalOf`/`linkedExpenseId`
combination:**

| `reversalOf` | `linkedExpenseId` | Classification | Migration action |
|---|---|---|---|
| `null` | absent | Ordinary contribution/withdrawal | Apply directly to `memberUid` |
| `null` | present | Shared-Stash Expense withdrawal | Locate linked Expense, proportionally deplete |
| `<id>` | absent | **Impossible under current callables** — no generic reversal exists for ordinary transactions (re-confirmed unchanged from the original preflight's §8: `recordSavingsTransaction.ts` hardcodes `reversalOf: null` on every write it performs) | **Fail closed** — this shape cannot be legitimately produced by any trusted callable; treat as corrupt/malformed and flag `REQUIRES_MANUAL_REVIEW` |
| `<id>` | present | Shared-Stash Expense refund | Locate the Expense via `linkedExpenseId`, confirm it is `"reversed"` with `refundTransactionId` equal to this document's own id, restore the Expense's reconstructed allocation |

Any `savingsTransactions` document for the target Trip that does not fit
one of the four rows above (e.g. an unrecognized `type`, a malformed
`reversalOf`/`linkedExpenseId` combination not listed, a `resourceType`
mismatch inside what should be a trip-scoped query) is **never silently
skipped or guessed at** — it fails the Trip closed for manual review.

---

## 7. Deterministic Ordering Model

**`createdAt` is the only trusted ordering field — `occurredAt` is
explicitly rejected for ordering purposes.** `occurredAt` is optional,
user-chosen, and carries no monotonicity guarantee relative to
`createdAt` or to any other transaction (confirmed directly from the
`CreateSavingsTransactionInputBase`/`CreateExpenseInput` types: it is
converted from a plain client-supplied `Date`, never a server sentinel).
Using it for replay ordering would let a user-supplied backdated value
silently reorder the very proportional-depletion arithmetic that defines
correct ownership. `createdAt` is server-generated
(`FieldValue.serverTimestamp()`) on every single relevant document,
confirmed at every write site in all three callables, with no exception.

**Atomic linked-record groups, and why they are provably simultaneous,
not merely "probably close" — corrected by Checkpoint 5B.4A.1, item 2:**
Firestore resolves every `FieldValue.serverTimestamp()` sentinel written
within the **same** transaction to the **same** commit timestamp (a
documented platform guarantee, not a repository-specific assumption).
This applies to **two separate pairs**, each with its own distinct
logical-event timestamp — the original version of this document
incorrectly treated a reversed Expense and its refund as sharing the
Expense's own *original* `createdAt`, which is wrong: `createdAt` is set
once, at creation, and is **never** rewritten by a later reversal.

- **Shared-Stash Expense creation event:** `recordSharedStashExpenseCore`
  writes the Expense and its linked withdrawal in one transaction, so
  `Expense.createdAt` and `withdrawal.createdAt` are provably identical.
  **Migration requires this equality explicitly and fails closed if it
  ever disagrees** (`"unexpected_historical_record_type"`-class
  corruption — these two documents were supposedly written together and
  must agree). The logical-event timestamp is `withdrawal.createdAt`
  (equivalently the validated-equal `Expense.createdAt`).
- **Shared-Stash Expense reversal event:** `reverseSharedStashExpenseCore`
  writes the refund and the Expense's `status`/`reversedAt` update in
  one transaction, so `refund.createdAt` and `Expense.reversedAt` are
  provably identical — **never** `Expense.createdAt`, which remains
  fixed at the Expense's own original creation moment throughout its
  entire lifetime, reversed or not. Migration requires, before treating
  any reversal as valid:
  - `Expense.status === "reversed"` and `Expense.reversedAt` is present;
  - the refund transaction exists, `Expense.refundTransactionId` equals
    its document id, `refund.reversalOf` equals the original
    withdrawal's id, and `refund.linkedExpenseId` equals `Expense.id`;
  - `refund.createdAt` exactly equals `Expense.reversedAt`.

  Any disagreement among these fails closed — the two were supposedly
  committed in the same trusted transaction and must agree exactly. The
  logical-event timestamp for the **reversal** is `refund.createdAt`
  (equivalently the validated-equal `Expense.reversedAt`) — **never**
  `Expense.createdAt`.

This is exactly why the original preflight's §7 instinct (treat each
pair as one combined logical event, never independently orderable) is
not just safe but is the **only** correct interpretation — a naive "sort
all documents by `createdAt`, process one at a time" approach would have
no principled way to break a tie between a withdrawal and its own
Expense (or a refund and its own reversed-Expense update), and using the
*wrong* field for one side of the reversal pair would silently replay a
reversal at the wrong point in history relative to everything else.

**Frozen replay unit:** migration never iterates raw documents — it
iterates **logical events**, each carrying exactly one trusted timestamp:
1. **Ordinary contribution** — one `savingsTransactions` document,
   timestamp = its own `createdAt`.
2. **Ordinary withdrawal** — one `savingsTransactions` document,
   timestamp = its own `createdAt`.
3. **Shared-Stash Expense creation** — the `(Expense, linked withdrawal)`
   pair, timestamp = their validated-equal `createdAt`.
4. **Shared-Stash Expense reversal** — the `(reversed Expense, refund)`
   pair, timestamp = their validated-equal `reversedAt`/`createdAt` —
   **never** the reversed Expense's own original `createdAt`.

**Deterministic tie-break policy between *different* logical events
sharing an identical timestamp — corrected and substantially narrowed by
Checkpoint 5B.4A.1, item 3:** the original version of this document
claimed ordinary contribution/withdrawal events are always
order-insensitive, including for the *same* uid. That is false. Example:
starting ownership `0`, a same-timestamp `+100` contribution and `-100`
withdrawal for the *same* uid give `0 -> 100 -> 0` (valid) if the
contribution is processed first, but `0 -> underflow` (invalid) if the
withdrawal is processed first — because migration enforces a
non-negative running-ownership invariant at every historical step (§8),
the two orders are **financially distinguishable**, not commutative.

**Corrected, precise policy:**
- **Provably order-insensitive** (deterministic id tie-break is safe and
  used, purely for run-to-run reproducibility):
  - two ordinary events (contribution and/or withdrawal, in any
    combination) affecting **different** uids, **provided** no
    Shared-Stash event (creation or reversal) shares the same timestamp
    as either of them.
  - two ordinary **contributions** for the same uid (addition is
    commutative regardless of order; no underflow risk either way).
  - two ordinary **withdrawals** for the same uid where processing
    order provably cannot change whether either one underflows (i.e.
    the running balance is large enough to absorb both regardless of
    which is applied first — checked arithmetically, not assumed).
- **Fails closed** (`"ambiguous_event_ordering"`, §26) for every other
  combination, including, at minimum:
  - a contribution and a withdrawal for the **same** uid sharing a
    timestamp (the underflow example above — order can change the
    outcome).
  - **any** pair where at least one side is a Shared-Stash Expense
    creation or reversal (proportional depletion/restoration depends on
    the exact ownership snapshot immediately before it) sharing a
    timestamp with any other, unrelated logical event.
  - any other combination where intermediate non-negative ownership or
    proportional allocation *could* differ depending on order, even if
    a specific instance happens not to.

  This is the "no guessing, prefer a conservative rule over clever
  permutation analysis" instruction applied precisely — migration proves
  commutativity for the narrow, enumerated safe cases above and fails
  closed for everything else, rather than attempting a general
  order-independence analysis. Given this product's actual scale (small,
  friend/family Trips, already the frozen assumption throughout this
  architecture), a genuine same-timestamp collision of any ambiguous
  kind is expected to be exceptionally rare in practice — exactly the
  kind of rare, high-stakes ambiguity this document's own repeated "fail
  closed, never guess" instruction exists for.

---

## 8. Ownership Reconstruction Algorithm

Replaying one eligible, now-locked, legacy Trip's full history
chronologically (per §7's logical-event ordering — note precisely:
a Shared-Stash Expense reversal's own event timestamp is
`refund.createdAt`/`Expense.reversedAt`, **never** the reversed Expense's
original `createdAt`), starting from an empty running-ownership map
(`Map<uid, ownershipMinor>`, all absent-key reads treated as `0`, per
§11's own "no row / row at 0" established equivalence):

**Before the loop below runs:** construct the fully-ordered logical-event
list per §7, applying its tie-break policy. If §7's policy classifies any
tie as ambiguous, the Trip fails closed (`"ambiguous_event_ordering"`)
**before** any arithmetic in the loop is attempted — the loop itself
assumes a single, already-proven-safe total order exists.

```text
for each logical event E in chronological order:
  case E is an ordinary contribution (uid, amountMinor):
    result = applyMemberContribution(currentOwnership(uid), amountMinor)
    if !result.ok: FAIL CLOSED (unsafe/malformed - §13)
    runningOwnership[uid] = result.newOwnershipMinor

  case E is an ordinary withdrawal (uid, amountMinor):
    // NOTE: migration does NOT enforce applyMemberWithdrawal's ceiling
    // check as an authorization gate - the withdrawal ALREADY committed
    // successfully under the legacy aggregate-only model, so migration
    // is reconstructing a historical FACT, not re-authorizing it. If the
    // member's reconstructed-so-far ownership is insufficient to cover
    // this historical withdrawal (meaning a per-member ceiling was
    // ALREADY silently violated under the old aggregate-only design -
    // precisely the vulnerability 5B exists to close), this is
    // "ownership underflow during replay" (§26) - FAIL CLOSED, never
    // clamp to zero, never go negative.
    if amountMinor > currentOwnership(uid): FAIL CLOSED (underflow)
    runningOwnership[uid] -= amountMinor

  case E is a Shared-Stash Expense creation (Expense, withdrawal):
    balances = snapshot of runningOwnership as MemberOwnershipBalance[]
      (every uid with a nonzero OR previously-touched entry; see §10 for
      why "touched" matters)
    depletion = applySharedStashDepletion(withdrawal.amountMinor, balances)
    if !depletion.ok: FAIL CLOSED (insufficient pooled ownership to fund
      this historical Expense - itself evidence of pre-existing drift)
    runningOwnership = depletion.resultingOwnership (as a map)
    recordedAllocation[withdrawal.id] = {
      tripId, expenseId: Expense.id,
      withdrawalTransactionId: withdrawal.id,
      amountMinor: withdrawal.amountMinor, currency: withdrawal.currency,
      allocations: depletion.allocations,
      provenance: "migrated",
    }  // kept in memory only until the write phase (§19)

  case E is a Shared-Stash Expense reversal (reversedExpense, refund):
    original = recordedAllocation[reversedExpense.sharedStashTransactionId]
    if original is undefined: FAIL CLOSED ("missing original withdrawal
      allocation" - the reversal references an Expense whose own
      creation event was never found/validated earlier in this same
      replay - §10)
    restore = restoreSharedStashDepletion(
      runningOwnership as balances,
      {amountMinor: original.amountMinor, allocations: original.allocations}
    )
    if !restore.ok: FAIL CLOSED (missing current row / overflow - §10/§14)
    runningOwnership = restore.resultingOwnership (as a map)
    // the ORIGINAL recordedAllocation entry is NOT deleted or mutated -
    // it remains the one-and-only companion record for this withdrawal
    // id, exactly as the live 5B.3 system already guarantees.
```

**Every arithmetic step above reuses an existing 5B.2 pure primitive
(`applyMemberContribution`, `applySharedStashDepletion`,
`restoreSharedStashDepletion`) — migration duplicates none of the
proportional/BigInt math**, per this checkpoint's own §8 instruction and
this project's own established "do not duplicate pure math" convention
(already enforced in 5B.3's own implementation).

**Validation gates applied to every event, before arithmetic (§13):**
`amountMinor` must be a positive safe integer; `currency` must equal the
Trip's own single `currency`+(§12); `memberUid`/linked uids must be
non-empty strings representable by `tripMemberOwnershipId` (§11).

---

## 9. Shared-Stash Historical Allocation Reconstruction

Exactly as §8's algorithm already encodes: for each historical
Shared-Stash Expense creation event (whether or not it was later
reversed), reconstruct its allocation using `applySharedStashDepletion`
against the **ownership snapshot that existed immediately before that
event in the replay** — never today's ownership, never a snapshot from
any other point in history. The result is persisted as exactly one
`tripOwnershipAllocations/{withdrawal.id}` record (canonical id,
unchanged from the live schema — §11 of the original preflight, re-used
verbatim) with:

- `provenance: "migrated"` (never `"original"` — that value is reserved
  for a record created by a **live** 5B.3 write at the moment of a
  genuinely new Expense; a migration-reconstructed record was not
  present at creation time and must say so honestly).
- `createdAt`: the ORIGINAL historical Expense/withdrawal's own
  `createdAt` value (re-used, not re-stamped to "now") — this is the
  moment the allocation's economic facts actually became true, and
  back-dating this field to the historical moment (rather than the
  migration's own run time) is the only choice consistent with
  `createdAt`'s own documented meaning everywhere else in this schema
  ("server-generated... when this record came into being"). **Decision
  point, frozen here:** since `createdAt` is normally
  `FieldValue.serverTimestamp()`-only and migration is not writing this
  document "now" in the economic sense, migration must construct this
  field as an explicit `Timestamp` value copied from the source
  withdrawal's own `createdAt` — not a fresh `serverTimestamp()` sentinel
  — so that a chronological query/audit of this collection later reflects
  true economic history, not migration run order.
- `migratedAt`: `FieldValue.serverTimestamp()` at the moment migration
  actually performs this write — this is genuinely "now," and is exactly
  what the frozen 5B.1A discriminated-union schema already requires for
  `provenance: "migrated"` (`createdAt` always present; `migratedAt`
  present if and only if `provenance === "migrated"` — re-used verbatim,
  zero schema change).

**The original withdrawal `SavingsTransaction` and the original Expense
are never altered, touched, or re-written by this reconstruction** — the
new allocation record is a pure, additive companion document, exactly as
§12 of the original preflight already froze for the live-5B.3 case.

---

## 10. Historical Reversal Replay

Re-confirms §16.3 of the original preflight exactly, now made concrete
against the real reversal shape read from source
(`reverseSharedStashExpenseCore`'s actual field writes, verified this
session): a historical reversal is replayed by **locating the exact
in-memory `recordedAllocation` entry this same replay already produced
for the original Expense's withdrawal id**, then calling
`restoreSharedStashDepletion` with that record's authoritative
`{amountMinor, allocations}` — **never** `applySharedStashDepletion` run
backwards, **never** a fresh proportional computation using ownership at
the reversal's own point in history.

**Corruption cases, explicit:**
- The reversed Expense's `sharedStashTransactionId` does not match any
  allocation this replay has already produced → **fail closed**
  ("missing original withdrawal allocation" — this can only happen if
  the Expense-creation event itself was somehow skipped/malformed earlier
  in the *same* replay, which should be structurally impossible given
  chronological ordering, but is checked explicitly rather than assumed,
  matching this codebase's "never assume, always verify" discipline).
- The refund's own `reversalOf` does not match the Expense's
  `sharedStashTransactionId`, or the Expense's `refundTransactionId` does
  not match the refund's own document id → **fail closed** ("corrupt
  reversal linkage").
- **Added by Checkpoint 5B.4A.1, item 2:** `Expense.status !== "reversed"`,
  `Expense.reversedAt` is absent, or `refund.createdAt !==
  Expense.reversedAt` → **fail closed** ("corrupt reversal linkage" /
  reversal timestamp mismatch) — the refund and the reversed-Expense
  update were committed in the same trusted transaction and must agree
  on their shared timestamp exactly; a disagreement proves at least one
  of the two documents was not produced the way the trusted callable
  claims to have produced it. **`Expense.createdAt` is never consulted
  for this check or for ordering the reversal** — only `Expense.reversedAt`/
  `refund.createdAt` (§7).
- `restoreSharedStashDepletion` itself reports `{ok: false}` (a named uid
  from the original allocation has since vanished from the running
  ownership map entirely, or restoration would overflow) → **fail
  closed**. Per §19 of the original preflight and §11 of this one, this
  should be structurally unreachable for a well-formed history
  (ownership, once created during replay, is never deleted, only ever
  adjusted — see §11 on former members), but is still an explicit,
  tested gate, never an assumption.

---

## 11. Member / Former-Member Handling

**Migration's reconstructed ownership set is explicitly NOT scoped to
current `Trip.memberIds`.** The replay in §8 derives every participating
uid purely from `savingsTransactions.memberUid` and the uids named inside
historical `tripOwnershipAllocations`-equivalent allocation entries —
**never** from `memberIds`. This directly satisfies the checkpoint's own
instruction and the original preflight's §7 invariant ("the sum ranges
over every uid that has ever held a `tripMemberOwnership` record for this
Trip, not merely those currently authorized to transact").

**Frozen outcomes:**
- **Current member, positive reconstructed ownership:** ordinary case —
  a `tripMemberOwnership` row is created/updated normally.
- **Current member, reconstructed ownership of exactly `0`:** a row is
  still created at `0` (never omitted) — matches the original preflight's
  own "no row / row at 0" equivalence, and makes the §15 reconciliation
  sum trivially inclusive of every participant without a separate
  existence check.
- **Historical/former member no longer in current `memberIds`, positive
  reconstructed ownership:** the row is **still created**, at its true
  reconstructed positive value — ownership follows financial history,
  never current UI membership. This is the exact scenario the
  already-frozen §19 policy from the original preflight anticipates:
  *"financial membership cannot be removed from a Trip while that uid
  holds positive Shared-Stash ownership"* — meaning, under the
  already-frozen design, **this situation should be structurally rare
  going forward** (a future member-removal feature must refuse removal
  while ownership is positive), but for **historical** pre-5B data, no
  such guard ever existed, so migration must not assume it is impossible
  retroactively. **5C/future removal logic must later guarantee:**
  before any uid is ever removed from `memberIds` for an `"initialized"`
  Trip, its `tripMemberOwnership.ownershipMinor` must already be exactly
  `0` — migration does not implement or enforce that; it only produces
  the trusted figure that future logic will have to respect.
- **Historical/former member, reconstructed ownership of `0`:** a row at
  `0` is still created, for the same completeness reason as above.

Migration never discards, zeroes, or "reassigns to the owner" any uid's
reconstructed ownership merely because that uid is absent from current
`memberIds`. Doing so would silently manufacture exactly the kind of
unexplained institutional residual §7 of the original preflight already
forbids.

---

## 12. Composite Ownership IDs

Migration **must** call the existing `tripMemberOwnershipId(tripId, uid)`
helper (`functions/src/domain/tripMemberOwnership.ts`) for every ownership
row it writes or reads — never hand-concatenate `${tripId}_${uid}`.
`tripOwnershipAllocationId(withdrawalTransactionId)` similarly for every
allocation document — it is **not** a composite id (single component,
no delimiter restriction at all).

**Frozen, re-confirmed from `tripCompositeId.ts`'s own header comment at
this HEAD:** the underscore delimiter is accepted only because this
project's *current* flows happen not to produce an underscore-containing
component — a Trip id is a Firestore auto-generated id (platform
guarantee, genuinely underscore-free); a uid is an opaque Firebase Auth
string with **no** such platform guarantee (only an observation that
*today's* registration flow never calls `createUser({uid: ...})` with a
caller-chosen value). `tripMemberOwnershipId`/`assertNoDelimiter` already
throw (`HttpsError("internal", ...)`, which surfaces as a plain thrown
error outside a callable context, exactly as any other exception would in
a Node.js migration script) the moment either component violates this
assumption. **Migration must never catch and route around this
exception with a fallback id scheme** — per this checkpoint's own
instruction, encountering it means **migration must stop for that Trip**,
flagged `REQUIRES_MANUAL_REVIEW` (`"invalid canonical ownership id"`,
§26). Given no current flow produces such a uid, this is expected to be
unreachable in practice for the foreseeable migration population, but
the guard is never bypassed.

---

## 13. Currency

**Re-confirmed from source:** `resolveEffectiveCurrency(parentData,
requestCurrency)` establishes the Trip's one effective currency (its own
`currency` field if present, else `"USD"`) and requires an **exact**
string match, no normalization, no case-folding. Every write site in all
three callables enforces this already. `Expense.currency`/
`SavingsTransaction.currency` are both free-form `CurrencyCode = string`
at the type level, but in practice are always already proven equal to
the Trip's effective currency by the trusted callable that wrote them (a
currency mismatch at write time is rejected before any document is
created — confirmed in all three callables' existing, unmodified
validation blocks).

**Migration's own currency validation, frozen:**
- **Impossible (should never occur, checked anyway):** any historical
  `SavingsTransaction`/`Expense` whose `currency` differs from the Trip's
  own effective currency. Confirmed structurally impossible for any
  document a trusted callable actually wrote (both already enforce exact
  match before writing) — but migration checks this explicitly per-event
  anyway, matching this codebase's "never assume, always verify" rule,
  and fails that Trip closed (`"currency mismatch"`, §26) if it is ever
  observed, since its existence would itself prove some other, unknown
  write path once bypassed the trusted callables.
- **Repairable:** none. **No currency conversion of any kind occurs
  during migration**, per this checkpoint's own explicit instruction.
- **Requires manual review:** any mismatch found (see above) — there is
  no automatic repair path; a human must determine how a currency-
  inconsistent record came to exist before this Trip can ever migrate.

---

## 14. Safe-Integer / Numeric Validation

Every historical `amountMinor` migration consumes is validated through
the **existing** 5B.2 pure predicates before any arithmetic — never a
new, parallel validation scheme:
- `applyMemberContribution`/`applyMemberWithdrawal` already reject
  non-safe-integer/non-positive amounts and unsafe results (`"unsafe_
  result"`, `"invalid_amount"`).
- `applySharedStashDepletion`/`restoreSharedStashDepletion` already
  perform every proportional computation in `BigInt` internally
  (confirmed, this session's own 5B.2 work), re-asserting safe-integer
  bounds at every conversion boundary.
- `validateAndNormalizeMemberOwnershipBalances` already rejects a
  malformed/duplicate/unsafe ownership-balance array outright.

Migration's own **additional** responsibility (not covered by those
primitives, since they only validate their own direct numeric
arguments) is validating the **raw Firestore field values** before ever
passing them in: `typeof amountMinor === "number" &&
Number.isSafeInteger(amountMinor)` for every `amountMinor` read off a
historical document (NaN, a string, a float, or an out-of-range value
must never reach the pure primitives at all — they would correctly
reject such input, but migration should classify *which specific
historical document* was malformed for the audit output, §30, rather
than let a primitive's generic rejection reason stand in for "this
specific document is corrupt"). **No floating-point proportion is ever
computed anywhere in this algorithm** — re-confirmed, not re-decided.

---

## 15. Aggregate Reconciliation

**Both of the checkpoint's suggested validations are possible here, and
both are required — not merely optional extra safety:**

1. **Σ reconstructed ownership == Trip's CURRENT `ledgerBalanceMinor`**
   (read fresh, at finalization time, inside the finalization
   transaction — §20). This is the §7-of-the-original-preflight
   invariant itself; it is the **one** condition that must hold for
   `"initialized"` to ever be written.
2. **Independently replaying the full historical ledger (opening
   balance + every signed `amountMinor` in chronological order) must
   produce the exact same total as `Trip.ledgerBalanceMinor` already
   caches.** This is not redundant with (1) — (1) proves the *ownership
   model* agrees with the *cached aggregate*; (2) proves the *cached
   aggregate* itself agrees with the *actual immutable history* it
   claims to summarize. A Trip could in principle have a self-consistent
   but wrong `ledgerBalanceMinor` (e.g. from a hypothetical bug in some
   earlier, unrelated code path) that nonetheless happens to equal a
   wrongly-reconstructed ownership sum — (2) closes that gap by deriving
   the expected aggregate from the *same* history migration already
   scanned for ownership, at zero additional read cost (the opening
   balance plus a running signed sum of the exact same events §8 already
   iterates).

**Exact definitions, frozen:**
- **Successful reconciliation:** both (1) and (2) hold exactly (integer
  equality, no tolerance/rounding).
- **Ownership drift:** (2) holds (replayed-ledger total matches the
  stored aggregate) but (1) fails (the ownership reconstruction itself
  diverges from that total) — this would indicate a bug in the
  reconstruction algorithm itself, not the data; treated as `fail
  closed`, Trip remains `migrating`, flagged for engineering
  investigation (distinct from ordinary `REQUIRES_MANUAL_REVIEW`, since
  it implicates the tool, not the Trip's data).
- **Historical drift:** (1) holds but (2) fails (the stored aggregate
  disagrees with what the immutable history itself replays to) — this is
  exactly the kind of "the cache has quietly drifted from the ledger"
  scenario §12B of the original preflight already names as a real,
  always-possible risk (external/manual Firestore edits). Fail closed,
  `REQUIRES_MANUAL_REVIEW` (`"aggregate/history mismatch"`).
- **Malformed history:** any single event fails §6/§13/§14's own
  validation during replay — the Trip never reaches a reconciliation
  verdict at all; it fails closed at the point of the malformed event,
  tagged with that event's own specific corruption reason.
- **Unresolved opening balance:** §5's Case C — never reaches
  reconciliation; excluded at eligibility (§4) before any scan begins.

**Any unresolved mismatch of any of the above kinds: `"initialized"` is
never written. The Trip remains `"migrating"` until explicitly repaired
or resumed** (§20) — never silently downgraded, never partially
finalized.

**Hardened by Checkpoint 5B.4A.1, item 7:** the aggregate-sum invariant
above (condition 1) is **necessary but not sufficient** on its own — a
wrong per-member distribution or a wrong set of allocation records can
share an identical sum/count with the correct answer (the checkpoint's
own worked example: `{Daniel: 900, Friend: 100}` vs. a corrupted
`{Daniel: 800, Friend: 200}`). §16A/§22 freeze an **additional**,
stronger exact-output-set digest verification that finalization performs
*before* this sum check is even allowed to matter — the sum/aggregate
equality remains an independent invariant worth checking in its own
right, never a substitute for proving the exact expected set.

---

## 16. Migration State Lock

**Pre-lock step, added by Checkpoint 5B.4A.1, item 6 (bounded automatic
migration):** before ever attempting the lock-acquisition transaction
below, the tool performs a cheap, read-only measurement of the Trip's
total ownership-relevant history size (a count of matching
`savingsTransactions` + `tripExpenses` documents, via the same
index-free queries §21 already establishes). If this count exceeds the
safe automatic-migration bound (an exact numeric threshold is explicitly
**not** frozen by this document — see §16A's own note on why), the Trip
is `REQUIRES_MANUAL_REVIEW` (`history_exceeds_automatic_migration_limit`)
and **the lock is never attempted at all** — never a partially-scanned,
partially-locked Trip.

**Exact trusted lock-acquisition transaction**, extending §12A.3 of the
original preflight into concrete, current-schema steps — **corrected by
Checkpoint 5B.4A.1, item 11: the Trip document receives ONLY the
authorizing state field, nothing else.** The original version of this
section proposed writing `lastUpdatedAt`/`lastUpdatedBy` on the Trip as
migration bookkeeping. Direct inspection of `src/types/domain/trip.ts`
confirms these fields exist and are written by the three live financial
callables, but **always alongside an actual financial-state change
those fields are documenting** (a new balance, a new archive status) —
there is no established convention of writing them for a lock-flag-only
change, and this document's own already-proposed dedicated
`tripOwnershipMigrationState` collection is the correct, established-
pattern home for every piece of migration bookkeeping instead of
inventing a new justification for touching unrelated Trip metadata:

```text
db.runTransaction(tx => {
  tripSnap = tx.get(tripRef)
  if (!tripSnap.exists) fail "not-found"
  tripData = tripSnap.data()

  classification = classifyTripOwnershipModelState(
    tripData.ownershipModelState, tripData.ownershipModelVersion)
  if (classification.kind !== "legacy") {
    if (classification.kind === "migrating")
      => explicit, distinct outcome (see below) - never silently retried
         as if it were a fresh acquisition
    else
      fail "already-exists"-equivalent: Trip is not eligible (initialized/
      needs_reconciliation/corrupt)
  }

  ledgerBootstrapClass = classify per §5's full decision table
    (classifyLedgerInitialization + history-emptiness guard +
    deriveLegacyLedgerInitialization, exactly as production bootstrap
    already does)
  if (ledgerBootstrapClass is anything other than Case A / Case
      A-equivalent)
    fail REQUIRES_MANUAL_REVIEW (the specific §5/§26 reason), no lock
    acquired

  if (!Array.isArray(tripData.memberIds))
    fail REQUIRES_MANUAL_REVIEW, no lock acquired

  // Checkpoint 5B.4A.2, item 1: construct the canonical locked
  // financial basis from the SAME read of tripData already used above
  // - never a second, independent read. See §16A for the exact shape
  // and why this is NOT redundant with lockedLedgerBalanceMinor alone.
  lockedFinancialBasis = buildLockedFinancialBasis(tripData,
    ledgerBootstrapClass)   // §16A

  // Only now, with every precondition proven inside THIS transaction's
  // own consistent read snapshot, perform the one authorizing write -
  // the Trip document gets ONLY this field:
  tx.update(tripRef, {
    ownershipModelState: "migrating",
    // ownershipModelVersion remains absent - never written here.
    // No lastUpdatedAt/lastUpdatedBy - migration bookkeeping lives
    // exclusively in migrationStateRef below (5B.4A.1, item 11).
  })
  tx.set(migrationStateRef, {        // proposed NEW collection - §16A
    tripId,
    attemptId: <fresh UUID, generated by the tool>,
    phase: "locked",                 // Checkpoint 5B.4A.2, item 2
    lockedAt: FieldValue.serverTimestamp(),
    lockedFinancialBasis,            // §16A - replaces the old, insufficient
                                        lockedLedgerBalanceMinor-alone design
    startedAt: FieldValue.serverTimestamp(),
    // sourceHistoryDigest/sourceHistoryDocumentCount/
    // expectedOwnershipDigest/expectedOwnershipCount/
    // expectedAllocationDigest/expectedAllocationCount are NEVER written
    // here, and NEVER merely absent-as-a-progress-signal (5B.4A.2, item
    // 2) - they are written only by the SEPARATE "locked -> reconstructed"
    // phase-transition transaction (§16B), once the bounded history
    // scan and reconstruction (§8) actually complete. No migration
    // output row may be written while phase remains "locked" (§16B/§19).
  }, {create-only semantics - never overwrite an existing one})

  return "lock_acquired"
})
```

**Explicit behavior if already `"migrating"`:** this is **not** a
rejection in the ordinary sense — it is a **distinct, third outcome**
("already locked by *something*") that the migration tool's own
*resumption* logic (§20) handles separately from a fresh acquisition.
The lock-acquisition step itself never silently proceeds as if it had
just acquired the lock; it reports "already migrating" and hands control
to the resumption decision (does a matching `migrationStateRef` document
exist? → resume; does it not? → `REQUIRES_MANUAL_REVIEW`,
`"unexplained migrating state"`).

This is a **proposed, additive, new collection** (`tripOwnershipMigrationState`
or equivalent name) — **not implemented in this checkpoint**. It is
small, inert, write-closed to every client (mirroring `tripMemberOwnership`/
`tripOwnershipAllocations`'s own existing Rules posture), and touches
nothing else in the schema. Flagged explicitly as a **5B.4B
requirement** — see §16A for the full field list and §13's own
per-field justification.

---

## 16A. Locked Financial Basis, Source-History Fingerprint, and Exact-Output Verification (Checkpoint 5B.4A.1 Items 4-7/13, Hardened by Checkpoint 5B.4A.2 Item 1)

**Two independent protections, never conflated:** the migration tool
locks and later re-verifies a **canonical Trip financial basis**
independently from the **source-history digest**. The former protects
Trip-level ledger/bootstrap/currency facts (fields that live directly on
the Trip document, never inside `savingsTransactions`/`tripExpenses`);
the latter protects the historical financial documents themselves. This
distinction is frozen — neither substitutes for the other.

**Why the locked financial basis is NOT redundant with a bare aggregate
snapshot — corrected by Checkpoint 5B.4A.2, item 1:** the original
version of this document treated `lockedLedgerBalanceMinor` alone as
sufficient, reasoning that the source-history digest would catch
anything else. That reasoning has a real gap: `ledgerOpeningBalanceMinor`
and `ledgerBalanceMinor` are **Trip document fields**, never
`savingsTransactions`/`tripExpenses` documents — the source-history
digest cannot see them at all, by construction. Concretely: locked
opening `0` / locked aggregate `1000`; an out-of-band edit changes
opening to `500` while leaving the aggregate at `1000` — the aggregate
check alone passes, but the financial basis (how much of that `1000` is
"opening" vs. "transaction history") has silently changed, which this
architecture's entire ownership reconstruction depends on getting right
(§5/§8). Equivalently, for an **uninitialized** Trip, an out-of-band
edit to the legacy `Trip.saved` field can change what
`deriveLegacyLedgerInitialization` would derive, with **zero** change to
any `savingsTransactions`/`tripExpenses` document — again invisible to
the source-history digest.

**Canonical locked financial basis, frozen shape** — one explicit object,
captured once inside the lock transaction (`buildLockedFinancialBasis`,
§16) from the exact same `tripData` read already used for eligibility,
never a second independent read:

```text
lockedFinancialBasis =
  | {
      ledgerInitializationKind: "initialized",
      ledgerOpeningBalanceMinor: number,   // exact, as persisted
      ledgerBalanceMinor: number,          // exact, as persisted
      effectiveCurrency: string,           // resolveEffectiveCurrency(tripData)
    }
  | {
      ledgerInitializationKind: "uninitialized",
      derivedLegacyOpeningBalanceMinor: number,  // deriveLegacyLedgerInitialization
                                                     (tripData.saved ?? 0).initOpeningMinor
      effectiveCurrency: string,
    }
```

**Re-verified at finalization (§22), by re-running the identical
classification against the CURRENT Trip document and requiring EXACT
equality with the locked value, field for field:**
- **Initialized Trip:** `ledgerOpeningBalanceMinor`, `ledgerBalanceMinor`,
  and `effectiveCurrency` must all still exactly match. If either ledger
  field changed, appeared, or disappeared after lock — fail closed
  (`locked_financial_basis_mismatch`).
- **Uninitialized Trip:** the ledger fields must still both be absent
  (if either now appears — fail closed, the Trip's own ledger-
  initialization kind changed after lock, which is itself impossible
  under every trusted write path while `"migrating"` and therefore proof
  of an out-of-band edit), and re-running
  `deriveLegacyLedgerInitialization` against the Trip's *current*
  `saved` value must produce the *exact same*
  `derivedLegacyOpeningBalanceMinor` — if `saved` changed in a way that
  shifts the derived opening balance (e.g. a value that used to derive
  `0` now derives something positive, or vice versa), fail closed.
- **Either kind:** `effectiveCurrency` must still match exactly — no
  currency conversion or normalization ever occurs; a changed Trip
  `currency` field after lock fails closed.

This check is **independent of, and performed alongside**, the
source-history digest check below — both must pass; neither is a
substitute for the other.

---

**Why `createdAt > lockedAt` alone is insufficient (item 4):** it detects
a *newly created* record after the lock. It does **not** detect an
existing `savingsTransactions`/`tripExpenses` document being *edited* in
place, *deleted*, a manually-created backdated record (whose `createdAt`
is itself the forged field), or a mutation to some *other*
replay-relevant field while `createdAt` happens to stay unchanged.
`lockedAt` therefore **downgrades to audit metadata and an early, cheap
anomaly check** — useful, never claimed sufficient on its own.

**Canonical source-history digest, frozen design:**

1. After lock acquisition, load the complete ownership-relevant source
   history for the Trip (the bounded set already measured at §16's
   pre-lock step) — every `savingsTransactions` document for
   `resourceType=="trip", resourceId==tripId`, and every `tripExpenses`
   document for `tripId==tripId` (including `"member_out_of_pocket"`
   ones, fetched incidentally — §3/§12 hardening — but **excluded from
   the digest's own economic-field projection**, since they carry no
   replay-relevant fields to begin with; only their presence/count
   matters, see below).
2. Validate every document and build the logical-event list (§7/§8).
3. Construct a **deterministic canonical projection** of every
   source document — explicit field order, explicit normalization,
   never relying on however Firestore happens to serialize a document
   object:

   **`SavingsTransaction` projection** (array of these objects, sorted
   by `[id]` ascending for a stable digest input order — sorting by id
   rather than by the §7 replay order specifically *because* the digest
   must detect a record whose own `createdAt` was tampered with, so it
   cannot sort by the very field it is trying to protect):
   ```text
   {
     id: string,
     resourceType: string,
     resourceId: string,
     memberUid: string,
     type: string,
     amountMinor: number,
     currency: string,
     createdAtSeconds: number,   // Timestamp.seconds - exact, never a
     createdAtNanos: number,     // formatted/rounded string
     reversalOf: string | null,
     linkedExpenseId: string | null,   // normalized: absent -> null,
                                          never an actual `undefined` in
                                          the hashed representation
   }
   ```
   **`Expense` projection** (same sort-by-id discipline):
   ```text
   {
     id: string,
     tripId: string,
     paymentSource: string,
     amountMinor: number,
     currency: string,
     sharedStashTransactionId: string | null,
     status: string,
     createdAtSeconds: number,
     createdAtNanos: number,
     reversedAtSeconds: number | null,
     reversedAtNanos: number | null,
     refundTransactionId: string | null,
     replacesExpenseId: string | null,
     replacedByExpenseId: string | null,
   }
   ```
4. Serialize both arrays via a fixed, explicit scheme — e.g. `JSON.stringify`
   over the exact object-key order written above (never relying on
   V8's own key-enumeration order for an object built by spreading
   Firestore's returned data; each projection object is built field-by-
   field, in the order listed, specifically to make the serialization
   deterministic across Node.js versions/processes) — concatenated with
   an explicit separator, and hashed with SHA-256. **Never hash a raw
   Firestore `DocumentSnapshot`/`DocumentData` object directly** —
   Firestore's own internal field ordering is not a contract this
   digest may depend on.
5. Persist `sourceHistoryDigest` (the hex digest) and
   `sourceHistoryDocumentCount` (total documents projected, both
   collections combined) in `migrationStateRef`, as part of the explicit
   `"locked" -> "reconstructed"` phase transition (§16B) — never inside
   the small lock transaction (§16/§21), and never as a bare field
   update with no accompanying phase change (5B.4A.2, item 2).

**Expected-output digests (item 7) — exact-set verification, not sums:**
the checkpoint's own worked example is decisive: `{Daniel: 900, Friend:
100}` and a corrupted `{Daniel: 800, Friend: 200}` share the identical
sum. A sum/count check alone **cannot** catch a wrong distribution with
a right total, or a right allocation count with wrong contents. Frozen,
in addition to (never instead of) the §15 aggregate-sum invariant:

- **`expectedOwnershipDigest`**: canonical projection
  `[{uid, ownershipMinor}, ...]`, sorted by `uid` ascending (the same
  canonical order already frozen for the live `tripOwnershipAllocations`
  schema, §9 of the original preflight), hashed the same explicit way as
  above. `expectedOwnershipCount` — the row count.
- **`expectedAllocationDigest`**: canonical projection of every
  allocation's **immutable economic fields only** —
  `[{id, tripId, expenseId, withdrawalTransactionId, amountMinor,
  currency, allocations, provenance, createdAtSeconds, createdAtNanos},
  ...]`, sorted by `id` ascending, hashed the same way. **Deliberately
  excludes** `migratedAt` and ownership-row `lastUpdatedAt` — both are
  intentionally-variable operational metadata (a rerun's `migratedAt`
  legitimately differs run to run for an otherwise-identical record,
  §19) that must never make an otherwise-correct record look "different"
  to this digest. `expectedAllocationCount` — the record count.

Both are computed once, immediately after reconstruction (§8) completes
successfully, and persisted into `migrationStateRef` **as part of the
same `"locked" -> "reconstructed"` phase-transition update** as the
source-history digest (§16B) — **before** any output write occurs, so a
crash mid-write-phase has a stable, already-computed target to resume
toward (§19/§20), and so that "reconstruction is complete" is always an
explicit, atomic phase change rather than something inferred from which
optional fields happen to be present.

**Consolidated `migrationStateRef` field list (item 13) — every field
justified individually, nothing included merely for convenience:**

| Field | Purpose | Correctness-critical or audit-only? |
|---|---|---|
| `tripId` | Identifies which Trip this lock/state belongs to (the document's own id could serve this role too, but an explicit field survives being read out of context, e.g. in a log line). | Audit-only. |
| `attemptId` | Resumability disambiguation (§18/§20) — distinguishes "this exact tool, this exact lock" from any other attempt; correlates a resumed run's output with its original attempt in the audit log. | Correctness-critical (§19/§20's fresh-vs-resumed distinction depends on this document's mere *existence*, but `attemptId` specifically is what makes a *resumed* run's own audit trail coherent). |
| `phase` | **(Checkpoint 5B.4A.2, item 2)** The explicit migration-state lifecycle phase (`"locked"` / `"reconstructed"` / `"completed"`) — governs which other fields must/must not be present (§16B) and which resume path applies (§19/§20). Reconstruction progress is never inferred from which optional fields happen to exist. | Correctness-critical. |
| `lockedAt` | Early, cheap anomaly check (a `createdAt > lockedAt` scan can short-circuit obviously-wrong cases fast) and the historical origin point for audit purposes. **No longer the sole out-of-band-mutation proof** (§16A's own correction) — downgraded from primary mechanism to a useful secondary signal. | Audit-only (the digest in `sourceHistoryDigest` is the correctness-critical mechanism now). |
| `lockedFinancialBasis` | **(Hardened, Checkpoint 5B.4A.2, item 1)** The canonical Trip-level financial-basis snapshot (ledger-initialization kind, opening/current balance or derived legacy opening, effective currency) — re-verified at finalization independently from the source-history digest, since Trip document fields are invisible to that digest entirely. Replaces the earlier, insufficient `lockedLedgerBalanceMinor`-alone design. | Correctness-critical. |
| `sourceHistoryDigest` / `sourceHistoryDocumentCount` | The canonical source-history fingerprint (§16A) — finalization's primary out-of-band-mutation defense over `savingsTransactions`/`tripExpenses`, re-verified by exact recomputation inside the finalization transaction. | Correctness-critical. |
| `expectedOwnershipDigest` / `expectedOwnershipCount` | The canonical expected-output fingerprint for `tripMemberOwnership` (§16A/item 7) — finalization's primary defense against a wrong distribution with a right sum. | Correctness-critical. |
| `expectedAllocationDigest` / `expectedAllocationCount` | The same, for `tripOwnershipAllocations`. | Correctness-critical. |
| `startedAt` / `completedAt` | Audit timeline — when this attempt began and (if ever) finished. `completedAt` additionally doubles as the required-iff-`phase=="completed"` discriminant (§16B). | Audit-only, except `completedAt`'s presence/absence, which is correctness-critical to the phase-shape validation (§16B). |

No field from the checkpoint's own suggested list was dropped without a
reason: the original `lockedLedgerBalanceMinor`/`derivedOpeningState`
pair is superseded entirely by the single `lockedFinancialBasis` object
(item 1 — a more complete, more precisely-targeted replacement, not a
mere rename).

**Why a numeric history-size bound is frozen as an architectural rule,
not an exact number (item 6):** reading the complete bounded source
history inside (or immediately before) the finalization transaction is
*intentionally stronger* than a timestamp-only design, and this document
explicitly refuses to weaken that integrity proof merely to support an
arbitrarily large Trip. The **rule** — bounded automatic migration,
fail closed above the bound, intermediate *output* writes may still be
chunked (§21) but the *integrity proof itself* is never chunked or
approximated — is frozen now. The **exact threshold** is deliberately
left to 5B.4B's own implementation, once real Firestore read-cost/
transaction-size behavior can be measured against this product's actual
Trip-history sizes — inventing a specific number here would be exactly
the kind of unsupported numeric claim this document's own "no guessing"
discipline exists to avoid.

---

## 16B. Migration-State Phase Lifecycle (New, Checkpoint 5B.4A.2, Item 2)

**Why an explicit phase field, rather than inferring progress from which
optional fields happen to exist:** the original design risked exactly
the ambiguity this checkpoint flags — a `migrationStateRef` document
with no digest fields yet could mean "freshly locked, scan not started"
*or* "scan crashed mid-write before persisting digests," and nothing
distinguished them. A single, explicit, atomically-transitioned `phase`
field removes the ambiguity entirely.

**Three phases, frozen:**

### `phase: "locked"`

Written atomically with the Trip's own `legacy -> migrating` write
(§16) — same transaction, same commit. At this instant:
- **Must contain:** `tripId`, `attemptId`, `phase`, `lockedAt`,
  `lockedFinancialBasis`, `startedAt`.
- **Must NOT contain:** `sourceHistoryDigest`, `sourceHistoryDocumentCount`,
  `expectedOwnershipDigest`, `expectedOwnershipCount`,
  `expectedAllocationDigest`, `expectedAllocationCount`, `completedAt`.
- **Must never claim reconstruction is complete.** No migration output
  row (`tripMemberOwnership`, `tripOwnershipAllocations`) may be written
  for this Trip while `phase === "locked"` — enforced as a hard
  precondition the tool itself checks before any output write, and
  independently verifiable by inspecting Firestore directly (§19's
  fresh-vs-resume table already froze the general "no pre-existing
  output" expectation for a fresh lock; this phase makes the *window*
  during which that must hold explicit and checkable even for a
  resumed attempt that hasn't reached reconstruction yet).

### The `"locked" -> "reconstructed"` transition (its own atomic step)

While the Trip remains `"migrating"`:
1. Scan the bounded source history (§16A).
2. Validate and fully reconstruct (§8).
3. Compute `sourceHistoryDigest`/`sourceHistoryDocumentCount`,
   `expectedOwnershipDigest`/`expectedOwnershipCount`,
   `expectedAllocationDigest`/`expectedAllocationCount` (§16A).
4. In one atomic transaction, update `migrationStateRef`:
   ```text
   db.runTransaction(tx => {
     ms = tx.get(migrationStateRef)
     tripSnap = tx.get(tripRef)
     if (!ms.exists) fail-closed ("lost_lock_state")
     if (ms.data().phase !== "locked") fail-closed
       ("invalid_migration_state_phase")
     if (ms.data().attemptId !== thisAttemptId) fail-closed
       ("invalid_migration_state_phase")
     classification = classifyTripOwnershipModelState(
       tripSnap.data().ownershipModelState,
       tripSnap.data().ownershipModelVersion)
     if (classification.kind !== "migrating") fail-closed
       ("unexpected_state_change")

     tx.update(migrationStateRef, {
       phase: "reconstructed",
       sourceHistoryDigest, sourceHistoryDocumentCount,
       expectedOwnershipDigest, expectedOwnershipCount,
       expectedAllocationDigest, expectedAllocationCount,
     })
     return "reconstructed"
   })
   ```
   This update fails closed if the Trip is no longer migrating, if
   `attemptId`/`phase` no longer match what this run expects, or if
   `phase` is anything other than `"locked"` going in.
5. **Only after this transition commits** may chunked migration-output
   writes (§21) begin. This establishes, durably and atomically, exactly
   what reconstruction the subsequent writes are supposed to
   materialize — a crash immediately after this transition has a
   stable, frozen target to resume toward.

### `phase: "reconstructed"`

Means, durably: the authoritative bounded history was fully validated;
the expected source digest was frozen; the expected ownership/allocation
digests were frozen; output materialization may now proceed, or be
safely resumed idempotently after a crash, against those frozen
expectations (§19/§20).
- **Must contain:** everything `"locked"` required, **plus**
  `sourceHistoryDigest`, `sourceHistoryDocumentCount`,
  `expectedOwnershipDigest`, `expectedOwnershipCount`,
  `expectedAllocationDigest`, `expectedAllocationCount`.
- **Must NOT contain:** `completedAt`.

### `phase: "completed"`

Written **only** inside the same finalization transaction (§22) that
flips `Trip.ownershipModelState -> "initialized"` and sets
`ownershipModelVersion`. Never permitted while the Trip itself remains
`"migrating"` — the two writes are atomic and simultaneous, by
construction, since they are the same transaction. Migration must never
initialize the Trip while `phase` is merely `"locked"` — finalization's
own precondition (§22) requires `phase === "reconstructed"` before it
will even attempt the rest of its checks.
- **Must contain:** everything `"reconstructed"` required, **plus**
  `completedAt`.
- All reconstruction fields are **retained**, never cleared — the
  `migrationStateRef` document is never deleted after success; it is
  the permanent audit record for this Trip's migration (§16A/§28).

---

## 17. In-Flight Transaction Race Analysis (Critical)

**Claim to prove:** once the migration-lock transaction commits, no
previously-started repository financial mutation can subsequently commit
a *new* financial change without first observing `"migrating"`.

**Proof, grounded in mode-independent Firestore guarantees plus this
repository's own confirmed code structure — corrected by Checkpoint
5B.4A.1, item 9:** the original version of this section stated
"Firestore Admin SDK transactions use optimistic concurrency" as a
universal fact. That overstates what is actually guaranteed: Firestore's
server-side concurrency mechanism is configured at the database level
(Firestore in Datastore mode vs. native mode, and within native mode,
the database's own concurrency-control setting), and this architecture
must not depend on which specific mechanism is in effect. The proof
below is restated using only the properties Firestore guarantees
**regardless** of concurrency mode:

- Firestore transactions are **serializable** — the database guarantees
  that the set of committed transactions behaves as if they executed in
  *some* serial order, never producing a result inconsistent with every
  possible serial ordering.
- When two transactions conflict (one reads a document another
  concurrently writes), the Admin SDK's transaction API resolves this
  via its documented retry contract: a transaction that cannot be
  serialized as written is **delayed, retried, or aborted** by the
  client library (via automatic callback re-invocation, up to its
  configured retry limit) rather than silently committing a result
  inconsistent with serializable ordering — this contract is the same
  across the underlying concurrency mechanism; this document does not
  depend on *which* mechanism produces it, only that the SDK's retry
  behavior itself is guaranteed.
- Therefore: **the financial callable's transaction (which reads the
  Trip) and the migration-lock transaction (which writes the same Trip)
  cannot both be treated as having committed in an order where the
  callable's read precedes the lock's write *and* the callable goes on
  to commit a new financial mutation without ever observing the lock's
  write.** Serializability requires some total order between the two;
  if the lock's write is serially earlier, the callable's transaction
  must either observe it (and therefore see `"migrating"` on whichever
  attempt actually commits) or be the one that is retried/aborted.

This mode-independent framing still relies on retry re-invoking the
*entire* callback (so the gate check re-runs against fresh data), which
is the Admin SDK's own documented client-side behavior, not a
database-concurrency-mode detail — every `tx.get(...)` call inside a
transaction's callback is re-performed on each retry attempt, against
whatever data is current at that attempt.

Confirmed directly from source, for **all three** ownership-affecting
callables, that every single code path — including every early-return
replay branch — begins by reading the Trip (or, for
`recordSavingsTransactionCore`, the Bucket-or-Trip "parent") document
via `tx.get(...)` **inside that callable's own transaction**, every
single invocation, with no caching or reuse across retries:
`recordSavingsTransactionCore`: `parentSnap = await tx.get(parentRef)`.
`recordSharedStashExpenseCore`: `tripSnap = await tx.get(tripRef)`.
`reverseSharedStashExpenseCore`: `tripSnap = await tx.get(tripRef)`
(read in step D, before authorization).

The migration-lock transaction (§16) performs a genuine **write** to
that exact same Trip document (`ownershipModelState: "migrating"`).
Therefore:

- **Case A — the concurrent callable's transaction has not yet attempted
  to commit when the lock commits:** serializability requires the
  callable's transaction to be ordered either before or after the lock's
  write. If the SDK's retry contract determines it must come after (the
  only way its own commit can succeed is by being retried against the
  lock's already-committed result), the retry re-reads the Trip document
  fresh, observes `"migrating"`, and — because the gate check
  (`classifyOwnershipMutationGate`) is itself *inside* the same
  re-invoked callback, re-executed on every retry — correctly rejects
  the mutation this time. **No new financial write occurs.**
- **Case B — the concurrent callable's transaction already committed
  successfully *before* the lock transaction's own commit:** this is not
  a race at all — it is an ordinary pre-lock write, already accounted
  for by the fact that the lock transaction's *own* read of the Trip
  (and, transitively, of the history §8 will scan) happens *after* that
  commit, so the scan will see it. This is exactly the designed, correct
  "below the lock" case.
- **Case C — a *replay-only* transaction (zero writes) races the
  lock:** a pure-replay branch that performs no `tx.set`/`tx.update` at
  all has no write to serialize against anything — there is nothing to
  conflict about, under any concurrency mechanism, since conflict
  resolution exists to protect *writes* from violating serializable
  order, and a read-only transaction cannot violate it. It simply
  returns the data it read (the original, already-committed result)
  regardless of what else changed concurrently. This is **exactly the
  intended behavior** (§18) — replay reconciles to an already-true
  historical fact, which remains true regardless of the Trip's current
  lifecycle state, and performs no new mutation either way.

**Conclusion: the claim holds under Firestore's serializability
guarantee alone — it does not depend on which specific concurrency
mechanism (optimistic or pessimistic) the database is configured to
use — given the already-confirmed fact that every ownership-affecting
callable reads the Trip document inside its own transaction on every
invocation (including every retry).** No additional hardening is
required in the three deployed callables for this specific race — 5B.3's
own structure already closes it, and this document's job was to *prove*
that claim from the actual code rather than assert it.

**The one race this mechanism does *not* close** is a **non-transactional,
out-of-band write** (e.g. a manual Admin SDK/console edit, or some
unrelated future backend bug) mutating, deleting, or backdating
`savingsTransactions`/`tripExpenses` records *during* migration's own
historical scan — since that scan is explicitly **not** one giant
Firestore transaction (§21), it cannot rely on serializable-transaction
guarantees at all for documents it reads non-transactionally. **Hardened
by Checkpoint 5B.4A.1, items 4-5:** this is the **source-history
fingerprint's** reason for existing (§16A), re-verified inside the
finalization transaction itself (§22) — a strictly stronger mitigation
than a `createdAt`-only watermark, which this document's original
version incorrectly treated as sufficient on its own (§16A explains
exactly why `createdAt > lockedAt` alone cannot detect an edited,
deleted, or backdated existing record).

---

## 18. Exact-Replay-During-Migration Analysis

Per §17's Case C: an exact replay performs **zero** new financial
mutation, by construction (no `tx.set`/`tx.update` call exists on that
code path in any of the three callables — confirmed from source, not
assumed). It therefore:
- Cannot alter any reconciliation field (`ledgerBalanceMinor`,
  `ledgerOpeningBalanceMinor`, any `tripMemberOwnership`/
  `tripOwnershipAllocations` document) — nothing is written.
- Cannot create a missing document — a replay only ever *reads* and
  *compares against* already-existing documents; if one it expects to
  exist is missing, it `throw`s (`failed-precondition`), it never creates
  a substitute.
- Cannot affect migration's history scan in any way — the scan reads
  `savingsTransactions`/`tripExpenses` directly; a replay touches neither
  collection with a write.

**Migration can and does safely ignore all such replays entirely** — they
are invisible to it, by construction, with no special-case code needed
anywhere in the migration tool to account for them.

---

## 19. Partial-Output / Idempotency Model

**Hardened by Checkpoint 5B.4A.1, item 8 — fresh lock vs. resumed
migration are NOT the same situation, and the tables below apply only
to the resumed case.** The original version of this section said a
differing `tripMemberOwnership` row can simply be overwritten "while
`'migrating'`," with no distinction for *whose* prior write produced it.
That is safe for a partial output *this exact migration mechanism*
produced before a crash — it is **not** automatically safe for a row
that already existed **before** a *fresh* `legacy -> migrating` lock
was ever acquired, since such a row has no legitimate explanation at
all (nothing has ever been authorized to write `tripMemberOwnership` for
a Trip that has never been anything but legacy).

**Frozen distinction, checked once, immediately after a lock-acquisition
attempt resolves, before any output computation begins — hardened by
Checkpoint 5B.4A.2, item 3, to be fully phase-aware rather than a bare
"does `migrationStateRef` exist" check:**

| Trip state + `migrationStateRef` | Classification | Behavior |
|---|---|---|
| `"legacy"`, no migration state | **Fresh migration candidate.** | Proceed with lock acquisition (§16) normally. Before this run writes anything, query for *any* existing `tripMemberOwnership` row or `tripOwnershipAllocations` record for this Trip. **Any** such document found is anomalous pre-lock data with no legitimate source — `REQUIRES_MANUAL_REVIEW` (`pre_existing_output_on_fresh_lock`), migration halts, **nothing overwritten, nothing trusted**. A fresh lock implies this Trip has never been anything but legacy (§3's forbidden-transition rules make "was once initialized/migrating" structurally unreachable), so the only honest explanation for existing output is external/manual/test data this tool must never silently absorb. |
| `"migrating"`, `migrationStateRef.phase === "locked"` | **Tool-owned migration interrupted before output materialization.** | Safe resume: re-scan/reconstruct the bounded history (§8), freeze the source-history/expected-output digests via the `"locked" -> "reconstructed"` transition (§16B), **then** begin output materialization. Before advancing past `"locked"`, there must be **no** tool-created migration outputs for this Trip at all — if any `tripMemberOwnership`/`tripOwnershipAllocations` document already exists while `phase` remains `"locked"`, this violates the write-order invariant §16B freezes (outputs may only be written once `phase === "reconstructed"`): **fail closed** (`invalid_migration_state_phase`), never silently treated as if reconstruction had already happened. |
| `"migrating"`, `migrationStateRef.phase === "reconstructed"` | **Normal resumable partial-output state.** | Re-read the frozen `sourceHistoryDigest`/expected-output digests from `migrationStateRef` (never recomputed as a fresh target — §16B already froze them); re-verify the current source history still matches `sourceHistoryDigest` (an early check, same mechanism §22 performs at finalization, run again here so a genuinely corrupted history is caught before wasted output-write effort); materialize/repair the deterministic ownership outputs per the tables below; skip already-matching immutable allocation outputs; any conflict → fail closed (tables below); once complete, proceed toward finalization (§22). |
| `"migrating"`, `migrationStateRef.phase === "completed"` | **Impossible — contradiction.** | `phase === "completed"` is only ever written atomically with `ownershipModelState -> "initialized"` (§16B) — a Trip claiming both `"migrating"` and a completed migration state disagree about the single most basic fact this mechanism tracks. **Fail closed** (`invalid_migration_state_phase`), flagged for engineering investigation, not ordinary operational review. |
| `"initialized"` at `CURRENT_TRIP_OWNERSHIP_MODEL_VERSION`, `migrationStateRef.phase === "completed"` | **Migration already successfully finished.** | Report "already completed," no new mutation of any kind — matches §20's own already-established "already initialized" no-op case. |
| `"initialized"`/`"needs_reconciliation"`, `migrationStateRef.phase === "locked"` or `"reconstructed"` | **Impossible pairing.** | A Trip cannot be `"initialized"`/`"needs_reconciliation"` while this tool's own state still claims an in-progress migration — these states are mutually exclusive by the frozen transition model (§3). **Fail closed** (`invalid_migration_state_phase`). |
| `"legacy"`, migration state exists (any phase) | **Impossible pairing.** | A `migrationStateRef` document implies a lock was once acquired, which (per §3's forbidden-transition rules) can never be followed by a return to `"legacy"`. **Fail closed** (`invalid_migration_state_phase`). |
| `"migrating"`, no migration state | **Unexplained/manual migrating state** (already frozen, §18/§20) | `REQUIRES_MANUAL_REVIEW` (`unexplained_migrating_state`) — never auto-resumed. |
| Any unrecognized/unknown `phase` value | **Impossible — never inferred.** | `REQUIRES_MANUAL_REVIEW` (`invalid_migration_state_phase`) — migration never guesses what an unknown phase string was "probably" meant to indicate. |

**The tables below apply only once `phase === "reconstructed"`** —
partial tool-owned output from an earlier, interrupted attempt by this
exact mechanism, past the lock-only stage, is expected and is safely
reconciled deterministically:

**Pre-existing `tripMemberOwnership` rows while `phase === "reconstructed"`**, frozen:

| Observed state of `tripMemberOwnership/{tripId}_{uid}` | Behavior |
|---|---|
| Absent | Create fresh with the computed value. |
| Present, `ownershipMinor` exactly matches this run's freshly-recomputed expected value | **Idempotent no-op** (or an unconditional overwrite with the identical value plus a fresh `lastUpdatedAt` — either is observably safe; this document recommends the unconditional overwrite for simplicity, since it is a strict no-op on content) |
| Present, `ownershipMinor` differs from the freshly-recomputed expected value | **Overwrite is safe and required *while still `"migrating"`*** — the Trip remains non-authoritative (no financial mutation has been permitted against it since the lock, §17) until finalization, so a stale/partial value from an earlier, interrupted attempt is **never** trusted as a competing source of truth. Migration always recomputes from the immutable history and **writes its own freshly-computed value over whatever is there**, every single run, every single row, unconditionally. |
| Malformed identity (document exists at the canonical id but its own `tripId`/`uid` fields disagree with the id, or `ownershipMinor` is not a valid safe integer) | **Fail closed** for this Trip — a malformed row at the canonical location, found *before* migration itself has written anything this run, indicates either a bug in a prior interrupted attempt or genuine external corruption; never silently repaired by simply overwriting without first surfacing it (`REQUIRES_MANUAL_REVIEW`, `"malformed pre-existing ownership row"`). |

**Why historical immutable records remain sole source-of-truth, restated
precisely:** the entire reconstruction (§8) is computed *fresh*, from
`savingsTransactions`/`tripExpenses`, every single run — a prior run's
own output (`tripMemberOwnership` rows, `tripOwnershipAllocations`
records) is **never read as an input** to the computation. It is only
ever **compared against**, as the write target, after the fact. This is
what makes "unconditional overwrite while migrating" safe: the computed
value never depends on what was already there.

**Pre-existing `tripOwnershipAllocations` records while `phase === "reconstructed"`** — these
differ from ownership rows because they are **immutable by the frozen
schema itself** (never overwritten under any circumstance once
written, live-5B.3 or migrated):

| Case | Behavior |
|---|---|
| No existing record at the canonical id | Write the freshly-computed `"migrated"` record. |
| Existing `"migrated"` record whose `tripId`/`expenseId`/`withdrawalTransactionId`/`amountMinor`/`currency`/`allocations` **exactly** match this run's freshly-computed value | **Idempotent — treat as already-done, skip the write entirely** (never re-write even an "identical" record, since `createdAt` would need to be bit-for-bit identical to the historical value anyway for true identity, and skipping avoids any question of whether a re-write could ever subtly differ — e.g. `migratedAt` would otherwise change on every rerun for no reason). |
| Existing `"original"` record at that id | **Never overwritten, ever, under any circumstance.** This is the scenario named in §29/§17 of the checkpoint prompt — a legacy Trip should never have one of these (§3's own transition model makes it structurally unreachable to reach `"original"` provenance without first having been `"initialized"`, which a true `"legacy"` Trip has never been). Finding one anyway is **itself** the anomaly: fail closed, `REQUIRES_MANUAL_REVIEW` (`"conflicting allocation record"`), flagged as evidence of impossible history, never silently trusted *or* silently discarded. |
| Existing record (either provenance) whose content **disagrees** with this run's freshly-computed value | **Fail closed**, `REQUIRES_MANUAL_REVIEW` (`"conflicting allocation record"`) — allocation records are immutable; a disagreement means either this run's own computation is wrong (a tool bug, investigated as such) or the existing record was never legitimately produced by this exact history (external corruption). Migration **never** picks one side and overwrites the other. |
| Malformed existing record (fails `validateTripOwnershipAllocationShape`) | **Fail closed**, `REQUIRES_MANUAL_REVIEW` (`"malformed existing allocation record"`) — reusing the exact existing 5B.1/5B.3B pattern of calling the real shape validator rather than ad-hoc field checks. |

---

## 20. Resumability / Crash Recovery

Analyzed crash points, each shown to be safely resumable under the model
above:

**Hardened by Checkpoint 5B.4A.2, item 2 — every crash point below is
now anchored to an explicit `phase` value, never inferred from which
optional fields happen to be present:**

| Crash point | `phase` found on resume | Recovery on next run |
|---|---|---|
| Immediately after `legacy -> migrating` + `migrationStateRef` write (both in the same transaction, §16) | `"locked"` | Lock-acquisition sees `"migrating"` + `migrationStateRef.phase === "locked"` → §19's phase-aware table recognizes this as "interrupted before output materialization" → proceeds to re-scan/reconstruct from scratch, using the **original** `lockedFinancialBasis` already captured (never recomputed as a new target) → drives the `"locked" -> "reconstructed"` transition (§16B). |
| After history load/reconstruction, before the `"locked" -> "reconstructed"` transition commits | `"locked"` (the transition never partially applied — it is itself one atomic Firestore transaction, §16B) | Identical to the row above — reconstruction is cheap, read-only, and deterministic to redo; no partial output exists yet to reconcile against, and §19 explicitly requires none to exist while `phase` is still `"locked"`. |
| After `"locked" -> "reconstructed"` commits, before any output write | `"reconstructed"` | §19's "normal resumable partial-output state" row applies directly — the frozen digests are read back (never recomputed as a new target at this point), and output materialization begins fresh. |
| After some allocation records written, before all | `"reconstructed"` | Re-run recomputes the *same* full set of expected allocations against the **already-frozen** `expectedAllocationDigest`; for each, §19's table applies (identical → skip; absent → create). Previously-written ones are found identical and skipped; the rest are created. |
| After some ownership rows written, before all | `"reconstructed"` | Re-run recomputes and unconditionally overwrites every row (§19) against the **already-frozen** `expectedOwnershipDigest` — previously-written ones land on the same value a second time; the rest are newly created. |
| Before final reconciliation | `"reconstructed"` | Re-run performs §15/§22's checks fresh, from the (now possibly-already-complete) current state — no different from a first attempt reaching that point. |
| During finalization itself (the single small transaction, §22) | `"reconstructed"` (finalization requires this as its own precondition, §16B/§22) | Firestore transactions are atomic — this transaction either fully commits (`"initialized"` + version + `migrationStateRef.phase -> "completed"`, all preconditions having held) or fully does not. There is no partially-applied finalization state to recover from; a rerun simply re-attempts finalization (and will find the Trip either already `"initialized"` with `phase === "completed"` — an explicit "already done, no-op" report — or still `"migrating"` with `phase === "reconstructed"` — retries normally). |

**Distinguishing "resumable migration owned by this mechanism" from
"unexplained/manual migrating state," frozen:** a Trip is
`"migrating"` **and** has a corresponding `migrationStateRef` document
→ safe to resume automatically. A Trip is `"migrating"` **and has no
such document** → this mechanism never created that lock; **do not
touch it automatically** — `REQUIRES_MANUAL_REVIEW`
(`"unexplained migrating state"`). This is exactly the `attemptId`/
companion-document design's purpose (§16).

---

## 21. Firestore Transaction / Batch / Chunking Strategy

**Firestore's own documented limit, already cited and relied upon
elsewhere in this exact architecture (original preflight §13):
a single transaction or batched write supports at most 500 writes.**
This product's own established scale assumption (small, friend/family
Trips — stated repeatedly and unchanged throughout 5B) makes it likely
that most eligible Trips' *write* volume (one ownership row per distinct
historical contributor, one allocation record per historical
Shared-Stash Expense) comfortably fits in far fewer than 500 writes. A
Trip with enough history to exceed that must still be handled correctly,
so chunking is designed in from the start, not deferred.

**Hardened by Checkpoint 5B.4A.1, item 6 — chunking applies to OUTPUT
writes only, never to the integrity proof itself:** §16's pre-lock
history-size bound exists precisely so this chunking strategy is never
asked to do double duty as a substitute for §16A's exact source-history/
expected-output digest verification. A Trip whose *history* is too
large to fully re-read and digest inside/around the finalization
transaction is `REQUIRES_MANUAL_REVIEW`
(`history_exceeds_automatic_migration_limit`) **before** any lock is
attempted — it is never migrated with a "best effort" partial or
sampled integrity check. Chunking below concerns only the *write* phase
of a Trip that already passed the bound.

1. **History scan (read-only):** performed **outside** any single
   enclosing transaction, via the **same index-free query shape already
   used by this project's own existing client code** for
   `tripExpenses` (`.where("tripId","==",tripId)`, no `orderBy`) and,
   by the same reasoning, applied identically to `savingsTransactions`
   (`.where("resourceType","==","trip").where("resourceId","==",tripId)`,
   no `orderBy`) — **introducing zero new index dependency**, even
   though a composite index already happens to exist for the latter
   query with `createdAt` ordering (§3). Sorting by the §7 ordering
   model happens **in memory**, in the migration tool's own process,
   after fetching. This is safe precisely *because* the Trip is already
   quiesced (§17) — the data cannot change out from under a non-
   transactional read in any way 5B.3's trusted callables could ever
   cause; only an out-of-band write could, and that is independently
   caught by §16's watermark at finalization.
2. **Write phase (the actual ownership rows + migrated allocation
   records):** split into multiple **separate** Firestore transactions
   (or plain batched writes, since no cross-document read-then-write
   consistency is needed *within* a single chunk — each chunk's content
   was already fully computed in step 1), each bounded well under the
   500-write ceiling. Chunk boundaries are **deterministic** (e.g. a
   fixed chunk size over the deterministically-ordered list of expected
   outputs) so that resuming after a crash mid-chunking reproduces the
   exact same chunk boundaries on the next run, keeping §20's recovery
   reasoning simple.
3. **These intermediate writes are explicitly non-authoritative** —
   `ownershipModelState` remains `"migrating"` throughout, so 5B.3's
   production callables continue rejecting every new financial mutation
   regardless of how far the write phase has progressed. This is the
   same principle the original preflight's §12A.4 already froze for
   resumability, now extended to intra-run chunking: partial completion
   is always safe to observe from outside, because nothing outside this
   tool treats a `"migrating"` Trip's cache rows as trustworthy yet.
4. **Finalization (§22) is its own final, small, separate transaction**
   — it does not re-scan history; it re-reads the Trip's current ledger
   fields, re-sums the now-fully-written `tripMemberOwnership` rows for
   this Trip (one more `.where("tripId","==",tripId)` query, same
   index-free shape), and performs the gate-check + the two-field write.
   Comfortably within ordinary transaction limits (a handful of reads, a
   bounded-size sum, one update).

No Cloud Functions runtime-timeout concern applies here, since this tool
is explicitly **not** a Cloud Function (§24) — it runs as a local/
administrative Node.js process with no imposed execution-time ceiling
beyond whatever the operator's own environment allows.

---

## 22. Final Reconciliation Gate / Final Initialization Transaction

**The single most important transaction in this entire design. Rewritten
by Checkpoint 5B.4A.1, items 5/7/11/14, and Checkpoint 5B.4A.2, items 1/4
— exact-set digest verification replaces sum/count-only checks, the
locked financial basis is re-verified as an INDEPENDENT protection
alongside the source-history digest, the phase precondition is checked
explicitly, and the Trip write is reduced to the two already-frozen
fields.** Before writing `"initialized"`, in one atomic transaction,
re-prove — **never trust any value computed earlier in the run**:

```text
db.runTransaction(tx => {
  // --- ALL READS FIRST ---

  tripSnap = tx.get(tripRef)
  if (!tripSnap.exists) fail (should be structurally impossible)
  tripData = tripSnap.data()

  migrationState = tx.get(migrationStateRef)
  if (!migrationState.exists) fail-closed ("lost_lock_state")
  ms = migrationState.data()

  // Bounded per §16/§16A - safe to fully re-read inside this
  // transaction precisely because the Trip was excluded at the pre-lock
  // step otherwise.
  sourceHistorySnap = read complete savingsTransactions + tripExpenses
    for this Trip (same index-free queries as §16A/§21)

  ownershipSnap = tx.get(ownershipQueryForThisTrip)
  allocationSnap = tx.get(allocationQueryForThisTrip)

  // --- THEN VALIDATE / COMPUTE ---

  // 1. Still migrating, exactly as this attempt left it.
  classification = classifyTripOwnershipModelState(
    tripData.ownershipModelState, tripData.ownershipModelVersion)
  if (classification.kind !== "migrating") fail-closed
    ("unexpected_state_change" - state/version changed unexpectedly)

  // 2. ownershipModelVersion is absent (re-confirms the above, belt-
  //    and-suspenders per this codebase's own "never assume" discipline).
  if (tripData.ownershipModelVersion !== undefined) fail-closed

  // 2a. (Checkpoint 5B.4A.2, item 4) Migration-state phase must be
  //     "reconstructed" - finalization NEVER proceeds from "locked"
  //     (reconstruction, and the frozen digests it produces, must
  //     already exist), and "completed" would mean this Trip already
  //     finished (a different, earlier-checked case entirely).
  if (ms.phase !== "reconstructed") fail-closed
    ("invalid_migration_state_phase")

  // 2b. (Checkpoint 5B.4A.2, item 4) Re-verify the LOCKED FINANCIAL
  //     BASIS - independently from the source-history digest below,
  //     since Trip-document fields (ledgerOpeningBalanceMinor/
  //     ledgerBalanceMinor/currency, or the legacy `saved`-derived
  //     opening value) are invisible to that digest entirely (§16A).
  currentLedgerBootstrapClass = classify per §5's full decision table,
    using tripData exactly as freshly read above
  currentFinancialBasis = buildLockedFinancialBasis(tripData,
    currentLedgerBootstrapClass)   // same pure function as §16
  if (currentFinancialBasis !== ms.lockedFinancialBasis)  // exact,
      field-for-field equality - ledgerInitializationKind,
      opening/current balance or derived legacy opening, and
      effectiveCurrency must ALL still match
    fail-closed ("locked_financial_basis_mismatch")

  // 3. Recompute the canonical source-history digest (§16A) from the
  //    FRESH, just-read sourceHistorySnap - never from any value
  //    computed earlier in this run - and require an EXACT match
  //    against the persisted ms.sourceHistoryDigest/
  //    sourceHistoryDocumentCount. This single check subsumes and
  //    strictly strengthens the old createdAt > lockedAt watermark - it
  //    detects an edit, a deletion, a backdated insert, or any
  //    linkage/status change to any existing record, not merely a
  //    newly-created one. INDEPENDENT of (2b) above - one protects Trip
  //    fields, the other protects savingsTransactions/tripExpenses
  //    documents; neither substitutes for the other.
  currentDigest = computeSourceHistoryDigest(sourceHistorySnap)  // §16A
  if (currentDigest.hash !== ms.sourceHistoryDigest ||
      currentDigest.count !== ms.sourceHistoryDocumentCount)
    fail-closed ("out_of_band_mutation_detected")

  // 5. Exact ownership-output-set verification (item 7) - NEVER
  //    sum/count alone. Validate every row's shape/canonical id
  //    (fail-closed on any malformed row), require the EXACT expected
  //    row count, then compute this run's own canonical ownership
  //    digest (§16A's projection) and require an EXACT match against
  //    ms.expectedOwnershipDigest. A wrong distribution with a right
  //    sum, a rogue extra row, or a missing row are all caught HERE -
  //    not merely by the sum check below.
  balances = validate-and-map each ownershipSnap row
  if (balances.length !== ms.expectedOwnershipCount) fail-closed
    ("exact_output_mismatch")
  actualOwnershipDigest = computeOwnershipDigest(balances)  // §16A
  if (actualOwnershipDigest !== ms.expectedOwnershipDigest) fail-closed
    ("exact_output_mismatch")

  // 6. ONLY NOW, as an INDEPENDENT invariant (never a substitute for
  //    (5)): Sigma(ownership) == Trip.ledgerBalanceMinor.
  sumResult = sumOwnershipMinor(balances)
  if (!sumResult.ok) fail-closed
  reconcile = reconcileOwnershipAgainstAggregate(
    tripData.ledgerBalanceMinor, balances)
  if (!reconcile.ok) fail-closed  ("ownership_drift", §15)

  // 7. Exact allocation-output-set verification (item 7) - the same
  //    discipline as (5), applied to tripOwnershipAllocations: exact
  //    expected count, then an exact digest match over each record's
  //    immutable economic fields (§16A's projection - excludes
  //    migratedAt/ownership lastUpdatedAt deliberately).
  allocations = validate-and-map each allocationSnap record
  if (allocations.length !== ms.expectedAllocationCount) fail-closed
    ("exact_allocation_output_mismatch")
  actualAllocationDigest = computeAllocationDigest(allocations)  // §16A
  if (actualAllocationDigest !== ms.expectedAllocationDigest)
    fail-closed ("exact_allocation_output_mismatch")

  // 8. No unresolved opening-balance ambiguity, no malformed historical
  //    event encountered earlier in THIS run (checked by the run's own
  //    control flow already having aborted before reaching finalization
  //    if either occurred - re-asserted here as a final belt-and-
  //    suspenders flag, never silently skipped).

  // --- ONLY IF EVERY CONDITION ABOVE HOLDS, THEN WRITE ---
  // Corrected by item 11: the Trip receives ONLY the two already-frozen
  // fields - no lastUpdatedAt/lastUpdatedBy (migration bookkeeping
  // belongs exclusively in migrationStateRef, exactly as the lock
  // transaction already establishes, §16).
  tx.update(tripRef, {
    ownershipModelState: "initialized",
    ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
  })
  tx.update(migrationStateRef, {
    phase: "completed",   // Checkpoint 5B.4A.2, item 2 - atomic with the
                             Trip write above; never written separately,
                             never written while the Trip remains
                             "migrating"
    completedAt: FieldValue.serverTimestamp(),
    // Every "reconstructed"-phase field (digests/counts/
    // lockedFinancialBasis/etc.) is RETAINED, never cleared - this
    // document is the permanent audit record (§16B/§28).
  })
  return "initialized"
})
```

**This never initializes first and reconciles afterward** — every
condition, including the full locked-financial-basis re-verification,
the source-history digest recomputation, and the expected-output digest
recomputation, is proven inside the *same* atomic transaction that
performs the state-flip write, exactly as this checkpoint's §14/§20
instructions require, and exactly mirroring the already-frozen §12B
reconciliation-checklist discipline from the original preflight ("if any
item fails, the transition does not commit — the Trip remains in its
current state"). **All reads happen before any write**, matching this
codebase's own universal Firestore-transaction convention (re-confirmed
across every existing callable). **Two independent protections, thus
two independent failure modes:** `locked_financial_basis_mismatch`
(Trip-level ledger/bootstrap/currency facts changed) and
`out_of_band_mutation_detected` (historical source documents changed) —
deliberately distinguishable reason codes, never merged into one,
because they point an investigator at entirely different places to
look.

---

## 23. Dry-Run Design

**Default mode. No flag is required to get a dry run; an explicit flag
is required to do anything else.** A dry run performs every read-only
step of §8/§15 (full reconstruction, full reconciliation arithmetic) and
produces the §30 audit-output shape **without ever acquiring the
migration lock** (§16 is skipped entirely in dry-run mode — it is itself
a write, and dry-run performs *zero* writes of any kind, including never
touching `ownershipModelState`). Reports: migration eligibility (§4),
legacy state classification, opening balance and its §5 classification,
historical transaction/Expense/Shared-Stash-Expense/reversal counts,
every reconstructed `(uid, ownershipMinor)` pair, reconstructed ownership
total, current aggregate, every allocation record that *would* be
created (full content, unwritten), any anomaly encountered (§26's
catalog), and an explicit boolean verdict: "automatic migration would be
safe" / "would require manual review, reason: …".

**Applying a migration requires an explicit, separate, unambiguous
flag/command** distinct from the dry-run invocation — never a mode
switch on the same otherwise-identical call that could be fat-fingered.

---

## 24. Trusted Execution Surface

**Recommended mechanism: a local, non-exported, Admin-SDK-authenticated
Node.js script — never a Cloud Function, never anything reachable via
`onCall`.** Grounded in this repository's own actual structure, not a
generic recommendation:

- `functions/src/index.ts` exports exactly the eleven production
  callables (confirmed by direct read, this session) — **the migration
  tool must never be added to this file**, and must never be wrapped in
  `onCall(...)` anywhere, satisfying the checkpoint's own explicit
  prohibition ("MUST NOT be exposed as an ordinary callable usable by
  app clients").
- This repository has **no existing admin-script/CLI directory**
  (confirmed: no `scripts/`, no `functions/src/admin/` — grepped, this
  session). 5B.4B would introduce this pattern for the first time,
  recommended as a new `functions/src/admin/migrateTripOwnership.ts` (or
  a sibling top-level `scripts/` entry point outside the deployed
  Functions bundle entirely — preferred, since it guarantees the tool is
  never accidentally bundled/deployed as part of `functions`' own
  `predeploy` build) invoked via `ts-node`/compiled-and-run locally,
  authenticated via a service-account credential the operator already
  controls (the same Admin SDK initialization pattern every existing
  test file already uses against the emulator — `initializeApp({projectId:
  ...})` — extended to accept a real service-account credential for a
  genuine production run).
- **Project targeting:** `.firebaserc` defines exactly one project alias
  (`"default": "squadstash-6d0f1"`) — there is **no separate staging
  project** to rehearse a real production run against safely. This is a
  concrete constraint the tool's design must respect: the **safe default
  target is the local Firestore emulator** (the same
  `FIRESTORE_EMULATOR_HOST`-gated pattern every existing test file
  already requires, re-used verbatim), and targeting the real production
  project requires an explicit, separate, hard-to-mistype flag (e.g. a
  required `--project squadstash-6d0f1` that must *literally* match the
  known production project id, rejecting anything else, including a
  silently-wrong typo) **in addition to** the apply-vs-dry-run flag from
  §23 — two independent, explicit opt-ins stacked, never one.
- **Trip targeting:** single Trip only (§25/§26) — a required
  `--trip <tripId>` argument, no default, no "all Trips" mode in 5B.4B at
  all.
- **Confirmation guard:** an apply-mode run against the real production
  project should require an additional interactive confirmation (e.g.
  echoing back the exact Trip id, its current `saved`/`ledgerBalanceMinor`,
  and the dry-run's own computed verdict, then requiring the operator to
  type a matching confirmation string) before proceeding — mirroring the
  spirit of this project's own existing "never silently proceed with a
  destructive/high-stakes action" discipline (the same philosophy this
  very session's own system prompt already enforces for git/Firestore
  operations).
- **Emulator testing:** the dry-run/apply code paths must both be fully
  exercisable against the local Firestore emulator with fixture data,
  using the exact same test harness convention every existing
  `functions/test/*.ts` file already establishes
  (`FIRESTORE_EMULATOR_HOST` guard, `initializeApp({projectId: "demo-..."})`).
  5B.4B's own test matrix (§31 of the checkpoint prompt) runs entirely
  against the emulator; no test in 5B.4B ever touches the real project.
- **Output/report format:** the §30 audit-output shape, emitted as
  structured JSON to stdout and/or a timestamped local file — never
  written back into Firestore as part of the *dry-run* path, and, for
  the *apply* path, the human-meaningful summary fields (§30) are
  additionally persisted into the `migrationStateRef` document itself
  (already being written anyway) so the Firestore-side record and the
  tool's own console/file output agree.

---

## 25. Single-Trip First

5B.4B implements **single-Trip targeting only** — no "migrate every
Trip" mode, no implicit iteration. This document does not freeze exact
CLI flag spellings (left to 5B.4B's own implementation, matching this
checkpoint's own instruction not to over-specify), but the conceptual
shape (`--trip <tripId> [--dry-run|--apply] [--project <id>]`) matches
§24's design. Bulk/batched migration across many Trips is explicitly
**out of scope** for 5B.4B and would be a later, separately-reviewed
checkpoint once single-Trip execution is proven in production at least
once.

---

## 26. Manual-Review Reason Catalog

Structured, closed enumeration — a Trip is `SAFE_TO_MIGRATE` only if
**none** of the following apply; otherwise it is `REQUIRES_MANUAL_REVIEW`
with the specific reason(s) recorded:

1. `positive_ambiguous_opening_balance` (§5, Case C / Case C-equivalent)
2. `aggregate_history_mismatch` (§15, historical drift)
3. `ownership_drift` (§15, ownership-side divergence — flagged for
   engineering, not purely operational, review)
4. `missing_required_timestamp` (a `savingsTransactions`/`tripExpenses`
   document missing `createdAt` — should be structurally impossible
   given it is always server-generated, checked anyway)
5. `ambiguous_event_ordering` (§7, order-sensitive tie — including a
   same-timestamp contribution/withdrawal for the same uid, hardened by
   5B.4A.1 item 3)
6. `currency_mismatch` (§13)
7. `malformed_transaction_amount` (§14)
8. `orphan_expense_linkage` (a Shared-Stash withdrawal's `linkedExpenseId`
   does not resolve to an existing `tripExpenses` document, or vice
   versa — §6's classification table)
9. `duplicate_or_conflicting_reversal` (more than one refund referencing
   the same original withdrawal via `reversalOf`, or a reversed Expense
   whose `refundTransactionId` disagrees with the refund actually found)
10. `missing_original_withdrawal` (a reversal references a withdrawal id
    with no corresponding `savingsTransactions` document at all)
11. `reversal_timestamp_mismatch` (**new, Checkpoint 5B.4A.1, item 2** —
    `Expense.status !== "reversed"`, `Expense.reversedAt` absent, or
    `refund.createdAt !== Expense.reversedAt`; kept distinct from #9
    since the linkage can be structurally correct while the timestamp
    agreement specifically fails)
12. `ownership_underflow_during_replay` (§8, an ordinary withdrawal or a
    Shared-Stash depletion that the reconstructed-so-far ownership
    cannot cover)
13. `safe_integer_overflow` (any arithmetic step reporting an unsafe
    result via the existing 5B.2 primitives)
14. `invalid_canonical_ownership_id` (§12)
15. `conflicting_existing_allocation` (§19, resumed-migration path)
16. `malformed_pre_existing_ownership_row` (§19, resumed-migration path)
17. `pre_existing_output_on_fresh_lock` (**new, Checkpoint 5B.4A.1, item
    8** — any `tripMemberOwnership`/`tripOwnershipAllocations` document
    found for this Trip immediately after a *fresh* `legacy -> migrating`
    lock, before this run has written anything — distinct from #15/#16,
    which apply only to a *resumed*, tool-owned migration)
18. `corrupt_ownership_state` (§4, item 2 — already excludes the Trip at
    eligibility, listed here for completeness of the catalog)
19. `unexpected_historical_record_type` (§6 — any `savingsTransactions`/
    `tripExpenses` shape not matching one of the classified rows)
20. `unexplained_migrating_state` (§18/§20 — a `"migrating"` Trip with no
    corresponding `migrationStateRef` document)
21. `lost_lock_state` (a `"migrating"` Trip whose own
    `migrationStateRef` document is unexpectedly missing at
    finalization time, despite having existed at some earlier point this
    run — treated as its own distinct anomaly from #20, since it implies
    something deleted tool-owned state mid-run)
22. `out_of_band_mutation_detected` (**hardened, 5B.4A.1 items 4-5** —
    the §16A source-history digest disagreeing at finalization time;
    supersedes a `createdAt`-only watermark as the authoritative signal
    for `savingsTransactions`/`tripExpenses` document changes.
    **Deliberately distinct from #30** — this code covers historical
    *document* mutation, never a Trip-field change.)
23. `exact_output_mismatch` (**new, Checkpoint 5B.4A.1, item 7** — the
    finalization-time ownership-row count or canonical ownership digest
    disagrees with the expected value computed at reconstruction time —
    catches a wrong distribution with a right sum, a rogue extra row, or
    a missing row)
24. `exact_allocation_output_mismatch` (**new, Checkpoint 5B.4A.1, item
    7** — the same discipline as #23, applied to
    `tripOwnershipAllocations`)
25. `unexpected_state_change` (the Trip's `ownershipModelState`/
    `ownershipModelVersion` no longer classifies as `"migrating"` with
    an absent version at finalization time, despite this run itself
    never having changed it — §22)
26. `malformed_memberIds` (§4, item 5)
27. `invalid_ledger_state` (§4/§5 — includes both the pre-existing
    `invalid_initialized_state`/`partial_corrupt` cases and a malformed/
    unsafe legacy `saved` value)
28. `uninitialized_ledger_with_history` (**new, Checkpoint 5B.4A.1, item
    1** — `classifyLedgerInitialization` reports `"uninitialized"` for
    this Trip while `savingsTransactions` history already exists for
    it — a combination the production bootstrap itself already treats
    as impossible/corrupt; never reconstructed as though the opening
    balance were zero)
29. `history_exceeds_automatic_migration_limit` (**new, Checkpoint
    5B.4A.1, item 6** — the Trip's bounded ownership-relevant history
    size exceeds the safe automatic-migration bound, checked **before**
    lock acquisition, §16/§16A)
30. `locked_financial_basis_mismatch` (**new, Checkpoint 5B.4A.2, item
    1** — the re-verified, freshly-classified Trip-level financial basis
    — `ledgerOpeningBalanceMinor`/`ledgerBalanceMinor`/`effectiveCurrency`
    for an already-initialized ledger, or the re-derived legacy opening
    balance/`effectiveCurrency` for an uninitialized one — disagrees
    with `migrationStateRef.lockedFinancialBasis` at finalization time.
    **Deliberately distinct from #22** — this code covers Trip-document
    field changes, which the source-history digest cannot see at all,
    never a historical-document change.)
31. `invalid_migration_state_phase` (**new, Checkpoint 5B.4A.2, item 2/3**
    — `migrationStateRef.phase` is missing, unrecognized, or paired with
    a Trip `ownershipModelState` the frozen phase/state model forbids:
    migration outputs already exist while `phase === "locked"`;
    `phase === "completed"` while the Trip is still `"migrating"`; the
    Trip is `"initialized"`/`"needs_reconciliation"`/`"legacy"` while a
    `migrationStateRef` document claims an in-progress phase it cannot
    coexist with; or finalization reached with `phase` anything other
    than `"reconstructed"`. Migration never infers intent for an
    unrecognized pairing — every such combination fails closed.)

**No "best effort" path exists for any of these** — every one is a hard
stop for that specific Trip, surfaced in the audit output, never
silently worked around.

---

## 27. Archived-Trip Decision

**Recommendation: archived legacy Trips ARE migration-eligible, using
the identical algorithm, with zero special-casing.** Grounded in the
actual, already-frozen archive semantics (`isTripArchived`, confirmed
identical across all three callables: `archivedAt !== undefined &&
archivedAt !== null`) — archive status gates **only new contributions**
(the wind-down model's own frozen scope, Checkpoint 4B.5C, unchanged);
it has never gated withdrawals, reversals, or any read. Migration
performs no new *contribution* — it is a pure backend reconstruction of
*already-settled* history — so there is no principled reason archive
status should block it. If anything, an archived (wound-down) Trip's
history is **more** stable (no further contributions can land, by the
Trip's own already-frozen rule), making it if anything a *safer*
candidate than an actively-growing legacy Trip, not a riskier one.

**Migration never alters `archivedAt`/`archivedBy`** — archive semantics
are completely untouched by this checkpoint and by 5B.4B's own eventual
implementation. The only interaction worth naming explicitly: an
archived Trip's own history naturally cannot gain any *new* contribution
between dry-run and apply (by the existing, unrelated archive rule), but
this is incidental, not something migration relies upon or specially
checks for — the §17/§22 watermark already covers the general case
regardless of archive status.

---

## 28. Migration Audit-Output Schema

```text
{
  tripId: string,
  attemptId: string,               // from migrationStateRef
  mode: "dry_run" | "apply",
  phase: "locked" | "reconstructed" | "completed" | null,  // §16B - null for dry-run
  initialState: { ownershipModelState, ownershipModelVersion } | "legacy"-equivalent,
  finalState: { ownershipModelState, ownershipModelVersion } | null,  // null for dry-run
  lockedFinancialBasis: <the §16A shape> | null,  // null for dry-run (no lock acquired)
  openingBalanceMinor: number,
  openingBalanceClassification:
    "case_a" | "case_a_equivalent" | "case_c" | "case_c_equivalent",  // §5 - Case B unreachable
  aggregateLedgerBalanceMinor: number,
  historyCounts: {
    ordinaryContributions: number,
    ordinaryWithdrawals: number,
    sharedStashExpenses: number,
    sharedStashReversals: number,
    memberOutOfPocketExpensesFetchedAndIgnored: number,  // fetched by the
      // Trip-scoped scan, classified, never acted upon - §3/§12 hardening
    totalHistoryDocumentCount: number,   // measured against §16's
      // pre-lock automatic-migration bound
  },
  sourceHistoryDigest: string,         // §16A - hex SHA-256
  sourceHistoryDocumentCount: number,
  reconstructedOwnership: Array<{ uid: string, ownershipMinor: number }>,
  reconstructedOwnershipTotalMinor: number,
  expectedOwnershipDigest: string,     // §16A
  allocationsToCreate: Array<{ withdrawalTransactionId, expenseId, amountMinor,
                                allocations, alreadyExists: boolean }>,
  expectedAllocationDigest: string,    // §16A
  anomalies: Array<{ reasonCode: <one of §26's catalog>, detail: string,
                      relatedDocumentIds: string[] }>,
  verdict: "safe_to_migrate" | "requires_manual_review",
  reconciliation: {
    aggregateMatches: boolean,           // §15 condition 1
    historyReplayMatches: boolean,       // §15 condition 2
    lockedFinancialBasisMatches: boolean | null,   // §16A/§22 - apply mode only
    sourceHistoryDigestMatches: boolean | null,    // §16A/§22 - apply mode only
    exactOwnershipOutputMatches: boolean | null,   // §16A/§22 - apply mode only
    exactAllocationOutputMatches: boolean | null,  // §16A/§22 - apply mode only
  },
  startedAt: string (ISO 8601),
  completedAt: string | null,
}
```

**No sensitive data beyond what already exists in the Trip's own
financial records is included** (no auth tokens, no PII beyond the uids
already present throughout this schema everywhere else).

---

## 29. Test Matrix for 5B.4B

Organizes the checkpoint's own required 42-case list into this
repository's actual test-file convention (dedicated emulator-backed
`node:test` files, mirroring every `functions/test/*.ts` file already
established this session), grouped by concern:

**Happy paths** (single contributor; multiple contributors; contribution
+ personal withdrawal; the frozen 900/100 → pooled 200 → 180/20 worked
example; the frozen A/B/C odd-cent tie; multiple pooled Expenses over
time; Expense followed by exact reversal; changed proportions between
Expense and reversal — re-using the exact "Daniel -180/Friend -20,
current 5000/10, restored 5180/30" worked example already proven in
5B.3's own test suite; a correction represented as reverse-then-new-
Expense; owner reaches zero; historical member reaches zero; an archived
Trip, migrated identically to a non-archived one).

**Fail-closed** (every one of §26's catalog entries gets at least one
dedicated test proving the Trip is correctly flagged
`REQUIRES_MANUAL_REVIEW` with the exact right reason code, and that
**zero** writes occur).

**Resumability** (crash immediately after lock; crash after first
allocation chunk; crash after ownership rows written; rerun with exact-
matching partial outputs behaves idempotently; rerun with a deliberately
corrupted partial output fails closed per §19's table; already-initialized
Trip is a no-op/explicit "already done" report; an unexplained
`"migrating"` state with no `migrationStateRef` is flagged, never
auto-resumed).

**Concurrency** (a financial transaction that begins before lock
acquisition and attempts to commit after it is proven to retry-and-reject,
per §17 — implemented as an emulator test that deliberately interleaves
a held-open transaction with a lock acquisition; a genuinely new mutation
attempted while `"migrating"` rejects, re-confirming 5B.3's own already-
passing tests still hold; an exact prior replay during `"migrating"`
remains harmless, re-confirming §18).

**Finalization** (a fully correct migration reaches `"initialized"` at
`CURRENT_TRIP_OWNERSHIP_MODEL_VERSION`; one missing expected allocation
record prevents initialization; a reconciliation mismatch prevents
initialization; the Trip's state/version changing unexpectedly between
lock and finalization — simulated by a test directly mutating it mid-run
— prevents initialization).

**Hardened by Checkpoint 5B.4A.1, item 15 — explicit new groups for
every correction made in this pass:**

- **Legacy bootstrap** (§5): uninitialized ledger + `saved == 0` + no
  history → eligible, Case A-equivalent; uninitialized ledger + positive
  `saved` → `REQUIRES_MANUAL_REVIEW` (`positive_ambiguous_opening_balance`);
  uninitialized ledger + existing `savingsTransactions` history →
  `REQUIRES_MANUAL_REVIEW` (`uninitialized_ledger_with_history`), never
  reconstructed as zero.
- **Reversal timing** (§7/§10): create at T1, reverse at T5 → the
  reversal replays at T5 (`refund.createdAt`/`Expense.reversedAt`),
  never at T1 (`Expense.createdAt`); `Expense.reversedAt !==
  refund.createdAt` → fails closed (`reversal_timestamp_mismatch`); a
  reversed Expense missing `reversedAt` entirely → fails closed.
- **Tie ordering** (§7): same uid, same timestamp, contribution +
  withdrawal → `ambiguous_event_ordering`, fails closed; two ordinary
  events for *different* uids at the same timestamp → deterministic,
  safe, proceeds; a Shared-Stash event sharing a timestamp with any
  unrelated event → fails closed; two ordinary *withdrawals* for the
  same uid at the same timestamp where order could change the underflow
  verdict → fails closed; where it provably cannot (sufficient balance
  for both regardless of order) → proceeds deterministically.
- **History mutation detection** (§16A/§22) — after the source-history
  digest is captured: modifying an old transaction's `amountMinor`
  without touching `createdAt` → finalization rejects
  (`out_of_band_mutation_detected`); deleting an old transaction →
  rejects; modifying an old Expense's `status`/linkage fields → rejects;
  inserting a backdated historical document → rejects; a concurrent
  mutation landing *during* the finalization transaction itself → the
  transaction's own read-set conflict (or the digest recomputation,
  whichever triggers first) prevents a stale commit.
- **Exact outputs** (§16A/§22/item 7): ownership total correct but
  per-member distribution wrong → rejects (`exact_output_mismatch`),
  never silently accepted on sum alone; an extra, unexpected
  zero-ownership row → rejects unless genuinely part of this run's own
  reconstruction; a missing expected ownership row → rejects; allocation
  count correct but contents wrong → rejects
  (`exact_allocation_output_mismatch`); an extra allocation row →
  rejects.
- **Fresh vs. resume** (§19, item 8): a *fresh* `legacy -> migrating`
  lock on a Trip with pre-existing `tripMemberOwnership`/
  `tripOwnershipAllocations` documents → `REQUIRES_MANUAL_REVIEW`
  (`pre_existing_output_on_fresh_lock`), nothing overwritten; a
  *resumed*, tool-owned migration with matching partial rows → safe,
  deterministic repair/resume per §19's resumed-path tables.
- **Large history** (§16/§16A, item 6): a Trip whose ownership-relevant
  history exceeds the automatic-migration bound →
  `REQUIRES_MANUAL_REVIEW` (`history_exceeds_automatic_migration_limit`),
  checked *before* any lock attempt, with no weakened/sampled/chunked
  integrity check ever substituted for the real one.

**Hardened by Checkpoint 5B.4A.2, item 6 — explicit new groups for the
locked-financial-basis and migration-state-phase corrections:**

- **Locked financial basis** (§16A/§22, item 1): an already-initialized
  Trip's `ledgerOpeningBalanceMinor` changes after lock while
  `ledgerBalanceMinor` (the aggregate) stays unchanged → finalization
  rejects (`locked_financial_basis_mismatch`), proving the aggregate
  check alone would have missed it; `ledgerBalanceMinor` itself changes
  → rejects; the Trip's `currency` field changes after lock → rejects;
  for an uninitialized Trip, the legacy `saved` value changes such that
  the derived opening balance changes (including a zero-deriving value
  changing to a positive-deriving one, or vice versa) → rejects; an
  uninitialized Trip gains real `ledgerOpeningBalanceMinor`/
  `ledgerBalanceMinor` fields after lock → rejects
  (`ledgerInitializationKind` itself changed).
- **Phase lifecycle** (§16B, item 2): lock acquisition creates
  `migrationStateRef` with `phase: "locked"` atomically with the Trip's
  own `legacy -> migrating` write (one transaction, both documents); no
  migration output row may be written while `phase === "locked"` — a
  test seeding an output row during this phase and then attempting to
  proceed must reject (`invalid_migration_state_phase`); a crash during
  `phase === "locked"` resumes by re-scanning/reconstructing from
  scratch; the `"locked" -> "reconstructed"` transition atomically
  freezes all six digest/count fields before any output write is
  permitted; a crash during `phase === "reconstructed"` resumes output
  materialization against the already-frozen digests (never recomputed
  as a new target); finalization requires `phase === "reconstructed"`
  as its own explicit precondition and rejects
  (`invalid_migration_state_phase`) if it finds `"locked"` or
  `"completed"` instead; finalization atomically produces both
  `Trip.ownershipModelState === "initialized"` and
  `migrationStateRef.phase === "completed"` in the same transaction —
  never one without the other; every impossible Trip-state/migration-
  phase combination from §19's table (`"legacy"` + any migration state,
  `"migrating"` + `phase === "completed"`, `"initialized"`/
  `"needs_reconciliation"` + `phase` in `{"locked","reconstructed"}`, an
  unrecognized `phase` string) is rejected
  (`invalid_migration_state_phase`) with no inferred intent.

**Repository-specific additions this document identifies beyond the
checkpoint's own list:** a test proving the `(Expense, linked withdrawal)`
pair's shared `createdAt` is correctly treated as one atomic replay unit
(§7); a test proving `occurredAt` is never consulted for ordering even
when it would produce a different (wrong) order than `createdAt`; a test
proving a `"member_out_of_pocket"` Expense is fetched by the Trip-scoped
scan, classified by `paymentSource`, and then never touches ownership
arithmetic or any allocation output (§3/§12/§32 hardening); a test
proving the finalization transaction's own precondition set — including
the full digest recomputation — is checked *inside* that single
transaction (not computed earlier and merely asserted) by deliberately
racing a concurrent external change against it; a test proving the
source-history digest's canonical projection/serialization is stable
across repeated computation of the *same* input (no nondeterministic
key-ordering drift).

---

## 30. 5B.4B Proposed File Set (Not Created Here)

- `functions/src/admin/migrateTripOwnership.ts` (or a non-`functions/`-bundled
  `scripts/migrateTripOwnership.ts` — final placement decided in 5B.4B
  itself, per §24's reasoning favoring the latter) — the core
  reconstruction/lock/finalization logic, built entirely on the existing
  5B.2 pure primitives and 5B.1 schema helpers, duplicating none of their
  math.
- A small new domain module (or an addition to an existing one) defining
  the proposed `tripOwnershipMigrationState` document shape and its own
  minimal validators — mirroring `tripMemberOwnership.ts`/
  `tripOwnershipAllocation.ts`'s own established "schema + validator,
  nothing else" shape.
- `firestore.rules`: one new match block for `tripOwnershipMigrationState`,
  closed to every client read/write unconditionally (mirroring
  `tripMemberOwnership`/`tripOwnershipAllocations`'s own existing
  posture) — **a Rules change 5B.4B will need to make**, explicitly
  flagged now so it is not a surprise when that checkpoint arrives; **no
  Rules change is made by this preflight document**.
- A CLI entry point (`package.json` script or a thin wrapper) invoking
  the tool with explicit, required flags per §24/§25.
- A comprehensive emulator-backed test file (or a small family of them,
  matching this session's own established one-file-per-concern
  convention) implementing §29's full matrix.
- **No change to any of the currently-deployed callables** — 5B.4B is
  purely additive; `recordSavingsTransaction.ts`/
  `recordSharedStashExpense.ts`/`reverseSharedStashExpense.ts` already do
  everything they need to do (§2).

---

## 31. Explicit Non-Goals (This Checkpoint and 5B.4B)

- Does not implement 5C or any membership-activation logic.
- Does not alter `memberIds`, invitation acceptance, or membership
  acceptance in any way.
- Does not modify any historical `SavingsTransaction` or `Expense`
  document — every migration write is additive (a new
  `tripMemberOwnership`/`tripOwnershipAllocations` document) or a
  two-field Trip-document state flip.
- Does not create, modify, or read `tripExpenseSplits` or any settlement/
  pairwise-debt record (§32 of the checkpoint, restated as a frozen
  decision below).
- Does not change Shared-Stash Expense's zero-pairwise-debt invariant in
  any way.
- Does not change Firestore Rules or indexes in this checkpoint (5B.4B
  will need exactly one new Rules match block, named above, not added
  here).
- Does not add any UI/client behavior.
- Does not run any migration, dry-run or otherwise, against any real
  project.
- Does not implement bulk/multi-Trip migration.

---

## 32. Migration Must Not Create Pairwise Debt (Restated, Frozen)

Re-confirmed from source, not merely asserted: ownership migration's
entire read surface (§6) is `savingsTransactions` and `tripExpenses` —
the latter necessarily includes `"member_out_of_pocket"` documents as
an artifact of the Trip-scoped scan query (§3/§12 hardening), but each
is classified by `paymentSource` and discarded immediately, never acted
upon. Migration never queries, reads, creates, or updates
`tripExpenseSplits` or any `tripSettlements`-equivalent collection, for
any Expense, under any circumstance. The already-frozen
"Shared Stash Expense creates zero `tripExpenseSplits` documents"
invariant (confirmed unchanged in `recordSharedStashExpenseCore`'s own
write set, this session) is exactly why migration's reconstruction of a
historical Shared-Stash Expense likewise produces **no** pairwise-debt
side effect — there was never any to reconstruct. Ownership
migration concerns the Shared Stash's own internal per-member accounting
exclusively, fully architecturally separate from Trip-Expense
reimbursement, exactly as Concepts B and C were frozen as distinct in the
original preflight's §4 and have never been revisited since.

---

## 33. 5C Gate (Restated, Unchanged)

Even once 5B.4B exists, tested, and has successfully migrated at least
one real production Trip with verified reconciliation: 5C remains
blocked **per Trip** until that specific Trip's own
`ownershipModelState === "initialized"` **and**
`ownershipModelVersion === CURRENT_TRIP_OWNERSHIP_MODEL_VERSION` both
hold (the already-frozen §20 conjunction from the original preflight,
re-confirmed unchanged). This checkpoint implements no part of 5C and
proposes no shortcut to it.

---

## 34. Frozen Decisions / Unresolved Blockers

**Corrected by Checkpoint 5B.4A.1, item 16 — this document no longer
claims any of the following, each replaced by the corrected rule next
to it:**

| Superseded claim | Corrected rule |
|---|---|
| Absent ledger fields automatically imply a zero opening balance. | §5's full ledger-bootstrap decision table — `"uninitialized"` requires evaluating the legacy `saved` value via `deriveLegacyLedgerInitialization` (and an existing-history guard) exactly as production bootstrap already does; a positive derived value is just as ambiguous as a persisted positive `ledgerOpeningBalanceMinor`. |
| A reversed Expense's reversal replays at its own `createdAt`. | A reversal's logical-event timestamp is `refund.createdAt`/`Expense.reversedAt` — `Expense.createdAt` is fixed at original creation and is never consulted for ordering a reversal (§7/§10). |
| Same-member contribution/withdrawal timestamp ties are order-insensitive. | Order can change the underflow verdict for a same-uid contribution+withdrawal tie; this specific combination fails closed, and only a narrow, explicitly-enumerated set of provably-commutative cases uses a deterministic tie-break (§7). |
| `lockedAt` alone solves the out-of-band source-mutation problem. | `lockedAt` is downgraded to audit metadata and an early, cheap anomaly check; the canonical source-history digest (§16A), re-verified inside the finalization transaction, is the authoritative mechanism — it detects edits, deletions, and backdated inserts a timestamp watermark cannot. |
| Ownership sum/count alone proves exact outputs. | Finalization requires an exact canonical-digest match over the full expected ownership set *and* the full expected allocation set (§16A/§22/item 7) — the sum/count checks remain as independent, additional invariants, never a substitute for the exact-set proof. |
| All production Trips are known to have `ownershipModelState` absent. | Not asserted — actual production document states have not been exhaustively enumerated; the migration tool always classifies each target Trip from a fresh, authoritative read and fails closed on anything other than a genuinely eligible state (§2/§10 hardening). |
| Firestore Admin SDK transactions always use optimistic concurrency. | The in-flight-race proof is restated in mode-independent terms — Firestore's serializability guarantee plus the Admin SDK's documented retry contract, never a claim about which specific concurrency mechanism is configured (§17). |

**Also corrected:** a fresh `legacy -> migrating` lock finding
pre-existing `tripMemberOwnership`/`tripOwnershipAllocations` output is
now its own distinct, conservative failure
(`pre_existing_output_on_fresh_lock`) — the original document's
"overwrite while migrating" rule applies only to a *resumed*, tool-owned
attempt (§19, item 8). The lock/finalization Trip-document writes are
now reduced to exactly the two already-frozen fields each
(`ownershipModelState` alone at lock; `ownershipModelState` +
`ownershipModelVersion` at finalization) — no `lastUpdatedAt`/
`lastUpdatedBy`, which belong only to a write that also changes an
actual financial fact, never a lock-flag-only change (§16/§22, item 11).
A bounded automatic-migration history size is now a frozen architectural
rule (exact threshold deliberately left to 5B.4B) — large Trips fail
closed rather than receiving a weakened or sampled integrity check
(§16/§16A/§21, item 6).

**Corrected by Checkpoint 5B.4A.2 — this document no longer claims the
locked opening-balance/aggregate snapshot is redundant:**

> The migration tool locks and later re-verifies a canonical Trip
> financial basis independently from the source-history digest. The
> former protects Trip-level ledger/bootstrap/currency facts; the latter
> protects historical financial documents.

This distinction is frozen (§16A). Concretely: `lockedFinancialBasis`
(§16A/item 1) captures and later re-verifies
`ledgerOpeningBalanceMinor`/`ledgerBalanceMinor`/`effectiveCurrency` for
an already-initialized Trip, or the ledger-absence fact plus the
re-derivable legacy-`saved` opening balance for an uninitialized one —
none of which the source-history digest can see, since they are Trip
document fields, never `savingsTransactions`/`tripExpenses` documents.
The two checks are independent and both mandatory at finalization
(§22); neither is a substitute for the other, and a mismatch in either
produces its own distinguishable reason code
(`locked_financial_basis_mismatch` vs. `out_of_band_mutation_detected`).

**Also frozen by Checkpoint 5B.4A.2:** an explicit three-phase
migration-state lifecycle (`"locked"` → `"reconstructed"` →
`"completed"`, §16B) replaces any design that inferred reconstruction
progress from which optional `migrationStateRef` fields happened to be
present. No migration output may be written while `phase === "locked"`;
the frozen source-history/expected-output digests are only ever written
as part of the atomic `"locked" -> "reconstructed"` transition;
`phase === "completed"` is written only inside the same transaction
that initializes the Trip. Every Trip-state/migration-phase pairing not
explicitly frozen as legal (§19) fails closed
(`invalid_migration_state_phase`) rather than having its intent
inferred.

**Frozen by the original 5B.4A pass, still standing, unaffected by this
hardening:**
- The historical scan is deliberately non-transactional and
  index-independent, with chunked, idempotent, non-authoritative writes
  until a single small finalization transaction (§19/§21/§22).
- A new, minimal, additive `tripOwnershipMigrationState` collection is
  proposed — its full, individually-justified field list is now frozen
  in §16A (item 13), superseding the original pass's shorter list.
- Archived Trips are migration-eligible with zero special-casing (§27).
- The migration tool is a local, non-exported Admin SDK script, never a
  callable, with dry-run as the unconditional default and two independent
  explicit opt-ins (project + apply flag) required for any real-project
  write (§24).

**Unresolved, but not blocking:**
- The exact final name/placement of the proposed
  `tripOwnershipMigrationState` collection, and its exact Rules match
  block text, are left to 5B.4B's own implementation — the *fields* and
  *behavior* are frozen here; the literal collection name is not.
- The exact CLI flag spellings are left to 5B.4B, per this checkpoint's
  own instruction not to over-specify them now.
- The exact automatic-migration history-size bound (§16A, item 6) is
  deliberately left to 5B.4B's own implementation, to be set from real
  measurement rather than an invented number.

**No blocker in this document prevents 5B.4B from proceeding.** The one
genuine schema gap identified in the original pass (out-of-band mutation
detection across a non-atomic scan) now has a complete, minimal,
justified, and substantially strengthened proposal (§16A) — exact-digest
verification rather than a timestamp watermark — not merely a flagged
risk.

---

## 35. Validation

- HEAD at the time of the original 5B.4A audit:
  `7d9fcc147c0db95d63ae56870e9d8c50233a9454`, branch
  `claude/milestone-3-personal-savings-mvp`. **Checkpoints 5B.4A.1 and
  5B.4A.2** (these hardening passes) made no further commits and edited
  only this one document — HEAD is unchanged.
- No production source file, test file, Firestore Rules file, or
  Firestore indexes file was modified, in the original 5B.4A pass or in
  either the 5B.4A.1 or 5B.4A.2 hardening passes — confirmed below.
- No migration was run, no production Trip was touched, no Firestore
  write of any kind occurred against any real project, no deployment
  occurred.
