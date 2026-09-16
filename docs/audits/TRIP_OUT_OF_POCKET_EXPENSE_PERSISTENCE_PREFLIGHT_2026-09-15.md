# Trip Out-of-Pocket Expense Persistence Preflight

**Preflight date:** 2026-09-15 (amended 2026-09-15, Checkpoint 4C.1A hardening pass; amended again 2026-09-15, Checkpoint 4C.1B hardening pass)
**Type:** Architecture/audit only — **no production code, Rules, Functions, tests, dependencies, or UI were changed**
**Baseline:** `claude/milestone-3-personal-savings-mvp` @ `73ac94a` ("Polish trip archive confirmation"), working tree clean before and after
**Checkpoint:** 4C.1 — Out-of-Pocket Expense Persistence Preflight; hardened by 4C.1A, then 4C.1B
**Governing documents:** `docs/audits/TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md` (as hardened by 4A.1) and `docs/audits/TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_2026-09-13.md` (as hardened by 4B.5A.1) — both re-verified against the current repository below, not assumed current
**Status:** DO NOT IMPLEMENT — this document resolves the remaining open persistence/authorization questions for Milestone 4C and recommends an implementation sequence; no 4C.2x checkpoint should begin until this is reviewed

**Amendment note (Checkpoint 4C.1A):** this revision corrects five issues found in the original 4C.1 pass before it becomes the frozen plan: (1) the proposed idempotent-replay check compared only the `creationRequest` snapshot, which is insufficient once `createdBy != payerUid` is a frozen, intended case — two different authenticated members could produce a byte-identical snapshot, letting one silently inherit the other's already-committed record; replay is now additionally bound to `stored.createdBy === authUid`, without moving replay after authorization/lifecycle checks (§5, §7); (2) the `creationRequest` snapshot itself was underspecified — now precisely defined as a server-normalized structure with canonical ascending-`uid` participant ordering and an explicit non-inclusion of `createdBy` (§5.2); (3) `occurredAt` was listed among the compared replay facts in one section while another section claimed it was "never used for any idempotency decision" — corrected to the precise rule: `clientRequestId` alone is the idempotency key, but `occurredAt`'s normalized (parsed-instant, not textual) value is one of the facts compared when judging whether a reused id represents the same request (§10); (4) `receiptImageUrl`'s omission from the callable's input contract was implicit rather than an explicit, reasoned 4C decision — now stated plainly, with rejection (not silent dropping) of any client attempt to supply it (§6.1); (5) the reversal-ready-schema analysis had no explicit real-user release gate — added as a named future checkpoint (4C.3) and an explicit "must exist before real-user/manual-money beta" requirement, distinct from and not blocking 4C.2A–C development or 4D UI development (§11, §16). All five corrections are detailed in the relevant sections below; every other 4C.1 decision (§2's frozen list, the flat-collection schema, `clientRequestId`-as-document-id, `recordTripExpense` naming, member-on-behalf-of-payer authorization, USD-only, out-of-pocket-only scope, transaction atomicity, trusted-only writes, archived-Trip new-Expense blocking with historical reads preserved, duplicated Functions-side split math, and the 4F/4E deferrals) is unchanged and not reopened.

**Amendment note (Checkpoint 4C.1B):** this revision corrects one further schema-level issue found before the design becomes frozen: the proposed `tripExpenseSplits` document id, `${expenseId}_${participantUid}`, was a raw underscore concatenation with no unambiguous component boundary — two different `(expenseId, participantUid)` pairs (e.g. `expenseId="abc_def"`+`participantUid="ghi"` vs. `expenseId="abc"`+`participantUid="def_ghi"`) could concatenate to the identical string, letting a trusted write silently overwrite an unrelated Expense's split document. Replaced with `splitDocumentId`, a deterministic SHA-256 hash (Node's built-in `crypto`, no new dependency) of `JSON.stringify([expenseId, participantUid])`, whose unambiguous array-serialization delimiting removes the collision by construction rather than by convention (§5.3). This is a document-id encoding fix only — determinism, atomicity, the flat-collection shape, and every persisted field on the split document itself (§4) are unchanged. Every other 4C.1/4C.1A decision is unchanged and not reopened.

---

## 1. Current repository facts (re-verified, not assumed)

The frozen 4A/4A.1 audit was written before Checkpoints 4B/4B.1/4B.2 (expense domain) and 4B.5B/4B.5C/4B.5C.1/4B.5B.1/4B.5B.1A (archive lifecycle) existed. Every fact below was re-checked against the current tree, not carried over from the older audit.

