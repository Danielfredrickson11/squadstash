# Trip Expenses & Settlement Architecture Audit

**Audit date:** 2026-09-13 (amended 2026-09-13, Checkpoint 4A.1 hardening pass)
**Audit type:** Architecture audit and design only — **no production code, Rules, Functions, or dependencies were changed**
**Branch / baseline:** `claude/milestone-3-personal-savings-mvp` @ `fac9528` ("Add My Stash savings guidance"), working tree clean before and after
**Checkpoint:** 4A — Trip Expenses & Settlement Architecture Audit; hardened by 4A.1
**Status:** DO NOT IMPLEMENT YET — this document is the design to review before any 4B+ checkpoint begins

---

## Executive summary

SquadStash's current live financial architecture (the trusted `savingsTransactions` ledger, `createBucket`, and the two-fund Trip model — Shared Stash + My Stash) is solid, tested, and a good foundation to build on. Expenses, however, are **completely unimplemented** — not "partially built," not "stubbed," but entirely absent from every Cloud Function, Firestore rule, and service file in the repository. The only trace of the feature is a set of **frozen, unused TypeScript types** from an earlier design pass (`Expense`, `ExpenseSplit`, `Settlement`, plus `ActivityRecord`/`Invitation`/`Membership`), never wired to any backend or UI.

The most important finding for scoping this work correctly: those frozen types describe a **Settlement** that already embodies the exact philosophy this checkpoint's prompt demands — "SquadStash never processes or moves money itself" (its own doc comment, verbatim). That single sentence, written before this checkpoint existed, already answers the central question of Section 6: an expense record and a Shared Stash ledger withdrawal must remain two separate, explicit, truthfully-labeled events, linked only by reference — never fused into one automatic action.

This audit recommends: reusing the frozen `Expense`/`ExpenseSplit`/`Settlement` types with additive fields (a `paymentSource` discriminant, a conditional `payerUid`, and a linking field to a real ledger transaction that is *required*, never optional, whenever an Expense claims Shared-Stash funding), a flat top-level Firestore layout consistent with the already-proven `savingsTransactions` pattern (not a `trips/{tripId}/expenses` subcollection), a deterministic per-participant split ID scheme mirroring the already-proven `trip_personal` Bucket ID trick, and a phased implementation sequence (4B, a Trip archive/delete-hardening prerequisite, then 4C–4F) that keeps every phase independently testable and never touches the hardened savings ledger until the final phase.

**Amendment note (Checkpoint 4A.1):** this revision corrects six issues found in the original 4A pass before it becomes the frozen plan: (1) `payerUid` was incorrectly required even for Shared-Stash-funded expenses, where no member personally paid anything; (2) the audit never stated an MVP currency policy; (3) percentage-split remainder cents were assigned by an arbitrary uid-order rule rather than a largest-remainder allocation that better preserves the intended percentages; (4) a Shared-Stash-funded Expense could be persisted with no real linked withdrawal yet, an unsafe half-true state; (5) Trip hard-delete was left as an "observation" rather than a hard prerequisite, even though Trip financial history is about to exist; (6) either party to a reimbursement could unilaterally record it as complete, letting a debtor erase their own debt without confirmation. All six are corrected below; the original findings in §1/§2 and the overall recommendation to proceed are otherwise unchanged.

---

## 1. Repository findings

Full-repository search for `Expense`, `ExpenseSplit`, `Settlement`, `reimbursement`, `payerUid`, `createdBy`, `splitStrategy`, `equal`/`percentage`/`custom` (split-strategy senses), `receipt`, `category`, `owes`/`owed`, `settled`/`settlement`.

| File | Contains | Wired to backend/UI? |
|---|---|---|
| `src/types/domain/expense.ts` | `SplitStrategy`, `Expense`, `ExpenseSplit`, `CreateExpenseInput`, `CreateExpenseSplitInput` | **No** — type-only |
| `src/types/domain/settlement.ts` | `SettlementMethod`, `Settlement`, `CreateSettlementInput` | **No** — type-only |
| `src/types/domain/activity.ts` | `ExpenseAddedActivity`, `SettlementRecordedActivity` (variants of `ActivityRecord`) | **No** — type-only |
| `src/types/domain/invitation.ts` | `Invitation`, `CreateInvitationInput`, `InvitableRole` | **No** — type-only, no `invitations` Firestore rule exists |
| `src/types/domain/membership.ts` | `Membership`, `CreateMembershipInput`, `Role` (`owner`/`admin`/`member`) | **No** — describes a `trips/{tripId}/members/{uid}` subcollection that is never read or written anywhere; real Trip membership today is `Trip.memberIds`/`Trip.ownerId` only |
| `src/types/domain/index.ts` | `export * from "./expense"`, `"./settlement"`, `"./activity"` | Exported from the barrel, so importable — but grep confirms **zero actual imports** of `Expense`/`ExpenseSplit`/`Settlement`/`CreateExpenseInput`/`CreateSettlementInput` anywhere outside their own definition files |
| `app/(tabs)/trips/[tripId].tsx` (comment only, ~line 837) | A code comment left by Checkpoint 3F.3B.3 explaining why the old "Record Expense" button was removed: *"SquadStash's frozen Milestone 2A domain model already defines Expense/ExpenseSplit/Settlement types for a future shared-vs-personal expense system, but none of it has a service, Cloud Function, or Firestore rules today."* | No code reference — comment only |

