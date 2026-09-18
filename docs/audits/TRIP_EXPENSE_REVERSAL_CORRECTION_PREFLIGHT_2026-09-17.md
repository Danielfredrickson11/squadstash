# Trip Expense Reversal / Correction Architecture Preflight

**Preflight date:** 2026-09-17 (amended 2026-09-17, Checkpoint 4C.3A.1 hardening pass; amended again 2026-09-17, Checkpoint 4C.3A.2 final freeze pass)
**Type:** Architecture only — **no production code, Rules, Functions, tests, or dependencies were changed**
**Baseline:** `claude/milestone-3-personal-savings-mvp` @ `138c6c8` ("Harden trip expense persistence security"), working tree clean before and after
**Checkpoint:** 4C.3A — Trusted Expense Reversal/Correction Architecture Preflight; hardened by 4C.3A.1, finalized by 4C.3A.2
**Governing documents:** `docs/audits/TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md` (as hardened by 4C.1A/4C.1B) — the source of the one open item this preflight resolves: §11/§16's flagged, deliberately-deferred reversal/correction design
**Status:** DO NOT IMPLEMENT — this document freezes the trusted reversal/correction model before any 4C.3B+ checkpoint begins writing code

**Amendment note (Checkpoint 4C.3A.1):** this revision corrects two issues found in the original 4C.3A pass before it becomes the frozen plan: (1) the exact-reversal-replay check was sequenced *after* reading and validating the parent Trip, weaker than the parent-independent replay property already frozen for `recordTripExpense` — reordered so a caller's exact replay of their own already-committed reversal is resolved immediately after reading the Expense, before any Trip document is ever read at all (§4.3/§4.4, with downstream references corrected throughout §7/§8/§15/§16); (2) the correction-link design was one-way-only (`replacesExpenseId` on the new Expense alone), which does not prevent two different new Expenses from concurrently claiming to replace the same reversed Expense — replaced with a two-way, atomically-written, one-to-one link (`replacesExpenseId` + `replacedByExpenseId`, both written by the same `recordTripExpense` transaction that creates the replacement), with an explicit concurrency/idempotency model and an explicit argument for why this is not the "two independently-settable sources of truth" anti-pattern this document itself rejects elsewhere (§9). A small, related normalization ambiguity (`reversalReason` trimming/whitespace-equivalence) was frozen explicitly at the same time (§8.2/§14), and 4C.3D's own test plan (§21) was expanded to cover the corrected link model. Every other 4C.3A decision — the permission model (§5), archived-Trip behavior (§6), removed-member behavior (§7), reversal's own single-document idempotency mechanism (§8.1), the reverse-only (Model A) correction shape (§10), balance/Split semantics (§11/§12), the no-Rules-change conclusion (§13), and the beta gate (§19) — is unchanged and not reopened.

**Amendment note (Checkpoint 4C.3A.2):** this revision freezes three remaining architecture gaps before implementation begins: (1) `replacesExpenseId` is now an explicit field of `recordTripExpense`'s own normalized `creationRequest` snapshot, so a same-`clientRequestId` request that changes only its correction target is a genuine conflict (`already-exists`) rather than an exact replay or an unhandled edge case (§9.3); (2) claiming the correction-link slot (setting `replacesExpenseId`) is now gated by its own narrower authorization model — Trip owner, or the old Expense's `createdBy`/`reversedBy` while still a current member — distinct from, and layered on top of, ordinary Expense-creation authority (§9.4); (3) `reverseTripExpense`'s pre-authorization validation is narrowed further than 4C.3A.1 already narrowed it: only the routing fact (`tripId`) is checked before authorization — `status` itself is now read but never inspected or disclosed until after authorization succeeds (§4.3/§4.4, with the resulting required security matrix in §15 and the split concurrency-table row in §16). The exact `recordTripExpense` correction-transaction ordering is now fully specified (§9.5), and 4C.3D's test plan (§21) is expanded to 19 items reflecting all three changes. Every 4C.3A/4C.3A.1 decision not named above — the permission model for reversal itself (§5), archived-Trip behavior (§6), removed-member behavior (§7), reversal's own single-document idempotency mechanism (§8.1), the two-way correction-link field design (§9.1/§9.2), the reverse-only (Model A) correction shape (§10), balance/Split semantics (§11/§12), the no-Rules-change conclusion (§13), `reversalReason` normalization (§14), and the beta gate (§19) — is unchanged and not reopened.

---

## 1. Current-state findings (re-verified against the live repository, not assumed)

| Area | Current state |
|---|---|
| `src/types/domain/expense.ts` | `Expense` already carries `status: "active" \| "reversed"`, `reversedAt?`, `reversedBy?`, `reversalReason?` — shipped in Checkpoint 4B, unused by any write path until now. No `correctedByExpenseId`/`replacesExpenseId`-style link field exists anywhere on the type. |
| `src/domain/tripSettlement.ts` (`computeTripBalances`) | **Already fully correct for reversal, confirmed by direct read — no balance-domain change is needed for 4C.3.** Every Expense's shape/total is validated unconditionally (line ~212, `if (expense.status !== "active" && expense.status !== "reversed") throw`), so a malformed record can never hide behind `"reversed"`. Only the **debt-contribution step** is skipped for a reversed Expense (line ~297, `if (expense.status === "reversed") continue;`) — its `ExpenseSplit` rows are still read, validated, and required to sum correctly; they simply stop contributing to anyone's balance. This is exactly the "neutralize economically, never rewrite" behavior the product goal (§3) requires, and it already works today. |
| `functions/src/callables/recordTripExpense.ts` | Creates Expenses only; never mutates `status`/`reversedAt`/`reversedBy`/`reversalReason` (all reserved, unwritten). Confirmed once more, hardened through 4C.2C: authorization-before-disclosure ordering, creator-bound idempotency via a `creationRequest` snapshot stored **on the Expense document itself** (not a side collection), strict top-level input allowlisting, a collision-safe `splitDocumentId` hash, a `MAX_EXPENSE_PARTICIPANTS` bound, and Firestore document-id safety validation for `tripId`. These are the exact precedents this preflight reuses below (§5, §8, §15, §17). |
| `functions/src/domain/tripExpenseSplits.ts` | Pure split math only; has no concept of reversal and needs none — `ExpenseSplit` documents are never touched by any correction path (confirmed, §12). |
| `functions/test/recordTripExpenseCore.ts` | 4C.2A–4C.2C's full creation/concurrency/security suite (222 tests combined with the parity suite) — no reversal coverage exists yet, confirming reversal is entirely unbuilt, not partially built. |
| `firestore.rules` | `tripExpenses`/`tripExpenseSplits`: `allow get, list` via `canAccessTripById(resource.data.tripId)` (current Trip membership/ownership only, `archivedAt` never inspected); `allow create, update, delete: if false` for every role, unconditionally. No field-level exception exists for `status`/`reversedAt`/`reversedBy` today. |
| `tests/firestore-rules/tripExpenses.rules.test.js` | 276 tests total confirm direct client writes are closed for every role including the owner, and reads follow current Trip access only — re-confirms there is no existing Rules carve-out this preflight needs to reconcile with. |
| Production exposure | Rules and `recordTripExpense` are live; no Expense-creation UI exists; no real user has ever created a real Expense. This preflight is being written **before** any real financial record could exist to reverse. |

**Conclusion:** the existing schema and balance engine already anticipated reversal correctly (Checkpoint 4B's own design, re-verified rather than trusted from memory) — the only real work 4C.3B+ needs to do is **write** `status`/`reversedAt`/`reversedBy`/`reversalReason` through a new trusted callable, with the same level of authorization/concurrency care already proven necessary for `recordTripExpense` (4C.2A→2C).

---

## 2. Frozen existing Expense model (restated, not reopened)

No redesign found necessary. Confirmed exactly as the checkpoint states:
- `tripId`, `payerUid`, `createdBy`, `amountMinor`, `currency`, `description`, `category`, `splitStrategy`, `paymentSource`, `occurredAt`, `createdAt`, `creationRequest` are immutable financial facts — reversal must never touch any of them.
- `ExpenseSplit` documents are immutable and untouched by reversal (§12).
- Reversal neutralizes an Expense economically by writing `status`/`reversedAt`/`reversedBy`/`reversalReason` only — no other field.

---

## 3. Product goal (restated)

Reverse-then-optionally-recreate is confirmed as the correct model, consistent with this codebase's established "reversal over mutation" philosophy (already the precedent for `savingsTransactions`' own unused-but-present `reversalOf` field, and for the original Trip Expense audit's own §9 finding). The original financial record remains permanently auditable; nothing is ever destroyed.

---

## 4. Reversal callable contract

**Name: `reverseTripExpense`.** Mirrors `recordTripExpense`'s own `record*`/verb-first naming convention, using "reverse" (the exact verb already embedded in this codebase's `reversedAt`/`reversedBy`/`reversalReason`/`reversalOf` field names) rather than inventing a different verb.

### 4.1 Input — deliberately minimal

```ts
interface ReverseTripExpenseInput {
  expenseId: string;        // the tripExpenses document id to reverse
  reversalReason?: string;  // optional free text - see §14
  clientRequestId: string;  // idempotency key for THIS reversal request - see §8/§17
}
```