| Area | Current state |
|---|---|
| `src/types/domain/expense.ts` | `Expense`, `ExpenseSplit`, `CreateExpenseInput` exist in **final, already-hardened** form (Checkpoints 4B/4B.1/4B.2). `ExpensePaymentSource = "member_out_of_pocket" \| "shared_stash"`, `ExpenseStatus = "active" \| "reversed"`. `CreateExpenseInput` deliberately has **no `createdBy`** (server-derived only) and **no `participants`/`clientRequestId`** (callable-wire concerns, not persisted-domain concerns — see §7). |
| `src/types/domain/settlement.ts` | `Settlement`/`CreateSettlementInput` exist, unchanged since 4B.1/4B.2. Out of scope for 4C entirely (frozen decision A). |
| `src/domain/tripExpenseSplits.ts` | `computeEqualSplit`/`computePercentageSplit`/`computeCustomSplit`/`computeExpenseSplits` fully implemented, fully unit-tested, zero I/O, zero Firebase imports. Largest-remainder percentage rounding and lexicographic equal-split rounding both implemented exactly as the frozen audit specified. |
| `src/domain/tripSettlement.ts` | `computeTripBalances`, `assertValidExpensePaymentShape`, `assertUsdCurrency`, `assertNonEmptyId` fully implemented and tested. Out-of-pocket expenses already require ≥1 split (validated even when `status === "reversed"`); `shared_stash` expenses contribute zero debt. |
| `firestore.rules` | No `tripExpenses`, `tripExpenseSplits`, or `tripSettlements` match block exists yet — confirmed absent. `trips/{tripId}` now carries the full archive lifecycle: missing-safe `tripIsActive()` helper, an archive-only `allow update` branch, `allow delete: if false`. `savingsTransactions/{transactionId}` is the direct structural precedent for a future `tripExpenses` read rule (`canAccessParent()`-style cross-reference, client create/update/delete permanently closed). |
| `functions/src/index.ts` | Exports exactly three callables: `createBucket`, `lookupUserByEmail`, `recordSavingsTransaction`. No Expense/Settlement callable exists. |
| `functions/src/callables/recordSavingsTransaction.ts` | **Now the gold-standard authorization-ordering precedent in this codebase**, hardened twice this milestone (4B.5C, 4B.5C.1). Current order inside the transaction: idempotent-replay check first (so an exact replay of an already-committed request always reconciles, regardless of any state change since) → caller membership → caller self-only → **then** the archived-Trip lifecycle check → currency → ledger init → balance arithmetic → writes. This ordering — replay before authorization, authorization before lifecycle-state disclosure — is the exact pattern this preflight reuses for `recordTripExpense` (§8). |
| `functions/src/callables/createBucket.ts` | Confirms two additional reusable idioms: (1) a `creationRequest` immutable-snapshot idempotency comparison (richer than `recordSavingsTransactionCore`'s flat `storedFactsMatch`, needed once "the facts" include a structured list); (2) **the callable's own wire-input interface (`CreateBucketInput`) is a locally-defined `interface` inside the callable file, never imported from `src/types/domain`** — the same is true of `recordSavingsTransaction.ts`'s `RecordSavingsTransactionInput`. This is a second, independent confirmation of the cross-boundary-duplication precedent examined in §9. |
| `functions/tsconfig.json` | `"include": ["src"]` — scoped strictly to `functions/src`. No path reaches outside the `functions/` directory. Confirmed via direct read; there is no workspace/monorepo config (`package.json` at the repo root has no `workspaces` key) that would let `functions/` import from root `src/domain` even if a relative path were attempted. |
| `src/domain/tripPersonalFund.ts` / `functions/src/callables/createBucket.ts` | Already contain a **directly-applicable precedent for §9**: `tripPersonalBucketId(tripId, uid)` is implemented independently in both files, each with an explicit comment ("a separate compiled TypeScript project with no shared import path... keep both in sync manually if this ever changes"). This is not a hypothetical strategy — it is the one already chosen and shipped in this exact codebase for the identical cross-boundary-duplication problem. |
| `src/types/domain/trip.ts` | `Trip.archivedAt?: PersistedTimestamp \| null`, `Trip.archivedBy?: string \| null`. No separate `status` field. Legacy Trips (no key) are active. |
| `firestore.indexes.json` | Three composite indexes exist today: `buckets`/`trips` (by `memberIds` array-contains + `createdAt` desc) and `savingsTransactions` (by `resourceType` + `resourceId` + `createdAt` desc). This is the exact shape a future `tripExpenses` list query will need (§13) — not needed by 4C's callable itself, which never issues a list query. |
| App/Functions/Rules test baselines | App: 265/265 (`npm test -- --runInBand`). Functions: 132/132 (`firebase emulators:exec --only firestore "npm --prefix functions test"`, includes the 4B.5C/4B.5C.1 archived-Trip contribution tests). Rules: 225/225 (`npm run test:rules`). Lint: 0 errors, 3 pre-existing accepted warnings. All confirmed current as of this preflight — no code changed to produce these numbers. |

**Conclusion:** the frozen 4A/4A.1 schema recommendation is still structurally sound and requires no revision. What has changed since 4A.1 is that this codebase now has a *proven, twice-hardened* authorization-ordering precedent (`recordSavingsTransactionCore`) that did not exist when 4A.1 was written — §8 below applies that precedent directly rather than reasoning about authorization ordering from first principles.

---

## 2. Approved/frozen decisions (restated, not reopened)

Per the checkpoint's own instruction, decisions A–I are treated as settled and are not re-litigated below. No concrete conflict with the current repository was found for any of them:

- **A.** 4C supports only `paymentSource: "member_out_of_pocket"`. `shared_stash` is rejected outright, not silently coerced.
- **B.** `payerUid` is required and must be a current Trip member; `createdBy` is server-derived from `request.auth.uid`, never client-authoritative.
- **C.** USD-only.
- **D.** Equal/percentage/custom split math is frozen in `src/domain/tripExpenseSplits.ts` and reused, not reimplemented (§9 covers exactly how, given the package boundary).
- **E.** Percentage uses the already-implemented integer basis-point/largest-remainder allocation.
- **F.** Append-only correction model: `status: "active" | "reversed"`; a correction is a new Expense, never a mutation of financial facts on an existing one.
- **G.** New Expenses blocked on an archived Trip; Settlements remain a later checkpoint (not built in 4C at all).
- **H.** No Personal Expense system; My Stash stays a private savings Bucket.
- **I.** Shared Stash transaction linkage (`sharedStashTransactionId`) is not part of 4C.

One clarification worth stating explicitly, since it directly answers the checkpoint's §3.D question: the frozen audit's own permission model (§10 of the 4A/4A.1 audit, unchanged and unconflicted by anything built since) already resolves **"can one member record an expense paid by another member?" — yes.** `createdBy` (who is logging the record) and `payerUid` (who actually paid) are deliberately distinct fields specifically to support "I'm logging a receipt for a friend who paid cash." This is *not* the same authorization model as `recordSavingsTransactionCore`'s self-only rule — that rule exists because `recordSavingsTransactionCore` moves real ledger money and financial attribution must be self-asserted; `recordTripExpense` only creates a *description* of a real-world event and never moves money, so a different, wider authorization rule for who may create the record is not a contradiction, it is answering a different question. Nothing found in the current repository conflicts with this — it is adopted as-is (§8 authorization order below).

---

## 3. Proposed Firestore schema

No change from the frozen audit's recommendation — re-verified against current Rules/service conventions, not reopened:

**Flat top-level collections**, not `trips/{tripId}/expenses` subcollections:

```
tripExpenses/{clientRequestId}
tripExpenseSplits/{splitDocumentId}
```

`splitDocumentId` is a collision-safe deterministic hash of `(expenseId, participantUid)`, **not** a raw underscore concatenation of the two — see §5.3 for the exact formula and why the naive concatenation is unsafe.

(`tripSettlements` is **not created in 4C** — it belongs to 4E, per frozen decision A/I. No Rules match block or type work for it happens in 4C.2x.)

Rationale, re-confirmed against the current tree:
- **Queryability by `tripId`**: both collections carry a denormalized `tripId` field, enabling a plain `where("tripId", "==", tripId)` query — the same shape already used by `savingsTransactions` (`where("resourceType","==",...).where("resourceId","==",...)`). No `collectionGroup` query anywhere in this design, matching every existing query in the app.
- **Rules simplicity**: reuses the `canAccessParent()`-style cross-reference already proven for `savingsTransactions/{transactionId}` (`firestore.rules`) nearly verbatim — a `tripExpenses`-scoped variant needs only `parentExists`/`parentData`/membership check against `trips/{tripId}`, no new Rules idiom (§12).
- **Append-only behavior**: matches `savingsTransactions`' own posture exactly — `allow create, update, delete: if false` for direct clients; the trusted callable (Admin SDK) is the sole writer.
- **Atomic creation**: a flat collection changes nothing about atomicity — a Firestore transaction can write to documents at arbitrary paths in one commit regardless of collection shape (§7).
- **Future balance aggregation**: `computeTripBalances` (already implemented, §1) consumes flat arrays of `Expense`/`ExpenseSplit`/`Settlement` fetched by a `tripId`-scoped query — the flat shape is exactly what that function already expects; no schema change would be needed to wire it up in a later checkpoint.
- **Future reversals**: a reversal only ever adds `status`/`reversedAt`/`reversedBy`/`reversalReason` to an *existing* `tripExpenses/{id}` document, or creates a wholly new one — neither requires restructuring `ExpenseSplit`'s storage, since a reversed Expense's splits are never deleted, only ignored by `computeTripBalances` via the `status` check that already exists in that function today.
- **Future Shared-Stash linkage (4F)**: `sharedStashTransactionId` is already a field on the frozen `Expense` type (absent for 4C's `member_out_of_pocket`-only writes) — no schema migration needed when 4F adds it.

No unnecessary collection is introduced. `tripExpenseSplits` remains a separate flat collection rather than an embedded array on `Expense`, for the identical reason already established and re-confirmed: an embedded array cannot be queried by one field (e.g. `userId`) while filtering by another, which a flat collection can (`where("userId","==",uid)` — "what do I owe across every trip" is a real future query this schema must not foreclose).

---

## 4. Exact document paths

```
tripExpenses/{clientRequestId}
tripExpenseSplits/{splitDocumentId}
```

The Expense's own document id is `clientRequestId` directly — no separate randomly-generated Expense id ever exists; the callable's own idempotency key **is** the persisted identity.

`splitDocumentId` is **not** a human-readable concatenation of `expenseId` and `participantUid` — it is an opaque, collision-safe deterministic hash of that pair (§5.3, Checkpoint 4C.1B hardening). The persisted split document's own fields (`expenseId`, `tripId`, `userId`, `amountMinor`, `percentageBasisPoints?`, `createdAt`) carry every meaningful fact already — no caller ever needs to decode the document id itself to know which Expense or participant a split belongs to; every query (`where("expenseId","==",X)`, §14) filters on the field, never on the id's own structure.

---

## 5. Idempotency design (compared explicitly to `recordSavingsTransaction`)

**Decision: `clientRequestId` is the `tripExpenses` document id directly (the `recordSavingsTransactionCore` pattern), but the replay comparison uses the richer `creationRequest`-snapshot idiom (the `createBucketCore` pattern), not the flatter `storedFactsMatch` idiom — and, per Checkpoint 4C.1A hardening, replay equivalence is now BOUND TO THE ORIGINAL CREATOR, not just to the request facts.**

This is a deliberate hybrid, and the reasoning matters:

| | `recordSavingsTransactionCore` | `createBucketCore` | **`recordTripExpense` (proposed)** |
|---|---|---|---|
| Document id | `clientRequestId` directly | `clientRequestId` (ordinary Bucket) **or** a deterministic `tripfund_${tripId}_${uid}` id (trip_personal, because a real "at most one per key" constraint exists) | **`clientRequestId` directly** — an Expense has no natural per-key uniqueness constraint the way a trip_personal Bucket does (a Trip may have arbitrarily many Expenses); a deterministic non-`clientRequestId` id would solve a problem that doesn't exist here |
| Replay comparison | Flat five/six-field `storedFactsMatch` | Full `creationRequest` snapshot object, field-by-field | **Full normalized `creationRequest` snapshot, PLUS a separate `stored.createdBy === authUid` check** — see below for why the snapshot alone is not enough here. |

### 5.1 Why creator-binding is required (Checkpoint 4C.1A hardening)

`recordSavingsTransactionCore`'s replay is self-only by construction — `authUid` must already equal `input.memberUid` for the request to ever succeed the first time, so "the same facts replayed" and "the same facts replayed by the same person" are the same statement there. `recordTripExpense` breaks that equivalence on purpose (§2's frozen decision: `createdBy != payerUid` is an intended, everyday case — one member may log an expense another member actually paid). This means the `creationRequest` snapshot alone (tripId, payerUid, amountMinor, description, split shape, etc.) can be **byte-identical** across two different authenticated callers with no relationship to each other beyond both being current Trip members — e.g., two different members independently deciding to log "Daniel paid $250 for the cabin, split 5 ways" would produce an identical snapshot. Without a creator check, the second member to submit that exact snapshot under a guessed or coincidentally-reused `clientRequestId` would silently inherit and "own" the first member's already-committed record as if it were their own idempotent retry — a real cross-user identity confusion, not merely a cosmetic one, since `createdBy` is a persisted audit-trail fact this codebase already treats as meaningful (§1's `recordSavingsTransactionCore` comparison table; `createdBy`'s own doc comment in `src/types/domain/expense.ts`).

**The fix: an exact replay requires BOTH of the following, not just the snapshot match:**

```
if expenseRef already exists:
    if stored.createdBy != authUid:
        -> already-exists          // different creator: never a valid replay of THIS caller's request
    if stored.creationRequest != normalizedIncomingCreationRequest:
        -> already-exists          // same creator, different facts: existing convention, unchanged
    -> return original successful result   // same creator, same facts: genuine replay
```

This check is evaluated entirely from data already loaded in Phase 2 step 1 (`tx.get(expenseRef)` already returns the stored `createdBy`) — no additional read is introduced. **The creator check runs first, before the snapshot comparison**, purely so that a creator mismatch and a facts mismatch both produce the identical `already-exists` outcome and identical error message — there is no way for a caller to distinguish "someone else already used this id" from "you already used this id for something different" from the error alone, which is itself a deliberate anti-enumeration property (revealing "a different person already recorded this exact expense" would leak more than this callable should ever disclose to an unrelated caller).

**This does NOT move replay after current membership/archive checks — replay stays first, unconditionally, for the original creator.** The two hardening goals are independent and both hold simultaneously:
- The **original creator** must be able to reconcile their own already-committed request even if the Trip was later archived, or even if that same creator was later removed from Trip membership — this is historical idempotency reconciliation (self-referential: "did MY request already commit"), not a fresh authorization decision, and must never be re-litigated against today's membership/archive state.
- **Any other authenticated caller** — including a current, fully-authorized Trip member — must never be able to replay or inherit another creator's request merely by knowing the `clientRequestId` and independently producing matching facts. That caller's own attempt with that `clientRequestId` is `already-exists`, full stop, before their own membership or the Trip's archive state is ever consulted for this request (there is nothing further to authorize — the id is already claimed by someone else's request).