**Confirmed absent, full stop (not "minimal," not "legacy" — nonexistent):**
- Any `expenses`, `expenseSplits`, `settlements`, `activity`, `invitations`, or `members` (Trip subcollection) match block in `firestore.rules` (verified: only `buckets/{bucketId}`, `trips/{tripId}`, `savingsTransactions/{transactionId}`, `users/{uid}`, `publicUsers/{uid}` exist).
- Any `functions/src/callables/*Expense*` or `*Settlement*` file. `functions/src/index.ts` exports exactly three callables today: `createBucket`, `lookupUserByEmail`, `recordSavingsTransaction`.
- Any `src/services/firebase/*expense*` or `*settlement*` file.
- Any `reimbursement`, `owes`, `owed`, `settled`, `balances owed`, or `expense category` string anywhere in application source (only appears in the two type files above, this checkpoint's own prompt text, and the long-term vision doc discussed in §19).
- Any Firebase Storage integration for `receiptImageUrl` (no `getStorage()` call, no `storage.rules` file anywhere in the repo — a real receipt-upload feature has zero supporting infrastructure today).

**Conclusion:** there is no earlier settlement helper anywhere outside `src/domain` (or anywhere at all) — the frozen types are the entirety of prior art. Nothing here is stale/misleading to correct; it is simply unbuilt.

---

## 2. Current trusted money architecture — what's reusable, what must stay separate

| Component | File | Reusable pattern for expenses? |
|---|---|---|
| `recordSavingsTransaction` / `recordSavingsTransactionCore` | `functions/src/callables/recordSavingsTransaction.ts` | **Pattern reusable, code path must NOT be reused.** Its idempotency shape (`clientRequestId` as the document ID, an atomic `runTransaction`, a `storedFactsMatch` replay check) is exactly the shape a trusted `recordTripExpense` callable should copy. But this function's actual job — mutating `ledgerBalanceMinor`/`Trip.saved`/`Bucket.balance` — must never be invoked as a side effect of recording an expense. An expense is a description of a real-world event; only an explicit, separate contribution/withdrawal call may move ledger money (see §6). |
| `createBucket` / `createBucketCore` | `functions/src/callables/createBucket.ts` | **Two directly reusable idioms:** (1) an immutable `creationRequest` snapshot stored alongside the document, compared field-by-field on replay — better suited to expense creation than the simpler `storedFactsMatch` above, because an expense's "facts" include a structured split list, not just five scalar fields; (2) a **deterministic, non-random document ID** derived from stable inputs (there: `tripfund_${tripId}_${uid}`) enforcing at-most-one-per-key via Firestore's own transactional read-before-write — directly reusable for ExpenseSplit uniqueness (see §7). |
| Shared Stash flow (`Trip.saved`, `Trip.ledgerBalanceMinor`, `submitSharedAction` in `app/(tabs)/trips/[tripId].tsx`) | — | Reusable **only as a payment source reference**, never mutated by expense recording itself. |
| My Stash / `trip_personal` flow (`src/domain/tripPersonalFund.ts`, `createBucket`'s `trip_personal` branch) | — | **Must remain fully isolated.** No expense-related code may read or aggregate another member's `trip_personal` Bucket. See §4 for why "Personal Expense" as a new concept is unnecessary here. |
| Trip membership (`Trip.memberIds`/`Trip.ownerId`) | `firestore.rules` (`isTripMember`/`isTripOwner`), `functions/src/callables/createBucket.ts`'s trip-membership check | **The only real membership model that exists.** `Membership`/`Invitation`/roles (`admin`) are frozen, unwired concepts — do not design expense permissions around a role system that isn't real. Every permission decision in this document is expressed in terms of `memberIds`/`ownerId` only. |
| Firestore Rules cross-reference pattern (`canAccessParent()` in the `savingsTransactions` match block, `firestore.rules:262-272`) | `firestore.rules` | **Directly reusable, nearly verbatim**, for `tripExpenses`/`tripExpenseSplits`/`tripSettlements` read access (see §13). |
| Cloud Functions test convention (`functions/test/createBucketCore.ts`, isolated Node `node --test` runner against the Firestore emulator) | `functions/test/` | Directly reusable convention for a future `recordTripExpenseCore.ts` test file. |

**Must remain separate, no exceptions:**
- `Trip.saved` / `Trip.ledgerBalanceMinor` / any Bucket's `balance`/`ledgerBalanceMinor` — an expense record must never write to these fields directly or indirectly except through the existing, unmodified `recordSavingsTransactionCore` path, and only when a human explicitly chose "paid from Shared Stash" (§6).
- My Stash privacy boundary — already absolute today (a Trip owner has zero special access to another member's `trip_personal` Bucket, per Firestore Rules' `isBucketMember()`/`isBucketOwner()` being the sole access gate, with no Trip-ownership carve-out). Nothing in this design introduces a new read path that could leak a personal balance to the group.

---

## 3. Recommended canonical Expense model

The frozen shape in `src/types/domain/expense.ts` is **kept**, with two additive fields the frozen design (written before the two-fund architecture existed) could not have anticipated. Repository evidence — not aesthetic preference — drives every change:

```ts
export type SplitStrategy = "equal" | "percentage" | "custom";

// NEW — see §5. Renamed (Checkpoint 4A.1) from the original draft's
// "member_personal" to `member_out_of_pocket` - "personal" was too easy
// to confuse with My Stash / private personal spending, which this value
// has nothing to do with. This is exclusively about HOW a SHARED expense
// was paid: a member's own external cash/card, vs. the group's own
// Shared Stash fund.
export type ExpensePaymentSource = "member_out_of_pocket" | "shared_stash";

// CurrencyCode is kept as the field type for forward compatibility, but
// see the MVP currency policy immediately below the type - only "USD" is
// a valid value anywhere in this design until a dedicated multi-currency
// design exists (§19).
export type Expense = {
  id: string;
  tripId: string;
  // Checkpoint 4A.1 correction: CONDITIONAL, not always required - if
  // Shared Stash paid the expense, no member personally paid anything,
  // and inventing a payerUid in that case would be a fabricated fact.
  //   paymentSource === "member_out_of_pocket" -> payerUid REQUIRED,
  //     and must be a current Trip member (validated server-side, §11).
  //   paymentSource === "shared_stash" -> payerUid MUST be null/absent.
  payerUid: string | null;
  createdBy: string;               // REQUIRED in both cases - see below
  amountMinor: number;          // integer minor units — never a float dollar amount
  currency: CurrencyCode;       // MUST be "USD" for this entire milestone - see the note below
  description: string;
  category?: string;            // free-form for MVP — see §3 note below
  receiptImageUrl?: string | null; // reserved field only — no upload path exists; see §16
  splitStrategy: SplitStrategy;

  // NEW fields (this audit):
  paymentSource: ExpensePaymentSource;
  // Checkpoint 4A.1 correction: REQUIRED whenever paymentSource ===
  // "shared_stash" - an Expense may never claim Shared-Stash funding
  // without a real, already-verified withdrawal behind it (see §6).
  // Absent/undefined for a member_out_of_pocket expense (there is
  // nothing to link). There is no longer any persisted state where
  // paymentSource === "shared_stash" and this field is null - that
  // "temporary half-linked" state from the original draft is removed.
  sharedStashTransactionId?: string;

  occurredAt?: PersistedTimestamp;
  createdAt: PersistedTimestamp;   // server-generated only, never client-supplied
  lastUpdatedAt?: PersistedTimestamp;
  lastUpdatedBy?: string;
  // NEW — see §9. Never a boolean "deleted" flag (see §9's reasoning for
  // reversal-over-mutation); absent/null means active.
  reversalOf?: string | null;
  reversedBy?: string | null;
};
```

**MVP currency policy (Checkpoint 4A.1 addition): USD only, everywhere, no exceptions.** `Expense.currency` must equal `"USD"`; the trusted `recordTripExpense`/`recordTripSettlement` callables reject any other value outright (§11); `computeTripBalances()` (§8) never sums or nets `amountMinor` values across different currencies — it doesn't need to, because no other currency can ever reach it. This matches the current app exactly: every visible money value today (`Trip.saved`, `Bucket.balance`, `savingsTransactions.currency`) is already USD-only in practice. Genuine multi-currency travel support (a trip priced in EUR with members contributing in USD, say) is legitimate future work, but it requires its own dedicated design — either one canonical Trip settlement currency with real conversions, or entirely separate debt graphs per currency — and is explicitly deferred, not assumed solvable by "just adding a currency field" (§19).

**Why every field is there:**
- `id`/`tripId` — identity and the sole scoping key (see §13 for why `tripId` is a field, not a path segment).
- `payerUid` — who actually handed over money in the real world, **only when a member did** (§1 above). Distinct from `createdBy` because any member may log an out-of-pocket expense someone *else* paid (e.g., logging a receipt for a friend who paid cash).
- `createdBy` — who created the record, for audit/permissions (§10) and idempotency replay comparison (§12), mirroring `recordSavingsTransactionCore`'s `recordedBy` field exactly. Required unconditionally, regardless of `paymentSource` — someone always initiates the record, even when no one personally paid.
- `amountMinor`/`currency` — integer minor units, matching every other financial field in this codebase (`ledgerBalanceMinor`, `amountMinor` in `savingsTransactions`). **Never** a floating-point dollar amount, per the checkpoint's explicit instruction and this codebase's own established convention. `currency` is constrained to `"USD"` only for this entire milestone (see above).
- `description` — required, length-validated server-side (mirrors `note`'s `MAX_TRANSACTION_NOTE_LENGTH` precedent in `savingsTransactions.ts`).
- `category` — kept **optional and free-form** (a validated string, not yet an enum) for MVP. A fixed allowlist is real, useful future work (§16) but not required to ship a correct, safe expense-splitting core, and inventing the "right" category list without product input risks freezing a bad taxonomy under a `firestore.rules` allowlist that's expensive to change later. Recommend: ship with a *client-side* suggested-category list (no server enforcement) and revisit server-side validation once real usage data exists.
- `receiptImageUrl` — kept as a reserved, nullable field only. No Firebase Storage bucket, no `storage.rules`, no upload UI exists anywhere in this repository. Do not build receipt upload in the same milestone as the ledger-safety-critical split/settlement engine (§16).
- `splitStrategy` — see §7.
- `paymentSource` (NEW) — see §5/§6; this is the field the frozen design was missing.
- `sharedStashTransactionId` (NEW) — the link described in §6, **required** (not optional) whenever `paymentSource === "shared_stash"`, and only ever set to a transaction that has already been validated to exist.
- `occurredAt` — optional, same "plain Date at the API boundary, converted to a Firestore `Timestamp` server-side" convention already used by `recordSavingsTransaction`'s `occurredAt` handling.
- `createdAt`/`lastUpdatedAt`/`lastUpdatedBy` — server-generated, matching every other trusted document in this codebase.
- `reversalOf`/`reversedBy` (NEW) — see §9; mirrors the **already-present-but-unused** `reversalOf: null` field `recordSavingsTransactionCore` already writes into every `savingsTransactions` document (`functions/src/callables/recordSavingsTransaction.ts:275`) — this codebase has already chosen "reversal, not mutation" as its financial-record philosophy once before. Expenses should follow the same precedent, not invent a different one.

`ExpenseSplit` is kept as originally designed, since the frozen comment's own reasoning is sound (participant balances are always computed live from Expense+Split+Settlement together, never cached):

```ts
export type ExpenseSplit = {
  participantUid: string;
  shareAmountMinor: number;          // always authoritative
  percentageBasisPoints?: number;    // informational only, when splitStrategy === "percentage"
};
```

---

## 4. Shared vs. Personal expense semantics — recommendation

**Recommendation: do not build a "Personal Expense" concept in this milestone at all.** This is the fourth option the checkpoint explicitly allowed, and repository evidence supports it directly:

My Stash already lets a member record a private withdrawal with an optional note (`MoneyActionSheet`'s note field, `MAX_TRANSACTION_NOTE_LENGTH`-validated, `src/services/firebase/savingsTransactions.ts`). "I withdrew $40 from My Stash — note: 'lunch'" **provides a lightweight private spending/budget record today** — it does not require inventing a second, parallel `Expense`-shaped schema just to let a member note what they personally spent. A parallel `Expense` document with `expenseType: "personal"` would duplicate a real chunk of that capability with a second schema, a second write path, and a second place privacy could be gotten wrong — for a concept (splitting an expense with yourself) that is a contradiction in terms. The frozen `Expense` type itself has no shared/personal discriminant at all and its own doc comment calls it "Expenses are TRIP-ONLY" — read most naturally, this design was always scoped to **shared** expenses; "personal expense" was never actually part of it.

**Important limitation, stated plainly (Checkpoint 4A.1 correction):** a My Stash withdrawal note is a single free-text string, not a structured record. It does **not** replace a future, richer private-expense ledger with merchant/description structure, categories, receipts, or analytics/reporting across a member's personal spending — those are real, legitimately unbuilt capabilities, not capabilities this milestone secretly already has. The claim here is narrower and more honest: for *this* milestone's scope (splitting shared costs), a separate Personal Expense system is unnecessary because the lightweight need it would serve is already served adequately, not because the deeper need doesn't exist.

If that richer personal-spending-log feature is wanted later, the correct home — if and when it's built — is a **self-only, user-owned path**, mirroring the existing `users/{uid}` rule (`firestore.rules`: `allow read, write: if signedIn() && request.auth.uid == uid;`) — e.g. a document under the user's own uid, never a Trip-scoped collection a Trip owner could ever query across members. That is explicitly **out of scope** for this milestone, not a "TBD."

Consequently, every `Expense` document is a **SHARED expense** by construction — there is no `expenseType` field. `paymentSource` (§5) is the only axis of variation this milestone introduces.

---

## 5. Payment-source semantics (separated from expense classification)

Per the checkpoint's own framing, "what kind of expense" and "how was it paid" are kept **fully independent**, with `paymentSource: "member_out_of_pocket" | "shared_stash"` as the only new persisted field for the latter:

| | `member_out_of_pocket` | `shared_stash` |
|---|---|---|
| Real-world meaning | A member personally handed over their own money (cash, their own card) | Money was actually drawn from the Trip's Shared Stash — **no member personally paid anything** |
| `payerUid` | **Required**, must be a current Trip member | **Must be null/absent** — never fabricate a payer when the fund itself paid (§1 correction) |
| Produces split obligations? | Yes — the whole point (§7/§8) | Only if the product later wants a "the group still owes each other nothing, but the fund shrank" record — see below |
| Touches `Trip.saved`/`ledgerBalanceMinor`? | **Never** | Only because a real withdrawal **already happened first**, through the unmodified, existing `recordSavingsTransaction` — see §6. The Expense record itself never triggers or performs that withdrawal. |

Both examples from the checkpoint prompt are representable directly: "Daniel personally paid $250, split five ways" is `paymentSource: "member_out_of_pocket"`, `payerUid: "daniel-uid"`, with a 5-participant equal split producing real reimbursement obligations toward Daniel. "$1,000 hotel actually paid from Shared Stash" is `paymentSource: "shared_stash"`, `payerUid: null` — this **may** still carry a split (e.g., to show each member "your $1,000/5 share of the hotel already came out of the group fund," a transparency/reporting record with **no reimbursement obligation**, since the group fund already absorbed it) or may carry no split at all if the product doesn't want that level of detail in MVP. Recommend deferring the "does a Shared-Stash-paid expense still get a split for reporting purposes" decision to the 4D/4E UX pass (§19) — it doesn't affect the schema either way, since `ExpenseSplit` records are optional/empty-array-permitted regardless of `paymentSource`.

---

## 6. The savings-ledger interaction rule — recommendation

**Recommendation: Option B — two explicit operations, linked by reference. Do not build an atomic combined callable in this milestone.**

Rationale:
1. **The frozen `Settlement` type already committed to this philosophy** before this checkpoint existed (`src/types/domain/settlement.ts`'s own comment: *"This records that an external payment happened — SquadStash never processes or moves money itself"*). An atomic "create Expense + withdraw from Shared Stash" callable would be the first time this codebase's Trip-money layer silently performs a financial side effect a human didn't independently, explicitly trigger — a real precedent break, not a small implementation detail.
2. **Blast radius.** `recordSavingsTransactionCore` is the single most safety-critical function in the app (it is the sole writer of `ledgerBalanceMinor`/`Trip.saved`/`Bucket.balance` everywhere). Bolting a brand-new, less-battle-tested expense-creation code path onto the *inside* of that same trusted transaction multiplies the blast radius of any bug in the new code — a bug in expense-split validation could now also corrupt the savings ledger in the same failure. Keeping them as two separate trusted calls means an expense-creation bug can, at worst, corrupt expense/split data — never the ledger.
3. **UX honesty.** The product's own instruction is explicit: an expense and a ledger withdrawal "are different events unless the product explicitly performs both." Two explicit steps ("Log this $1,000 hotel as paid from Shared Stash" → separately, "Confirm $1,000 withdrawal from Shared Stash") keeps that distinction visible to the user, rather than hiding a real money movement inside what looks like a simple expense-logging form.

**Recommended MVP flow for a `shared_stash`-sourced expense (Checkpoint 4A.1 correction — withdrawal-first, no half-linked state):** a persisted `Expense` must never claim Shared-Stash funding unless a real Shared-Stash withdrawal *already exists* — there is no intermediate state where `paymentSource === "shared_stash"` and `sharedStashTransactionId` is null. Concretely, in strict order:

1. The user explicitly performs a Shared Stash withdrawal through the **existing, unmodified** `recordSavingsTransaction` (`resourceType: "trip"`, `type: "withdrawal"`) — the same Add Money/Withdraw flow that already exists in `app/(tabs)/trips/[tripId].tsx` today. This succeeds and returns a real `transactionId`.
2. Only then is `recordTripExpense` (§11) called, with `paymentSource: "shared_stash"`, `payerUid: null`, and `sharedStashTransactionId: <the real transaction id from step 1>`.
3. The trusted callable validates that transaction before creating anything: it exists in `savingsTransactions`, its `resourceType` is `"trip"` and `resourceId` matches this Expense's `tripId`, its `type` is `"withdrawal"`, its `currency` is `"USD"`, and its `amountMinor` matches this Expense's `amountMinor` (a future explicit partial-funding design, where one withdrawal covers part of an expense, is out of scope for this milestone — §19). Only if all of that holds does the Expense (and its splits, if any) get created.

If step 2 fails or is never attempted after step 1 succeeds, **the withdrawal still happened and the ledger remains true** — it is simply not yet described by an Expense record. That gap is reconcilable later (a UI prompt, a background job, or a manual follow-up) without ever corrupting or reversing the actual ledger, because the ledger was never waiting on the Expense side to be correct. This sequencing is exactly why Option B (§6 above) is safe: `recordSavingsTransactionCore` is **never modified, and never called with new logic from inside a new transaction** — it is only ever invoked exactly as it already is today, by the same existing Shared Stash UI flow. A prerequisite of this design: `recordTripExpense` must **reject `paymentSource: "shared_stash"` outright** until the phase that implements this validation exists (§16, Phase 4F) — see §16 for why 4C/4D deliberately support only `member_out_of_pocket`.

---

## 7. Split architecture

**Storage: a flat top-level `tripExpenseSplits` collection, not embedded in the Expense document and not a subcollection.**

| Option | Embedded array on `Expense` | Subcollection `tripExpenses/{id}/splits/{uid}` (the frozen comment's own suggestion) | **Flat top-level `tripExpenseSplits/{splitId}` (recommended)** |
|---|---|---|---|
| "What do I owe across all my trips?" query | **Not queryable** — Firestore cannot filter inside an array of maps by one field while reading another | Requires a `collectionGroup("splits")` query — a pattern never used anywhere in this codebase today | A plain `where("userId", "==", uid)` query — the same query shape already used everywhere else in this repo (`savingsTransactions`, `trips`, `buckets`) |
| Firestore document-size limit | Trivially fine either way (a Trip has at most a handful of members) — not the deciding factor | Fine | Fine |
| Rules complexity | Simplest (no separate collection) but query limitation above is disqualifying | New: a wildcard `match /{path=**}/splits/{splitId}` rule for the collection-group case | Reuses the **exact `canAccessParent()`-style cross-reference already proven** for `savingsTransactions` (`firestore.rules:262-276`) — no new Rules idiom introduced |
| Per-participant uniqueness | N/A (array, dedup is the caller's problem) | Free (doc ID = `participantUid`) | Achieved the same way, via a **deterministic composite ID**: `splitId = ${expenseId}_${participantUid}` — directly reusing the exact pattern already proven for `trip_personal` Bucket uniqueness (`tripPersonalBucketId`, `src/domain/tripPersonalFund.ts`) |
| Deletion/correction | N/A | Requires knowing to recurse into the subcollection | A plain `where("expenseId", "==", id)` batch delete — same shape as any other cleanup query in this codebase |

Recommended `ExpenseSplit` persisted shape (flat collection):

```ts
// tripExpenseSplits/{expenseId}_{participantUid}
{
  expenseId: string;
  tripId: string;             // denormalized for the canAccessParent()-style rule and for direct queries scoped to a trip
  userId: string;             // matches ExpenseSplit.participantUid
  amountMinor: number;
  percentageBasisPoints?: number;
  createdAt: PersistedTimestamp;
}
```

**Validation rules (server-side, inside the same trusted transaction that creates the Expense):**
- **equal:** `sum(shareAmountMinor) === expense.amountMinor` exactly, always — see deterministic rounding below.
- **percentage:** every participant's `percentageBasisPoints` is a non-negative safe integer; `sum(percentageBasisPoints) === 10000` exactly (100.00%) — reject any other total, including 9999 or 10001. **Never accept a floating-point percentage** (e.g. `33.33`) — basis points (integers, 1 bp = 0.01%) avoid the entire class of floating-point-percentage bugs.
- **custom:** caller supplies `shareAmountMinor` directly per participant; `sum(shareAmountMinor) === expense.amountMinor` exactly required — reject on any mismatch, never silently adjust the last entry to force a match (that would silently override a value the caller explicitly typed).

**Deterministic remainder-cent assignment — two different rules for two different splits (Checkpoint 4A.1 correction):**

**Equal split** keeps the original rule exactly: compute each participant's base share via integer floor division, then distribute the leftover 1-cent remainder(s) to participants **in ascending lexicographic order of `participantUid`** — never input-array order (which a client controls and could differ run-to-run for the same logical set of people, making the split non-reproducible).

```
base = floor(amountMinor / n)
remainder = amountMinor - base * n         // 0 <= remainder < n
sortedUids = participantUids.sort()        // lexicographic
for i, uid in enumerate(sortedUids):
    share[uid] = base + (1 if i < remainder else 0)
```

**Percentage split does NOT use uid-order distribution.** Lexicographic-uid assignment is arbitrary with respect to the percentages themselves — it can hand the extra cent to whichever participant merely has the earliest uid, regardless of who was actually closest to earning it by their intended share. Instead, use **exact integer largest-remainder allocation** (a real, well-known deterministic apportionment method — not floating-point comparison):

```
for each participant:
    numerator      = amountMinor * percentageBasisPoints
    baseShare      = floor(numerator / 10000)
    remainderScore = numerator % 10000        // integer, 0..9999 - exact, no floats

remainingCents = amountMinor - sum(baseShare)

# Sort participants by remainderScore descending; ties broken by
# ascending participantUid (deterministic, referee-free, matching the
# equal-split tie-break convention above).
sortedByRemainder = participants.sort(
    key = (-remainderScore, participantUid)
)
for i, participant in enumerate(sortedByRemainder):
    share[participant] = baseShare[participant] + (1 if i < remainingCents else 0)
```

This uses integer arithmetic only (`numerator`/`remainderScore` are exact integer products and remainders — never a divided/rounded floating percentage), preserves the participants' *intended* percentages more faithfully than an arbitrary uid-order distribution would, remains fully deterministic across devices and retries (the sort key is a pure function of the validated input, with a stable uid-based tie-break), and — because `percentageBasisPoints` is already required to sum to exactly 10000 (§7 validation rules) — `sum(baseShare)` is always `<= amountMinor`, so `remainingCents` is always a small non-negative integer strictly less than the participant count.

**Should the payer be included in the split?** Recommend: **participants are an explicit, per-expense-selected list** (defaulting to "all current Trip members" in the UI for convenience, but always a real, editable list — never implicitly "every Trip member" with no way to exclude someone who wasn't actually there). Whether `payerUid` is or isn't a member of that participant list is then simply a UI/product choice per expense ("I'm treating everyone" excludes the payer; an ordinary shared dinner includes them) — no special backend rule is needed either way, since the settlement engine (§8) already nets a payer's own share against what they paid, however that share is set.

---

## 8. Settlement / balance engine

**Recommendation: a pure, fully derived engine — no cached "net balance" field anywhere — mirroring this codebase's own already-proven pure-domain-helper convention (`src/domain/tripSavingsGuidance.ts`, `src/domain/tripDates.ts`).**

Reuse the frozen `Settlement` type as the reimbursement-payment record the checkpoint calls "SettlementPayment/Reimbursement" — **it is the same concept already designed**, just under a name the frozen author already chose:

```ts
export type SettlementMethod = "venmo" | "paypal" | "zelle" | "cash" | "other";

export type Settlement = {
  id: string;
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: CurrencyCode;
  method: SettlementMethod;   // which external channel was used
  note?: string;
  occurredAt?: PersistedTimestamp;
  createdAt: PersistedTimestamp;
  createdBy: string;
};
```

No change recommended to this type at all.

**Balance derivation (proposed pure function, `src/domain/tripSettlement.ts`, not yet implemented):**

```ts
function computeTripBalances(
  expenses: Expense[],
  splits: ExpenseSplit[],   // joined by expenseId
  settlements: Settlement[],
  tripId: string
): Map<string /* "fromUid|toUid" ordered pair */, number /* net owed, minor units */>
```

For every `member_out_of_pocket`-sourced expense, each non-payer participant's `shareAmountMinor` becomes a debt **from that participant to the payer**; accumulate these per ordered `(ower, payer)` pair across every expense. Subtract every `Settlement` between that exact pair (in the paying direction) from its accumulated debt. `shared_stash`-sourced expenses (§5) contribute **no debt** to this engine at all (the group fund already absorbed the cost, and there is no `payerUid` to owe in the first place — §1) — they only ever appear here for reporting, never for balance math. All amounts compared/accumulated are `"USD"` (§3's MVP currency policy) — `computeTripBalances()` never nets `amountMinor` values across different currencies, because no other currency can reach it this milestone.

**Scope for MVP: direct pairwise net debt only — no transitive debt simplification.** The checkpoint's own example (Alex owes Daniel $100, Sarah owes Daniel $100) is exactly this: a straightforward accumulation per `(ower, payer)` pair, not a minimum-cash-flow graph reduction (the classic "Splitwise simplify debts" feature, which collapses transitive chains like "A owes B, B owes C" into "A owes C"). That optimization is real, useful, and explicitly **deferred** — it adds real complexity (a graph algorithm, and a product decision about whether users want their literal payment history or an optimized abstraction) the checkpoint's own §15 warns against front-loading ("Avoid Splitwise-style complexity everywhere at once").

**Reimbursement reduces debt, never mutates the Expense/Split records that created it** — a `Settlement` is a wholly independent record (per its own frozen doc comment: "no expenseId/split reference"). This is a deliberate simplification with one real consequence worth naming explicitly: because a `Settlement` isn't tied to a specific `Expense`, correcting/reversing an expense after a `Settlement` already happened against the old (now-wrong) balance cannot be "undone" at the data level — it can only be *surfaced* (the derived balance will change, and the UI must be able to show "this trip's balances changed after a correction" truthfully). See §9 and §19.

---

## 9. Edit / delete / reversal policy

Recommend a firm split by blast radius:

| Change | Policy | Why |
|---|---|---|
| Description, category, receipt image | **True mutation** allowed, via `lastUpdatedAt`/`lastUpdatedBy` (same convention as Bucket/Trip metadata edits) | Never affects any derived financial balance |
| Amount, payer, or split (strategy or participants) | **Reversal, never mutation.** Mark the original `Expense.reversalOf`/`reversedBy` (nulled out to "reversed", or a small `status` field — exact shape is a 4B design detail, not resolved here) and create a **fresh** corrected `Expense` document | Directly mirrors the **already-present, currently-unused** `reversalOf: null` field `recordSavingsTransactionCore` writes into every `savingsTransactions` document today (`functions/src/callables/recordSavingsTransaction.ts:275`) — this codebase already chose "reversal over mutation" as its financial-record philosophy once; expenses should follow the identical precedent rather than a different one invented fresh |
| Delete | **No hard delete of a financial record, ever.** "Delete" in the UI should be presented as, and implemented as, a reversal (a reversed expense contributes $0 to every derived balance, but the record and its audit trail remain) | Prevents silent history corruption (checkpoint §9's explicit requirement); matches this codebase's general pattern of never letting a client directly `deleteDoc` a trusted financial record (`allow create: if false` on `savingsTransactions`, no delete rule at all on that collection) |
| An expense a `Settlement` was already recorded against | Reversal is still allowed (Settlements aren't linked to specific expenses — §8), but the UI must clearly warn that trip balances will change as a result | Real-world reconciliation problem, not a data-integrity bug — see §19 |

---

## 10. Permissions

Every rule below is expressed in terms of the **real** membership model (`Trip.memberIds`/`Trip.ownerId`) — not the frozen, unwired `Membership`/role system (§1/§2).

| Action | Who |
|---|---|
| Create a shared expense | Any current Trip member (`memberIds` or `ownerId`) — when `paymentSource === "member_out_of_pocket"`, `payerUid` and every participant in the split must also be a current Trip member, verified server-side inside the trusted transaction (never trusted from client input), exactly like `createBucket`'s existing Trip-membership check pattern; when `paymentSource === "shared_stash"`, there is no `payerUid` to check, but every participant is still verified the same way |
| Read a shared expense / its splits | Any current Trip member — **not** limited to the payer or split participants; per the product's own transparency model (§14, "who owes what" is a shared-visibility feature), reusing the `canAccessParent()`-style rule already proven for `savingsTransactions` |
| Edit metadata-only fields | `createdBy` or the Trip owner |
| Reverse/correct an expense (amount/payer/split) | `createdBy`, `payerUid` (when present), or the Trip owner — recommend requiring one of these, not "any member," given the financial-correction blast radius |
| Create a reimbursement (`Settlement`) | **Only `toUid` — the recipient of the reimbursement (Checkpoint 4A.1 correction).** The person *receiving* money is the only party who can truthfully confirm it was actually received; `fromUid` (the debtor) must not be able to unilaterally record "I paid" and erase their own debt with no confirmation from the other side. Concretely: if Alex owes Daniel $100 and pays him externally, **Daniel** (the recipient, `toUid`) is the one who records the `Settlement` (`fromUid: Alex`, `toUid: Daniel`, `amountMinor: 10000`) — not Alex. |
| Read reimbursements | Any current Trip member (same transparency rationale as expense reads) |
| Access another member's My Stash via any expense/settlement code path | **Never, under any circumstance, for any role including the Trip owner** — this is an absolute, pre-existing boundary (§2) that this feature must not create a single new way to cross |

**Future enhancement, explicitly NOT built for MVP:** a payer-initiated *pending* reimbursement that the recipient must separately confirm before it affects any derived balance (only the confirmed `Settlement` would count). This is a legitimate improvement — it would let the payer initiate the record instead of relying on the recipient to remember — but it introduces a new lifecycle/state machine this milestone deliberately avoids. MVP keeps the simpler, harder rule above: only `toUid` may record a `Settlement` at all, and every recorded `Settlement` is immediately and fully effective.

---

## 11. Trusted write path

Yes — expense creation, edits/reversals, and reimbursement creation should all be Cloud Function callables, matching this codebase's established rule that every financial-affecting write is server-validated (`allow create: if false` is the correct Rules posture for all three new collections — see §13).

**Candidate `recordTripExpense` callable — inputs:**
```
tripId: string
payerUid: string | null            // REQUIRED (non-null) iff paymentSource === "member_out_of_pocket"; MUST be null/absent iff "shared_stash"
amountMinor: number
currency: string                   // MUST be "USD" - rejected otherwise (§3)
description: string
category?: string
splitStrategy: "equal" | "percentage" | "custom"
participants: { uid: string; percentageBasisPoints?: number; amountMinor?: number }[]
paymentSource: "member_out_of_pocket" | "shared_stash"
sharedStashTransactionId?: string  // REQUIRED iff paymentSource === "shared_stash" (§6) - not optional in that case
occurredAt?: string                 // ISO date/time, same convention as recordSavingsTransaction
clientRequestId: string
```

**Server must validate (mirrors `createBucketCore`/`recordSavingsTransactionCore`'s existing validation style exactly):**
- Caller is authenticated (`requireAuthenticatedUid`, identical helper).
- Caller is a current Trip member.
- `currency` must equal `"USD"` exactly — reject any other value, including other real ISO codes (§3).
- **`paymentSource` cross-validation (Checkpoint 4A.1):**
  - `"member_out_of_pocket"` → `payerUid` must be present and a current Trip member (read fresh from `trips/{tripId}` inside the same transaction — never trusted from client input, exactly like `createBucketCore`'s Trip-membership check); `sharedStashTransactionId` must be absent.
  - `"shared_stash"` → `payerUid` must be null/absent (reject if supplied — never silently ignore it); `sharedStashTransactionId` is **required** and must resolve to a real `savingsTransactions` document whose `resourceType === "trip"`, `resourceId === tripId`, `type === "withdrawal"`, `currency === "USD"`, and `amountMinor === this expense's amountMinor` (§6). **Additionally, until Phase 4F exists, the callable rejects `paymentSource: "shared_stash"` outright** (`invalid-argument` or a dedicated `failed-precondition`) — see §16.
- Every `participants[].uid` is a current Trip member.
- `amountMinor` is a positive safe integer (`Number.isSafeInteger(...) && > 0`, identical guard used everywhere else in this codebase).
- `description` is a non-empty string under a max length.
- `category`, if present, under a max length (no allowlist enforcement in MVP — §3).
- Split totals match exactly, per the rules in §7 (no silent rounding adjustment of caller-supplied values).
- Idempotency (§12).
- `createdAt`/timestamps are always server-generated (`FieldValue.serverTimestamp()`), never accepted from the client.

**Candidate `recordTripSettlement` callable** — the same shape of validation, scaled down, with one hard restriction (Checkpoint 4A.1): the authenticated caller **must equal `toUid`** — not `fromUid` or either party. `fromUid` and `toUid` are both current Trip members, `amountMinor` is a positive safe integer, `currency` must equal `"USD"`, `method` is a valid enum value, and the whole call is idempotent via `clientRequestId`. A request where `request.auth.uid !== input.toUid` is rejected with `permission-denied`, regardless of whether the caller is `fromUid` or an unrelated Trip member.

---

## 12. Idempotency

Reuse **both** proven idioms already in this codebase, applied to the case each fits best:

- **Expense creation:** like `recordSavingsTransaction`, use `clientRequestId` directly as the `tripExpenses` document ID (`tripExpenses/{clientRequestId}`), inside a `runTransaction`. Like `createBucket`, additionally store an immutable `creationRequest` snapshot of every input field (including the full split list) and compare it field-by-field on replay — a plain `storedFactsMatch`-style five-field comparison isn't expressive enough once the "facts" include a structured split list, so the richer `creationRequest`-snapshot idiom from `createBucketCore` is the better fit here, not the simpler one from `recordSavingsTransactionCore`.
- **Splits:** need **no independent idempotency mechanism at all.** They are written only as a side effect of the expense-creation transaction succeeding exactly once (guaranteed by the expense's own `clientRequestId`-keyed uniqueness above), at deterministic IDs (`${expenseId}_${participantUid}`, §7) that make a duplicate-write attempt a no-op read-then-overwrite-with-identical-data rather than a duplicate record.
- **Reimbursement creation:** identical shape to expense creation — `tripSettlements/{clientRequestId}`, same replay-comparison idiom.

This prevents double-clicks, retries, and ambiguous-callable-response scenarios exactly the same way the existing Bucket/savings flows already do — no new class of race condition is introduced.

---

## 13. Firestore data shape

**Recommendation: flat top-level collections, not `trips/{tripId}/expenses` subcollections.**

```
tripExpenses/{clientRequestId}
tripExpenseSplits/{expenseId}_{participantUid}
tripSettlements/{clientRequestId}
```

| Consideration | Flat top-level (recommended) | `trips/{tripId}/expenses/{id}` subcollection |
|---|---|---|
| Consistency with existing architecture | Matches `savingsTransactions`'s already-proven flat-collection-plus-cross-reference-rule pattern exactly | A structurally new pattern for this codebase (no existing subcollection is read this way for Trip data — `trips/{tripId}/members` is defined in types but never actually used) |
| Rules | Reuses the existing `canAccessParent()` idiom near-verbatim | Needs a fresh nested-path rule (`match /trips/{tripId}/expenses/{expenseId}`), still solvable but a second idiom to maintain alongside the first |
| Queries ("my activity across every trip I'm in") | Trivial: `where("payerUid", "==", uid)` with no `tripId` in scope at all | Requires a `collectionGroup("expenses")` query — new pattern, new composite index needs |
| Deletion / trip-deletion cleanup | `where("tripId", "==", tripId)` + batch delete — note `deleteTrip` (`src/services/firebase/trips.ts:106-108`) **already does a bare `deleteDoc` with no subcollection cleanup today** — see the hard prerequisite immediately below | Same orphaning risk, arguably worse since it's less discoverable (nested docs don't show up in a flat collection browse) |
| Atomicity | Unaffected either way — a Firestore transaction can touch documents at any paths in the same write | Unaffected either way |

Recommend keeping the naming explicit (`tripExpenses`, not a bare `expenses`) — self-descriptive next to `savingsTransactions` in the Firebase console, and leaves room for a conceptually distinct Bucket-level expense feature later without a collision (none is currently planned, but the cost of the clearer name today is zero).

### Hard prerequisite: Trip delete/archive hardening (Checkpoint 4A.1 — promoted from observation to requirement)

The original audit noted `deleteTrip`'s bare `deleteDoc` (`src/services/firebase/trips.ts:106-108`) only as evidence for the collection-shape comparison above. That is no longer sufficient once real financial history is about to exist. **Once Trip financial history (Expenses, Splits, Settlements) exists, an owner hard-deleting a Trip today would silently orphan every one of those records** — they'd remain in Firestore, unreachable through the app, with no parent Trip left for the `canAccessParent()`-style Rules (§13 table, §10) to authorize reads against, effectively locking that financial history away forever without ever explicitly "deleting" it.

**This is now a hard implementation prerequisite, not a nice-to-have: before Phase 4C stores the first real Expense, Trip hard-delete behavior must be hardened.** Recommended product rule: **a Trip with any trusted financial history must not be hard-deleted.** Concretely, `deleteTrip` needs an archive/soft-delete path (e.g., an `archivedAt`/`status: "archived"` field, with the existing rules' `allow delete: if isTripOwner()` either removed in favor of an archive-only update, or retained only for a Trip verified to have zero Expenses/Settlements/`savingsTransactions` history) so that:
- Trip financial records remain auditable indefinitely.
- `tripExpenses`/`tripExpenseSplits`/`tripSettlements` remain resolvable to their parent Trip (the `canAccessParent()`-style rule keeps working, since the Trip document still exists).
- Settlement history is never orphaned.
- Existing Shared Stash `savingsTransactions` history (which already exists for every Trip today, independent of this feature) remains intact and reachable.

If a Trip genuinely has zero trusted financial history (no `savingsTransactions`, no Expenses, no Settlements — realistic for a Trip abandoned right after creation), permanent deletion may remain possible, but that is its own separate, carefully validated path (checking all three history sources before allowing a real delete), not the default. **This audit does not implement this hardening** — it is called out here as a required prerequisite phase in §16 (Phase 4B.5), to be designed and built as its own small, focused checkpoint before Phase 4C begins.

---

## 14. Query / index requirements

| Screen need | Query | Index needed? |
|---|---|---|
| Trip Detail: recent expenses | `tripExpenses where tripId == X order by createdAt desc` | Composite (`tripId` + `createdAt`) |
| Trip Detail: total spent | Derived client-side from the same fetched page, or a future aggregation — **not** a cached field (matches this codebase's derived-not-cached financial philosophy) | None beyond the above |
| Trip Detail: category totals | Same base query, aggregated client-side for MVP; a Cloud Function scheduled/triggered rollup is future work if the per-fetch aggregation becomes too slow | None for MVP |
| Expense Detail: split breakdown | `tripExpenseSplits where expenseId == X` | Single-field (auto) |
| Expense Detail: payer, receipt | Direct `get()` on the `Expense` doc | None |
| Balances: "you owe Alex $82" | Fetch all `tripExpenses`+`tripExpenseSplits`+`tripSettlements` for the trip, run `computeTripBalances()` (§8) client-side | Composite (`tripId` + `createdAt`) on each collection, same as above |
| My activity: expenses I paid | `tripExpenses where payerUid == me order by createdAt desc` (cross-trip, no `tripId` filter) | Composite (`payerUid` + `createdAt`) |
| My activity: expenses I owe toward | `tripExpenseSplits where userId == me` | Single-field (auto) |
| Future: analytics by category, budget vs. actual, export | All supported by the same flat, field-queryable shape — no schema change needed later, only new composite indexes as new query shapes emerge | Deferred |

All of the above are ordinary `where`/`orderBy` queries on a flat collection — no `collectionGroup` query is required anywhere in this design, keeping the whole feature inside patterns this codebase already uses and already has working CI/emulator coverage for.

---

## 15. UI / product flow (MVP recommendation — not implemented)

```
Trip Detail
  -> Expenses (new section/tab)
       -> + Add Expense
            1. description
            2. amount
            3. who paid (defaults to the current user)
            4. split method: equal (MVP default) — percentage/custom as fast-follow, not launch-blocking
            5. participants (defaults to all current Trip members, editable)
            6. payment source: "I paid out of pocket" (the only option through Phase 4E — "Paid from Shared Stash" is a Phase 4F addition, §16, and requires the withdrawal to happen first, §6)
            7. category: optional free-text/suggested chips, no server enforcement
            (receipt upload: NOT in MVP — no Storage infrastructure exists, §3/§16)
       -> Expense list (recent, with running total)
       -> Expense Detail (payer, split breakdown, edit/reverse)
       -> Balances / Settle Up (derived, §8) -> "Record a payment" (Settlement, recorded by the recipient confirming they received it — §10)
```

Recommend **equal split only at first real launch**, with percentage/custom split as an explicit, separately-shippable fast-follow (the domain math for all three should still be built and tested together in 4B, since the marginal cost of testing percentage/custom alongside equal is small once the framework exists — but the *UI* can expose only "equal" at first without blocking anything downstream). This matches the checkpoint's own instruction to avoid Splitwise-style complexity everywhere at once, and lets 4D ship sooner.

---

## 16. MVP boundary — recommended phased sequence

| Phase | Scope | Touches Firebase/Functions/Rules? | Touches the savings ledger? |
|---|---|---|---|
| **4B** | Pure domain layer only: `SplitStrategy` math (equal/percentage/custom + deterministic rounding — lexicographic-uid for equal, largest-remainder for percentage, §7), `computeTripBalances()` (§8), formalized `Expense`/`ExpenseSplit`/`Settlement` types (this audit's additions, including the `member_out_of_pocket`/`shared_stash` payment-source split). Fully unit-tested, zero I/O — the exact same pattern already proven successful for `tripSavingsGuidance.ts`/`tripDates.ts` in Checkpoints 3F.3D/3F.3D.1 | No | No |
| **4B.5 (new, Checkpoint 4A.1 — hard prerequisite)** | Trip archive/soft-delete hardening (§13) — required before Phase 4C stores the first real Expense. Its own small, focused, carefully validated checkpoint; not implemented as part of this audit | Yes (Rules + `deleteTrip`/a new archive path) | No |
| **4C** | Firestore Rules for `tripExpenses`/`tripExpenseSplits`/`tripSettlements` (read-only for clients, `allow create: if false`); trusted `recordTripExpense` callable + emulator tests (mirroring `functions/test/createBucketCore.ts`'s convention). **Supports ONLY `paymentSource: "member_out_of_pocket"` — the callable explicitly rejects `"shared_stash"` until Phase 4F exists (§6/§11).** | Yes | No |
| **4D** | Trip Detail "Expenses" list + "+ Add Expense" UI (equal split only, out-of-pocket only), wired to 4C | UI only, calls 4C | No |
| **4E** | `recordTripSettlement` callable + Rules, **restricted to `toUid`-only creation (§10)**; Balances/"Settle Up" UI powered by the 4B engine reading live 4C/4E data; percentage/custom split UI fast-follow | Yes | No |
| **4F** | Shared-Stash-funded expenses: the withdrawal-first flow (§6) using a **required, fully validated** `sharedStashTransactionId` — no half-linked Expense state is ever created or persisted | Yes (a small `recordSavingsTransaction` call from the existing, unmodified Shared Stash flow, plus the `recordTripExpense` cross-validation added in §11) | **Yes — deliberately last**, since it's the only phase that touches the hardened ledger at all, and only via the existing unmodified function |

This sequence keeps every phase independently reviewable and revertible, defers all ledger contact to the final, smallest, most tightly-scoped phase, and — new in this revision — does not let any trusted Expense-creation code exist at all until Trip deletion can no longer silently orphan the financial history that code is about to create.

---

## 17. Test plan (to write before 4B/4C implementation, not after)

**Pure domain (4B), no emulator needed:**
1. Equal split, amount divides evenly by participant count.
2. Equal split with remainder cents — verify deterministic lexicographic-uid assignment, not array order.
3. Percentage split, basis points sum to exactly 10000.
4. Invalid percentage total (9999 or 10001 bps) rejected.
5. Custom split, amounts sum exactly to the expense total.
6. Invalid custom total (off by even 1 cent) rejected, no silent adjustment.
7. Payer included in the participant list.
8. Payer excluded from the participant list (product permits this — §7).
9. One-member Trip (degenerate equal split = the full amount to that one participant).
10. Multiple expenses across the same Trip, correctly netted.
11. Reciprocal debts between the same pair from different expenses correctly net down (not tracked as two separate unrelated debts).
12. A `Settlement` reduces the correct pairwise debt, and only that pair's debt.
13. Over-reimbursement: recommend the pure `computeTripBalances()` function surface a resulting *negative* net (i.e., "now owed the other way") truthfully rather than clamping at zero — see the unresolved product decision in §19 about whether the trusted callable should also *reject* an over-reimbursement server-side.
14. A reversed/corrected expense contributes $0 to every derived balance; the original and the correction are both retrievable for audit.
15. A `shared_stash`-sourced expense contributes $0 to every derived debt/balance regardless of its split (§8).
16. Non-member rejected — split participant not in `Trip.memberIds`.
17. Idempotent retry — replaying the exact same `clientRequestId`+facts returns the original result; replaying the same `clientRequestId` with different facts is rejected as `already-exists` (mirrors the existing `createBucketCore`/`recordSavingsTransactionCore` test suites' own conventions and should reuse their exact test scenarios).
18. **(New, 4A.1) Percentage split largest-remainder allocation** — a case where floor-division leaves multiple leftover cents, verify they go to the participants with the largest `remainderScore`, not to whoever has the earliest uid.
19. **(New, 4A.1) Percentage remainder tie-break** — two or more participants with an identical `remainderScore`; verify the tie is broken by ascending `participantUid`, deterministically.

**Trusted callable (4C+), Firestore-emulator-backed, mirroring `functions/test/createBucketCore.ts`'s structure:**
- Every server-side validation bullet in §11, individually.
- Non-member payer/participant rejected.
- Split totals enforced exactly as in the pure tests above, now via the real callable.
- **(New, 4A.1) `paymentSource: "member_out_of_pocket"` requires a real, current-Trip-member `payerUid`** — reject when absent or when it names a non-member.
- **(New, 4A.1) `paymentSource: "shared_stash"` rejects a supplied `payerUid`** outright (never silently drop it) and, once Phase 4F exists, **requires** a `sharedStashTransactionId` that resolves to a real, matching withdrawal (§6/§11) — reject when absent, non-existent, wrong `resourceId`/`resourceType`/`type`/`currency`, or mismatched `amountMinor`.
- **(New, 4A.1) Phase 4C/4D callable rejects `paymentSource: "shared_stash"` entirely**, regardless of whether a `sharedStashTransactionId` is supplied — this restriction is lifted only in Phase 4F.
- **(New, 4A.1) `currency` acceptance** — `"USD"` is accepted; any other value (including another real ISO code, empty string, or lowercase `"usd"`) is rejected.
- **(New, 4A.1) Settlement authority** — a `recordTripSettlement` call where `request.auth.uid === input.toUid` succeeds; a call where the caller is `input.fromUid` (attempting to record their own debt as paid) is rejected with `permission-denied`; a call from an unrelated Trip member (neither `fromUid` nor `toUid`) is also rejected.
- **(New, 4A.1) Archived-Trip financial-record resolvability** — once Phase 4B.5 exists, verify that an archived (not hard-deleted) Trip's `tripExpenses`/`tripExpenseSplits`/`tripSettlements`/`savingsTransactions` remain readable by current Trip members exactly as before archiving.
- **(New, 4A.1) Expense creation against an archived Trip** — reject or allow per whatever the 4B.5 checkpoint's own design decides (§19); write the test once that rule is actually chosen, not assumed here.

---

## 18. Tooling / maintenance note (recorded, not addressed this checkpoint)

Per explicit instruction, these are recorded only:
- `npm outdated` shows numerous Expo SDK packages with available patch/minor updates (`expo` 54.0.36 → 54.0.37, `@expo/vector-icons`, `react-native-safe-area-context`, etc.) — routine patch drift, not urgent.
- `functions/package.json` pins `"node": "20"` in `engines` — Firebase Cloud Functions Node.js runtime deprecation timelines should be tracked separately.
- `firebase-functions` is pinned at `^7.0.0`; `firebase-admin` at `^13.6.0` — worth a dedicated version-currency pass at some point, not tied to this feature.
- `@typescript-eslint/eslint-plugin`/`@typescript-eslint/parser` are pinned at `^5.12.0` in `functions/package.json`, a major version behind the root project's tooling — a real but unrelated compatibility item.

None of the above block or influence the design in this document. **Do not bundle dependency upgrades into the Expense feature's implementation checkpoints.**

---

## 19. Unresolved product decisions (explicitly flagged, not silently assumed)

1. **Does a Shared-Stash-paid expense still generate a split for reporting purposes**, or is a split only ever meaningful for `member_out_of_pocket` expenses? (§5) — does not affect the schema; affects 4D/4E UX only.
2. **Should an over-reimbursement be hard-rejected server-side**, or only soft-warned client-side from an already-fetched (non-authoritative) balance snapshot? Hard-rejection requires the trusted callable to recompute a live aggregate balance across potentially many expense/split/settlement documents inside one Firestore transaction (which has a 500-document read/write ceiling) — a real scaling question, not just a validation nuance. Recommend the soft-warning approach for MVP (§8/§17 item 13), matching this codebase's existing pattern of non-authoritative client-side balance hints (e.g., the Shared Stash withdrawal-amount check in `app/(tabs)/trips/[tripId].tsx`) — revisit only if it becomes a real support burden. (Note: this is independent of, and not resolved by, the 4A.1 settlement-authority correction in §10 — that correction decides *who* may record a Settlement, not whether an *amount* that would overpay is blocked.)
3. **Category allowlist** — ship free-form for MVP (§3), or invest in a fixed enum + Rules validation now? Recommend deferring.
4. **Receipt upload** — genuinely out of scope until Firebase Storage exists in this project at all (§3/§16); flag as its own future prerequisite checkpoint, not a "later phase of this feature."
5. **Debt simplification (transitive graph reduction)** — deliberately out of MVP scope (§8); revisit only once direct pairwise balances are shipped and real usage shows a need.
6. **Exact reversal-record shape** (`status` field vs. `reversalOf`/`reversedBy` pair vs. a fully separate `expenseReversals` collection) — sketched in principle (§9) but the exact persisted shape is a 4B/4C design detail to finalize when that phase actually begins, not frozen here.
7. **Relationship to the long-term vision document** (`docs/product/SQUADSTASH_MASTER_SPEC_V2.md` §14–§16, "Expenses and Expense Splitting" / "Reimbursements, Refunds and Settlement") describes a materially more advanced system — trip cards, manager-approval workflows, an embedded-finance banking partner, dispute workflows. **None of that is assumed, required, or half-built by this design.** This audit's recommendations are scoped entirely to the current, much simpler two-fund architecture; the master spec should be treated as a north star for a later era of the product, not a checklist this milestone must partially satisfy.
8. **(New, 4A.1) Multi-currency travel support** — this milestone is USD-only, everywhere, by hard requirement (§3). A real multi-currency design is future work requiring its own dedicated decision between (a) one canonical Trip settlement currency with real currency conversion, or (b) entirely separate debt graphs maintained per currency with no cross-currency netting ever. Never assume "just widen the `currency` field" is sufficient — `computeTripBalances()` summing/netting `amountMinor` values that are secretly in different currencies would silently produce a meaningless number, which is exactly the class of mistake this audit is trying to prevent elsewhere (§6/§8).
9. **(New, 4A.1) Exact Trip archive semantics** — §13's hard prerequisite establishes *that* a Trip with financial history must not be hard-deleted, but not the full shape of "archived": can an owner still add new Expenses/Settlements to an archived Trip, or does archiving also freeze new financial activity? Can an archived Trip be un-archived? These are real product questions for the dedicated Phase 4B.5 checkpoint to resolve, not assumed here.

---

## 20. Conclusion

**DO NOT IMPLEMENT ANY PART OF THIS DESIGN YET.** This document (as hardened by Checkpoint 4A.1) is the architecture to review, question, and approve or amend before Checkpoint 4B (or any later phase) begins writing code. No application code, Firestore Rules, Cloud Functions, or dependencies were modified to produce either the original 4A audit or this 4A.1 amendment — only this markdown file was ever touched.

---

### Validation

```
git diff --check     -> no output (no whitespace/conflict issues)
git status --short   -> ?? docs/audits/TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md
```

The file remains untracked (never committed from the original 4A pass), so this 4A.1 hardening pass is a further edit to that same still-uncommitted file — no other file appears in `git status`.

No backend deployment was run. No production code was modified during this checkpoint.

CHECKPOINT 4A TRIP EXPENSES ARCHITECTURE AUDIT READY FOR REVIEW

DO NOT COMMIT.
DO NOT PUSH.
DO NOT DEPLOY.
DO NOT IMPLEMENT.
STOP.
