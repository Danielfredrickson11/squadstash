# Trip Wallet Ownership & Withdrawal-Ceiling Preflight — 2026-10-08

**Status:** Architecture / preflight only. No application code, Functions
code, Firestore Rules, indexes, or tests were modified to produce this
document.

**Baseline:** HEAD `d48690abfb6dbcfb2999e813b59143b02d0783a9` ("Add Trip
terms and membership state architecture"), branch
`claude/milestone-3-personal-savings-mvp`, clean working tree. Checkpoint
5A (Trip Terms & Membership State Architecture) is committed, pushed,
deployed, and production-verified. Production now includes
`createTripInvitation`, `publishTripTerms`, their Firestore Rules, and the
authoritative Trip-terms/version architecture — none of which grants Trip
financial authorization (re-confirmed by source read in §2 below).

**Amendment 5B.0A (2026-10-08):** This document has been hardened after
the original 5B.0 pass identified twelve unresolved architecture gaps.
Model A (per-member ownership, proportional depletion, exact-allocation
restoration, backend-enforced ceiling) remains the provisionally
accepted high-level shape. The following were corrected or newly
resolved: legacy `ledgerOpeningBalanceMinor` attribution now has an
explicit three-case rule that fails closed by default (§16); historical
Shared-Stash allocations move to a dedicated immutable companion
collection rather than ever mutating a historical `SavingsTransaction`
(§12); historical reversal replay now explicitly reuses the persisted
original allocation rather than recomputing (§16); a `Trip.
ownershipModelVersion` marker now gates every ownership-aware code path
(§12A); a five-stage, per-Trip (not global) migration/cutover sequence
closes the deploy-order race the original pass left open (§21); the §9
depletion arithmetic moves to exact BigInt computation rather than
`Number` multiplication (§9); the former-member ownership contradiction
is resolved by a "removal blocked while ownership is positive" policy,
which also resolves the read-authority question by making the
problematic state unreachable (§19); §8's operation table is corrected
to state plainly that no generic contribution/withdrawal reversal exists
today; and the composite-id wording for the two new collections is
corrected to match the 5A.2-frozen standard (never claiming Firebase
Auth itself guarantees underscore-free uids). All other findings from
the original 5B.0 pass are preserved unchanged.

**Amendment 5B.0B (2026-10-09):** 5B.0A's own `migrating` state was
itself unsafe — it still permitted legacy financial writes during
migration, meaning a contribution or withdrawal committed mid-replay
could be silently excluded from the ownership snapshot migration was
about to finalize. This pass freezes `migrating` as a **financial-write
quiescence state** (no new ownership-affecting mutation of any kind may
proceed while a Trip is migrating — only exact idempotent replay of
something that already committed beforehand), splits the single
`ownershipModelVersion` field into two concepts
(`ownershipModelState` + `ownershipModelVersion`) with explicit, frozen,
one-way-except-one transitions, defines migration-lock acquisition as
its own trusted precondition-checked operation, makes migration
crash-resumable without ever silently reverting a Trip to legacy, fixes
an ambiguity in the allocation-record identity (it is keyed by the
original Shared-Stash withdrawal's id only — never a second,
competing record keyed by the refund), and strengthens the 5C gate to
require both the state and the version to match exactly, excluding
every other state by name. §9's chosen depletion/restoration model and
every other finding from 5B.0/5B.0A not named above is preserved
unchanged.

**Primary sources of truth:**
`docs/audits/TRIP_WALLET_MILESTONE_PREFLIGHT_2026-10-06.md` (as hardened
by its 5.0A amendment) and `docs/product/SQUADSTASH_MASTER_SPEC_V2.md`
§6 (Trip Wallet Model), §13 (Contributions), §15 (Reimbursements, Refunds
and Settlement), §16 (Double-Entry Financial Ledger). Also read: all
eight prior Trip/Expense/Settlement/Shared-Stash audit documents in
`docs/audits/`.

---

## 1. Executive Summary

The 5.0/5.0A preflight already proved, from source, that
`recordSavingsTransaction`'s withdrawal path checks a requested amount
against the Trip's **aggregate** `ledgerBalanceMinor` only — never
against any per-member figure. This document re-confirms that finding
against the current HEAD (unchanged since 4F.5; 5A/5A.1/5A.2 touched only
inert, non-financial collections) and then does the work 5.0A deferred:
it **freezes an ownership model** (§6), a **deterministic Shared-Stash
depletion/restoration rule** (§9–10), a **withdrawal-ceiling algorithm**
(§11), and a **derived-vs-persisted architecture decision** (§12) —
everything 5C needs to be safely unblocked, and everything 5B's actual
implementation checkpoints (§20) will build.

The central finding that makes this checkpoint necessary, restated
precisely from source: **`deriveMemberSavingsBalanceMinor`
(`src/domain/savingsBalance.ts`) has zero production callers today** —
grep across the entire repository finds it referenced only by its own
module, its own test file, and comments. No screen in this application
currently displays a per-member Shared-Stash ownership figure at all.
This means 5B is not "fixing a UI that shows the wrong number" — it is
building the **first-ever** per-member ownership primitive this product
has had, from scratch, as a trusted backend authorization control.

---

## 2. Current-State Source Audit

Read in full: `functions/src/callables/recordSavingsTransaction.ts`,
`functions/src/callables/recordSharedStashExpense.ts`,
`functions/src/callables/reverseSharedStashExpense.ts`,
`functions/src/domain/savingsLedger.ts`, `src/domain/savingsBalance.ts`,
`src/domain/tripExpenseSplits.ts`, `src/types/domain/savingsTransaction.ts`,
`src/types/domain/trip.ts`, and the relevant `firestore.rules` sections.

**Transaction types:** exactly two — `"contribution"` and `"withdrawal"`
(`SavingsTransactionType`, `src/types/domain/savingsTransaction.ts`). One
collection, `savingsTransactions`, for both — never a separate collection
per type (frozen Milestone 2A design).

**Sign convention:** a contribution adds `amountMinor`, a withdrawal
subtracts it (`getSignedSavingsAmountMinor`,
`applyLedgerTransition` in `savingsLedger.ts`) — pure integer arithmetic,
never floating point, confirmed in every arithmetic site read.

**Aggregate balance derivation:** `Trip.ledgerBalanceMinor` is a
**cache**, not re-derived from history on every read — maintained
atomically inside the same Firestore transaction as every write that
affects it (`recordSavingsTransaction.ts`, `recordSharedStashExpense.ts`,
`reverseSharedStashExpense.ts` all read-then-write it in one transaction).
The append-only `savingsTransactions` history plus
`Trip.ledgerOpeningBalanceMinor` remain the full auditable source of
truth; `ledgerBalanceMinor` is the trusted, pre-computed current total of
that history (`src/types/domain/trip.ts`'s own header comment states this
explicitly). `Trip.saved` is a further dollar-denominated display cache
of `ledgerBalanceMinor`, never an independent source.

**How cached balance is updated:** via `classifyLedgerInitialization` →
`deriveLegacyLedgerInitialization` (for a never-yet-initialized Trip) →
`applyLedgerTransition` (`savingsLedger.ts`, extracted in Checkpoint
4F.5) — the exact same three-function pipeline is called identically by
`recordSavingsTransaction.ts` and `recordSharedStashExpense.ts`;
`reverseSharedStashExpense.ts` reproduces the same classification logic
inline (explicitly **not** refactored onto the shared primitive — flagged
as a deferred candidate in 4F.5's own report, still deferred today).

**How per-member balance is currently derived:**
`deriveMemberSavingsBalanceMinor(transactions, memberUid)` — filters
`savingsTransactions` to `memberUid === requested && linkedExpenseId ===
undefined`, then sums signed amounts. This is a **pure, client-side-only**
function (`src/domain/savingsBalance.ts`, no Firestore import) with no
backend counterpart and, as established in §1, **no production caller at
all**. It is never read inside any trusted callable's Firestore
transaction.

**How reversals are represented:** never a mutated status field on the
original — a reversal is an ordinary new `SavingsTransaction` of the
opposite type and equal amount, linked via `reversalOf: <original id>`
(`src/types/domain/savingsTransaction.ts`'s own header comment, confirmed
by `reverseSharedStashExpense.ts`'s `refundData.reversalOf =
expenseData.sharedStashTransactionId`). `getSignedSavingsAmountMinor`
deliberately never special-cases `reversalOf` — it nets to zero purely
because it is the same type-and-amount math as any other transaction.

**Member identity on a transaction:** `memberUid` is set once at write
time and never mutated afterward (`savingsTransactions` Rules:
`allow update, delete: if false` unconditionally, confirmed in
`firestore.rules`). It is immutable by construction.

**Linked Shared-Stash Expenses excluded from personal ownership
calculations:** confirmed — `linkedExpenseId`'s presence is the
authoritative discriminator (`recordSharedStashExpense.ts` always writes
it on the withdrawal; `reverseSharedStashExpense.ts` always writes it on
the refund), and `deriveMemberSavingsBalanceMinor` excludes any
transaction carrying it. This exclusion is **correct for the "personal
contribution/withdrawal history" purpose it was built for** — the gap is
that nothing fills the resulting hole for Shared-Stash-Expense-caused
ownership *depletion* (see §4).

**Every place that currently assumes a single-member Trip:**
`recordSavingsTransaction.ts`'s withdrawal path (checks only aggregate
balance — the vulnerability itself); `recordSharedStashExpense.ts`'s
withdrawal path (identical — `applyLedgerTransition` is called against
the Trip's aggregate balance only, §5–8 confirm no per-member check
exists anywhere in this file); `reverseSharedStashExpense.ts`'s refund
path (adds to the Trip's current aggregate only, with no per-member
allocation tracked at all — confirmed by reading its full `refundData`
write, which contains no allocation map or per-member field of any kind).
**No source file inspected contains any per-member ownership check,
cache, or allocation record anywhere in this codebase today.** This
confirms, from source, that the vulnerability 5.0A traced is not merely
present in `recordSavingsTransaction` — it is architecturally absent
*everywhere*, including the newer Shared-Stash paths built after that
audit.

**Firestore Rules governing `savingsTransactions`:** `allow get, list`
via `canAccessParent` (current Bucket/Trip `memberIds`/`ownerId`,
re-checked fresh on every read); `allow create, update, delete: if
false` unconditionally for every client, every role — the trusted
callables (Admin SDK) are the only writer. Nothing here could express a
per-member ownership ceiling even if asked to — Rules operate per
document, never across a Trip's full history.

---

## 3. Current Vulnerability (Re-Confirmed From Source, HEAD `d48690a`)

Exact trace (unchanged from 5.0A, re-verified against current HEAD):

1. `recordSavingsTransactionCore` requires `authUid === input.memberUid`
   (self-only) and `tripData.memberIds.includes(input.memberUid)`
   (current-member) — **who may submit** the transaction.
2. The only balance check is `applyLedgerTransition(currentBalanceMinor,
   "withdrawal", input.amountMinor)`, where `currentBalanceMinor` comes
   from `classifyLedgerInitialization(parentData)` — **`parentData` is
   the Trip document**, never any per-member record.
3. `recordSharedStashExpenseCore`'s withdrawal path (always `type:
   "withdrawal"` for this payment source) follows the identical pattern
   against the Trip's aggregate balance — confirmed in §2.

**Consequence, unchanged from 5.0A:** once a Trip has two or more
financially-authorized members (blocked today only by the absence of any
working "add a second member" path — see 5.0A §1/§5), any member can
withdraw up to the Trip's full aggregate `ledgerBalanceMinor`, regardless
of their own contribution history. This is the exact exposure 5B must
close before 5C may activate a second financially-authorized member.

---

## 4. Accounting Concepts (Frozen Separation, Preserved)

**A. Aggregate Shared Stash cash balance** — `Trip.ledgerBalanceMinor`.
How much pooled money exists for the Trip, full stop. Already correctly
implemented and atomically maintained.

**B. Member economic ownership / withdrawable entitlement** — a new
concept this checkpoint defines. How much of balance (A) belongs,
economically, to a specific member, and therefore how much that member
may personally withdraw. **Does not exist in any form today** (§1–2).

**C. Expense responsibility / settlement debt** — who owes whom for
**member-funded** (`member_out_of_pocket`) Expenses, tracked via
`tripExpenses`/`tripExpenseSplits` and resolved via `tripSettlements`.
Already correctly implemented, confirmed unaffected by this checkpoint:
a Shared-Stash Expense creates **zero** `tripExpenseSplits` documents
(`recordSharedStashExpense.ts`: `"Zero tripExpenseSplits documents are
ever created for this payment source"`) and therefore zero pairwise
debt — this invariant is preserved by every model considered below.

These three remain architecturally distinct collections/concepts.
**Concept B (ownership) is not a restatement of Concept A (aggregate) and
must never collapse into it** — that collapse is precisely today's bug.
Concept B must also never leak into Concept C: a Shared-Stash Expense's
depletion of member ownership is never expressed as a debt one member
owes another (confirmed required by the Master Spec's own 4F.0-frozen
"zero pairwise debt" invariant, re-affirmed here).

---

## 5. Candidate Ownership Models

### Model A — Contribution ownership with proportional pooled-spend depletion

Each member owns their net contributions/refunds; a Shared-Stash Expense
reduces every currently-positive-ownership member's stake **in
proportion to their current ownership at the moment of the expense**,
using exact integer largest-remainder rounding. Fairness: depletion
tracks who actually has money in the pool *right now*, not stale
history. Determinism: fully deterministic given a documented tie-break
rule (see §9). Rounding: this codebase already has a proven, tested,
production largest-remainder implementation for exactly this
shape of problem — `computePercentageSplit`
(`src/domain/tripExpenseSplits.ts`, duplicated at
`functions/src/domain/tripExpenseSplits.ts`) divides an integer amount
proportionally across participants, using
`floor(amount * share / totalShares)` for a base allocation and handing
leftover cents to the largest fractional remainders, tie-broken by
ascending uid. Depletion is the *same* mathematical shape with "ownership
balance" standing in for "percentage basis points" — reusing this exact,
already-tested algorithm (§9) rather than inventing a new one.
Reversals: requires persisting the *exact* original per-member delta
(§10) — a real but bounded, precedented cost (mirrors the
already-established pattern of persisting `creationRequest`/
`reversalRequest` snapshots for idempotent-replay verification).
Implementation complexity: moderate, fully bounded by Trip member count.
Future refunds (5E): directly supports "distribute unused funds
proportional to remaining ownership" (one of Master Spec §15.3's own
listed methods) with zero additional modeling.

### Model B — FIFO/LIFO or specific-lot attribution of pooled spend

Would require tracking each contribution as a distinct, orderable "lot"
(inventory-accounting style) and consuming lots in a chosen order when a
Shared-Stash Expense occurs. **Rejected.** A pooled, fungible Shared
Stash is explicitly the product's own framing (Master Spec §6.1: "a
controlled financial workspace," never "a set of earmarked individual
sub-funds") — no user mental model expects "my specific dollars get
spent first." This also roughly doubles bookkeeping complexity (lot
records plus consumption-order tracking) for a fairness property (whose
money is "spent first") the product never asked for and the Master Spec
never mentions. Rejected as unnecessarily complex with no corresponding
requirement.

### Model C — Fully pooled ownership after contribution

No per-member tracking after the money enters the pool; ownership is
either undefined or implicitly "whatever the aggregate is, shared by
whoever is currently a member." **This is exactly today's architecture**
— the status quo bug, not a candidate fix. It categorically **cannot**
satisfy the withdrawal-ceiling requirement, because by construction it
has no per-member figure to check a withdrawal against. Rejected
explicitly as the thing being fixed, not a fix.

### Model D — Master-Spec-aligned check

Master Spec §6.1 requires the wallet to track "each member's remaining
financial interest"; §6.3 requires a member-level ledger showing
contributions/contribution-returns/expense-responsibility/reimbursements/
adjustments/settlements/**remaining refundable interest**. This
*validates* Model A's shape (a real, persisted-or-derivable per-member
figure) and *invalidates* Model C (no such figure exists). §15.3 lists
"return proportionally according to remaining ownership" as one of
several acceptable **unused-funds distribution** methods at *settlement*
time — it does not mandate a single depletion formula for *every
individual* Shared-Stash Expense as it happens, but proportional
depletion is the only one of §15.3's own listed methods that is
meaningfully computable incrementally, after each expense, rather than
only once at final settlement (net-contribution and custom-distribution
are inherently settlement-time, whole-Trip-lifetime concepts, not
per-expense ones).

---

## 6. Chosen Model and Rationale

**Model A — contribution ownership with proportional, current-ownership
pooled-spend depletion, using the codebase's own existing
largest-remainder integer rounding convention.**

Rationale: it is the only candidate that (a) satisfies the
withdrawal-ceiling requirement at all (Model C cannot); (b) matches the
Master Spec's own explicit "each member's remaining financial interest"
/ "remaining refundable interest" requirements (Model D's own reading);
(c) avoids unjustified complexity the product never asked for (rejecting
Model B); and (d) reuses an already-proven, already-tested arithmetic
primitive from this exact codebase rather than inventing new integer-
rounding math, minimizing both new-code risk and reviewer burden.

---

## 7. Formal Invariants

**Primary invariant** (must hold after every atomic operation):

```
Trip.ledgerBalanceMinor
  ==
sum over every uid that has ever held a tripMemberOwnership record
  for this Trip of that uid's current ownershipMinor
```

Note this is deliberately **not** scoped to *current* `memberIds` — §13
(Member Exit) requires ownership to survive membership changes, so the
sum ranges over every uid with a historical ownership record for this
Trip, not merely those currently authorized to transact.

**No institutional/unattributed residual** is permitted once a Trip's
ownership ledger is fully initialized (either newly created under 5B, or
successfully backfilled per §16) — every cent of `ledgerBalanceMinor`
must be attributable to exactly one uid's `ownershipMinor`. The one
explicit, time-bounded exception is a **not-yet-migrated legacy Trip**
(§16), which is a startup-period gap this document defines a closing
procedure for, never a permanent architectural feature.

**Secondary invariant** (per member, always):

```
tripMemberOwnership[tripId_uid].ownershipMinor >= 0
```

Never negative — exactly mirroring the existing aggregate-balance
invariant `applyLedgerTransition` already enforces (rejecting any
transition that would make the *aggregate* negative); 5B extends the
identical non-negativity discipline to each member's own figure.

---

## 8. Operation-by-Operation Ownership Effects

**Corrected by Amendment 5B.0A, item 9:** the original pass's table
included "contribution reversal" and "withdrawal reversal" rows as if
they were existing, backend-supported operations. Re-auditing
`recordSavingsTransaction.ts` precisely: its `transactionData.reversalOf`
is **hardcoded to `null`** on every write (line confirmed by direct
read), and `RecordSavingsTransactionInput`'s own validated shape has no
field through which a caller could ever request an actual reversal. The
client-side `CreateSavingsTransactionInputBase` type does carry an
optional `reversalOf?: string | null`, but `src/services/firebase/
savingsTransactions.ts`'s own comment confirms this is "held back" —
never forwarded to, or honored by, the trusted callable. **No generic
contribution/withdrawal reversal exists anywhere in this codebase
today.** The only real reversal mechanism that exists is
`reverseSharedStashExpenseCore`, scoped specifically to Shared-Stash
Expenses. The table below reflects this accurately; 5B must not build a
generic reversal callable merely because the math was worth considering
for completeness.

| Operation | Exists today? | Effect on acting member's ownership | Effect on aggregate | Existing primitive sufficient? |
|---|---|---|---|---|
| Contribution of A | **Yes** (`recordSavingsTransaction`) | `+A` | `+A` | **Yes** — `deriveMemberSavingsBalanceMinor`'s own formula already computes this correctly for any non-`linkedExpenseId` transaction; 5B's job is only to make the *trusted backend* maintain an authoritative cache of the same sum, not to change the math. |
| Withdrawal of A | **Yes** (`recordSavingsTransaction`) | `-A` | `-A` | **Yes** for the ownership *delta* itself; **No** for *authorization* — this is exactly the missing ceiling check (§11). |
| Generic contribution/withdrawal reversal | **No — does not exist.** Conceptually supportable later (a reversal would just be an opposite-type, equal-amount transaction, exactly like every other transaction type in this ledger), but 5B has no requirement to build one. If a future checkpoint does add it, the ownership delta would be the mirror of whichever operation it reverses, using the already-correct existing math — no new concept. | — | — | N/A — not in scope. |
| Shared-Stash Expense of A | **Yes** (`recordSharedStashExpense`) | Distributed across *every currently-positive-ownership member* per §9 — **never** just the creating member | `-A` | **No** — entirely new mechanism required. |
| Shared-Stash Expense reversal of A | **Yes** (`reverseSharedStashExpense`) | Distributed back per the *original* allocation (§10) | `+A` | **No** — entirely new mechanism required. |

The two ordinary-contribution/withdrawal rows confirm
`deriveMemberSavingsBalanceMinor`'s *math* was always correct for the
cases it was designed for — the gap is entirely in (1) making it an
authoritative, atomically-maintained backend cache rather than an
unused client-side function, and (2) the two Shared-Stash-Expense rows,
which need genuinely new mechanism, not a wiring fix.

---

## 9. Shared-Stash Expense Allocation (Deterministic Rule)

**Whose ownership decreases:** every member whose *current* ownership is
positive at the moment the expense is recorded — in proportion to that
current ownership. A member with zero current ownership (never
contributed, or already fully depleted by prior expenses) loses nothing;
there is nothing to deplete.

**Exact algorithm**, directly generalizing `computePercentageSplit`'s own
proven method (ownership balance stands in for percentage basis points)
— **arithmetic corrected by Amendment 5B.0A, item 6.**

The original pass specified `numerator_i = A * O_i` checked for
`Number.isSafeInteger` overflow, mirroring `computePercentageSplit`'s own
pattern. That pattern is safe for a percentage split only because
`percentageBasisPoints` is bounded to a constant (`10000`), making
overflow reachable only for an implausibly large `amountMinor`.
Ownership `O_i` has no such bound — it is a full-range minor-unit
balance, so `A * O_i` can realistically exceed
`Number.MAX_SAFE_INTEGER` (e.g. a $1M `A` and a $1M `O_i`, both
individually ordinary safe integers, multiply to `10^16`, already past
`2^53-1`). The prompt is explicit that 5B "must preserve the monetary
domain accepted by the existing trusted ledger unless a lower explicit
product limit is intentionally adopted" — so overflow must never
*reject an otherwise-valid balance*; it must simply never occur.
**Resolution: perform the entire calculation in `BigInt`, converting
back to `Number` only for each final, individually-small delta, with an
explicit safe-integer re-assertion at that boundary.**

Given expense amount `A` (validated positive safe integer `Number`,
minor units) and the set of members with positive current ownership
`{(uid_i, O_i)}` (each `O_i` a validated non-negative safe integer
`Number`):

1. Convert to `BigInt`: `Abig = BigInt(A)`; `Oi_big = BigInt(O_i)` for
   each member.
2. `Tbig = Σ Oi_big` (exact `BigInt` addition — unbounded precision, no
   overflow possible regardless of participant count or balance size).
3. For each member: `numerator_i_big = Abig * Oi_big` (exact `BigInt`
   multiplication — no precision loss at any magnitude).
4. `baseShare_i_big = numerator_i_big / Tbig` (`BigInt` division
   truncates toward zero; exactly equivalent to `floor` since both
   operands are non-negative).
5. `remainder_i_big = numerator_i_big % Tbig` (exact `BigInt` modulo).
6. `totalBaseShare_big = Σ baseShare_i_big`; `remainingCents_big = Abig -
   totalBaseShare_big` — provably `0 <= remainingCents_big < BigInt(number
   of participating members)` by the same reasoning
   `computePercentageSplit`'s own remainder logic already relies on,
   carried out exactly rather than in floating/`Number` arithmetic.
7. Sort participating members by `remainder_i_big` descending (exact
   `BigInt` comparison), ties broken by ascending uid — byte-for-byte the
   same tie-break `computePercentageSplit` already uses. The first
   `Number(remainingCents_big)` members in this order (safe to convert:
   this count is always bounded by the small participant count, never by
   `A` or `O_i`) each receive one additional minor unit.
8. `delta_i_big = baseShare_i_big + (1n if selected in step 7 else 0n)`.
9. **Boundary re-assertion, before converting anything back to
   `Number`:** assert `delta_i_big >= 0n && delta_i_big <=
   BigInt(Number.MAX_SAFE_INTEGER)` for every member — this must always
   hold given `delta_i_big <= Oi_big` and `O_i` was itself already a
   validated safe integer, but is asserted explicitly rather than
   assumed, matching this codebase's own "never assume, always verify at
   the boundary" discipline (e.g. `computeExpenseSplits`'s own final
   invariant re-check). Convert: `delta_i = Number(delta_i_big)`, then
   re-confirm `Number.isSafeInteger(delta_i)` as a final belt-and-
   suspenders check.
10. `Σ delta_i === A` exactly (checked as `BigInt`, then as `Number`) —
    a final defense-in-depth invariant check, mirroring
    `computeExpenseSplits`'s own "re-assert the one invariant every
    caller depends on, once, in a single place."
11. New ownership: `O_i_new = O_i - delta_i` for every participating
    member; untouched (delta `0`) for every zero-ownership member.

No floating point appears anywhere in this algorithm, and no otherwise-
valid balance is ever rejected merely because an intermediate `Number`
multiplication would have overflowed — the whole point of moving to
`BigInt` internally is that it has no such limit to hit.

**Worked odd-cent example** (from the required test matrix, §18): three
members A, B, C each own 1 minor unit (`T = 3`); a 1-minor-unit expense
occurs. `numerator_i = 1` for all three; `baseShare_i = floor(1/3) = 0`
for all three; `remainingCents = 1 - 0 = 1`; `remainderScore_i = 1 mod 3
= 1` for all three (an exact tie) → the lexicographically-smallest uid
receives the single cent. Result: that one member's ownership goes from
1 to 0; the other two remain at 1. Aggregate goes from 3 to 2. Sum of new
ownerships (`0 + 1 + 1 = 2`) exactly matches the new aggregate — the §7
invariant holds with no unexplained residual, by construction.

**Deterministic tie-breaking:** ascending uid, identical to the existing
convention — no new tie-break rule is introduced.

**Members who joined after prior spending, or who have never
contributed:** own `0`; never participate in any depletion (step 1's own
"positive current ownership" filter excludes them structurally) until
they make their own contribution.

**`memberUid` on the linked withdrawal transaction:** per the preflight's
own explicit instruction, this remains exactly what 4F.0 froze it as —
schema-compatibility only, attributed to the creating member, **never**
reinterpreted as the economic-depletion attribution. The depletion
allocation computed above is a *separate*, new piece of metadata (§12),
never derived from or conflated with `memberUid`.

---

## 10. Reversal Restoration Model

**Rule: restore the exact original allocation, never recompute from
current proportions.**

Why recomputation is wrong: ownership proportions can legitimately change
between an expense and its later reversal (new contributions, other
expenses, other reversals in between). Recomputing "as if the expense
never happened" using *current* proportions would let a member who
contributed *after* the original expense absorb (or be shielded from) a
refund tied to spending they had no part in — breaking the Master
Spec §6.3 "expense responsibility" traceability requirement and
contradicting the already-frozen 4F.0A principle that a reversal "adds
to the current balance, never restores a historical snapshot" **at the
aggregate level** — the correct per-member generalization of that exact
same principle is "restore each member's own originally-deducted amount
to their current ownership," not "recompute a fresh split using today's
proportions." These are subtly different, and only the former is
consistent with the aggregate-level rule already frozen for 4F.

**Required metadata:** the exact per-member allocation computed in §9
must be persisted at expense-creation time — a map of `{uid:
deltaMinor}` — so reversal has an unambiguous, zero-guesswork source to
reverse against. See §12 (revised by Amendment 5B.0A, item 2) for
exactly where this map lives: a dedicated immutable companion record,
never a field mutated onto the historical `SavingsTransaction` document
itself.

**Reversal effect:** for every `(uid, deltaMinor)` pair in the original
allocation, `ownership[uid] += deltaMinor` (added to that member's
*current* ownership — which may have changed since the original expense
for unrelated reasons, exactly mirroring the aggregate-level "add to
current, never restore a snapshot" rule). The aggregate addition already
implemented by `reverseSharedStashExpense.ts` is simply the sum of these
per-member additions — no change to the aggregate-level behavior is
required, only an additional per-member fan-out alongside it.

---

## 11. Withdrawal Authorization Algorithm

```
requested withdrawal <= member's current ownershipMinor      (PRIMARY — new in 5B)
requested withdrawal <= Trip's aggregate ledgerBalanceMinor   (EXISTING — kept)
```

**Is the second check redundant once ownership invariants are correct?**
Mathematically, yes — if the §7 invariant (`aggregate == sum of
ownership`) holds exactly and every `ownershipMinor >= 0`, then
`ownershipMinor_M <= aggregate` for every member `M` by construction (a
non-negative partition of a whole can never exceed the whole), so the
primary check alone implies the second. **Recommendation: keep the
second check anyway, as defense-in-depth** — this matches the
codebase's own, repeatedly-demonstrated philosophy of never trusting a
single derivation for a financial decision (e.g.
`recordSharedStashExpense.ts`'s exact-replay branch re-verifies the
linked withdrawal's full shape rather than trusting it; `publishTripTerms`
re-validates an existing pointer rather than trusting its mere presence).
The second check is cheap (already computed) and catches cache drift
between the aggregate and the ownership ledger that the invariant *says*
can't happen but a future bug could still produce.

**Full ordering**, extending `recordSavingsTransactionCore`'s existing
sequence (self-only → current-member → [NEW: ownership-model-state
gate] → [NEW: ownership ceiling] → archive-gate-for-contributions-only →
currency/ledger-state → aggregate transition):

1. Authenticated, self-only (`authUid === memberUid`) — unchanged.
2. Current Trip member — unchanged.
3. **(New, per §12A, revised by Amendment 5B.0B)** Read
   `Trip.ownershipModelState`:
   - Absent or `"legacy"`: fall back to the **legacy aggregate-only
     check only** (today's exact existing behavior, step 6 below), never
     attempting to read or trust a `tripMemberOwnership` row that
     migration has not yet populated. This is the dual-write branch
     §21's rollout plan depends on.
   - `"migrating"` or `"needs_reconciliation"`: **reject this withdrawal
     outright** (`failed-precondition`) unless it is an exact idempotent
     replay of an already-committed request (§12A.5) — this Trip's
     ownership state is either being actively reconstructed or known to
     have drifted, and no new financial mutation may proceed either way.
   - `"initialized"`: proceed to step 4.
4. **(New, only for an `"initialized"` Trip)** Read the member's current
   `ownershipMinor` inside the same transaction; reject
   (`failed-precondition`, matching this codebase's existing error-code
   convention for financial-state rejections) if the requested amount
   exceeds it. This is a financial-state fact, so it is disclosed only
   *after* steps 1–2's authorization succeeds — preserving the project's
   universal anti-enumeration ordering.
5. Currency/ledger-state classification — unchanged.
6. Aggregate transition check (`applyLedgerTransition`) — unchanged for
   every Trip regardless of initialization state; kept per the
   redundancy discussion above for initialized Trips, and remains the
   *only* balance check at all for a not-yet-initialized Trip.

**Owner special withdrawal authority:** **no.** `recordSavingsTransaction
.ts`'s own existing, explicit comment already freezes this: "Owner-on-
behalf recording... intentionally NOT permitted right now... until a
future group-sharing milestone adds trusted, accepted membership." 5B
preserves this — an owner may not withdraw another member's ownership.
Least privilege, and consistent with an already-written, already-shipped
design decision.

**Trip Managers:** no Manager role exists anywhere in this codebase
today (confirmed by grep — no file references a Manager/approver role).
No special authority to define; explicitly deferred, matching this
checkpoint's own instruction not to model unbuilt future roles.

**One member withdrawing another's ownership:** no, for the same reason
as owner authority above — this is precisely the vulnerability being
closed, and no narrower carve-out is introduced.

**Administrative refunds on a member's behalf (e.g., at member exit):**
explicitly **not** part of this withdrawal-ceiling rule. If a future
checkpoint (5E, member-removal) needs an owner-initiated "return this
departing member's unused ownership to them," that must be a **separate,
narrowly-scoped, explicitly-audited trusted operation** — never a general
"owner can withdraw for anyone" capability, which would silently reopen
exactly this checkpoint's own vulnerability.

**Archived Trip:** withdrawal rules are **unchanged by archive status** —
re-affirming, not re-deciding, the existing frozen invariant that new
*contributions* are archive-gated while withdrawals/reversals (which
resolve existing facts rather than create new exposure) are not. The
ownership ceiling applies identically whether the Trip is active or
archived.

---

## 12. Derived vs. Persisted Ownership

**Decision: Option C — an immutable allocation record plus a cached,
atomically-maintained per-member balance (both new collections).**
**Revised by Amendment 5B.0A, item 2:** the original pass proposed
attaching the allocation as a new field directly on the existing
Shared-Stash-Expense withdrawal `SavingsTransaction` document. That is
fine for a *newly created* document (written once, atomically, at
creation — never touched again, no different from any other field on a
brand-new document) but breaks down for **historical backfill**: every
pre-5B Shared-Stash withdrawal document already exists and was already
finalized under this project's own unconditional "financial transaction
records are append-only, `allow update: if false` forever" convention —
retroactively adding a field to one of those documents during migration
would be a genuine mutation of an already-finalized financial record,
violating the exact invariant the rest of this codebase enforces at the
Rules layer. The corrected design moves the allocation to its own
dedicated, separately-created companion record instead, so historical
backfill is purely **additive** (a new document) rather than a mutation
of an old one — and, as a direct benefit, reversal gets one **uniform**
lookup location regardless of whether the original expense predates or
postdates 5B.

**Option A (derive from scratch every time) — rejected**, unchanged from
the original pass: re-summing a Trip's entire `savingsTransactions`
history inside every withdrawal's transaction does not scale, and would
require re-deriving every past Shared-Stash depletion allocation on
every single withdrawal.

**Option B (persist only a cache, no allocation history) — rejected**,
unchanged from the original pass: without a persisted exact allocation,
reversal has nothing authoritative to restore against except a risky
recomputation.

**Option C, concretely (corrected):**

- **Source of truth — two new collections, neither ever mutated once
  written:**
  - `tripOwnershipAllocations/{withdrawalTransactionId}` — **identity
    clarified by Amendment 5B.0B, item 7** (the 5B.0A draft's own wording
    — "one record per withdrawal *or* refund" — was genuinely ambiguous,
    implying a reversal might create a second, competing allocation
    record keyed by the refund's own id). Frozen precisely: **there is
    exactly one allocation record per Shared-Stash Expense, keyed solely
    by the id of that Expense's ORIGINAL Shared-Stash withdrawal
    `SavingsTransaction`** (`Expense.sharedStashTransactionId` — already
    an existing, already-deterministic id; no new id-derivation scheme
    needed, and no separate id derived from a refund). A reversal never
    creates a second allocation record of its own — it **locates the
    original Expense, reads its `sharedStashTransactionId`, and reads
    that exact one record** to know what to restore (§10). If a future
    checkpoint ever needs its own audit linkage for the *reversal* event
    itself (as opposed to the original depletion this record describes),
    that is an explicitly separate concern from this record, not
    something to fold into it. Fields: `tripId`, `withdrawalTransactionId`
    (redundant with the document id, kept for query convenience),
    `expenseId`, `allocation` (map of `uid: deltaMinor`), `amountMinor`,
    `currency`, `createdAt`, and `provenance: "original" | "migrated"`
    (plus `migratedAt` when `"migrated"`). For a **new** expense, this
    record is created in the exact same atomic transaction that already
    creates the Expense and its withdrawal — a pure addition, not a
    mutation of anything. For a **historical** expense, migration creates
    this record for the first time, just as additively, without ever
    touching the original, already-finalized withdrawal
    `SavingsTransaction` document.
  - Reversal (new or historical) always reads
    `tripOwnershipAllocations/{withdrawalTransactionId}` by the
    *original* withdrawal's id — **one canonical location, uniform
    regardless of the original expense's age** — never branching on "was
    this an old or new transaction," and never consulting any
    refund-keyed record, because none exists.
- **Cache (new collection):** `tripMemberOwnership/{tripId}_{uid}` —
  deterministic id. **Wording corrected by Amendment 5B.0A, item 10,**
  aligning with the already-frozen 5A.2 standard: this concatenation is
  accepted only because it is a **current SquadStash constraint**, never
  a guarantee the underlying Firebase APIs make — Firestore's own
  auto-generated-id alphabet is genuinely underscore-free by documented
  platform behavior, but a Firebase Auth uid carries no such promise (it
  is an opaque string up to 128 characters); today's uids happen to be
  underscore-free only because this project's registration flow never
  calls `createUser({uid: ...})` with a caller-chosen id anywhere. A
  runtime guard (mirroring `assertNoTripCompositeIdDelimiter` from
  5A.1/5A.2) must fail closed — loudly, never a silent collision — the
  moment either component ever violates this assumption, and any future
  custom/imported-uid identity model must replace this id scheme before
  such identities are supported, not patch around it. Fields: `tripId`,
  `uid`, `ownershipMinor`, `lastUpdatedAt`. Write authority: only the
  trusted callables that already write `savingsTransactions`/
  `tripExpenses` for this Trip — `firestore.rules` closes direct client
  `create`/`update`/`delete` unconditionally, exactly like every other
  backend-maintained cache collection in this project (`tripTermsCurrent`
  is the most recent precedent). Reads gated by the same Trip-membership
  Rules helpers already in use.
- **Rebuild strategy:** replay a Trip's full chronological
  `savingsTransactions` history — ordinary contributions/withdrawals
  credit/debit the acting member directly; a Shared-Stash-Expense
  withdrawal applies the `tripOwnershipAllocations` record keyed by its
  own id, and a Shared-Stash-Expense refund applies (restores) the
  *same* record, keyed by the *original* withdrawal's id it reverses —
  never a record of its own (never recomputed either way — reading the
  `"migrated"` or `"original"` record created either by this same replay
  or by the live system, uniformly) in chronological order. **This is
  the identical operation needed for
  historical-Trip migration (§16)** — migration and cache-repair-after-
  drift are the same mechanism, a useful unifying property, not two
  things to build and maintain separately.
- **Auditability:** every ownership-affecting event remains individually
  inspectable across `savingsTransactions`/`tripExpenses`/
  `tripOwnershipAllocations` (all append-only, all Rules-closed to
  client mutation); the `tripMemberOwnership` cache is explicitly a
  convenience, never a second independent source of truth.

---

## 12A. Ownership Model State Machine, Migration Lock, and Resumability

**Rewritten by Amendment 5B.0B, items 1–4** (supersedes the 5B.0A
version of this section in full). The 5B.0A draft let `"migrating"`
Trips continue accepting ordinary legacy financial writes — that is
unsafe. Concretely, the exact race the prompt describes: (1) migration
marks a Trip `migrating`; (2) migration begins reading/replaying its
`savingsTransactions` history; (3) a user's ordinary contribution or
withdrawal commits against that *same* Trip via the still-legacy code
path, with no ownership-cache effect; (4) migration finishes its replay
using the snapshot it already started from; (5) the Trip is marked
initialized with an ownership total that silently omits step (3)'s
transaction. **This must be impossible.** The fix: `migrating` is
redefined as a **financial-write quiescence state** — while a Trip is
`migrating`, no new ownership-affecting financial operation of any kind
may proceed for that Trip, full stop.

### 12A.1 Two Separate Fields, Not One Overloaded Field

The 5B.0A draft stored both a string state (`"migrating"`) and an
integer version number in the single field `ownershipModelVersion`.
Splitting these avoids exactly that kind of overload:

- **`Trip.ownershipModelState`** — the authoritative lifecycle state.
  One of: *absent* (treated identically to `"legacy"`), `"legacy"`,
  `"migrating"`, `"initialized"`, `"needs_reconciliation"`. This is what
  every ownership-aware callable branches on.
- **`Trip.ownershipModelVersion`** — present only once `initialized` has
  ever been reached for this Trip. Absent for `legacy`/`migrating`
  (there is no version yet to speak of — migration-target metadata, if
  any is needed operationally, lives in a separate, non-authorization-
  relevant field, never masquerading as a version). A positive safe
  integer once `initialized`. **Retained unchanged** (never cleared)
  through a transition into `needs_reconciliation` — the version that
  was once valid stays recorded as the version reconciliation is trying
  to restore, not erased the moment drift is merely suspected.

### 12A.2 Frozen State Transitions

```text
absent / "legacy"
  -> "migrating"
  -> "initialized"

"initialized"
  -> "needs_reconciliation"

"needs_reconciliation"
  -> "initialized"
```

**Explicitly forbidden, by name:**
- `"initialized" -> "legacy"` (or to absent) — never. Once a Trip has
  real multi-member ownership accounting, there is no path back to the
  weaker aggregate-only model that could ever be safe once a second
  member might already be financially authorized on it.
- `"needs_reconciliation" -> "legacy"` (or to absent) — never, for the
  same reason, and explicitly not as a "give up and fall back" escape
  hatch. A failed/drifted ownership system fails closed (continues
  rejecting new mutations) — it never downgrades to a weaker
  authorization model merely because the stronger one is temporarily
  broken.
- `"migrating" -> "legacy"` as an *automatic* transition on timeout or
  retry — forbidden; see §12A.4's resumability rule. (A deliberate,
  explicitly-audited manual recovery procedure is a different thing
  from an automatic fallback, and is the only way a stuck `"migrating"`
  Trip may ever be unwound — not specified further here, since no
  migration implementation exists yet.)

### 12A.3 Migration Lock Acquisition

Starting migration for a Trip is itself a trusted, precondition-checked
operation — not merely "set a field." Before transitioning
`"legacy" -> "migrating"`, verify, inside one atomic transaction:

- The Trip exists.
- `Trip.ownershipModelState` is currently absent or `"legacy"` (never
  acquire the lock twice — a Trip already `"migrating"`,
  `"initialized"`, or `"needs_reconciliation"` rejects a second
  acquisition attempt outright).
- The Trip is eligible for *automatic* migration at all — i.e., §16.1's
  opening-balance classifier does not place it in Case C (ambiguous,
  unresolved provenance). A Case-C Trip never acquires the lock through
  the automatic path; it is flagged for manual review instead, and only
  a separate, explicitly-audited manual procedure (not specified here)
  could ever move it forward.
- `Trip.ledgerBalanceMinor`/`ledgerOpeningBalanceMinor` are themselves
  in a valid, non-corrupt trusted state (reusing the exact
  `classifyLedgerInitialization` check every existing ownership-
  unaware callable already performs — migration must not attempt to
  reconstruct ownership on top of a Trip whose own aggregate ledger
  state is already known-bad).

**Only after this lock-acquisition transaction commits** may historical
scanning/replay begin. From that moment, every production financial
callable (§12A.5) rejects new mutations for this specific Trip — so the
ledger history migration is about to read is guaranteed stable for the
remainder of the reconstruction, no matter how long it takes.

### 12A.4 Resumability (Crash Safety)

A migration process can crash, time out, or be killed after a Trip is
marked `"migrating"` but before reconciliation completes. **This must
never be "solved" by automatically reverting the Trip to legacy** — per
§12A.2, that transition does not exist. Instead, migration/backfill
(§16, revised) must be designed so that:

- **Re-running migration for the same `"migrating"` Trip is safe.**
  Every write migration performs is either already idempotent by
  construction (the `tripOwnershipAllocations` record's id is the
  original withdrawal's id — re-deriving and re-writing it, or writing
  it if genuinely missing, produces the same document either way) or is
  a deterministic recomputation from the same stable, already-quiesced
  history (the `tripMemberOwnership` cache rows converge to the same
  reconstructed values regardless of how many times the replay runs,
  because the input — the Trip's frozen `savingsTransactions` history —
  cannot change while the Trip is locked).
- **No second migration may independently race the first.** §12A.3's
  own lock-acquisition precondition (`state` must currently be absent/
  `"legacy"`) already prevents this: a second attempt to acquire the
  lock on an already-`"migrating"` Trip is rejected outright, so at most
  one replay process is ever actively reconstructing a given Trip's
  ownership at a time. A *resumed* run of the same logical migration
  (same Trip, already `"migrating"`) is not "a second migration" in
  this sense — it is a continuation, explicitly permitted and required
  to converge safely.
- **Partial backfill must never make the Trip appear initialized.**
  `"migrating"` state already guarantees this by construction (§12A.2:
  only an explicit, successful reconciliation-then-flip transaction ever
  writes `"initialized"`) — a crash mid-replay simply leaves the Trip in
  `"migrating"`, correctly still blocking new mutations, until a
  (resumed or fresh) migration run completes it.
- **The Trip remains financially write-blocked for the entire
  `"migrating"` duration**, however long that turns out to be —
  operational inconvenience (a Trip temporarily unable to accept a new
  contribution while its own historical reconstruction is in progress)
  is explicitly preferable to ever risking corrupted financial
  ownership. This is a deliberate, named tradeoff, not an oversight.

### 12A.5 Exact Per-State Callable Behavior

Every ownership-aware trusted callable (`recordSavingsTransaction`'s
`"trip"` branch, `recordSharedStashExpense`, `reverseSharedStashExpense`)
branches on `Trip.ownershipModelState` as its very first ownership-
relevant decision, after the existing authentication/membership checks
and before anything else ownership-related:

- **Absent / `"legacy"`:** today's exact existing behavior — aggregate-
  only authorization, no ceiling, no cache read or write. Temporarily
  safe *only* because of the existing, still-true invariant that no
  second uid may become financially authorized while a Trip is in this
  state (5C's own per-Trip gate, strengthened in §20).
- **`"migrating"`:** **reject every new ownership-affecting mutation** —
  no new contribution, no new personal withdrawal, no new Shared-Stash
  Expense, no new Shared-Stash Expense reversal. Use this project's
  normal `HttpsError("failed-precondition", ...)` convention, the same
  style already used for every other financial-state rejection in this
  codebase. **Exact idempotent replay of a request that genuinely
  already committed before the migration lock was acquired** may still
  reconcile to its original result exactly as today's existing replay
  branches already do (an already-committed Expense/withdrawal's own
  `clientRequestId`-keyed existence check runs *before* any new-mutation
  decision, so a true replay is recognized and answered without ever
  attempting a second financial change) — this is the one narrow
  exception, and it changes no financial state a second time.
- **`"initialized"`:** full ownership-aware behavior — the §11 ceiling
  check, the §9/§10 allocation/restoration mechanics, atomic
  `tripMemberOwnership` maintenance.
- **`"needs_reconciliation"`:** identical rejection behavior to
  `"migrating"` (§12B) — reject every new mutation, permit only exact
  replay of something that already committed — until trusted
  reconciliation tooling repairs the state and transitions it back to
  `"initialized"`.

---

## 12B. Cache Corruption / Invariant Verification

**New section, Amendment 5B.0A, item 11.** What happens if
`Trip.ledgerBalanceMinor != Σ ownershipMinor` after initialization —
from a bug, or external corruption (e.g. a manual Firestore Console
edit bypassing every trusted path, a risk that exists today for the
aggregate balance too and is not new to this design)?

**Routine operations do not, and should not, re-verify the global sum on
every call.** Every one of the five operations in §13's table already
applies the *same signed delta* to both the acting member's
`tripMemberOwnership` row and the Trip's `ledgerBalanceMinor`, atomically,
in one transaction — by construction, a single operation can never
*introduce* drift on its own, and detecting *pre-existing* drift
elsewhere in rows the operation never reads would require a full Trip-
wide scan on every single withdrawal, which is exactly the Option-A cost
§12 already rejected. The right place for full verification is not the
hot path.

**Design: `Trip.ownershipModelState` (§12A, revised by 5B.0B) already
doubles as the trust anchor.** The one-time reconciliation performed
before a Trip is ever marked `"initialized"` is the proof that the
invariant held *at that moment*; every subsequent 5B-authored write
preserves it by construction (same atomic dual-update discipline). This
gives a bounded, two-part fail-closed strategy rather than an assumption
that drift cannot occur:

1. **Detection:** a dedicated, explicitly-invoked reconciliation
   operation (an operational/admin tool, or a scheduled integrity job —
   never part of any user-facing request path) re-sums a specific Trip's
   `tripMemberOwnership` rows and compares against `ledgerBalanceMinor`,
   exactly as the initialization-time check already does. This can be
   run periodically, on demand, or triggered by operational suspicion —
   its cost is paid out-of-band, never by an ordinary user's withdrawal.
2. **Response to detected drift — frozen precisely, Amendment 5B.0B item
   9:** the affected Trip's `ownershipModelState` transitions
   `"initialized" -> "needs_reconciliation"` (§12A.2's one explicitly
   permitted transition out of `"initialized"`); `ownershipModelVersion`
   is left unchanged (it still names the version reconciliation is
   trying to restore, never cleared). While `"needs_reconciliation"`,
   every ownership-affecting callable applies **exactly §12A.5's
   `"migrating"` behavior**: reject every new contribution, personal
   withdrawal, Shared-Stash Expense, and Shared-Stash Expense reversal
   outright (`failed-precondition`); permit only the exact idempotent
   replay of something that already committed before drift was
   detected. This is neither the legacy path nor the trusting-the-cache
   path — it is its own named rejection state, chosen specifically so a
   known-bad cache is never trusted and the Trip never silently falls
   back to the weaker aggregate-only authorization `§12A.2` already
   forbids leaving `"initialized"` for. Only once trusted reconciliation
   tooling repairs the drift and re-verifies the invariant does the Trip
   transition `"needs_reconciliation" -> "initialized"` — the same
   reconciliation-then-flip discipline §12A.3/§16's migration-completion
   step already uses, applied here to a repair rather than a first-time
   initialization.

**Full reconciliation checklist, before any `-> "initialized"`
transition (first-time or repair) may commit** — frozen explicitly per
Amendment 5B.0B item 6, and shared identically by migration's own
completion step (§16) and by `"needs_reconciliation"`'s repair step
above:

- `Trip.ledgerBalanceMinor == Σ tripMemberOwnership.ownershipMinor`
  exactly (§7's invariant).
- Every `tripMemberOwnership.ownershipMinor` value is itself a
  non-negative safe integer.
- Every Shared-Stash Expense that requires one has a corresponding
  `tripOwnershipAllocations` record.
- Each allocation record's own `allocation` map sums exactly to its
  `amountMinor`.
- Each allocation record's `tripId`/`withdrawalTransactionId` correctly
  identify the Trip and original transaction it belongs to.
- No unexplained ownership residual exists anywhere in the sum.
- No unresolved opening-balance provenance ambiguity was encountered
  during reconstruction (§16.1 Case C) — a Trip with one cannot reach
  this checklist at all; it was never eligible to begin migration.
- Ownership-cache reconstruction itself completed without error for
  every member who has ever held a `tripMemberOwnership` row for this
  Trip.

If **any** item fails, the transition does not commit — the Trip remains
in its current state (`"migrating"` for a first-time attempt,
`"needs_reconciliation"` for a repair attempt) rather than ever being
marked `"initialized"` on partial or hopeful evidence.

A stronger mechanism (e.g. a monotonically-incrementing per-Trip
ownership-write epoch/checksum, verified on some fraction of writes) is
possible but is explicitly **not** recommended for 5B — it is
meaningfully more complexity than this product's actual current scale
(small, friend/family-sized Trips) justifies, consistent with this
checkpoint's own repeated instruction to choose the smallest robust
design. The periodic/on-demand reconciliation tool above is proposed as
that smallest design; a stronger mechanism remains available later if
operational experience ever shows it is needed.

---

## 13. Atomic Transaction Design

**Table corrected by Amendment 5B.0A, item 2 and 5B.0B, item 1:** "new
`ownershipAllocation` field" below now reads "new
`tripOwnershipAllocations` record," matching §12's revised companion-
collection design. Every row also now implicitly begins with the §12A
`ownershipModelState` read, with three possible outcomes: `"legacy"`
(aggregate-only, as today), `"migrating"`/`"needs_reconciliation"`
(reject the mutation outright unless it is an exact replay), or
`"initialized"` (proceed as described below) — never a bare "is this
Trip initialized" boolean.

| Operation | Documents read (inside the transaction, before any write) | Documents written atomically |
|---|---|---|
| Contribution | Trip (incl. `ownershipModelState`), acting member's `tripMemberOwnership` row (only if `"initialized"`) | New `SavingsTransaction`; updated Trip `ledgerBalanceMinor`; updated acting member's `tripMemberOwnership` row (+A, only if `"initialized"`) — **rejected outright with no write at all if `"migrating"`/`"needs_reconciliation"`, unless an exact replay** |
| Withdrawal | Same, plus the row is **required** (not merely read) for the **new** ceiling check on an `"initialized"` Trip | Same, with the ceiling check gating the write on an `"initialized"` Trip; legacy aggregate-only check only on a `"legacy"` Trip; **rejected outright if `"migrating"`/`"needs_reconciliation"`, unless an exact replay** |
| Reversal (ordinary — not currently implemented, §8) | N/A today | N/A today |
| Shared-Stash Expense | Trip (incl. `ownershipModelState`), Expense/withdrawal replay-detection docs (existing), **every currently-positive-ownership member's `tripMemberOwnership` row** (only if `"initialized"`) | Expense, withdrawal, new `tripOwnershipAllocations` record keyed by the withdrawal's own id (`provenance: "original"`), Trip `ledgerBalanceMinor`, **every participating member's `tripMemberOwnership` row** (only if `"initialized"`) — **rejected outright if `"migrating"`/`"needs_reconciliation"`, unless an exact replay** |
| Shared-Stash Expense reversal | Expense, original withdrawal id, **the `tripOwnershipAllocations` record keyed by that original withdrawal's id** (the uniform lookup — never a record keyed by the refund), **every member named in that allocation's `tripMemberOwnership` row** (only if `"initialized"`) | Refund, reversed Expense, Trip `ledgerBalanceMinor`, **every allocated member's `tripMemberOwnership` row** (only if `"initialized"`) — **rejected outright if `"migrating"`/`"needs_reconciliation"`, unless an exact replay** |

**Invariant restated mathematically** (from §7), with the explicit
institutional-balance caveat: for a fully-migrated Trip,

```
Trip.ledgerBalanceMinor == Σ tripMemberOwnership[tripId_*].ownershipMinor
```

with zero unexplained residual. No institutional/reserved bucket is
needed in the steady state — the one time-bounded exception is an
unmigrated legacy Trip (§16), never a permanent feature of the model.

**Scalability assumption, stated explicitly:** the Shared-Stash-Expense
and reversal operations above must read and write **every**
currently-positive-ownership (or originally-allocated) member's cache
row inside one transaction. Firestore transactions support up to 500
writes; for this product's actual current and foreseeable Trip scale
(small friend/family groups), this is comfortably within limits. If
Trips ever scale to hundreds of simultaneously-active members, this
per-expense "touch every row" design would need revisiting — explicitly
out of scope for this checkpoint, matching the instruction to design the
smallest architecture robust enough for the product as it actually
exists.

---

## 14. Idempotency Model

No new idempotency *primitive* is needed — every new write described in
§12–13 is added to an **already-idempotent, already-atomic** transaction
(the existing `clientRequestId`-keyed Expense/withdrawal documents, whose
existence-check already short-circuits before any write on replay). As
long as every new `tripMemberOwnership` write happens strictly *inside*
that same pre-existing atomic/idempotent transaction — never as a
separate, independently-retried operation — it inherits the existing
guarantee for free: a retried contribution, withdrawal, Shared-Stash
Expense, or reversal either (a) is detected as a replay before any write
occurs (ownership untouched a second time) or (b) is a genuinely new
operation and writes exactly once. The `tripOwnershipAllocations` record
(revised by Amendment 5B.0A, item 2) requires no new deterministic-id
scheme either — its id is simply the already-deterministic id of the
`SavingsTransaction` it describes. The `tripMemberOwnership/
{tripId}_{uid}` cache row's own id is deterministic by construction
(same discipline as `tripInvitationId`/`tripMembershipAcceptanceId` from
5A/5A.1, with the corrected delimiter-safety wording from §12), so "the
cache row for member X on Trip Y" always resolves to the same document
across any number of transaction retries.

---

## 15. Currency

Confirmed: a Trip has exactly one currency today —
`resolveEffectiveCurrency` (`savingsLedger.ts`) enforces an exact string
match against the Trip's own single `currency` field (defaulting to
`"USD"` when absent); every ownership figure introduced by this
checkpoint inherits that single currency unchanged, in integer minor
units throughout, with the exact same no-float discipline
`applyLedgerTransition` already enforces for the aggregate. No
multi-currency support is introduced or implied.

---

## 16. Historical / Existing-Data Migration Considerations

**What repository schema proves (not a guess about actual Firestore
data):** every Trip created and operated on *before* this checkpoint
lacks any `tripMemberOwnership` record, by definition (the collection
does not exist yet). Every historical `savingsTransactions` document for
every existing Trip already carries enough information to reconstruct
correct ownership **for ordinary contributions/withdrawals** —
`memberUid` plus `type` plus `amountMinor` is exactly the input the §8
table's two ordinary-operation rows need, and that data has been written
identically since Milestone 2B. **Historical Shared-Stash Expenses are
the one genuinely ambiguous case for *depletion***, because their
original depletion never allocated anything per-member (§3) — there is
no `tripOwnershipAllocations` record for any pre-5B Shared-Stash
withdrawal, by construction. A **second, independent** ambiguity, caught
by Amendment 5B.0A item 1 and addressed below, is the Trip's
**opening balance**.

### 16.1 Legacy `ledgerOpeningBalanceMinor` Attribution (New, Amendment 5B.0A Item 1)

`Trip.ledgerOpeningBalanceMinor` represents pre-ledger money derived from
a legacy `Trip.saved` value at the moment `recordSavingsTransaction`/
`recordSharedStashExpense` first initializes a Trip's ledger. This
opening amount is counted inside `ledgerBalanceMinor`, but — by the
existing, already-frozen design (`Trip.ts`'s own header comment: "NEVER
attributable to any specific Trip member") — **no `savingsTransactions`
event identifies who contributed it.** Chronological replay (as proposed
below) is therefore insufficient by itself whenever a Trip's opening
balance is positive: there is no event in the replayable history that
explains where that money came from. Three cases, considered explicitly:

- **Case A — opening balance is `0`.** No attribution problem exists.
  Replay ordinary history exactly as described below; the Trip's
  ownership total converges to the aggregate with no special handling.
- **Case B — positive opening balance, source-provable.** The bar for
  "provable" must be genuine, not convenient. **Current `memberIds`
  having exactly one entry is explicitly *not* sufficient proof on its
  own** — this document's own earlier draft treated it as a safe
  shortcut, and the checkpoint that produced this amendment correctly
  rejected that reasoning: current membership says nothing about
  *historical* membership at the moment the opening balance was actually
  created, and no membership-change audit log exists anywhere in this
  schema to rule out an earlier, now-reversed membership change. Genuine
  proof would require an actual provenance record identifying who caused
  `saved` to become nonzero before the ledger existed — **no such record
  exists anywhere in this codebase's schema today.** Case B is therefore
  **not achievable for any existing Trip with the data this repository
  currently persists.** It is retained here only as a defined category
  for a *future* Trip, if a later product change ever adds real
  provenance tracking to whatever path can set a pre-ledger balance —
  it is not a path 5B's migration can use today.
- **Case C — positive opening balance, ambiguous attribution (the
  default for every existing Trip with a positive opening balance, given
  Case B's unavailability).** **Fail closed.** Never invent a
  proportional split; never assign it to the current owner, or to any
  current member, merely because no better idea is available. The
  affected Trip is **not** migrated — it is explicitly flagged for
  manual/operational review and **remains on the legacy aggregate-only
  authorization path indefinitely** (§12A: `ownershipModelState` stays
  absent/`"legacy"` — it never even reaches `"migrating"`, since §12A.3's
  own lock-acquisition precondition excludes a Case-C Trip from the
  automatic migration path entirely) until a human/operational process
  resolves the
  ambiguity through means outside this document's scope (e.g. a
  documented, audited, product-level decision about that *specific*
  Trip, recorded as its own explicit event once made — never a silent
  default).

**Effect on the §7/§13 invariant during migration:** the invariant
`ledgerBalanceMinor == Σ ownershipMinor` is explicitly scoped to
**ownership-initialized Trips only** (already stated in §13, reinforced
here). A Case-C Trip simply never reaches that state — there is no
version of the invariant that "almost" holds for it with an
institutional residual; it is not subject to the invariant at all until
resolved, exactly as an entirely legacy/unmigrated Trip is not.

### 16.2 Backfill Replay Rule (Revised: Companion Records, Not Mutated History)

**Quiescence precondition, stated explicitly (Amendment 5B.0B, item
5):** every step below executes only *after* §12A.3's migration lock
has already committed (`"legacy" -> "migrating"`), and §12A.5's
state-aware callable code (already live in production per §21's 5B.3,
deployed before this tool ever runs) is already rejecting every new
ownership-affecting mutation against this Trip. **This quiescence is
precisely what makes the replay's snapshot authoritative** — without
it, the history being replayed could still be changing underneath the
replay, which is exactly the race this amendment exists to close. With
it, the Trip's `savingsTransactions` history is provably frozen for the
entire duration of the steps below, however long they take.

For a Trip classified as Case A (or a resolved former Case B/C), with
the Trip already locked into `"migrating"`, replay its full, now-stable
`savingsTransactions` history in chronological order (`createdAt`
ascending):

1. An ordinary contribution/withdrawal applies directly to the named
   `memberUid`'s running ownership total.
2. A Shared-Stash-Expense **withdrawal** is handled by **re-running the
   §9 allocation algorithm using the ownership snapshot computed so far
   at that exact point in the replay**, and **persisting the result as
   a new `tripOwnershipAllocations` record, keyed by that withdrawal's
   own id, with `provenance: "migrated"`** (§12's revised design) —
   never as a mutation of the original, already-finalized
   `SavingsTransaction` document.
3. A Shared-Stash-Expense **refund** is handled by §16.3's rule
   below — **never** by re-running §9 a second time.
4. Construct/update each affected member's `tripMemberOwnership` cache
   row to match the running totals this replay produces.
5. Calculate the final ownership sum across every member touched by the
   replay, feeding directly into §12B's reconciliation checklist before
   any `"initialized"` transition is attempted.

This treats history as if the ownership model had existed all along,
applying it exactly as it would have been applied in real time, while
respecting the append-only convention for the original financial
record. It is the one mathematically unambiguous reconstruction
available for Case A/resolved Trips, because the full event sequence
(aside from the opening-balance provenance addressed in §16.1) is
already preserved, append-only, and — thanks to the quiescence
precondition above — now provably untouched for the duration of the
replay.

### 16.3 Historical Reversal Replay (New, Amendment 5B.0A Item 3)

When chronological replay reaches a historical Shared-Stash Expense's
**reversal** (i.e., the refund `SavingsTransaction` that names it via
`reversalOf`), replay must **not** compute a fresh proportional
allocation from the ownership state at the reversal's own point in
history. It must locate the **exact** `tripOwnershipAllocations` record
already created for the *original* expense earlier in the same replay
(by the original withdrawal's id — the same uniform, age-independent
lookup §12 establishes for live, post-5B reversals) and restore precisely
those deltas, exactly mirroring the steady-state rule from §10. This is
not a special migration-only rule — it is the same `restoreAllocation`
operation a live Trip would use today, run historically; replay needs no
reversal-specific branch beyond "look up, don't recompute," because that
is already the only rule that ever existed for this operation.

**What this document does not and cannot determine:** whether any
existing production Trip actually has a positive `ledgerOpeningBalanceMinor`
or more than one `memberIds` entry; the actual volume/age of
Shared-Stash-Expense history needing replay; and any operational
concerns (batch size, read quotas) of running the replay at migration
time. These require inspecting actual Firestore data, which is
explicitly out of scope for this preflight (no migration is implemented
here — see §21's revised 5B.4).

---

## 17. Security / Trust Boundaries

**Must occur server-side, inside the trusted callable's Firestore
transaction** (never trusted from a client-supplied value, never
computed client-side and merely checked):
- Reading a member's current `ownershipMinor` before authorizing a
  withdrawal.
- Computing the §9 depletion allocation for a Shared-Stash Expense.
- Restoring the exact §10 allocation on reversal.
- Enforcing the withdrawal ceiling itself (§11).
- Every write to `tripMemberOwnership` (Rules: `create/update/delete: if
  false` for every client, mirroring `tripTermsCurrent`'s own posture).

**Safe for client display only, never for authorization:**
- Rendering a member's own cached `ownershipMinor` (read-only `get`,
  Rules-gated identically to every other Trip-scoped read today).
- `deriveMemberSavingsBalanceMinor` remains valid for its original,
  narrower purpose — personal contribution/withdrawal *history* display
  — but must never be read as, or substituted for, the trusted ownership
  figure. Any future UI built on top of 5B should read the new trusted
  `tripMemberOwnership` cache for "your Shared Stash ownership," not
  re-derive it client-side from raw transactions — avoiding exactly the
  client-derived-state-used-for-authorization anti-pattern this
  checkpoint's own prompt warns against.

Firestore Rules alone cannot express any of the §9–11 calculations
(proportional allocation across an arbitrary number of members, with
largest-remainder tie-breaking) — these are multi-document, multi-step
arithmetic decisions that only a trusted Cloud Function transaction can
correctly and atomically perform. Rules remain exactly what they already
are for every other financial collection in this project: a read gate
and an unconditional write-closure, never a calculator.

---

## 18. Detailed Test Matrix

**Basic ownership:**
- A contributes 900, B contributes 100 → aggregate 1000, A ownership
  900, B ownership 100.

**Withdrawal ceiling:**
- B attempts to withdraw 101 → rejected (`failed-precondition`).
- B withdraws exactly 100 → succeeds; B ownership → 0; aggregate → 900.
- A attempts to withdraw using B's identity → rejected at the existing
  self-only check, before the new ceiling check is even reached.
- A attempts to withdraw 1000 (all of aggregate, exceeding A's own 900
  ownership) → rejected by the new ceiling check even though the
  aggregate alone would have permitted it — this is the exact scenario
  5B exists to close.

**Shared-Stash Expense depletion (900/100 ownership, spend 100):**
- `numerator_A = 100*900=90000`, `numerator_B=100*100=10000`,
  `T=1000`; `baseShare_A = floor(90000/1000)=90`,
  `baseShare_B=floor(10000/1000)=10`; `remainingCents = 100-100=0` — no
  remainder to distribute. A → 810, B → 90. Aggregate → 900. Sum matches.

**Odd-cent rounding (A=1, B=1, C=1, spend 1):**
- Exact worked result from §9: the lexicographically-smallest uid's
  ownership goes to 0; the other two remain at 1; aggregate goes from 3
  to 2.

**Reversal:**
- Reverse the 900/100-ownership, spend-100 expense above → A exactly
  restored to 900, B exactly restored to 100 — regardless of any
  unrelated activity on other Trips or (if applicable) this same Trip
  that happened in between, since each member's own delta is restored to
  their *current* balance, not a snapshot.
- Reverse the odd-cent (A/B/C = 1/1/1, spend 1) expense after A and B
  have since each made an unrelated +50 contribution → the originally-
  depleted member's ownership increases by exactly 1 (their own original
  delta), never recomputed against the now-changed proportions.

**Contribution after spend:**
- After the 900/100 → 810/90 depletion above, A contributes another 500
  → A ownership → 1310; B's 90 is untouched; the *already-settled*
  allocation from the earlier expense is never revisited or adjusted.

**New member joining (post-5C):**
- A new member C joins with ownership 0 (no contribution yet).
- C attempts to withdraw any positive amount → rejected (0 ownership).
- A later Shared-Stash Expense does not deplete C's ownership (C is
  excluded from §9's participant set — zero current ownership).

**Former member:**
- A member removed from `memberIds` retains their last-known
  `ownershipMinor` row unchanged (§13/19 — removal must never touch
  `tripMemberOwnership`).
- That former member can no longer call `recordSavingsTransaction` for
  this Trip at all (membership check fails first, before ownership is
  ever consulted) — transaction *authority* is gone; *ownership* is not.

**Idempotency:**
- Retry every one of the five operations with the same `clientRequestId`
  → each resolves to the original result with zero additional
  ownership-cache mutation (the existing replay-detection branch, now
  also covering the ownership writes bundled into the same transaction).

**Concurrency:**
- Two simultaneous withdrawals by the same member, each individually
  within their ownership, but which together would exceed it → Firestore
  transaction contention ensures only one can commit against the
  pre-withdrawal ownership snapshot; the second sees the updated (lower)
  ownership on retry and is correctly rejected if it would now overdraw.
- Simultaneous withdrawals by two *different* members, each within their
  own ownership → both succeed independently, each only touching their
  own `tripMemberOwnership` row (no shared-document contention between
  them, since each writes a different member's row — only the shared
  Trip `ledgerBalanceMinor` document is a potential contention point,
  already handled by Firestore's existing transaction-retry machinery
  exactly as it is for the current aggregate-only design).
- A withdrawal concurrent with a Shared-Stash Expense → Firestore's
  transaction isolation ensures one commits first; the second re-reads
  the post-first-transaction ownership/aggregate state before deciding,
  never operating on stale data.
- Two Shared-Stash Expenses concurrently → same reasoning; whichever
  commits first establishes the ownership snapshot the second's
  allocation is computed against — never two allocations computed from
  the same stale snapshot.
- Prove in every concurrent case: no negative `ownershipMinor` is ever
  produced, and the §7 invariant holds after both operations settle.

**Migration lock (new, Amendment 5B.0B, item 11):**
- A Trip marked `"migrating"` rejects a new contribution
  (`failed-precondition`).
- A Trip marked `"migrating"` rejects a new personal withdrawal.
- A Trip marked `"migrating"` rejects a new Shared-Stash Expense.
- A Trip marked `"migrating"` rejects a new Shared-Stash Expense
  reversal.
- An exact replay of a request that already committed *before* the
  migration lock was acquired reconciles to its original result without
  any additional write, even while the Trip is currently `"migrating"`.

**Migration race (new):**
- Simulate: migration lock acquired → a concurrent attempt at any of
  the four operations above is attempted against the same Trip →
  rejected → migration's own replay proceeds against demonstrably
  stable history (no interleaved write landed) → reconciliation
  succeeds → the resulting `"initialized"` ownership total exactly
  matches what the stable history alone implies, with no silently
  dropped or silently duplicated transaction.

**Crash / resume (new):**
- Migration partially creates `tripOwnershipAllocations`/
  `tripMemberOwnership` data for a Trip, then the process stops (state
  remains `"migrating"`).
- Re-running migration for that same Trip converges to the identical
  final values as an uninterrupted run would have produced.
- Final reconciliation succeeds on the resumed run.
- No duplicate `tripOwnershipAllocations` record is ever created for the
  same withdrawal id across the interrupted-then-resumed attempts.

**Initialization gate (new):**
- A Trip with only a partially-populated ownership cache (simulating an
  incomplete or corrupted backfill) does not authorize any withdrawal —
  only a Trip that has actually completed the full §12B reconciliation
  checklist and reached `"initialized"` does.
- `ownershipModelState` absent or `"legacy"` → legacy aggregate-only
  rules apply, exactly as today.
- `"migrating"` → every new mutation blocked.
- `"needs_reconciliation"` → every new mutation blocked, identically.
- `"initialized"` → the full ownership ceiling is enforced.

**No downgrade (new):**
- An `"initialized"` Trip's state can never silently fall back to
  aggregate-only authorization, under any code path, including a
  detected-drift scenario — drift transitions to
  `"needs_reconciliation"` (still fully blocked for new mutations),
  never back to `"legacy"` or absent.

---

## 19. Membership Lifecycle Implications (Dependencies Only — Not Built Here)

**New member joins:** initial ownership is `0` until their own first
contribution — verified by §9's own "zero current ownership participates
in nothing" rule, which already handles this correctly by construction;
no special "new member" code path is needed beyond simply never having
created a `tripMemberOwnership` row for them yet (a row is created lazily
on first contribution, or could be created eagerly at `0` — either is
fine since the §9 algorithm treats "no row" and "row at 0" identically).

**Existing member leaves/is removed — corrected by Amendment 5B.0A,
items 7/8 (resolving a real contradiction in the original pass):** the
original draft asserted both "removal does not alter ownership" and "a
departed member retains their refund claim," while simultaneously
defining Shared-Stash depletion (§9) as touching *every* uid with
positive current ownership regardless of current membership. Those two
statements are incompatible: if a departed member's ownership is
genuinely preserved and still subject to future depletion, their
"refund claim" shrinks every time the *remaining* group spends money
they have no say over — which is not a protected claim at all, merely a
slower way of losing it.

**Resolved policy: financial membership cannot be removed from a Trip
while that uid holds positive Shared-Stash ownership.** A future
member-removal feature (5C or later) must refund, transfer, settle, or
otherwise resolve a departing member's ownership to exactly `0` *before*
their removal is allowed to complete — never as a side effect of
removal itself, and never left pending. This is stated here as a
**dependency 5C must satisfy, not something 5B implements**:

- This keeps §9's depletion rule exactly as simple as already specified
  — "every uid with positive current ownership" — because a departed
  uid is now *guaranteed* to already be at `0` by the time removal takes
  effect. There is no longer any live state in which a departed member
  has positive-but-protected ownership that depletion would need to
  special-case or exclude.
- **5C must not introduce a removal path that violates this** — any
  "remove member" feature must check `tripMemberOwnership` and reject
  removal outright while the departing uid's `ownershipMinor > 0`.
- **Direct/client manipulation of `memberIds` must eventually be closed**
  before multi-member financial membership actually launches. 5.0A
  already established that `firestore.rules` currently lets a Trip owner
  edit `memberIds` directly (including removing a uid) via a general,
  Rules-only update — today this is low-risk only because no Trip has a
  second financially-authorized member yet. Once 5C activates multi-
  member Trips, that same free-form path would let an owner silently
  remove a positive-ownership member via a raw Firestore write, entirely
  bypassing the policy above (Rules alone cannot easily express "reject
  this `memberIds` update if the removed uid's cross-collection
  ownership is nonzero" without materially more complexity than today's
  Trip Rules carry). This is flagged here as an explicit, named
  dependency for whichever checkpoint first makes `memberIds` removal
  possible for a multi-member Trip — not resolved in this document.

**Owner leaves/transfers ownership:** unsupported anywhere in this
codebase today (no ownership-transfer mechanism exists in any file read)
— this document does not design one; stated as a known gap, not solved
here.

**Rejoining member — corrected by Amendment 5B.0A, item 7:** under the
resolved policy above, a member can only ever leave a Trip with exactly
`0` ownership (removal is blocked otherwise) — so there is no "retained
historical ownership" for a rejoining member to restore. A rejoining
member starts at `0`, identically to a brand-new member (§9's own "no
row" / "row at 0" equivalence already covers this with no special
logic). The original draft's claim that "historical ownership is simply
still there, untouched" is withdrawn — it described a state the
resolved policy now makes unreachable.

**`tripMemberOwnership` read authority for former members — resolved by
Amendment 5B.0A, item 8, as a direct consequence of item 7's policy:**
the original pass asked how a former member could later inspect ownership
they are no longer a current Trip member of, since reads are currently
gated by current-membership Rules helpers. Under the resolved removal
policy, **this question does not arise as a live concern** — a former
member's ownership is guaranteed to already be `0` at the moment they
leave, so there is nothing of economic value for them to need to
inspect after departure that current-membership-gated reads would
hide. A former member's access to their own *historical* contribution/
allocation records, for personal record-keeping rather than any live
economic claim, remains a minor, separate UX nicety — explicitly
deferred to a future checkpoint if ever requested, not a correctness
requirement this document needs to resolve.

**How 5E will determine unused-funds refund entitlement:** by reading
each uid's final `tripMemberOwnership.ownershipMinor` at settlement time
— exactly the "remaining refundable interest" figure Master Spec §6.3
requires the member-level ledger to show, now finally a real, trusted,
persisted number rather than an undefined concept.

---

## 20. Exact Requirement Before 5C May Proceed

**Revised by Amendment 5B.0A, item 12, and strengthened by Amendment
5B.0B, item 12** — restating the preflight's own acceptance criterion,
now with each item tied to a concrete deliverable from this document,
and corrected to be a **per-Trip**, not a global, gate (see §21's
revised staging — a brand-new Trip created after 5B ships has no legacy
debt and can be `"initialized"` trivially, so 5C need not wait for every
historical Trip in existence to finish migrating before *any* Trip can
go multi-member):

1. **Strengthened gate condition (5B.0B):** a Trip may permit a second
   financially-authorized member only if **both**
   `Trip.ownershipModelState === "initialized"` **and**
   `Trip.ownershipModelVersion === CURRENT_SUPPORTED_VERSION` hold for
   that specific Trip — and explicitly **not** `"legacy"`, not
   `"migrating"`, and not `"needs_reconciliation"`. Checking only one of
   the two fields is insufficient: a stale or mid-repair Trip could
   plausibly carry a leftover version number while its state says
   otherwise, so 5C's own gate check must require the conjunction, never
   either field alone.
2. Withdrawals must enforce the member ceiling for every `"initialized"`
   Trip — §11 (algorithm frozen).
3. Shared-Stash Expense/reversal must maintain ownership atomically for
   every `"initialized"` Trip — §9/§10/§13 (allocation + restoration
   rules + the atomic transaction design they depend on).
4. Historical allocations needed for reversal must be durable — §12/
   §16.2/§16.3 (the `tripOwnershipAllocations` companion-record design,
   covering both newly-created and migrated-historical expenses
   uniformly, keyed unambiguously by the original withdrawal's id).
5. **No temporary aggregate-only compatibility path may be reachable by
   a second financially-authorized uid** — §11 step 3's state-gate must
   be a hard branch with no escape hatch: an `"initialized"` Trip never
   falls back to `"legacy"` (§12A.2 forbids the transition outright), a
   `"legacy"`/`"migrating"`/`"needs_reconciliation"` Trip never reaches
   multi-member financial authorization in the first place (enforced by
   5C's own per-Trip check at invitation-acceptance time, named
   explicitly as a 5C dependency here, not built in 5B), and a
   `"migrating"`/`"needs_reconciliation"` Trip rejects every new
   mutation outright regardless (§12A.5/§12B).
6. Concurrency tests must prove no drift or cross-member withdrawal —
   §18 (full matrix, specifically the "A attempts to withdraw using B's
   ownership," ceiling-rejection, concurrent-operation, and the newly
   added migration-lock/migration-race/crash-resume cases).

**5C remains blocked, per Trip, until all six hold for that specific
Trip** — this document freezes the *design*; implementation and
verification are §21's own proposed checkpoints, next.

---

## 21. Proposed Implementation Sequence (Not Implemented Here)

**Revised by Amendment 5B.0A, items 5/12, and by Amendment 5B.0B, item
10** — the sequence is restructured around an explicit
**deploy-before-migrate staged rollout**, closing the deploy-order race
5B.0A identified (old code still running against a migrated Trip) *and*
the migration-quiescence race 5B.0B identified (new legacy writes
landing against a Trip that is actively being migrated). The fix for
both is the same shape: the code that knows how to reject/branch on
`Trip.ownershipModelState` must already be live, in production, for
every Trip, *before* any Trip's state ever leaves `"legacy"` — so there
is never a moment where a Trip's state has changed but the running code
doesn't yet know what that state means.

1. **5B.1 — Schema + Rules (additive, inert).** Define
   `tripMemberOwnership`, `tripOwnershipAllocations`, and both
   `Trip.ownershipModelState`/`Trip.ownershipModelVersion` (backend-only;
   excluded from every existing client-write allowlist). Firestore
   Rules: read-gated identically to existing Trip-scoped collections,
   write-closed to every client unconditionally. **Zero behavior
   change** — mirrors 5A's own "inert scaffolding first" precedent
   exactly. Deployable immediately, independent of everything else
   below.
2. **5B.2 — Pure ownership primitives.** New pure-function module
   (mirroring `savingsLedger.ts`'s own no-Firestore-I/O convention): the
   §9 depletion algorithm (exact `BigInt` arithmetic), the §10
   restoration algorithm, the §11 ceiling-check math, the §16.1
   opening-balance Case A/B/C classifier, and the §12A.2 state-transition
   validator (a pure function answering "is this transition legal",
   used by every state-changing operation below). No existing callable
   is touched yet; this is pure math/logic, fully unit-testable in
   isolation.
3. **5B.3 — State-aware callable integration — the race-closing step for
   BOTH identified races.** Extend `recordSavingsTransactionCore`'s
   `"trip"` branch (never `"bucket"`/`trip_personal`, which is
   single-member by definition and needs no change),
   `recordSharedStashExpenseCore`, and `reverseSharedStashExpenseCore`
   to branch on `Trip.ownershipModelState` (§12A.5/§11 step 3), with
   **four** outcomes, not two: `"legacy"` → unchanged existing behavior;
   `"migrating"` → reject every new mutation outright (exact replay
   only); `"initialized"` → full ceiling enforcement, cache maintenance,
   `tripOwnershipAllocations` read/write; `"needs_reconciliation"` →
   identical rejection to `"migrating"`. **This ships and soaks in
   production before any Trip's state ever changes from `"legacy"`** —
   for every existing Trip (all currently `"legacy"`), this is provably
   a no-op change, so it carries none of the risk of the ceiling itself,
   only the risk of the new branch's own correctness, independently
   verifiable against the existing, unchanged test suite. Because this
   step lands *before* step 4 below ever runs, the `"migrating"`
   rejection behavior is already live the instant any Trip's lock is
   first acquired — closing the 5B.0B race by construction, not by
   timing discipline alone.
4. **5B.4 — Per-Trip migration/backfill tool.** Implements, in order,
   for one Trip at a time:
   - **Lock acquisition** (§12A.3): the precondition-checked, atomic
     `"legacy" -> "migrating"` transition. Rejected outright if the Trip
     is not currently `"legacy"`, or is a §16.1 Case-C Trip, or has an
     already-invalid aggregate ledger state.
   - **Stable historical replay** (§16.2/§16.3): with new mutations
     already blocked by step 3's own code (live since before this lock
     was ever acquired), the replay's input is guaranteed not to change
     out from under it — this quiescence is exactly what makes the
     resulting snapshot authoritative, not merely convenient.
   - **Final reconciliation-then-flip** (§12B's checklist, shared
     identically with repair): only commits `"migrating" ->
     "initialized"` if every checklist item passes; otherwise the Trip
     remains `"migrating"` for a resumed attempt.
   - **Resumability** (§12A.4): safe to re-run against the same
     `"migrating"` Trip after a crash — idempotent by construction
     (deterministic allocation-record ids; deterministic replay over a
     frozen, quiesced history).
   §16.1 Case C Trips are explicitly skipped and flagged, never
   migrated automatically. Explicitly **not** bundled with 5B.3's code
   deploy — this tool runs *after* 5B.3 is already live, on a
   Trip-by-Trip (or batched) basis, separately reviewed each time it is
   run against production data, since it is the one step in this
   sequence that touches data at rest rather than only shaping new
   writes.
5. **5B.5 — Reconciliation/integrity tooling.** The §12B on-demand/
   scheduled full-sum verification job, and the
   `"initialized" <-> "needs_reconciliation"` transition wiring
   (§12A.2/§12B), so drift is detectable and fails closed rather than
   merely assumed impossible, and repair never silently downgrades to
   `"legacy"`.
6. **5B.6 — Full verification.** The complete, revised §18 test matrix
   (including the `BigInt`-exactness cases, §16.1's Case-C-flagged-Trip
   behavior, the §19-resolved former-member-removal-blocked-while-
   positive-ownership policy, and the new migration-lock/migration-race/
   crash-resume/initialization-gate/no-downgrade categories) across all
   three extended callables, regression-proof against every existing
   4F/5A/5A.1/5A.2 test. **Only after 5B.6 is complete** does §20's
   per-Trip gate become something 5C can actually rely on — 5C's own
   invitation-acceptance logic (a 5C-scope task, checking **both**
   `ownershipModelState === "initialized"` **and**
   `ownershipModelVersion === CURRENT_SUPPORTED_VERSION` for the
   specific Trip being joined) is what ultimately enforces §20 item 5;
   5B's job ends at making that check meaningful and safe to add.

**Exact timing, stated explicitly per the amendments' own request:**
schema/Rules (5B.1) and state-aware callable code (5B.3, after 5B.2's
primitives) deploy together, well before any Trip's lock is ever
acquired; backfill (5B.4) runs afterward, Trip-by-Trip, under its own
operational review, never bundled with a code deploy, and is itself
internally staged (lock → stable replay → reconcile → flip, resumable
at any point); a Trip is marked `"initialized"` atomically, only inside
5B.4's own final reconciliation transaction (or 5B.5's repair
transaction, for a `"needs_reconciliation"` recovery); the withdrawal
ceiling becomes mandatory for a Trip the instant that transaction
commits — there is no separate "turn on enforcement" step, because
5B.3's state-branch already makes `"initialized"` *itself* the
activation event; the temporary `"legacy"`-compatibility branch in
5B.3's code is not removed as part of 5B at all — it remains
load-bearing for every not-yet-migrated Trip and is only a candidate
for removal in a *later*, separate cleanup checkpoint once telemetry
shows zero Trips still depend on it; and 5C becomes unblocked **per
Trip**, the moment that Trip's own state/version pair satisfies §20
item 1 and 5B.6's full verification has shipped — never as one global
flag for every Trip at once.

---

## 22. Validation

- HEAD at the time of this audit: `d48690abfb6dbcfb2999e813b59143b02d0783a9`,
  branch `claude/milestone-3-personal-savings-mvp`, clean working tree
  before this checkpoint began.
- No application code, Functions code, Firestore Rules, indexes, or
  tests were modified — confirmed below.
- Post-write validation (run after this document was created):
  `git status --short` shows exactly one new, untracked file —
  `docs/audits/TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md`
  — and nothing else changed, added, or deleted.

---

## 23. Implementation-Refinement Amendment (Checkpoint 5B.1)

This section records one durable-representation refinement made during
5B.1's actual implementation, approved after the fact — it does not
rewrite any historical section above; §12's own prose describing the
allocation as a "map of `uid: deltaMinor`" is superseded only in its
exact storage representation, never in its economic semantics.

**From:** an allocation map of `uid -> deltaMinor`.

**To:** a canonical, ordered array of `{ uid, amountMinor }` entries
(field named `amountMinor`, matching the already-established
`ExpenseSplitAllocation` convention in `tripExpenseSplits.ts`, rather
than `deltaMinor`), stored in **strictly ascending uid order** — the
one canonical representation a given logical allocation may ever have,
since this collection is immutable and a source of truth. The validator
rejects a correctly-valued but incorrectly-ordered array outright; it
never silently re-sorts one. A future 5B.2 allocator must itself
produce this canonical order.

**Why:** an arbitrary uid used as a Firestore map *field name* invites
avoidable edge cases (field-name character restrictions, dotted-path
ambiguity) a plain array of uid *values* never raises; duplicate
detection and iteration/audit readability are also more
straightforward against an explicit array. All economic semantics
(exactly one allocation record per Shared-Stash Expense, keyed by the
original withdrawal's id; sum-of-entries equals the Expense's
`amountMinor`; exact-restoration-on-reversal) remain exactly as §9/§10/
§12 already froze them.