### 5.2 Normalized `creationRequest` snapshot — exact definition

The snapshot compared on replay is a **server-normalized** structure, never an unvalidated echo of the raw client request body. It is built from the already-validated (Phase 1, §7) input, after normalization, and contains exactly:

```ts
{
  tripId: string;
  payerUid: string;
  amountMinor: number;
  currency: "USD";
  description: string;
  category: string | null;              // null when omitted, never undefined - a stable, comparable shape
  splitStrategy: "equal" | "percentage" | "custom";
  participants: (
    | { uid: string }
    | { uid: string; percentageBasisPoints: number }
    | { uid: string; amountMinor: number }
  )[];                                    // sorted ascending by uid - see below
  paymentSource: "member_out_of_pocket";  // always this literal for 4C - never persists a value the callable itself rejects
  occurredAtInstantMs: number | null;     // the PARSED instant, not the original ISO string - see §10
}
```

**`createdBy` is deliberately NOT a member of this snapshot** — it remains a separate, top-level persisted field on the `Expense` document (`stored.createdBy`), compared independently in §5.1's check, never folded into the client-controlled/client-echoed comparison object. This keeps the snapshot's own identity a pure function of "what was requested," while "who requested it" is checked as its own, separate, trusted fact.

**Participants use deterministic canonical ordering by ascending `uid` before the snapshot is stored or compared** — the same ascending-lexicographic convention `src/domain/tripExpenseSplits.ts` already uses for its own tie-break/output ordering (§1). This means a client submitting the identical logical participant set in a different array order produces the identical normalized snapshot, so harmless client-side array ordering can never change the identity of an otherwise-identical Expense request (and, symmetrically, can never be used to make an otherwise-identical request look "different" for replay purposes, deliberately or accidentally).

**Exact duplicate-request behavior (revised):** the same `clientRequestId`, submitted by the **same authenticated creator**, with a byte-identical normalized `creationRequest` snapshot, reconciles to the **original** result — same `expenseId`, no new write, no new `ExpenseSplit` documents, no new debt (§16 test case E). This must hold **even if the Trip has since been archived, or the original creator was later removed from Trip membership** (§5.1, §12) — mirroring `recordSavingsTransactionCore`'s own corrected 4B.5C.1 behavior, extended with the creator-binding this callable additionally needs.

**Exact same-id-different-facts behavior:** rejected with `already-exists` — both when the creator matches but the snapshot differs, and when the creator itself differs (§5.1). No partial/silent merge of any two requests is ever attempted.

**`ExpenseSplit` documents need no independent idempotency mechanism at all** (re-confirmed, not just repeated from the frozen audit): they are written only as a side effect of the Expense's own transactionally-unique creation, at the deterministic id `splitDocumentId` derived from `(expenseId, participantUid)` — see §5.3 for the exact, collision-safe formula. Because `expenseId` is now fixed as `clientRequestId` (not a fresh random id per attempt), a genuine replay by the original creator never re-writes them at all (§16 test case E) — the transaction returns before reaching the write step (§7 step 3).

### 5.3 Split document id — collision-safe deterministic derivation (Checkpoint 4C.1B hardening)

**The original 4C.1/4C.1A draft's proposed split document id, `${expenseId}_${participantUid}`, is not collision-safe and must not be built.** A plain underscore join has no unambiguous component boundary: `expenseId = "abc_def"` paired with `participantUid = "ghi"`, and `expenseId = "abc"` paired with `participantUid = "def_ghi"`, both concatenate to the identical string `"abc_def_ghi"`. Since `expenseId` is `clientRequestId` (§5) — a client-influenced string matched only by `CLIENT_REQUEST_ID_PATTERN` (`[A-Za-z0-9_-]{1,128}`, which explicitly permits underscores) — this is not a theoretical edge case; an ordinary, rule-conforming `clientRequestId` containing an underscore collides with a *different* Expense's split id whenever the two components straddle the same combined string differently. A trusted `tx.set()` at a colliding id would silently overwrite an unrelated split document belonging to a different Expense entirely — a real data-integrity hazard, not a cosmetic one, and one that must be closed before any Expense persistence ships.

**Approved fix: `splitDocumentId` is a deterministic SHA-256 hash of the `(expenseId, participantUid)` pair, hex-encoded, using Node's built-in `crypto` module — no third-party dependency.**

```ts
import { createHash } from "crypto";

function splitDocumentId(expenseId: string, participantUid: string): string {
  return createHash("sha256")
    .update(JSON.stringify([expenseId, participantUid]), "utf8")
    .digest("hex");
}
```

`JSON.stringify([expenseId, participantUid])` (rather than a raw string join of any kind) is what actually removes the ambiguity: JSON array serialization unambiguously delimits each element with quoting and a comma the two raw strings can never spoof into a matching byte sequence for two different `(expenseId, participantUid)` pairs — this is the load-bearing part of the fix, not merely "use a hash instead of a plus sign." Hashing the unambiguous serialized form, rather than persisting the JSON string itself as the id, keeps the id a fixed-length, Firestore-document-id-safe opaque token (a JSON array string is a legal but needlessly larger and less conventional document id than this codebase uses anywhere else).

**Why determinism is preserved, not traded away:** the fix only replaces the *encoding* of the two-component key, not the *fact* that the id is a pure, stateless function of `(expenseId, participantUid)` with no randomness and no counter. This keeps every property the original design wanted:
- **Stable write targets inside the Expense transaction** — `splitDocumentId(expenseId, uid)` for a given pair always names the same document, computed independently of write order.
- **No duplicate split rows for the same Expense/participant pair** — a second computation for the same pair always lands on the same id, never a new one.
- **Deterministic testing/debugging** — a test can compute the expected id ahead of a write and assert against it directly (§6, test case A/C below).
- **Safe retries/internal Firestore transaction retries** — Firestore's own automatic transaction-retry-on-contention mechanism re-runs the transaction body, which recomputes the identical ids on every retry; a hash-based id is exactly as replay-safe under retry as the original concatenation-based one was intended to be, since neither depends on anything but the two inputs.