**`tripId` is deliberately NOT part of the input at all.** Unlike `recordTripExpense` (which always knows `tripId` from trusted client input before touching Firestore), reversal begins from an `expenseId` — the Expense's own `tripId` is read from the trusted, already-persisted document, never asserted by the client. This is a genuine, deliberate hardening property: there is no client-suppliable field a caller could use to *claim* an Expense belongs to a Trip it doesn't actually belong to, because that fact is never taken as input in the first place.

### 4.2 Response

```ts
interface ReverseTripExpenseResult {
  expenseId: string;
}
```
Mirrors `RecordTripExpenseResult`'s own minimal shape exactly.

### 4.3 Document reads

Inside one `db.runTransaction`:
1. `tx.get(expenseRef)` — `db.collection("tripExpenses").doc(input.expenseId)` — always, first, unconditionally.
2. `tx.get(tripRef)` — `db.collection("trips").doc(expenseData.tripId)` — **only on the path that is NOT an exact replay of the caller's own already-committed reversal** (see §4.4 step B/D). This is a deliberate, hardened divergence from `recordTripExpense`'s own fixed two-read shape (Checkpoint 4C.3A.1): `recordTripExpense` always knows `tripId` from trusted client input up front, so it unconditionally reads both parent documents before branching at all. `reverseTripExpense` cannot do that — it doesn't know which Trip to read until it has read the Expense — and, per this hardening pass, an exact replay must be resolved **before any Trip lookup is even attempted**, not merely before the Trip's state is *used*. A transaction reading conditionally (read A, decide from A's data whether to read B) remains fully compliant with Firestore's "all reads before all writes" requirement, since the executed branch never reads after it writes — the replay branch (§4.4 step B) never writes at all.

### 4.4 Transaction shape / exact step order

This order is the single most load-bearing design decision in this document. **Checkpoint 4C.3A.1 hardening (retained): the exact-replay check runs immediately after reading the Expense, before any Trip lookup or authorization requirement whatsoever. Checkpoint 4C.3A.2 hardening (new): pre-authorization validation is narrowed to the ONE routing fact actually required to identify the governing Trip (`tripId`) — `status` itself is no longer inspected until AFTER authorization succeeds**, so an outsider's outcome cannot depend on, and can never reveal, whether the Expense is active, reversed, or even has a corrupted `status` value. It resolves §5 (permission), §6 (archive), §7 (removed members), §8 (idempotency), §15 (information leakage), and §16 (concurrency) **simultaneously**, the same way `recordTripExpense`'s own step ordering does:

```
A. Read the Expense (tx.get(expenseRef)).
   -> not exists: not-found.
   -> exists: capture expenseData exactly as stored. No other
      document is read yet.

B. Idempotent-replay-of-MY-OWN-prior-reversal check, FIRST - before
   ANY Trip lookup, before any authorization requirement of any kind,
   before even validating expenseData.status's own well-formedness:
     if expenseData.status === "reversed"
        && expenseData.reversedBy === authUid
        && reversalRequestsMatch(expenseData.reversalRequest, incoming):
       -> return { expenseId } immediately. NO Trip document is ever
          read for this outcome (§4.3). Historical reconciliation,
          not a fresh authorization decision - succeeds even if,
          after the original reversal already committed:
            - authUid was removed from the Trip
            - the Trip became archived
            - the parent Trip is unexpectedly missing
            - the parent Trip later became structurally malformed
          None of those facts are even OBSERVED on this path, let
          alone allowed to affect the outcome - the replay branch
          structurally cannot depend on current Trip state, because
          it never looks at the Trip at all. The replay does not
          rewrite anything - status/reversedAt/reversedBy/
          reversalRequest are read back exactly as already stored,
          never re-written (see §8.3).
     (If this simply does not match - status isn't "reversed",
     reversedBy differs, the request facts differ, or reversedBy/
     reversalRequest are themselves malformed and therefore trivially
     fail to equal/match anything - this comparison can only ever
     evaluate to false, never throw, so a malformed stored value here
     safely falls through to C exactly like a well-formed mismatch
     does. That distinction between "malformed" and "someone else's
     valid reversal" is made safely in G, AFTER authorization - see
     the reversal-metadata-consistency note below.)

C. Checkpoint 4C.3A.2: validate ONLY expenseData.tripId - the single
   routing fact actually required to identify which Trip governs
   authorization (§17's Firestore document-id safety check).
   expenseData.status is deliberately NOT inspected here - see the
   required security matrix below.
   -> tripId malformed: failed-precondition. (This remains the one
      place reversal cannot fully avoid resolving a structural
      question before authorization - there is no way to determine
      WHICH Trip's membership governs this request without first
      knowing tripId. A narrow, inherent, and now-minimized exception
      to "authorize before disclosing," restated from 4C.3A.1 and
      narrowed further here.)

D. Read the Trip (tx.get(tripRef), using the tripId validated in C) -
   the first and only point in this transaction a Trip document is
   ever read.
   -> not exists: failed-precondition (defensive only - Trips are
      never hard-deletable, so a dangling tripId should be
      structurally impossible; see the archive-delete-safety
      preflight).

E. Authorization (§5): authUid must be EITHER
     - the Trip's CURRENT ownerId, OR
     - expenseData.createdBy === authUid AND authUid is a CURRENT
       Trip member (memberIds or ownerId).
   -> not authorized: permission-denied. Reached WITHOUT ever having
      inspected expenseData.status at all - an unauthorized caller's
      outcome is identical regardless of whether the Expense is
      active, already reversed, or has a corrupted status value (see
      §15's required security matrix, restated and strengthened by
      this checkpoint).

F. (Nothing to check here for archive state - reversal is
   deliberately NOT gated on Trip archive status at all; see §6.)

G. NOW, for an authorized caller only: validate expenseData.status is
   a supported value ("active" or "reversed") - the FIRST point in
   this transaction status is ever inspected at all.
   -> status malformed (neither "active" nor "reversed"), OR
      status === "reversed" but reversedBy/reversalRequest are
      themselves malformed (missing, wrong type, or an unexpected
      shape - see the note below): failed-precondition. Safe to
      disclose now - the caller is already confirmed authorized.
   -> status === "reversed" (well-formed, and B already established
      this is NOT the caller's own prior reversal - i.e. reversed by
      someone/something else): failed-precondition ("This expense has
      already been reversed."). Also safe to disclose now.
   -> status === "active": proceed to H.

H. Compute the reversal write: status: "reversed", reversedAt:
   serverTimestamp(), reversedBy: authUid, reversalReason (if
   supplied), reversalRequest: { clientRequestId, reversalReason
   normalized - see §8 }.

I. tx.update(expenseRef, {...}) - a SINGLE-document write. No
   ExpenseSplit document is read or written at all (§12).

Return { expenseId: input.expenseId }.
```

**This mirrors, and structurally strengthens, `recordTripExpense`'s own parent-independent replay principle.** `recordTripExpense`'s own replay (its step B) already never lets the parent Trip's *current* state influence the replay decision, even though it happens to have already read the Trip document by that point (it reads both parent documents up front, unconditionally, since it always knows `tripId` before touching Firestore at all). `reverseTripExpense`'s replay goes one step further, structurally: because the Trip read is now *conditional* on the replay check's own outcome (§4.3), the replay branch cannot observe current Trip state even in principle — there is no Trip data in scope to accidentally consult. Same principle, applied as strictly as this callable's own input shape allows.

**Reversal-metadata consistency (Checkpoint 4C.3A.2), and why this is a purely forward-looking, purely defensive concern today:** step G's malformed-status handling additionally covers a `status === "reversed"` record whose own `reversedBy`/`reversalRequest` fields are themselves malformed — treated identically, `failed-precondition`, for an authorized caller only. Stated plainly, not overbuilt: **no Expense in production can actually be in this state**, because `reverseTripExpense` is the *sole* possible writer of `status: "reversed"` anywhere in this system, and it does not exist yet — this preflight precedes its own implementation checkpoint (§21). Every Expense that exists, or will exist before 4C.3B ships, has `status: "active"` by construction (`recordTripExpense` never writes any other value). This check is recorded as defensive robustness against a hypothetical future bug in `reverseTripExpense` itself, not a legacy-data-migration concern — no legacy-handling logic is built or needed for this, and none should be.

### 4.5 Error codes (summary table, in step order)

| Step | Condition | Code |
|---|---|---|
| A | `expenseId` doesn't exist | `not-found` |
| B | Exact replay of the caller's own prior reversal | *(success — no further step is reached)* |
| C | Expense's own `tripId` malformed (defensive; `status` is NOT checked here, see §15) | `failed-precondition` |
| D | Referenced Trip missing (defensive, should be impossible) | `failed-precondition` |
| E | Caller not the current owner, and not (current-member AND original `createdBy`) — reached without `status` ever being inspected | `permission-denied` |
| G | Expense's own `status`/reversal-metadata malformed (defensive, authorized caller only) | `failed-precondition` |
| G | Already reversed by a different reverser/request (authorized caller) | `failed-precondition` |
| *(input validation, before any read)* | Malformed input shape (`expenseId`/`clientRequestId` pattern, `reversalReason` too long, unsupported field) | `invalid-argument` |

### 4.6 Persisted fields written

Only these four, on the existing Expense document, via `tx.update()`:
```
status: "reversed"
reversedAt: FieldValue.serverTimestamp()
reversedBy: authUid
reversalReason: <trimmed string, if supplied>
reversalRequest: { clientRequestId, reversalReason: <normalized>, ... }  — see §8
```
No other field on the Expense document is touched. No `ExpenseSplit` document is touched.

---

## 5. Who may reverse? (recommendation, with tradeoffs)

**Recommendation: Model C, narrowed — the Trip's CURRENT owner, OR the Expense's original `createdBy` provided they are STILL a current Trip member.** `payerUid` is explicitly **excluded** as an independent reversal authority, narrowing the frozen 4A/4A.1 audit's own earlier, unreviewed note (`createdBy`, `payerUid`, or the Trip owner) exactly as the 4C.1A persistence preflight flagged this needed "its own dedicated review when 4C.3 is actually scoped" (§16 of that document) — this is that review.

**Why each candidate was accepted/rejected:**

| Candidate | Verdict | Reasoning |
|---|---|---|
| **A. Only original `createdBy`** | Rejected alone | Fails hard the moment the creator leaves the Trip — no one could ever correct their mistake again. A real usability dead end for exactly the group-trip scenario this feature exists to serve. |
| **B. Trip owner only** | Rejected alone | Matches this app's existing owner-moderation pattern (archive, date edits, membership are all owner-only elsewhere in `firestore.rules`/`recordTripExpense`'s own precedent), but forces every typo fix through one person, who may not know the details of an Expense they didn't create. Too centralized for the common case. |
| **C. `createdBy` OR owner (as originally drafted)** | Accepted, narrowed | Combines self-service correction (fix your own mistake without bothering anyone) with a moderation fallback that survives the creator leaving. The narrowing: `createdBy` alone is not enough — it must be **`createdBy` AND still a current Trip member**, otherwise a long-departed former member retains indefinite reversal authority over a Trip they are no longer part of at all, which is a real authority-scope violation, not merely a UX inconvenience. |
| **D. Any current Trip member** | Rejected | Genuinely too broad for a financial-correction action. Even though the underlying model is fully append-only/auditable (nothing is ever destroyed, §1/§2), the risk this checkpoint must weigh is *disruption/trust*, not data loss — an unrelated member reversing someone else's correctly-recorded Expense, out of malice or simple confusion, is a real, avoidable harm this narrower model closes off entirely. |
| **`payerUid` as independent authority** | Explicitly rejected | The frozen creation model deliberately allows `createdBy != payerUid` (any member may log an expense someone else paid, §2 of the persistence preflight) — but that is a statement about who may *describe* a real-world event, not who is *responsible for the record's accuracy*. Granting the payer independent reversal authority would let someone who had no hand in creating/recording an Expense unilaterally undo a record they were never responsible for maintaining, purely because their name appears in one field. `payerUid` grants no reversal authority under this model. |

**Structural guarantee this recommendation relies on, verified:** `firestore.rules`' own Trip `allow update` rule requires `resource.data.ownerId in request.resource.data.memberIds` on every write — meaning it is **structurally impossible**, through any Rules-governed path, for a Trip's owner to ever be absent from its own `memberIds`. The owner-fallback in this model is therefore never itself at risk of the same "removed from the Trip" problem `createdBy` has (§7).

---

## 6. Archived-Trip behavior

**Recommendation: reversing an existing Expense remains fully allowed on an archived Trip. Creating the corrected replacement Expense remains blocked on an archived Trip (unchanged, frozen `recordTripExpense` behavior — not reopened here).**

This is the "new economic activity" vs. "correcting historical activity" distinction the checkpoint asks for, and it is decided the same way this exact distinction was already decided twice before in this milestone:
- The original persistence preflight's own §12: `recordTripSettlement` (a different future callable) is recommended to **never** gate on archive state, because "a settlement only records that an external payment already happened... blocking it after archive would be actively harmful, trapping real obligations between real people with no path to resolve them, **often exactly when people go to settle up** (right after a trip wraps up)." Reversal is an even purer case of the same principle — it creates **zero** new economic activity, only corrects the record of something that already happened, and mistakes are realistically discovered at exactly the moment people reconcile a trip's expenses, which is often right after — i.e. right after — archiving.
- The 4B.5C wind-down model itself: Shared Stash contribution is closed on archive, withdrawal stays open, because withdrawal *resolves* existing state rather than creating new obligations. Reversal is the Expense-side analogue of "withdrawal" in that framing, not of "contribution."