**No caller ever needs to decode the id** — every field a consumer could want (`expenseId`, `tripId`, `userId`, `amountMinor`, `percentageBasisPoints?`, `createdAt`) is already a plain field on the persisted split document (§4); the id's only job is to be a stable, collision-free write target, never a data-bearing identifier.

---

## 6. Callable contract

**Naming: `recordTripExpense`, not `createTripExpense`.** The frozen audit itself proposed this name; re-checking it against the current naming convention confirms it's still the better fit: `createBucket` names a callable that establishes a new, ongoing, *mutable* resource (a Bucket has a lifecycle — renames, target changes, more contributions). `recordSavingsTransaction` names a callable that creates a single, *immutable*, append-only financial-event record. An Expense is unambiguously the second kind — closer in nature to a SavingsTransaction than to a Bucket — so `recordTripExpense` is the naming-convention-correct choice, not merely the audit's original preference.

**Client-supplied fields** (the callable's own wire-input shape — a **new, locally-defined interface inside `functions/src/callables/recordTripExpense.ts`**, per the confirmed precedent that neither existing callable imports its wire-input shape from `src/types/domain`; see §1/§9):

```ts
interface RecordTripExpenseInput {
  tripId: string;
  payerUid: string;                  // REQUIRED, non-null for 4C (out-of-pocket only)
  amountMinor: number;
  currency: string;                  // must be exactly "USD"
  description: string;
  category?: string;
  splitStrategy: "equal" | "percentage" | "custom";
  participants: (
    | { uid: string }                                          // equal
    | { uid: string; percentageBasisPoints: number }           // percentage
    | { uid: string; amountMinor: number }                     // custom
  )[];
  paymentSource?: "member_out_of_pocket" | "shared_stash";     // if provided, must be "member_out_of_pocket" - anything else is invalid-argument
  occurredAt?: string;               // ISO date/time, same convention as recordSavingsTransaction
  clientRequestId: string;
}
```

**Server-derived fields** (never accepted from client input, even if present in the raw request body):
- `id` — always equals `clientRequestId`.
- `createdBy` — always `request.auth.uid`.
- `createdAt` — always `FieldValue.serverTimestamp()`.
- `status` — always `"active"` at creation (this callable never writes `"reversed"` — no reversal path exists in 4C at all, per frozen decision F).
- `reversedAt` / `reversedBy` / `reversalReason` — never written by this callable.
- Every `ExpenseSplit.amountMinor` — always the **server-computed** output of `computeExpenseSplits` (§9), even for `splitStrategy: "custom"`, where the client supplies an amount per participant but the server still re-validates the sum exactly rather than trusting it blindly.
- `ExpenseSplit.createdAt` — server timestamp, matching every split document.

**Fields the client is forbidden to authoritatively control:**
- `createdBy` (identity of the record's creator).
- `sharedStashTransactionId` — must be absent for 4C; the callable does not even accept it as an input field for this phase (a client sending it is simply ignored/rejected at `invalid-argument`, not silently stored).
- `paymentSource` beyond `"member_out_of_pocket"` — a client asserting `"shared_stash"` is rejected outright (`invalid-argument`), never coerced to `"member_out_of_pocket"` and never silently accepted.
- Any `ExpenseSplit.amountMinor` for `equal`/`percentage` strategies — the client supplies *inputs* to the split calculation (a participant list, and percentages for the percentage case), never the final per-participant amounts for those two strategies; only `custom` lets the client name amounts directly, and even then every amount is re-validated to sum exactly to `amountMinor`.

Not implemented in this preflight — this is a contract specification only.

### 6.1 `receiptImageUrl` scope — explicit 4C decision (Checkpoint 4C.1A)

The persisted `Expense` domain type (`src/types/domain/expense.ts`) already carries `receiptImageUrl?: string | null` as a **reserved** field — re-confirmed in §1, this predates and is untouched by this preflight. `RecordTripExpenseInput` (§6 above) deliberately **does not** include it. This is an explicit decision, not an oversight:

- Receipt upload/storage is **deferred**, unchanged from the original 4A/4A.1 audit's own finding that no Firebase Storage bucket, `storage.rules` file, or upload UI exists anywhere in this repository today (§1 of that audit) — building receipt handling is a separate infrastructure prerequisite, not a 4C task.
- `recordTripExpense` in 4C does **not** accept, validate, or persist `receiptImageUrl` in any form.
- A raw caller attempting to inject `receiptImageUrl` into the request body is rejected outright (`invalid-argument`, §7 Phase 1 step 7) — never silently dropped-and-ignored, and never silently made trusted/persisted. This matters specifically because `Expense.receiptImageUrl` already exists as a valid field name on the persisted type; without an explicit rejection, a naive implementation might accidentally pass an unrecognized-but-type-shaped field straight through to the write.
- The existing optional persisted-domain field remains reserved, untouched, for a later dedicated receipt/Storage checkpoint — no schema change is needed then, matching the same "reserve now, build later" pattern already used for `sharedStashTransactionId` (§1, deferred to 4F).

**No Storage integration or receipt handling of any kind is built in 4C.** This is recorded here so the omission reads as a deliberate, reviewed scope boundary rather than something later discovered to have been accidentally missed.

---

## 7. Authorization model and order

**This directly reuses the `recordSavingsTransactionCore` pattern hardened by 4B.5C/4B.5C.1 in this exact milestone — replay before authorization, authorization before any lifecycle-state disclosure.** Two phases, mirroring every existing callable's own two-phase structure:

**Phase 1 — synchronous `validateInput`, before any Firestore access (cheapest possible rejection, and — critically — this phase cannot leak anything Trip-specific, since it never reads a Trip document):**
1. `tripId`, `payerUid`, `description`, `clientRequestId` are non-empty strings; `clientRequestId` matches the existing `CLIENT_REQUEST_ID_PATTERN`.
2. `amountMinor` is a positive safe integer.
3. `currency === "USD"` exactly (not "must match the Trip's own currency field" — Trip has no `currency` field at all today, unlike Bucket/`savingsTransactions`; this is a flat, unconditional assertion, not a `parentData.currency` lookup. **This is a deliberate, explicit divergence from `recordSavingsTransactionCore`'s currency-matching pattern, called out so a future implementer does not copy that pattern verbatim here.**)
4. `description` non-empty, under a max length; `category`, if present, under a max length.
5. `splitStrategy` is one of the three valid values; `participants` is non-empty and shaped consistently with `splitStrategy` (percentage entries all carry `percentageBasisPoints`; custom entries all carry `amountMinor`; equal entries carry neither).
6. `paymentSource`, if present, must equal `"member_out_of_pocket"` — reject anything else, including `"shared_stash"`, right here (`invalid-argument`), before ever touching Firestore.
7. `receiptImageUrl`, if present anywhere in the raw request body, is rejected outright (`invalid-argument`) — 4C does not accept it at all (§6.1). This is a strict unknown-field rejection, not a silent drop: a caller attempting to inject it never has it silently accepted-and-ignored, nor silently persisted.

**Phase 2 — inside `db.runTransaction`, mirroring `recordSavingsTransactionCore`'s read-then-branch structure exactly:**

1. `tx.get(expenseRef)` (by `clientRequestId`) and `tx.get(tripRef)` — both reads before any write, per Firestore's own transaction ordering requirement.
2. Trip not found → `not-found`.
3. **Idempotent replay check FIRST**, before any authorization check: if `expenseRef` already exists, apply the two-part check from §5.1 — (a) `stored.createdBy === authUid`, else `already-exists`; (b) the stored normalized `creationRequest` snapshot exactly equals the normalized incoming snapshot (§5.2), else `already-exists`; if both hold, reconcile to the original result immediately. This must succeed for the **original creator** regardless of the Trip's current archive state or current membership, exactly matching the 4B.5C.1 principle that a replay answers "did this already commit," never "is it still allowed today" — but it can never succeed for a *different* authenticated caller, no matter how closely their own request's facts match, because step (a) fails first for them.
4. **Caller authorization**: `authUid` must be a current Trip member (`memberIds` or `ownerId`, read fresh from the just-loaded Trip document, never trusted from client input) — `permission-denied` otherwise. This is the actual authorization boundary and must resolve before any Trip-state fact is revealed to the caller. (A caller who reaches this step already failed step 3's replay check for this `clientRequestId`, so this step 4 always concerns a *genuinely new* request from this caller's perspective — never a replay attempt.)
5. **Archived-Trip check**, placed immediately after caller authorization and before every other business-rule check below — reusing the exact 4B.5C.1 lesson: an unauthorized caller must never learn whether the Trip is archived, but once the caller is confirmed authorized, disclosing lifecycle state is safe. If the Trip is archived → `failed-precondition` (§10).
6. **Payer membership**: `payerUid` must be a current Trip member (fresh Trip data, never client-trusted) → `failed-precondition` if not. (Not `permission-denied` — the *caller* is authorized; it is the referenced payer that fails a data-integrity condition. This mirrors the code-family distinction `recordSavingsTransactionCore` already draws between "the caller lacks authorization" (`permission-denied`) and "the referenced resource state doesn't satisfy a required condition" (`failed-precondition`).)
7. **Participant membership**: every `participants[].uid` must be a current Trip member → `failed-precondition` per violation, same reasoning as step 6.
8. **Split math validation**: run `computeExpenseSplits(amountMinor, splitStrategyInput)` from the duplicated domain module (§9). A thrown `Error` here is caught and re-surfaced as `HttpsError("invalid-argument", err.message)` — this is a **new pattern** this callable introduces (neither existing callable reuses a `src/domain`-style throwing pure function internally), called out explicitly so it isn't missed during implementation.
9. Write: `tx.set(expenseRef, {...})` for the Expense document, plus one `tx.set(...)` per computed `ExpenseSplit` at its deterministic id — all inside the same transaction (§8).

**Explicit answer to "can one member record an expense paid by another member?": yes** (§2) — no additional self-only check exists between `authUid` and `payerUid` anywhere in this order, by design.

**Information-leakage check, explicit:** an outsider (non-member) attempting to create an Expense against any Trip — archived or not — receives the identical `permission-denied` at step 4, regardless of the Trip's actual archive state, existence of other members, or anything else about it. The only fact ever disclosed to a caller who fails step 4 is "you are not authorized here," matching `recordSavingsTransactionCore`'s own current (corrected) behavior exactly.

---

## 8. Atomicity model

**A single Firestore transaction (`db.runTransaction`), not a batch write.**

A `WriteBatch` cannot perform reads or branch on their result — it can only commit a fixed set of writes atomically with no read-your-writes/precondition logic. This callable's correctness depends on freshly-read data (the Trip's current `memberIds`, current archive state, and whether an Expense already exists at this `clientRequestId`) being evaluated **atomically with** the writes that follow from them — otherwise a Trip member could be removed, or the Trip archived, in the gap between an ordinary read and a subsequent unguarded write, producing a stale-authorization race. A transaction closes that window exactly the same way `recordSavingsTransactionCore` and `createBucketCore` already do for their own analogous races.

All writes — the one `tripExpenses/{clientRequestId}` document and every `tripExpenseSplits/{splitDocumentId}` document (§5.3) — happen via `tx.set(...)` calls inside that same transaction, so the Expense and all of its splits either all commit or none do; there is no window where a caller could observe an Expense with a partial or missing split set. The collision-safe hash derivation (§5.3) is itself pure/synchronous and computed before any write — it introduces no additional read, no additional round trip, and no change to the transaction's atomicity properties.

**Documented scale assumption, stated rather than silently assumed:** Firestore transactions cap at 500 mutations. A Trip's member count in this app is realistically small (single digits to low tens); 1 Expense document + N split documents is nowhere near that ceiling for any plausible Trip size. If a future Trip ever approached hundreds of members, this design would need revisiting — explicitly out of scope for this milestone, and no different in kind from `computeTripBalances`'s own unstated (but equally reasonable) assumption that a Trip's full financial history fits comfortably in memory client-side.

---

## 9. Domain-validation reuse decision

**Decision: duplicate, do not attempt to import.** `functions/tsconfig.json` scopes `include` to `["src"]` (i.e., `functions/src` only, confirmed by direct read) — there is no path by which `functions/src/callables/recordTripExpense.ts` can import `../../../src/domain/tripExpenseSplits.ts` without either breaking the Cloud Functions build's `rootDir` boundary or restructuring the whole `functions/` package into a workspace-aware monorepo, and the root `package.json` confirms this is not currently a workspace setup at all.

This is not a new problem this preflight is solving for the first time — **it is the identical problem already solved once in this exact codebase**, for `tripPersonalBucketId`: `src/domain/tripPersonalFund.ts` and `functions/src/callables/createBucket.ts` each carry an independent copy of the same one-line deterministic-id formula, cross-referenced by an explicit "keep both in sync manually if this ever changes" comment in both places. The correct move for the expense-split math is the same pattern, scaled up:

- Add a `functions/src/domain/tripExpenseSplits.ts` (or inline the needed logic directly in `recordTripExpense.ts` if the duplicated surface is small enough — a call to be made at actual implementation time, not here) containing a **duplicate** of `computeExpenseSplits`/`computeEqualSplit`/`computePercentageSplit`/`computeCustomSplit` from `src/domain/tripExpenseSplits.ts`.
- Both copies carry an explicit, mutual "this is duplicated at `<other path>` — keep in sync manually" comment, exactly matching the existing `tripPersonalBucketId` precedent's own wording convention.
- **Do not** attempt a shared npm package, a build-time file copy step, a symlink, or a monorepo restructure to avoid the duplication — all of those are real, disproportionate infrastructure investments for one already-small, already-frozen, rarely-changing pure-math module, and none of them are how this exact class of problem has been solved anywhere else in this codebase to date.
- **Mitigation against drift** (the real risk duplication introduces): the *tests* for the duplicated Functions-side copy should assert the identical input/output pairs already covered by `src/domain/__tests__/tripExpenseSplits.test.ts` — not a new, independently-designed test suite. If the two implementations ever diverge, a test on one side failing to match a fixture shared conceptually (not literally — the two test files live in genuinely separate Jest/`node --test` runners) with the other side's fixtures is the practical drift detector. This is a process recommendation, not a build-time enforcement mechanism, and is recorded honestly as such rather than oversold as automatic.

This directly answers the checkpoint's own instruction: reuse is **not** practical given the package boundary, and forcing it (e.g., relaxing `functions/tsconfig.json`'s `include` to reach outside `functions/`) would risk unintentionally bundling non-Functions application code into the Cloud Functions deploy artifact — a real deployment-surface-area concern, not just a style preference.

---

## 10. Timestamp model

| Field | Source | Notes |
|---|---|---|
| `createdAt` (Expense, each Split) | `FieldValue.serverTimestamp()` | Never client-supplied, matching every other trusted document in this codebase. |
| `occurredAt` (Expense, optional) | Client-selected event time, converted server-side | Same convention as `recordSavingsTransaction`'s own `occurredAt` handling: the client sends a plain ISO string representing "when did this expense actually happen" (which may differ from "when was it logged"); the server converts it to a `Timestamp` via `Timestamp.fromDate(new Date(input.occurredAt))` and validates it parses. **Never trusted as a server timestamp** — it is explicitly a client-asserted fact about the past, not a `serverTimestamp()` sentinel. See the clarification immediately below the table for its (corrected, Checkpoint 4C.1A) relationship to idempotency. |
| `updatedAt`/`lastUpdatedAt` | **Not needed in 4C** | 4C never mutates an existing Expense document — creation is the only write this callable performs (frozen decision F: corrections are always new documents, never mutations of financial facts). A future non-financial metadata-edit path (description/category/receipt only, per the original audit §9) would be the first thing to actually need `lastUpdatedAt`/`lastUpdatedBy` — not built or needed in 4C. |
| `reversedAt` | **Not written in 4C** | Reserved on the `Expense` type (already present) for a future reversal callable; 4C's `recordTripExpense` never writes it. |

**Distinguishing client-selected event time from server-created time is enforced structurally, not just by convention**: `occurredAt` and `createdAt` are two different fields on the persisted `Expense`, with two different trust levels, exactly mirroring `recordSavingsTransaction`'s existing precedent. There is no single "timestamp" field doing double duty.

**Correction (Checkpoint 4C.1A) — `occurredAt`'s relationship to idempotency, stated precisely to remove an inconsistency in the original 4C.1 draft:**
- **`occurredAt` is NOT the idempotency key.** `clientRequestId` alone is, and remains, the idempotency key (the document id itself, §5) — this is unchanged.
- **However, if `occurredAt` was part of the original creation request, its normalized value IS one of the facts compared** when determining whether a reused `clientRequestId` represents the exact same request (§5.2's `occurredAtInstantMs` field on the normalized snapshot). This is not a contradiction of the first point: the *key* used to look up a candidate prior request is `clientRequestId` alone; *whether that candidate is actually the same request* (versus a different request that happens to reuse the id) is a separate question, answered by comparing every meaningful fact of the request — `occurredAt` included, exactly like `amountMinor`, `description`, or any other field.
- **Normalization compares the parsed instant, not the original textual ISO representation.** `occurredAtInstantMs` is `Date.parse(input.occurredAt)` (a plain millisecond epoch number), not the raw string. This means two textually-different ISO representations of the same instant (e.g. an explicit `+00:00` offset vs. a trailing `Z`, or the same instant expressed with a different but equivalent UTC offset) compare as **identical** for replay purposes — a client-library or serialization difference in how the same moment is spelled out must never make an otherwise-identical retry look like a new, distinct Expense. `occurredAtInstantMs` is `null` when `occurredAt` was omitted from the original request, giving the snapshot a single stable, comparable shape in both cases (present-and-parsed vs. genuinely absent).

---

## 11. Reversal-ready schema (confirmed sufficient, one gap flagged)

The persisted `Expense` type already carries everything the frozen audit specified for reversal-readiness — **already shipped in Checkpoint 4B, re-verified here, not re-designed**:

```ts
status: ExpenseStatus;      // "active" | "reversed"
reversedAt?: PersistedTimestamp;
reversedBy?: string;
reversalReason?: string;
```

`recordTripExpense` in 4C only ever writes `status: "active"` and leaves the other three fields unset — no reversal callable is built in 4C at all (per frozen decision F, "the schema must support it," not "the callable must exist").

**How future reversal avoids rewriting original financial facts:** a reversal, when eventually built, would only ever add `status: "reversed"` plus the three metadata fields to the **existing** document — `amountMinor`, `payerUid`, `splitStrategy`, and every `ExpenseSplit` document tied to that `expenseId` remain byte-for-byte unchanged forever. `computeTripBalances` (already implemented and tested, §1) already has the `status === "reversed"` short-circuit that makes a reversed Expense contribute zero debt while its shape/total is still validated unconditionally (so a malformed record can never hide behind `"reversed"`) — this machinery is already correct and needs no change when the reversal callable itself eventually ships.

**One genuine gap, flagged rather than silently assumed away:** the current schema has **no field linking a reversed Expense to the new, corrected Expense that replaced it** (no `correctedByExpenseId`/`supersededBy`-style pointer in either direction). This means, today, "which new Expense corrected this old one?" is not machine-answerable from the data alone — only inferable by a human comparing description/amount/timing. This was already an explicitly-flagged open item in the original audit (§19 item 6, "exact reversal-record shape... a 4B/4C design detail to finalize") and Checkpoint 4B finalized the *reversal-marking* half of that shape but not a correction-linking field. **Recommendation: do not add one in 4C** — 4C doesn't build the reversal callable at all, so a linking field would be speculative schema-widening ahead of the checkpoint that actually needs it. This is recorded as an explicit unresolved question for whichever future checkpoint builds the reversal callable (§17), not something 4C should preemptively solve.

**Release-gate note (Checkpoint 4C.1A):** "the schema must support reversal" and "Expense creation is safe to enable for real users" are two different claims — see §16's explicit real-user beta gate for why a trusted reversal path must exist *before* Expense creation is enabled for real-user/manual-money use, even though 4C itself does not need to build that reversal callable.

---

## 12. Archive interaction

**New Expense creation against an archived Trip → `failed-precondition`.** This matches the archive preflight's own §12 recommendation exactly (re-confirmed, not reopened): an Expense is new spending/obligation-creating activity, which is precisely what archiving is meant to close off — the identical reasoning already applied to blocking new Shared Stash *contributions* (4B.5C) against an archived Trip.

**Exact idempotent-replay analysis, worked through explicitly (the checkpoint's own required analysis):** consider an Expense successfully created while a Trip was still active, whose exact `clientRequestId` is retried after the Trip later becomes archived.
- Per §7 step 3, the idempotent-replay check runs **before** the archive check (step 5) — an exact match on the stored `creationRequest` snapshot returns the original result immediately, without ever reaching the archive check at all.
- **Therefore the already-committed Expense reconciles successfully on replay, exactly as if the Trip were still active** — this is the same principle 4B.5C.1 already established and hardened for `recordSavingsTransactionCore`'s contribution path, applied here without modification.
- A **new** `clientRequestId` (a genuinely new logical request) against the now-archived Trip reaches step 5 and is rejected with `failed-precondition`, regardless of how similar its facts are to a prior successful Expense.

**Settlements remain unaffected by archive state** (frozen decision G, re-confirmed against the archive preflight §5.G/§12: "reject new Expense creation... continue to allow Settlement creation") — not relevant to 4C's actual scope since no Settlement callable exists yet, but recorded here so 4E's own preflight/implementation doesn't have to re-derive this from scratch.

---

## 13. Firestore Rules model

**Trusted callable/Admin SDK is the sole writer. Client access is read-only, reusing the `canAccessParent()` idiom.**

```
match /tripExpenses/{expenseId} {
  // Reuses the exact canAccessParent()-style cross-reference already
  // proven for savingsTransactions - adapted so the parent is always a
  // Trip (never a Bucket), since Expenses are Trip-only (audit §1).
  allow get, list: if signedIn()
    && resource.data.tripId is string
    && exists(/databases/$(database)/documents/trips/$(resource.data.tripId))
    && (
      request.auth.uid in get(/databases/$(database)/documents/trips/$(resource.data.tripId)).data.memberIds
      || get(/databases/$(database)/documents/trips/$(resource.data.tripId)).data.ownerId == request.auth.uid
    );

  // Trusted-callable-only, matching savingsTransactions' exact posture.
  allow create, update, delete: if false;
}

match /tripExpenseSplits/{splitId} {
  // Identical shape - split documents carry their own denormalized
  // tripId (audit §7/§13), so this rule does not need to look up the
  // parent Expense at all, only the parent Trip.
  allow get, list: if signedIn()
    && resource.data.tripId is string
    && exists(/databases/$(database)/documents/trips/$(resource.data.tripId))
    && (
      request.auth.uid in get(/databases/$(database)/documents/trips/$(resource.data.tripId)).data.memberIds
      || get(/databases/$(database)/documents/trips/$(resource.data.tripId)).data.ownerId == request.auth.uid
    );

  allow create, update, delete: if false;
}
```

Not implemented in this preflight — Rules text above is a concrete proposal for the 4C.2B checkpoint (§16), not a diff to apply now.

**Archived Trips remain fully readable — confirmed, no conflict found.** The rule above only checks `exists(...)` and membership, exactly like `canAccessParent()` does for `savingsTransactions` today; it never inspects `archivedAt`. This matches the archive preflight's own §5.B finding verbatim ("Trip Detail is not blanket read-only... Still fully readable") and needs no special-casing — an archived Trip's Expense history stays visible for exactly the same structural reason its `savingsTransactions` history already does.

**Minimum client access required, stated explicitly:** member `get`/`list` only. No client `create` (server must derive `createdBy`, validate splits, and enforce idempotency — none of which Rules alone can express). No client `update` (an Expense's financial facts are immutable by design — frozen decision F — and even the eventual reversal callable will need transactional read-then-write logic Rules cannot provide). No client `delete` (matches this codebase's now-uniform "no financial record is ever client-hard-deletable" posture — `savingsTransactions` has no delete rule at all; `trips` itself closed hard-delete entirely in 4B.5B).

---

## 14. Query/index implications

No index changes are needed **in 4C itself** — `recordTripExpense` only ever performs point-reads (`tx.get(expenseRef)`, `tx.get(tripRef)`) and point-writes, never a list query. The following become necessary starting at whichever checkpoint first issues them (most likely 4D, per the checkpoint's own explicit "do NOT jump into 4D UI" instruction — recorded here for that checkpoint's benefit, not built now):

| Future query (4D+) | Shape | Index needed |
|---|---|---|
| Trip Detail expense list | `tripExpenses where tripId == X order by createdAt desc` | Composite (`tripId` ASC, `createdAt` DESC) — same shape as the existing `savingsTransactions` composite index in `firestore.indexes.json` today |
| Expense split breakdown | `tripExpenseSplits where expenseId == X` | Single-field, automatic — no composite needed |
| My activity across trips (future) | `tripExpenses where payerUid == me order by createdAt desc` | Composite (`payerUid` ASC, `createdAt` DESC) |
| Balances derivation | Fetch all `tripExpenses`+`tripExpenseSplits` for a `tripId`, feed to the already-implemented `computeTripBalances` | Same composite as the first row above; no new index type |

No `collectionGroup` query is required anywhere in this design — every query shape above is an ordinary `where`/`orderBy` on a flat top-level collection, consistent with every existing query in this codebase.

---

## 15. Threat model

| Threat | Where it's stopped | How |
|---|---|---|
| Outsider attempts Expense creation | §7 step 4 | `permission-denied` — `authUid` not in Trip `memberIds`/`ownerId`. |
| Member forges `payerUid` (names a non-member) | §7 step 6 | `failed-precondition` — payer membership re-checked fresh from the just-loaded Trip document, never trusted from client input. |
| Caller injects split participants who are not Trip members | §7 step 7 | `failed-precondition` per offending uid, same fresh-read pattern. |
| Duplicate `clientRequestId`, identical facts, **same** original creator | §5.1, §5.2, §7 step 3 | Reconciles to original result — no new write, no new debt, no error. Succeeds even if the Trip has since been archived or the creator has since been removed from Trip membership (historical reconciliation, not fresh authorization). |
| Same `clientRequestId`, identical facts, but submitted by a **different** authenticated member (Checkpoint 4C.1A) | §5.1, §7 step 3 | `already-exists` — creator mismatch is checked first, before the facts comparison, so a different member can never inherit or "adopt" another creator's already-committed Expense merely by independently producing matching facts. No new write, no new debt. |
| Same `clientRequestId`, different facts, same creator | §5, §7 step 3 | `already-exists`. |
| Same `clientRequestId`, different facts, different creator | §5.1, §7 step 3 | `already-exists` — same outcome/error as every other id-collision case; the creator check alone is sufficient to reject before the facts are even compared. |
| Client-array-ordering difference in `participants` used to disguise/hide a request-identity change | §5.2 | Neutralized structurally — the normalized snapshot sorts participants by ascending `uid` before storage/comparison, so array order can never affect whether two requests are judged identical. |
| Textually-different but semantically-identical `occurredAt` ISO strings treated as different Expenses | §10 | Neutralized — the snapshot compares the parsed instant (`occurredAtInstantMs`), not the original string, so equivalent instants always compare equal regardless of textual representation. |
| `amountMinor <= 0` | §7 Phase 1, step 2 | `invalid-argument`, rejected before any Firestore access. |
| Unsafe integer `amountMinor` | §7 Phase 1, step 2 | `invalid-argument` (`Number.isSafeInteger` check, identical guard used everywhere else in this codebase). |
| Split totals mismatch | §7 step 8 | The duplicated `computeExpenseSplits`/`computeCustomSplit` throws; re-surfaced as `invalid-argument`. Never silently adjusted to force a match (frozen domain behavior, §1). |
| Malformed percentage split (basis points don't sum to 10000, or non-integer) | §7 step 8 | Same path — `computePercentageSplit` already rejects both cases today. |
| Malformed custom split (off by even one cent) | §7 step 8 | Same path — `computeCustomSplit` already rejects this exactly today. |
| Ambiguous split-document-id collision — two different `(expenseId, participantUid)` pairs produce the same raw-concatenation string (e.g. `expenseId="abc_def"`+`participantUid="ghi"` vs. `expenseId="abc"`+`participantUid="def_ghi"`), letting a later `tx.set()` silently overwrite an unrelated Expense's split document (Checkpoint 4C.1B) | §5.3 | Closed structurally, not merely mitigated: `splitDocumentId` is a SHA-256 hash of `JSON.stringify([expenseId, participantUid])`, whose unambiguous array-serialization delimiting makes the two components uncollide-able for any two distinct pairs — never a raw underscore join of the two raw strings. §16 4C.2C test cases A–D are the direct regression coverage for this row. |
| Caller injects `receiptImageUrl` (a valid field name on the persisted `Expense` type) into the request | §6.1, §7 Phase 1 step 7 | `invalid-argument` — rejected outright before any Firestore access, never silently dropped or silently persisted. |
| Caller injects `sharedStashTransactionId` in a 4C request | §6, §7 Phase 1 | `invalid-argument` — not an accepted input field for this phase at all. |
| Archived Trip, new Expense | §7 step 5, §12 | `failed-precondition`, placed after caller authorization (no leak to an unauthorized caller — see below). |
| Trip archived **concurrently** with Expense creation (race) | §8 | The Firestore transaction reads the Trip document fresh inside the same transaction that performs the archive check and the eventual write — Firestore's transaction semantics guarantee this read is consistent with the commit, so a concurrent archive either loses the race (Expense commits against the pre-archive state, which Firestore will retry/reconcile per its normal contention rules) or wins it (the transaction's own re-read sees the now-archived Trip and rejects) — there is no window where an Expense could commit against a Trip the transaction itself observed as archived. |
| Trip member removed concurrently with Expense creation | §8 | Identical mechanism — `memberIds` is re-read inside the same transaction that performs the membership check, so a concurrent removal is either not yet visible (pre-removal state, consistent) or already visible (removal wins, membership check fails) — never a torn read. |
| Client direct-writes an Expense document | §13 | `allow create: if false` — no exception for any role. |
| Client direct-writes a Split document | §13 | `allow create: if false` — same posture. |
| Client modifies/deletes a persisted Expense | §13 | `allow update, delete: if false` — matches `savingsTransactions`' append-only posture exactly. |
| Client modifies/deletes a Split | §13 | Same rule, same posture. |
| Future reversal authorization | §11, §17 | Not built in 4C; flagged as an explicit unresolved question for whichever checkpoint builds it, not silently assumed. |
| Information leakage from validation ordering | §7 | Explicitly worked through: an unauthorized caller's error is `permission-denied` regardless of the Trip's actual archive state, membership size, or anything else about it — the archive check never runs before authorization succeeds. This is the direct, deliberate reuse of the 4B.5C.1 hardening lesson, not a new analysis performed from scratch. |

---

## 16. Recommended implementation checkpoints

Three checkpoints, smaller and more incrementally reviewable than a single "build it all" pass — matching this project's own established rhythm of a substantial implementation checkpoint followed by a dedicated hardening pass (4B→4B.1→4B.2, 4B.5C→4B.5C.1, 4B.5B.1→4B.5B.1A):

**4C.2A — Persisted schema + trusted `recordTripExpense` callable foundation**
- Duplicate the split-math domain functions into `functions/src/domain/tripExpenseSplits.ts` per §9, with the mutual cross-reference comment.
- Implement the collision-safe `splitDocumentId(expenseId, participantUid)` SHA-256 derivation per §5.3 (Node's built-in `crypto` module, no new dependency) — this must land in the same checkpoint as the callable itself, not deferred, since it is the write target for every `ExpenseSplit` document the callable produces.
- Implement `functions/src/callables/recordTripExpense.ts` per §6/§7/§8 (contract, authorization order, transaction).
- Export from `functions/src/index.ts`.
- A first pass of focused Functions/emulator tests mirroring `functions/test/recordSavingsTransactionCore.ts`'s own structure — the core happy-path and the most direct authorization/idempotency cases, not yet the full threat-model sweep.
- **Firestore Rules for `tripExpenses`/`tripExpenseSplits` remain untouched in this checkpoint** — the collections do not need to be independently client-readable yet for the callable itself to work (Admin SDK bypasses Rules entirely), and building the Rules against a collection shape that doesn't exist yet risks designing against assumptions rather than the callable's actual persisted output.

**4C.2B — Firestore Rules + emulator tests**
- Add the `tripExpenses`/`tripExpenseSplits` match blocks per §13, now validated against 4C.2A's actual persisted document shape.
- Rules emulator tests: member read succeeds, outsider read fails, unauthenticated read fails, direct client create/update/delete all fail for every role including the Expense's own `createdBy`/`payerUid`, archived-Trip read still succeeds (§12/§13's explicit claim, made into a real regression test).

**4C.2C — Callable hardening pass**
- Full threat-model sweep from §15 as individual, named Functions/emulator tests: forged `payerUid`, non-member split participant, duplicate/mismatched `clientRequestId`, every split-math rejection path, archived-Trip rejection (new id) and archived-Trip reconciliation (exact replay), concurrent-archive and concurrent-member-removal races (to the extent they're practically simulable against the emulator), rejected `receiptImageUrl`/`sharedStashTransactionId` injection, and an explicit "outsider gets `permission-denied` regardless of archive state" information-leakage regression test.
- **New (Checkpoint 4C.1A) — creator-bound replay test cases, required additions to this pass:**
  - **A. Original creator, exact replay, after the Trip was later archived → success.** Reconciles to the original result; no new write.
  - **B. Original creator, exact replay, after the creator was later removed from Trip membership → success.** Reconciles to the original result even though the creator would now fail an ordinary (non-replay) membership check.
  - **C. A different authenticated Trip member submits the same `clientRequestId` with an identical (byte-for-byte, post-normalization) Expense request → `already-exists`, NOT success.** This is the core regression test for §5.1's creator-binding fix — it must never silently succeed as if it were the original creator's own replay.
  - **D. A different authenticated member submits the same `clientRequestId` with different facts → `already-exists`.** Same outcome as C — confirms the creator check alone is sufficient to reject, independent of whether the facts also happen to differ.
  - **E. No additional `tripExpenses`/`tripExpenseSplits` writes occur on any replay** (cases A, B, and the original creator's own ordinary same-facts replay) — assert collection counts are unchanged after each replay attempt, mirroring the existing "a failed withdrawal creates no ledger document" regression-test convention already used in `functions/test/recordSavingsTransactionCore.ts`.
- **New (Checkpoint 4C.1B) — split-document-id collision-safety test cases, required additions to this pass:**
  - **A. Same `expenseId` + same `participantUid` → the same `splitDocumentId`**, computed independently on repeated calls (proves the function is a pure, deterministic function of its two inputs, not merely "looks stable" by observation of one run).
  - **B. The exact concatenation-collision pair named in this hardening checkpoint — `("abc_def", "ghi")` vs. `("abc", "def_ghi")` — produce DIFFERENT `splitDocumentId`s.** This is the direct regression test proving the underscore-concatenation hazard is actually closed, not just reasoned about in prose.
  - **C. Generated id is stable across repeated calls within the same process and across process restarts** (i.e., not seeded by anything but the two string inputs — no timestamp, no random salt, no in-memory counter).
  - **D. One Expense cannot overwrite another Expense's split document because of component-boundary ambiguity** — an end-to-end version of test B: create two Expenses whose `(expenseId, participantUid)` pairs would collide under the old naive-concatenation scheme, assert both `ExpenseSplit` documents exist independently with their own correct `expenseId`/`userId`/`amountMinor` field values, and that creating the second never silently overwrote the first.
- This mirrors the exact shape of every prior hardening checkpoint in this milestone (4B.1, 4B.2, 4B.5C.1) — a dedicated review-and-fix pass after the foundational implementation has already been reviewed once, not a first-draft dumping ground.

**Do not jump to 4D UI** until 4C.2A–4C.2C are all reviewed and merged, per the checkpoint's own explicit instruction. 4D **development** may still begin after 4C.2A–C if desired — the real-user release gate below is a separate, later gate, not a block on UI development itself.

A reasonable alternative sequencing — Rules-and-tests-first (matching how `savingsTransactions`' own `allow create: if false` shipped in the same checkpoint that closed direct writes, before `recordSavingsTransaction` existed) is not wrong, but the sequence above is preferred here specifically because `recordTripExpense`'s persisted shape (particularly the `creationRequest` snapshot content, §5) is a genuinely new design in this checkpoint, not a well-established existing shape the way `savingsTransactions`' shape already was when its Rules closed. Designing the Rules against a shape not yet implemented risks a mismatch discovered only during 4C.2B; implementing the callable first removes that risk. This is a minor, non-blocking sequencing preference, not an unresolved question.

### 4C.3 — Trusted Expense Reversal/Correction Foundation (required release gate, not designed here)

**Checkpoint 4C.1A adds this as an explicit, named future checkpoint and real-user release gate — not designed or implemented now.**

Reasoning: an Expense's financial facts (`amountMinor`, `payerUid`, `splitStrategy`, every `ExpenseSplit`) are immutable by design (frozen decision F, §2), and direct client `update`/`delete` on `tripExpenses`/`tripExpenseSplits` is permanently closed (§13). This is the correct design for data integrity, but it has a direct consequence that must be named plainly: **without a trusted reversal/correction path, an accidental or fraudulent Expense would remain permanently active in every derived balance (`computeTripBalances`, §1), with no way for anyone — including the Trip owner — to correct it.** A typo'd amount, a wrong payer, or a genuinely malicious false Expense would be stuck forever.

**Explicit gate: SquadStash must NOT enter real-user/manual-money beta with Expense creation enabled unless a trusted reversal/correction path exists and has been reviewed.** This is a release gate on *real-user use of the feature*, not a gate on *building or testing* it — 4C.2A through 4C.2C (persisted Expense creation, fully tested against the Firestore emulator) may be developed, reviewed, and merged entirely before 4C.3 exists; only enabling the feature for real users with real money is gated on 4C.3 also existing and being reviewed. This mirrors the exact shape of the 4B.5B/4B.5C deployment gate already established this milestone (archive lifecycle UI could be built and reviewed on its own, but was not permitted to *deploy* until the trusted backend enforcement half also shipped) — the same "build ahead, gate deployment/real-use" pattern, applied to a different feature.

**Not designed here — recorded at minimum, per the checkpoint's own instruction, so 4C.3's own preflight does not start from zero:**
- **Authorization model**: who may reverse/correct an Expense — the frozen 4A/4A.1 audit's own (unimplemented, not yet re-verified) recommendation was `createdBy`, `payerUid` (when present), or the Trip owner, "given the financial-correction blast radius" — this needs its own dedicated review when 4C.3 is actually scoped, not adopted automatically from a pre-4C audit pass.
- **Correction-link semantics**: §11's flagged gap (no field connecting a reversed Expense to its replacement) must be resolved as part of 4C.3's own schema work, not deferred again.
- **Idempotency**: a reversal callable will need its own replay/idempotency design — likely the same `clientRequestId`-as-document-id-on-a-new-collection pattern already proven three times in this codebase now (`savingsTransactions`, Bucket creation, and this preflight's own `tripExpenses`), but this is explicitly not decided here.

**Placement relative to 4D**: 4D (Trip Detail "Expenses" list + "+ Add Expense" UI) may proceed after 4C.2A–C for development purposes, but the combination of "4D UI is live" and "real users can create real Expenses" should not reach production/real-user beta without 4C.3 also being complete — matching the same logic as the archive lifecycle's own two-part gate.

---

## 17. Unresolved questions (explicitly flagged, not silently assumed)

1. **Whether `functions/src/callables/recordTripExpense.ts` should inline the duplicated split-math or place it in its own `functions/src/domain/` file** (§9) — a call best made once the actual duplicated surface area is visible during 4C.2A implementation, not speculated here.
2. **No correction-linking field exists between a reversed Expense and the new Expense that replaced it** (§11) — an already-known gap from the original audit's §19 item 6, not resolved by Checkpoint 4B's shipped reversal-marking fields, and explicitly not resolved by this preflight either. Flagged for whichever future checkpoint actually builds the reversal callable.
3. **Whether a Shared-Stash-paid Expense should still generate a split for reporting purposes** — unchanged from the original audit's §19 item 1; irrelevant to 4C's actual scope (out-of-pocket only) but restated here so 4F's own preflight doesn't have to rediscover it.
4. **Exact HttpsError code for "payer/participant is not a current Trip member"** — this preflight recommends `failed-precondition` (§7 steps 6–7) for consistency with `recordSavingsTransactionCore`'s own code-family convention, but this is a judgment call worth explicit confirmation during 4C.2A review, not a settled architectural fact the way the archive-check code (`failed-precondition`, directly stated by the archive preflight itself) already is.
5. **Whether 4C.2A/4C.2B/4C.2C should instead ship as one combined checkpoint** — §16 recommends splitting them for reviewability, matching this project's established rhythm, but this is a process preference, not a technical requirement; nothing in this design changes if a reviewer prefers a different split.

---

## 18. Conclusion

**DO NOT IMPLEMENT ANY PART OF THIS DESIGN YET.** This document (as hardened by Checkpoints 4C.1A and 4C.1B) resolves the persistence-architecture, creator-bound idempotency, collision-safe split identity, authorization-ordering, atomicity, and Rules questions left open after the frozen 4A/4A.1 audit, re-verified against the current repository (through Checkpoint 4B.5C.1/4B.5B.1A) rather than assumed unchanged. No application code, Firestore Rules, Cloud Functions, tests, or dependencies were modified to produce the original 4C.1 pass or either the 4C.1A or 4C.1B amendments — only this markdown file was ever touched.

---

### Validation

```
git diff --check     -> no output (no whitespace/conflict issues)
git status --short   -> ?? docs/audits/TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md
```

No production code, Firestore Rules, Cloud Functions, tests, or dependencies were modified. Only this markdown file was created.

CHECKPOINT 4C.1 OUT-OF-POCKET EXPENSE PERSISTENCE PREFLIGHT READY FOR REVIEW (hardened by 4C.1A, then 4C.1B)

DO NOT IMPLEMENT.
DO NOT COMMIT.
DO NOT PUSH.
DO NOT DEPLOY.
STOP.