**Honest, stated limitation (not silently resolved):** because the corrected *replacement* Expense is created through ordinary, unchanged `recordTripExpense` (§10's Model A), and that callable's archived-Trip block is frozen, unmodified, and correctly still applies — a member can reverse a wrong Expense on an archived Trip, but **cannot** then record its corrected replacement on that same archived Trip. This is a real, accepted tension: the "undo" half of correction works after archive, the "redo" half does not. Reopening `recordTripExpense`'s archive gate to fix this asymmetry is explicitly **not recommended** here — that gate exists for a proven, deliberate reason (closing new spending/obligation-creating activity) that has nothing to do with reversal's own reasoning, and relaxing it would be scope creep without "a concrete blocker" (the checkpoint's own instruction). This is recorded as a known, accepted product limitation for 4D's UI copy to be honest about, not a defect to silently paper over.

---

## 7. Removed-member behavior

Explicitly analyzed per the checkpoint's own four cases:

| Case | Effect on reversal authority |
|---|---|
| **Original `createdBy` was removed from the Trip** | Loses independent reversal authority entirely (§5's narrowing) — they can no longer reverse their own past Expense unless they are *also* the Trip's owner. The Trip owner remains able to reverse it. This is a deliberate, accepted consequence of "authority follows current membership," matching the identical principle already governing every other authorization check in `recordTripExpense`/`firestore.rules` in this codebase — no exception is carved out for reversal. |
| **Payer was removed** | No effect at all — payer was never an independent reversal authority under this model (§5), so their membership status is irrelevant to reversal. |
| **Participant was removed** | No effect at all — same reasoning; participants were never reversal authorities. |
| **"Trip owner changed"** | Not a concept the current schema supports. `Trip.ownerId` has no reassignment path anywhere in this codebase (confirmed: no service function, no Rules branch, touches `ownerId` after creation) — this case does not arise today and is out of scope until a future checkpoint introduces ownership transfer, if ever. |

**Explicit distinction from `recordTripExpense`'s own idempotent replay (per the checkpoint's own instruction, not confused here):** a former creator/reverser's exact-replay of their **own already-committed reversal request** still succeeds even after they lose Trip membership (§4.4 step B) — resolved before any Trip is even read, let alone any membership re-evaluated — that is historical reconciliation of a request that already happened, answering "did MY request already commit," never a fresh authorization decision. It is categorically different from a former member attempting a **new** reversal (a fresh authorization decision, correctly denied per the table above, at step E). The same distinction `recordTripExpense` already draws between §5.1's replay and its own membership check applies here, now structurally reinforced rather than merely reordered (§4.4).

---

## 8. Idempotent reversal — design

**Recommendation: Option B — reversal metadata stored directly on the Expense document itself (the already-existing `status`/`reversedAt`/`reversedBy`/`reversalReason` fields, plus one new `reversalRequest` snapshot field), compared using the exact same explicit field-by-field snapshot-comparison idiom `creationRequest` already uses. No new collection.**

### 8.1 Why Option B over A/C/D

- **Option A (a separate, deterministic reversal document)** — rejected. A reversal is 1:1 with its Expense by construction (at most one, ever — no un-reverse, no re-reverse, §8 requirement). A dedicated document would track nothing a field on the Expense itself can't, while adding a second collection, a second Rules match block, and a second thing to keep consistent for no real benefit.
- **Option C (a separate `tripExpenseReversals` collection, keyed by the reversal's own `clientRequestId`)** — rejected, and rejected for a **specific, precedented reason**, not just "more collections is worse": it would create a second, independently-settable source of truth for the exact same fact ("is this Expense reversed") — the `Expense.status` field AND the *existence* of a `tripExpenseReversals` document. **This exact anti-pattern has already been explicitly rejected twice in this codebase's own history**: the Trip archive lifecycle's own design (`docs/audits/TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_2026-09-13.md`) deliberately has no separate `status: "active" | "archived"` field alongside `archivedAt`, for the stated reason that "a second, independently-settable source of truth for the exact same fact... would... could disagree... from a bug or partial write." Applying that same established principle here is not a new argument invented for this document — it is directly reusing this codebase's own settled reasoning.
- **Option D (another approach)** — no alternative considered offered a real advantage; not pursued further.

### 8.2 Exact `reversalRequest` snapshot shape

Mirrors `creationRequest`'s own normalization discipline exactly (server-normalized, never a raw echo of client input):

```ts
interface NormalizedReversalRequest {
  clientRequestId: string;
  reversalReason: string | null;  // trimmed, or null when omitted - never undefined, matching creationRequest.category's own convention
}
```

`reversalRequestsMatch(stored, incoming)` — an explicit field-by-field comparison function, mirroring `creationRequestsMatch`'s own style precisely (never a blind `JSON.stringify` equality, per the established convention).

**Checkpoint 4C.3A.1: exact `reversalReason` normalization, frozen to remove implementation ambiguity** — restated in full at §14, summarized here since it directly determines what `reversalRequestsMatch` actually compares:
- Trim the raw input.
- Omitted, or whitespace-only after trimming, both normalize to `null` — **the same** normalized value either way, on the `NormalizedReversalRequest` snapshot (`reversalRequest.reversalReason`, always present as `string | null`, exactly like `creationRequest.category` already works).
- The top-level `Expense.reversalReason` field itself (as opposed to the snapshot) is **not** persisted at all when the normalized value is `null` — mirroring exactly how `Expense.category` is only conditionally written today (`if (input.category !== undefined) expenseData.category = input.category;`).
- **Consequence, stated explicitly**: an omitted `reversalReason` and a whitespace-only `"   "` `reversalReason` are idempotently equivalent for replay purposes — a caller who retries with either shape against the same `clientRequestId` gets the same successful reconciliation at step B, never a spurious fall-through to step G's "already reversed by a different request" rejection merely because the reason's textual shape happened to differ.

### 8.3 Requirements, confirmed satisfied

- **Exact retry succeeds**: §4.4 step B — resolved before any Trip is even read.
- **Conflicting retry fails deterministically**: §4.4 step B falls through to C→D→E→G, which resolves to `failed-precondition` (malformed `tripId`/missing Trip, both defensive), `permission-denied` (unauthorized caller, `status` never inspected), or `failed-precondition` (authorized caller, malformed status or a different reversal already committed) — never ambiguous, never a partial/mixed state.
- **Concurrent reversal attempts never produce ambiguous state**: single-document Firestore transaction — Firestore's own optimistic-concurrency retry (identical mechanism already proven for `recordTripExpense`'s own same-id concurrency, 4C.2C §3) guarantees exactly one commit wins; the loser's transaction retries, re-reads the now-reversed Expense, and resolves via step B (if it's their own replay) or falls through to G (if someone else's).
- **`active -> reversed` only once**: the Expense document has no un-reverse path anywhere (no Rules branch, no callable) — `reversalRequest`/`reversedBy`/`reversedAt` are, once set, never overwritten by anything (step B's replay branch never re-writes; step G always rejects before reaching the write step H).
- **No client direct update**: unaffected, unchanged — `allow update: if false` already covers this at the Rules layer regardless of what the trusted callable does (§13).

---

## 9. Correction linking

**Checkpoint 4C.3A.1 correction: the original 4C.3A draft's one-way-only link (`replacesExpenseId` on the new Expense, nothing on the old one) is insufficient — it does not enforce that one reversed Expense has at most one canonical replacement.** Two different new Expenses could concurrently each set their own `replacesExpenseId` to the *same* old Expense, with no mechanism to prevent it, making correction lineage genuinely ambiguous (which one is "the" replacement?). **Revised recommendation: a TWO-WAY, one-to-one correction link, both fields written atomically in the SAME `recordTripExpense` transaction that creates the replacement — never by the reversal callable, and never by two independent writers.**

```ts
// On the OLD (now-reversed) Expense:
replacedByExpenseId?: string;   // set exactly once, atomically, by the
                                 // recordTripExpense transaction that
                                 // successfully creates its replacement

// On the NEW (replacement) Expense:
replacesExpenseId?: string;     // set once, at creation, by the client's
                                 // own recordTripExpense call
```

### 9.1 Why a two-way link, and why this is NOT the rejected anti-pattern

A two-way link sounds, at first glance, exactly like the "two independently-settable sources of truth for the same fact" anti-pattern §8.1 explicitly rejects for reversal's own idempotency design (and that the Trip archive lifecycle rejected before that). **It is not, for a specific, load-bearing reason: both fields are written by the same single trusted writer, in the same single atomic transaction, and neither field is ever independently settable by anything else.**

- **Clients cannot write either field.** Both are trusted, server-computed metadata — exactly like `status`/`reversedAt`/`reversedBy` already are — never accepted as client input on either the old or the new document (§18's "no client-suppliable audit field" principle, extended to these two).
- **The same `recordTripExpense` transaction writes both ends.** There is no window where `replacesExpenseId` exists on the new Expense but `replacedByExpenseId` does not yet exist on the old one, or vice versa — Firestore transactions are all-or-nothing, so both fields commit together or neither does.
- **There is no partial-success state.** Unlike the reversal-then-separate-creation split (§10), which deliberately *accepts* a "reversed, not yet replaced" truthful intermediate state, the link fields themselves have no analogous intermediate state — the replacement Expense either fully exists (with `replacesExpenseId` set) and the old one is fully marked replaced (with `replacedByExpenseId` set), or the whole creation attempt failed and neither field was ever written.
- **Concurrent replacement attempts contend on the SAME old-Expense document**, and Firestore's own document-level conflict detection — the identical mechanism already proven for every other same-document race in this milestone (4C.2C §3/§4, §16 above) — makes "at most one direct replacement" a structural guarantee, not merely a documented intention. See §9.6.

This is the same reasoning §8.1 already used, correctly distinguishing *why* a design is or isn't the rejected pattern: the anti-pattern is specifically "two things that could independently disagree." A single trusted transaction writing two fields together is not two things — it is one atomic fact expressed in two places for query convenience (forward-lookup from the new Expense, and reverse-lookup from the old one without a query), the same way `Bucket.balance`/`Bucket.ledgerBalanceMinor` are two fields the *same* trusted transaction keeps in lockstep elsewhere in this codebase.

### 9.2 One-to-one lineage, frozen explicitly

**One reversed Expense → at most one direct replacement, enforced by construction (§9.6), not merely by convention.** A replacement Expense may itself later be reversed and replaced, producing a **chain** (`A -> B -> C`), never multiple sibling replacements of the same original (`A -> B` and `A -> C` simultaneously is structurally impossible once `A.replacedByExpenseId` is set).

### 9.3 Correction target is part of creation identity

`replacesExpenseId` is not a side detail bolted onto validation after the fact — it is one of the logical facts of the creation request itself, and must be part of the normalized `creationRequest` snapshot `recordTripExpense`'s own existing, unmodified idempotency comparison already uses (the original persistence preflight's §5.2, unchanged in mechanism, only extended in content):

```ts
interface NormalizedCreationRequest {
  // ...every existing field, unchanged...
  replacesExpenseId: string | null;  // null for ordinary creation - present in the snapshot either way, never omitted
}
```

- Ordinary Expense creation (no correction target supplied) normalizes to `replacesExpenseId: null` in the snapshot — present, not omitted, exactly matching `category`'s own established convention (§8.2/§14 of this document).
- Correction creation normalizes it to the validated old Expense id.
- It is compared by the existing snapshot-comparison function like every other field in `creationRequest` — **no ad-hoc, separately-implemented check for this one field.**
- **Consequence, stated exactly as required:** the same `clientRequestId`, the same ordinary financial facts, but a *different* `replacesExpenseId`, is **not** an exact replay. It resolves through `recordTripExpense`'s own existing, generic conflicting-request path — `already-exists` — the identical outcome any other single-field mismatch (a different `amountMinor`, a different `description`) already produces today. No new error code, no new check, no special-casing for this one field.
- **`replacedByExpenseId` does NOT belong in the OLD Expense's own `creationRequest`.** That snapshot is immutable, frozen at the old Expense's *own* creation time (§2) — `replacedByExpenseId` is trusted post-creation correction metadata that did not exist, and could not have existed, when the old Expense was originally created; it is written later, by a *different* transaction (the replacement's own), to a field entirely outside `creationRequest`'s scope. This is the same reasoning already applied to `status`/`reversedAt`/`reversedBy` (§9.7) — none of them are, or ever should be, part of any Expense's own `creationRequest`.

### 9.4 Correction-link authorization — claiming the canonical replacement slot

Ordinary `recordTripExpense` authorization is **unchanged**: any current Trip member may record an Expense, including one paid by another member (the frozen creation model, preflight §2). Supplying `replacesExpenseId`, however, does more than create an ordinary Expense — it claims the **one** canonical correction slot of an already-reversed historical Expense (§9.2), and an unrelated current member must not be able to hijack that slot merely by being a member of the same Trip.

**Recommendation: correction-link authority mirrors the exact same authority family already frozen for reversal itself (§5), extended by one branch.** A caller may set `replacesExpenseId: <oldExpenseId>` only when they satisfy ONE of:
- the Trip's **current owner**, OR
- `oldExpense.createdBy === authUid` AND authUid is still a **current Trip member**, OR
- `oldExpense.reversedBy === authUid` AND authUid is still a **current Trip member**.

The third branch is new relative to §5's own reversal-authority list, for a concrete reason: it covers the trusted actor who actually *performed* the reversal, when that actor differs from `createdBy` (the §5 owner-fallback case — the Trip owner reversed someone else's mistake). That reverser has direct, demonstrated knowledge that this specific record needed correcting and is a reasonable party to also supply its replacement, even without having created the original. As with reversal itself: `payerUid` does **not** independently grant correction-link authority, and mere participant membership on either Expense does **not** independently grant it either — the same reasoning §5 already gives for excluding `payerUid` from reversal authority applies identically here (describing an event is not the same as being responsible for correcting its record).

**Any other current Trip member may still create an ordinary Expense on this Trip** — they simply cannot set `replacesExpenseId` to *this specific* old Expense. Rejected with `permission-denied` — a caller who is fully authorized to create Expenses on this Trip in general, but not authorized to claim this particular correction slot, is genuinely an authorization failure on the narrower claim, not a validation failure on the broader creation.

**Information-leak discipline, applied here the same way §15 applies it to reversal:** a replacement-creation attempt must not reveal the old Expense's state — active or reversed, already replaced or not, who reversed it — until correction-link authorization has succeeded. This governs the exact ordering in §9.5: the old Expense is read, and its `createdBy`/`reversedBy` fields are consulted **only** to decide authorization; whether it's active/reversed and whether `replacedByExpenseId` is already set is checked, and can only be disclosed, strictly after that authorization succeeds — the same "read for a decision, disclose only after authorization" discipline §4.4 already applies to reversal's own `status` check (Checkpoint 4C.3A.2).

The normal `recordTripExpense` Trip-membership/archive/payer/participant checks remain fully intact and unaffected — correction-link authorization is an **additional** check, layered on top of, never a replacement for, the existing creation authorization.

### 9.5 Exact transaction shape (extension to `recordTripExpense`, not a new callable)

`recordTripExpense`'s existing structure (Phase 1 input validation; Phase 2 read-replay-authorize-archive-payer-participant-split-persist, per the original persistence preflight and 4C.2A→4C.2C) is preserved in full. When `replacesExpenseId` is supplied, exactly one new read/validate/write group is inserted at one precise point, and the existing structure is otherwise untouched:

```
1. (Phase 1, existing, extended) Validate raw input and normalize
   creationRequest, NOW INCLUDING replacesExpenseId (null when
   omitted) - §9.3.

2. (Existing, unchanged) Read the prospective new Expense doc (by
   clientRequestId) and the Trip, exactly as recordTripExpense
   already does.

3. (Existing, unchanged) Exact creator-bound creation-replay check,
   FIRST: if the new Expense already exists and the stored
   creationRequest (now including replacesExpenseId) matches this
   caller's normalized request exactly, return success immediately.
   Do NOT re-read or re-validate the old correction target on this
   path - the replacement's own replay is exactly as self-contained
   as an ordinary creation's replay already is (§9.6 row A). This
   preserves recordTripExpense's existing parent-independent
   exact-replay guarantee unmodified - only WHAT is compared changed
   (§9.3), never replay's own priority in the ordering.

4. (Existing, unchanged) For a genuinely NEW Expense: perform the
   existing Trip-membership / archive authorization (§6).

5. (NEW) If replacesExpenseId is present: read the old Expense
   (tx.get(oldExpenseRef)) - before any write. Then, in this exact
   order:
     a. old Expense exists - else failed-precondition (unavoidable
        minimal disclosure - the same "must read to know anything"
        constraint reversal itself has, §4.4 step A/C).
     b. old Expense belongs to the SAME Trip as this request - else
        failed-precondition. A structural/routing check, resolved
        before correction-link authority is evaluated, since
        authority over a DIFFERENT Trip's record is not a question
        this Trip's membership can even answer.
     c. correction-link authorization (§9.4): authUid is the Trip
        owner, OR oldExpense.createdBy === authUid (current member),
        OR oldExpense.reversedBy === authUid (current member) - else
        permission-denied. Reached without yet disclosing whether the
        old Expense is active/reversed or already replaced.
     d. NOW, for an authorized caller only: oldExpense.status ===
        "reversed" - else failed-precondition ("cannot replace an
        active expense"). Safe to disclose now.
     e. oldExpense.replacedByExpenseId is not already set - else
        failed-precondition ("this expense has already been
        replaced"). Safe to disclose now, same reasoning.

6. (Existing, unchanged) Run the normal payer/participant/split
   validation - this addition never touches it.

7. (Existing + NEW) Atomically:
     - create the new Expense document (now additionally carrying
       replacesExpenseId), and its ExpenseSplit documents, exactly
       as recordTripExpense already does;
     - tx.update(oldExpenseRef, { replacedByExpenseId: newExpenseId })
       - the one new write against the old Expense document, in the
         same transaction as everything else.

Return { expenseId: newExpenseId } - the existing result shape,
unchanged.
```

Archived-Trip behavior is **unchanged, not reopened**: step 4's existing archive gate is evaluated before step 5 is ever reached, so a replacement cannot be created on an archived Trip, correction link or not — exactly as §6/§9.2 already established.

**All reads before all writes, preserved.** Step 5's old-Expense read is conditional (only when `replacesExpenseId` is supplied, and only on the non-replay path) but still occurs before step 7's writes in every executed branch — the identical "conditional reads are fine as long as the executed branch never reads after it writes" reasoning already established for `reverseTripExpense`'s own conditional Trip read (§4.3). If actual Firestore transaction mechanics, at implementation time, end up reading the old Expense at a physically different point than this conceptual ordering implies (e.g., batched with other reads for round-trip efficiency), the *decision/disclosure* ordering in application logic — steps 5a through 5e, strictly in that order — must be preserved regardless: **reading data is not equivalent to disclosing it.** Data may be fetched early; the authorization/state decisions built on it must not be evaluated or exposed early.

**Code-family choice, stated explicitly, unchanged from the 4C.3A.1 draft**: every one of 5a/5b/5d/5e resolves to `failed-precondition`, deliberately uniform — mirroring how `recordTripExpense` already treats every other "the referenced entity doesn't satisfy a required condition" case (a non-member `payerUid`, a non-member participant) as `failed-precondition` regardless of the *specific* reason, rather than inventing a different code per condition. Only 5c (correction-link authorization itself) is `permission-denied`, matching the code-family distinction §4.4/§5 already draw between "the caller lacks authorization" and "the referenced resource state doesn't satisfy a required condition." `replacesExpenseId`'s own shape (non-empty, Firestore-document-id-safe) is validated in Phase 1 using the exact same `isValidFirestoreDocumentId` helper already hardened for `tripId`/`expenseId` (4C.2C §8, this preflight §17) — a malformed *shape* is `invalid-argument`, same as every other Phase 1 check; only a well-formed-but-semantically-invalid reference reaches steps 5a/5b/5d/5e.

### 9.6 Correction idempotency / concurrency

| Scenario | Behavior |
|---|---|
| **A. Exact replay of the already-created replacement Expense** (same creator, same `clientRequestId`, same normalized facts — `replacesExpenseId` is now one more field compared as part of the `creationRequest` snapshot, §9.3) | Succeeds through `recordTripExpense`'s existing creator-bound idempotency (preflight §5.1) — the replay short-circuits **before** ever reaching step 5's read/validate/write group (§9.5), exactly the same way an ordinary Expense-creation replay already skips re-computing/re-writing Splits. The old Expense's `replacedByExpenseId` is never re-read or re-written on this path. |
| **B. Two concurrent DIFFERENT replacement Expenses targeting the same reversed Expense** | Exactly one commits. Both transactions read `oldExpenseRef` (initially, neither sees `replacedByExpenseId` set) and both attempt to write it — a direct write conflict on the same document. Firestore's optimistic-concurrency mechanism commits whichever transaction reaches commit first; the other is aborted and automatically retried. |
| **C. The retried loser, re-reading `oldExpenseRef`, now sees `replacedByExpenseId` already set (to the winner's new Expense id, not its own)** | The validation re-evaluates against the fresh read and rejects at step 5e — `failed-precondition` ("this Expense has already been replaced"). This is deterministic, not a race the caller can "win" by retrying — the *document* already reflects the winner permanently. |
| **D. A replacement attempt whose referenced old Expense belongs to a different Trip** | Rejected at step 5b, `failed-precondition`. |
| **E. Replacement of a still-active (not yet reversed) Expense** | Rejected at step 5d, `failed-precondition` — a client can never falsely claim to "replace" a record that was never actually reversed. |
| **F. Replacement referencing a nonexistent old Expense** | Rejected at step 5a, `failed-precondition` (kept in the same code family as 5b/5d/5e for consistency, rather than `not-found` — §9.5's code-family note). |
| **G. A current Trip member with no correction-link standing (not owner, not `createdBy`, not `reversedBy`) attempts a replacement** | Rejected at step 5c, `permission-denied` — before old-Expense state (active/reversed/already-replaced) is ever disclosed (§9.4). They may still create an ordinary Expense with no `replacesExpenseId`. |
| **H. The old Expense's payer, or a mere participant on either Expense, with no other qualifying role** | Same as row G — `permission-denied` at 5c. Neither `payerUid` nor participant membership independently grants correction-link authority (§9.4). |

**A sequential (non-concurrent) second replacement attempt** after `replacedByExpenseId` is already durably set behaves identically to row C above — the validation simply fails on its very first read, no retry/contention needed, since nothing was ever racing.

### 9.7 Schema classification — correction/audit metadata vs. original financial facts

Stated explicitly, to remove any implementation ambiguity: `replacesExpenseId` and `replacedByExpenseId` are **correction/audit metadata**, exactly the same category as `status`/`reversedAt`/`reversedBy`/`reversalReason` — never original financial facts. Setting `replacedByExpenseId` on an already-reversed Expense does **not** rewrite, and must never be implemented in any way that could rewrite, any of:

```
amountMinor
payerUid
splitStrategy
participants (i.e. the ExpenseSplit documents)
createdBy
createdAt
occurredAt
currency
description
category
paymentSource
creationRequest
```

All of those remain immutable forever, exactly as §2 already froze. **The complete, closed set of trusted post-creation metadata transitions, after this preflight, is:**

1. `active -> reversed`: writes `status`, `reversedAt`, `reversedBy`, `reversalReason`, `reversalRequest` — performed only by `reverseTripExpense` (§4).
2. **On successful replacement creation only**: writes `replacedByExpenseId` on the old Expense — performed only by `recordTripExpense`, atomically alongside creating the new Expense that carries `replacesExpenseId` (§9.5).

No other post-creation write to any Expense document exists or is proposed. No client direct update is ever allowed, for any of these transitions, under any circumstance (§13, unchanged).

### 9.8 Scope decision

Both the correction-link fields and their validation are a schema/contract change to the **already-shipped, already-hardened** `recordTripExpense` (4C.2A→4C.2C) — not implemented in this preflight, and not bundled silently into the reversal callable's own work. Recommended as its **own small, narrowly-scoped implementation checkpoint** (§21/4C.3D below), reviewed independently, exactly the same discipline already applied to every other change to that callable so far.

---

## 10. One callable or two-step correction?

**Recommendation: Model A for 4C.3 — `reverseTripExpense` only. The corrected replacement Expense is created by a separate, ordinary, unmodified client call to `recordTripExpense`** (optionally carrying `replacesExpenseId`, §9). Model C (support both reverse-only *and* an atomic `correctTripExpense`) is named as a legitimate **future** enhancement, not built now, revisited only if real usage data shows the two-step UX is a genuine problem.

**Why, weighing the checkpoint's own question directly:**

- **"What happens when reversal succeeds but corrected creation fails?"** — Under Model A, this is not a corruption state: the reversal is a fully complete, valid, independently-correct fact the instant it commits (the old Expense is genuinely reversed, contributing zero debt, exactly as intended) whether or not a replacement is ever created. A failed/abandoned second step leaves the Trip in a *truthful* state — "this expense was reversed; no replacement has been recorded (yet, or ever)" — never an inconsistent one. The client can retry `recordTripExpense` independently, as many times as needed, using its own already-proven idempotency, with zero coupling to the reversal that already succeeded.
- **An atomic `correctTripExpense` (Model B) would duplicate significant `recordTripExpense` logic** — membership/payer/participant validation, split computation, `creationRequest` normalization, the `MAX_EXPENSE_PARTICIPANTS` bound, `tripId` document-id safety — "unless carefully structured" (the checkpoint's own caveat). Structuring it to avoid duplication (e.g., factoring `recordTripExpense`'s core into a shared, reusable transaction step) is a real refactor of an already-hardened, already-shipped, security-critical function — exactly the kind of change this preflight's own instructions repeatedly warn against making without a concrete forcing reason. No such reason exists yet.
- **This matches SquadStash's own established design philosophy, applied consistently, not invented for this document.** The original architecture audit's §6 made this exact call once already for a different pairing (an Expense and a Shared-Stash ledger withdrawal): "two explicit operations, linked by reference... an atomic combined callable would be the first time this codebase's Trip-money layer silently performs a financial side effect a human didn't independently, explicitly trigger." Reversal-then-recreate is the same shape of decision, and the same answer applies for the same reason.
- **Archived-Trip behavior (§6) is also cleaner under Model A**: the two steps can have genuinely different outcomes (reversal succeeds, replacement creation correctly fails) without either callable needing to reason about the other's own gating logic.

---

## 11. Status/balance semantics

**Confirmed via direct code inspection (§1): no balance-domain change is required for 4C.3.** `computeTripBalances` (`src/domain/tripSettlement.ts`) already validates every Expense's shape/split-total unconditionally, and already skips only the debt-contribution step for `status === "reversed"`. This was built and tested in Checkpoint 4B/4B.1, well before any reversal *write* path existed, on the correct anticipation that it would eventually be needed. Nothing in `src/domain/tripSettlement.ts` or its test suite needs to change for 4C.3.

---

## 12. Split-document semantics

Confirmed, all four properties hold under the recommended design:
- Reversal **does not delete** Splits — `reverseTripExpense`'s transaction (§4.3/§4.4) never reads or writes `tripExpenseSplits` at all.
- Reversal **does not zero** Splits — same reason; their `amountMinor`/`percentageBasisPoints` values are untouched forever.
- Reversal **does not rewrite** participant amounts — same reason.
- Balance derivation ignores a reversed Expense economically based on the **parent Expense's own `status`** (already true, §11) — Splits themselves carry no status field and need none; they are pure historical fact, interpreted through their parent.

No flag needed — existing behavior already matches every one of these requirements exactly.

---

## 13. Firestore Rules implications

**Confirmed: no Rules change is needed.** `reverseTripExpense` performs its single `tx.update()` via the Admin SDK, which bypasses Firestore Rules entirely — the exact same mechanism `recordTripExpense`'s own writes already rely on, and the exact same mechanism every other trusted callable in this codebase (`createBucket`, `recordSavingsTransaction`) already relies on. The existing `allow update: if false` for `tripExpenses` (and `tripExpenseSplits`, untouched either way) remains completely correct and requires no field-level carve-out for `status`/`reversedAt`/`reversedBy` — a client still can never write those fields directly, by any role, which is exactly the intended posture. Client reads are unaffected: `canAccessTripById` never inspected `status` before and has no reason to start now — a reversed Expense is exactly as readable, to exactly the same current-Trip-access audience, as an active one, matching `firestore.rules`' own existing, unmodified read rule.

**Do not weaken `allow update` to permit a client-driven status transition under any circumstance** — restated per the checkpoint's own explicit instruction, and consistent with every write-lockdown decision made in this codebase so far.

---

## 14. Reversal reason

**Recommendation: optional, free-text, trimmed, capped at the same `MAX_DESCRIPTION_LENGTH` (500) precedent `recordTripExpense.ts` already established** for the analogous "free text explaining what this record is for" role (itself reused from `recordSavingsTransaction`'s own `MAX_NOTE_LENGTH`). No predefined reason taxonomy for MVP — matching the identical, already-approved reasoning for `category` on Expense creation ("ship free-form for MVP... a fixed allowlist is real, useful future work... but not required to ship a correct, safe... core"). Required-vs-optional: **optional** — mandating a reason risks frustrating an obvious, fast typo correction; if product data later shows reasons are needed for moderation/audit clarity, that is a small, well-scoped future addition (a single required-field flip plus a Rules-irrelevant validation tweak), not a reason to over-build now.

**Checkpoint 4C.3A.1: exact normalization, frozen to remove implementation ambiguity (echoed at §8.2, authoritative here):**
- Trim the raw input string.
- Omitted **or** whitespace-only-after-trimming both normalize to `null` — never treated as two different facts.
- Do **not** persist the top-level `Expense.reversalReason` field at all when the normalized value is `null` — mirrors the existing, already-shipped `Expense.category` convention exactly (`if (input.category !== undefined) expenseData.category = input.category;`), not a new pattern invented for reversal.
- `reversalRequest.reversalReason` (the idempotency-comparison snapshot, §8.2), by contrast, **always** stores `string | null` explicitly — present either way, never omitted from the snapshot itself, again mirroring `creationRequest.category`'s own already-established convention precisely.
- The 500-character maximum applies to the **trimmed** value.

**Consequence, stated explicitly**: an omitted `reversalReason` and a whitespace-only `"   "` `reversalReason` are idempotently equivalent — retrying a reversal request with either shape, against the same `clientRequestId`, reconciles successfully rather than being treated as two different requests.

---

## 15. Information-leakage strategy

The ordering in §4.4 is the actual mechanism; this section states the property it guarantees, and why reversal's shape genuinely differs from `recordTripExpense`'s.

**The genuine asymmetry, named plainly:** `recordTripExpense` always knows `tripId` from trusted client input *before* touching Firestore, so its Phase 1 (input validation) can reject cheaply, with zero disclosure risk, before any document is ever read. `reverseTripExpense` cannot do this — the Trip a given `expenseId` belongs to is a fact that only exists inside Firestore, discoverable only by reading the Expense first. This preflight does not paper over that difference; it designs around it explicitly.

**What is and isn't disclosed, and to whom:**
- `not-found` for a nonexistent `expenseId` is unavoidable and accepted, for the same reason `recordTripExpense`'s own `not-found` for a nonexistent `tripId` was already accepted: `expenseId` values are opaque, client-generated (UUID-shaped) `clientRequestId`s from the original creation call, not practically guessable/enumerable. This is bounded, not unbounded, disclosure.
- Once the Expense is found, **its `status` — and therefore whether it is reversed, by whom, its reason, or even whether that state is well-formed at all — is never disclosed to a caller who is not authorized** — because the idempotent-replay check (step B) only ever matches for the caller's **own** prior reversal (a self-referential check that reveals nothing about anyone else's, and that runs before the Trip is even read), and `status` itself is not inspected again by any other step until G, which is placed strictly *after* the real authorization check (step E). This is the checkpoint 4C.3A.2 strengthening: it is not merely that "already reversed" is disclosed late — `status` is not read for any decision-making purpose at all until an authorized caller reaches G.
- **Required security matrix, verified against the actual step order:**

  | Expense state | Caller | Outcome |
  |---|---|---|
  | Healthy, `status: "active"` | Outsider | `permission-denied` (E) |
  | Healthy, `status: "reversed"` | Outsider | `permission-denied` (E) — identical to the row above |
  | Malformed/corrupted `status` | Outsider | `permission-denied` (E) — identical again; E never inspects `status` |
  | Any of the above | Authorized owner/creator | The state-appropriate result, first disclosed at G: proceed (active), `failed-precondition` (already reversed), or `failed-precondition` (malformed) |

  An outsider, or an authorized-but-unrelated member, who submits a reversal attempt against any Expense — active, reversed, malformed, archived Trip or not — receives the **identical** `permission-denied` if they are not the owner or the current-member-original-creator. No other fact, including whether `status` itself is even well-formed, ever reaches them.
- Archive state is not merely reordered to avoid disclosure (as it was for `recordTripExpense`) — it **never appears in any reversal code path at all** (§6), so there is nothing to leak on that axis; a simplification over creation's own ordering, not an oversight.

---

## 16. Concurrency threat model

| Scenario | Outcome / invariant |
|---|---|
| Two identical reversal retries concurrently (same `expenseId`, same `clientRequestId`, same `authUid`) | Exactly one commits; Firestore auto-retries the loser, which re-reads the now-reversed Expense and resolves via step B (idempotent match, before any Trip read) — both callers observe success. |
| Two different members attempt reversal concurrently | Exactly one commits (whichever wins Firestore's own document-level contention); the loser retries, re-reads, and resolves via step B (fails to match, since `reversedBy` is now someone else) → falls through to C→D→E (their own authorization, independently evaluated) → G (`failed-precondition`, since the Expense is now already reversed by the winner). Never two reversals, never a mixed/ambiguous state. |
| Reversal races with Trip archive | Not a race from reversal's perspective at all — reversal never reads archive state (§6/§15), so a concurrent archive transition has zero effect on reversal's own transaction/authorization logic. |
| Reversal races with membership removal (of the reverser themselves, when authority depends on current membership) | Only relevant on the non-replay path (§4.4 step D onward) — the reversal transaction reads `tripRef` inside the same transaction it evaluates membership against, so a concurrent, committed membership-removal write to that same Trip document forces Firestore to abort and retry the reversal transaction, which re-reads the Trip fresh and re-evaluates E against the *new* state. Identical mechanism, already proven for `recordTripExpense`'s own Trip-state concurrency (4C.2C §4) — reused here without modification. The ORIGINAL reverser's own replay (step B) is entirely unaffected by this race, since it never reaches step D at all (§4.4). |
| Reversal races with a correction (replacement) creation | Different documents entirely (`tripExpenses/{oldId}` vs. `tripExpenses/{newId}`) — Firestore's per-document transaction isolation means these simply proceed independently at the document level; see §9.6 for the SPECIFIC concurrency behavior when two different replacement-creation attempts target the same old Expense, which is a distinct scenario from a simple reversal-vs-correction race. |
| Reversal of an already-reversed Expense | Covered above (own replay → success, step B, before any Trip read; someone else's prior reversal, once authorized → `failed-precondition`, step G). |
| Reversal requested while an unrelated `recordTripExpense` transaction is creating a different Expense | Different documents, no interaction — non-issue, same reasoning as the correction-race row above. |
| Malformed historical Expense — `tripId` itself malformed | Fails closed at step C, `failed-precondition`, for **every** caller regardless of authorization — reached only on the non-replay path (the caller's own exact replay, step B, never evaluates `tripId` at all, since it never needs it). This is the one place reversal cannot fully avoid resolving a structural question before establishing authorization, because authorization itself depends on knowing which Trip governs the record; stated plainly as an inherent, narrow exception to "authorize before disclosing," not an oversight (§15). |
| Malformed historical Expense — `status` (or reversal metadata) malformed, `tripId` itself fine | **Checkpoint 4C.3A.2: does NOT fail closed at C.** `status` is not inspected until step G, strictly after authorization (E) — an unauthorized caller reaches the identical `permission-denied` at E as they would for a perfectly healthy Expense, never learning that `status` is corrupted at all. Only an authorized caller (owner, or current-member original creator) reaches G, where the malformed value is finally checked and rejected `failed-precondition`. See §15's required security matrix. |
| Missing referenced Trip | Defensive-only, `failed-precondition` — should be structurally impossible given Trips are never hard-deletable (archived instead, permanently), but the code must never crash or leak an uncaught exception if it somehow occurred. |

**What Firestore transactions provide vs. what needs explicit application logic**, stated plainly: Firestore guarantees that any document a transaction *reads* will not have changed by the time that transaction *commits* (retrying transparently otherwise) — this is what makes the membership/archive-race rows above safe with no extra code. It does **not** provide any cross-request "only one logical operation may proceed" guarantee beyond that document-level conflict detection — the idempotency/authorization-ordering logic in §4.4 (steps D/E/G) is exactly the explicit application logic required on top of that primitive, mirroring the identical division of responsibility already proven correct for `recordTripExpense`.

---

## 17. `clientRequestId` / document-id safety

Reuses the existing, already-hardened `CLIENT_REQUEST_ID_PATTERN` regex verbatim — no weaker validation is introduced. One structural clarification: `reverseTripExpense`'s `clientRequestId` is **not** a Firestore document id anywhere (§4.6 — it lives only inside the `reversalRequest` field on the target Expense document), so it does not need the same *global* uniqueness `recordTripExpense`'s own `clientRequestId` requires (that one **is** a document id, `tripExpenses/{clientRequestId}`, and must be globally unique across the whole collection). Reversal's `clientRequestId` is logically scoped **per-Expense** — its comparison only ever happens against the one specific Expense document being reversed, so it can never collide with, or need to avoid colliding with, any Expense-creation `clientRequestId`, including the very Expense it is reversing. This is stated explicitly so a future implementer does not assume (or need) a shared global namespace between the two operations — they share a validation *pattern*, never a validation *namespace*.

`expenseId` (the input field that *is* used as a document lookup key, via `db.collection("tripExpenses").doc(input.expenseId)`) reuses the exact `isValidFirestoreDocumentId` helper already hardened in 4C.2C (§8 of that checkpoint) — the same real Firestore document-id constraints (non-empty, never `.`/`..`, never containing `/`, within the byte-length limit), not a weaker or reinvented check.

---

## 18. `createdBy` vs. `reversedBy`

Explicitly documented, as required:
- **`createdBy`** — who originally recorded the Expense. Set once, at creation, by `recordTripExpense`, from `request.auth.uid`. Never touched by reversal.
- **`reversedBy`** — who later reversed the Expense. Set once, at reversal, by `reverseTripExpense`, from `request.auth.uid`. May legitimately differ from `createdBy` whenever the Trip owner reverses someone else's Expense (§5's owner-fallback case) — this is an intended, auditable, everyday case, not an anomaly.
- **Neither field is ever client-suppliable.** `reverseTripExpense`'s input allowlist (mirroring `recordTripExpense`'s own `ALLOWED_TOP_LEVEL_KEYS` strict-rejection convention, 4C.2A.1) accepts only `{expenseId, reversalReason, clientRequestId}` — a client attempting to pass `reversedBy` (or `createdBy`, or `status`, or `reversedAt` directly) is rejected `invalid-argument` before ever reaching Firestore, exactly the precedent already proven for `createdBy` injection against `recordTripExpense` itself.

---

## 19. Real-user beta gate

**Backend safe to deploy** and **feature safe to expose to users** are kept explicitly distinct, per the checkpoint's own instruction:

- **Backend safe to deploy**: `reverseTripExpense` implemented, unit/emulator-tested to the same rigor `recordTripExpense` received across 4C.2A→4C.2C (concurrency, information-leak ordering, malformed-input, idempotency edge cases), and deployed to the production Firebase project — this alone changes nothing user-visible, since no UI can reach it (identical reasoning already applied to `recordTripExpense`'s own safe-to-deploy-without-exposure status through this entire milestone).
- **Feature safe to expose to real users**: requires **all** of the following, not any subset:
  1. `reverseTripExpense` implemented and passing its own dedicated hardening pass (recommended as its own checkpoint, §21 — mirroring the 4C.2A→4C.2A.1→4C.2B→4C.2C rhythm already used for creation).
  2. Rules confirmed to need no change (§13) — or, if a future implementation pass finds a concrete need this preflight did not anticipate, that change reviewed and shipped alongside.
  3. `replacesExpenseId`/`replacedByExpenseId` two-way correction-link support added to `recordTripExpense`, reviewed as its own small checkpoint (§9/§21).
  4. **Both** `recordTripExpense` and `reverseTripExpense` deployed together, as one reviewed unit — never Expense creation alone. This directly extends the *already-established* gate from the original persistence preflight (§11 of that document: "SquadStash must NOT enter real-user/manual-money beta with Expense creation enabled unless there is a trusted way to reverse/correct a mistaken Expense") — this preflight does not invent that requirement, it fulfills the design half of it.
  5. 4D's UI ships an "Add Expense" affordance and a correction/reversal affordance **together**, not staggered — a user must never be able to create a real Expense through the app before also having a way to fix a mistake in one.
  6. A manual production smoke test after deployment, before the feature is announced/exposed — matching this project's own established verification convention for every UI-facing checkpoint so far.

---

## 20. App Check / rate limiting

Restated, not redesigned, per the checkpoint's own instruction: 4C.2C confirmed no App Check enforcement or callable-level rate limiting exists anywhere in this repository today. Reversal introduces **no new requirement** that changes that finding — `reverseTripExpense` is exactly as exposed to the same class of abuse (an authenticated user calling a callable directly, bypassing any UI) as every other existing callable already is, no more and no less. This remains a legitimate future public-beta/production hardening item, not a blocker for the current manual-money development milestone.

---

## 21. Recommended implementation checkpoint sequence

Four small checkpoints, continuing the exact rhythm already established for creation (a foundation pass, a dedicated hardening pass, each independently reviewable):

**4C.3B — Trusted `reverseTripExpense` callable foundation**
- Implement `functions/src/callables/reverseTripExpense.ts` per §4 (contract, transaction shape, error codes).
- Export from `functions/src/index.ts`.
- First-pass Functions/emulator tests: the core happy path (owner reverses, original-creator-still-a-member reverses), the basic idempotency case, the basic authorization-denial case, malformed-input rejection — not yet the full concurrency/information-leak sweep.
- No Rules change (§13) unless this implementation pass discovers a concrete need this preflight did not anticipate — if so, STOP and report before proceeding, per this milestone's own established practice.

**4C.3C — `reverseTripExpense` security/concurrency hardening**
- Full threat-model sweep from §16 as individual, named tests: same-id concurrency (own replay, competing reverser), Trip-state races (archive — confirming no effect; membership removal — confirming the retry-and-re-evaluate mechanism), the §15 information-leakage ordering as explicit regression tests (outsider vs. any Expense state → identical `permission-denied`, archive state never disclosed), malformed-historical-Expense handling, removed-`createdBy`/removed-payer/removed-participant behavior per §7's table.
- Mirrors 4C.2A→4C.2C's own two-pass rhythm deliberately — the ordering subtlety identified in §15 is judged to deserve the same dedicated scrutiny creation's own ordering received, not less.

**4C.3D — `replacesExpenseId`/`replacedByExpenseId` two-way correction-link addition to `recordTripExpense`**
- Adds both link fields, correction-target creation-identity, and correction-link authorization and their validation (§9) to the already-shipped, already-hardened creation callable, as its own small, independently-reviewed change — not bundled into 4C.3B/C, since it touches a different, already-stable function.
- Focused tests, at minimum (expanded to 19 items, Checkpoint 4C.3A.2):
  1. Ordinary Expense creation with no `replacesExpenseId` supplied at all remains fully unaffected — a pure regression check against 4C.2A→4C.2C's existing suite.
  2. Original creator, still a current Trip member, claims the replacement → succeeds (§9.4).
  3. Trip owner (not the original creator, not the reverser) claims the replacement → succeeds (§9.4).
  4. The reverser (`reversedBy`, still a current member, not the original creator) claims the replacement → succeeds (§9.4).
  5. An unrelated current Trip member with no qualifying role attempts a replacement → `permission-denied`, before any old-Expense state is disclosed (§9.4/§9.6 row G).
  6. The old Expense's `payerUid` alone, with no other qualifying role, attempts a replacement → `permission-denied` (§9.4/§9.6 row H).
  7. A mere participant on either Expense, with no other qualifying role, attempts a replacement → `permission-denied` (§9.6 row H).
  8. Both directional link fields (`replacesExpenseId` on the new Expense, `replacedByExpenseId` on the old one) persisted correctly, atomically, in the same transaction.
  9. An active (not yet reversed) Expense cannot be replaced — `failed-precondition` (§9.6 row E), and only disclosed to an already-authorized caller (§9.5 step 5d).
  10. Cross-Trip replacement (old Expense belongs to a different Trip) is denied — `failed-precondition` (§9.6 row D).
  11. A nonexistent old Expense reference is denied — `failed-precondition` (§9.6 row F).
  12. An already-replaced Expense cannot receive a second replacement — `failed-precondition` (§9.6 row C).
  13. Two concurrent different replacement attempts targeting the same reversed Expense → exactly one winner, the other resolves via row C above (§9.6 row B/C).
  14. Exact replacement replay (same creator, same `clientRequestId`, same facts including `replacesExpenseId`) → success, no duplicate Splits, no re-write of either link field (§9.6 row A).
  15. The same new `clientRequestId` with the same ordinary facts but a *different* `replacesExpenseId` → `already-exists`, resolved through the existing generic conflicting-request path, not treated as a replay (§9.3).
  16. Omitted `replacesExpenseId` normalizes to `null` in the stored `creationRequest`; an exact replay of an ordinary (non-correction) creation is unaffected by this new field's presence (§9.3).
  17. Archived-Trip replacement attempt remains blocked — `failed-precondition`, unchanged, frozen behavior (§6/§9.5), a direct regression check that this addition never relaxed the existing archive gate.
  18. The old Expense's `createdBy` is removed from the Trip before attempting the replacement → loses creator-based authority; `permission-denied` unless they are also the owner or `reversedBy` (§9.4).
  19. The old Expense's `reversedBy` is removed from the Trip before attempting the replacement → loses reverser-based authority; `permission-denied` unless they are also the owner or `createdBy` (§9.4).

**4D — Expense UI** (unchanged from the existing plan) — may begin development once 4C.3B–D are complete, but per §19, must not reach real-user exposure without shipping both the creation and reversal/correction affordances together, and without a production smoke test.

**Do not jump to 4D UI before 4C.3B–D are complete and reviewed**, matching this milestone's own repeatedly-stated instruction.

---

## 22. Deferred / future items (explicitly flagged, not silently assumed)

1. **Atomic `correctTripExpense` (Model B/C, §10)** — a legitimate future enhancement if real usage shows the two-step correction UX is a genuine friction point; not built now, no concrete need identified yet.
2. **Required `reversalReason` / a predefined reason taxonomy (§14)** — deferred exactly like `category`'s own free-form-for-now treatment; revisit only with real product/support data.
3. **Trip ownership transfer** — not a concept this schema supports today (§7); out of scope until (if ever) a future checkpoint introduces it, at which point this document's owner-fallback reasoning (§5) would need re-review.
4. **A Rules change for reversal** — not expected to be needed (§13), but 4C.3B's own implementation pass is the checkpoint authorized to confirm this empirically and report back if wrong, rather than this preflight asserting it with false certainty.
5. **App Check / callable rate limiting** — unchanged future public-beta item (§20), not reopened here.

---

## 23. Conclusion

**DO NOT IMPLEMENT ANY PART OF THIS DESIGN YET.** This document (as hardened by Checkpoint 4C.3A.1, then finalized by Checkpoint 4C.3A.2) freezes the trusted reversal/correction architecture — permission model, callable contract, parent-independent idempotency ordering (for both reversal itself and its replacement), the two-way one-to-one correction-link design with `replacesExpenseId` as part of creation identity, the correction-link-specific authorization model, minimized pre-authorization reversal disclosure, archived-Trip behavior, and concurrency/information-leak reasoning — before any 4C.3B+ checkpoint begins writing code. No application code, Firestore Rules, Cloud Functions, tests, or dependencies were modified to produce the original 4C.3A pass or the 4C.3A.1/4C.3A.2 amendments — only this markdown file was ever touched.

---

**CHECKPOINT 4C.3A FINAL REVERSAL/CORRECTION PREFLIGHT FREEZE READY FOR REVIEW (hardened by 4C.3A.1, finalized by 4C.3A.2)**

**DO NOT IMPLEMENT.**
**DO NOT COMMIT.**
**DO NOT PUSH.**
**DO NOT DEPLOY.**
**STOP.**

---

### Validation

```
git diff --check     -> no output (no whitespace/conflict issues)
git status --short   -> ?? docs/audits/TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md
```

No production code, Firestore Rules, Cloud Functions, tests, or dependencies were modified. Only this markdown file was edited, and it was not staged.

CHECKPOINT 4C.3A EXPENSE REVERSAL/CORRECTION PREFLIGHT READY FOR REVIEW (hardened by 4C.3A.1)

DO NOT IMPLEMENT.
DO NOT COMMIT.
DO NOT PUSH.
DO NOT DEPLOY.
STOP.
