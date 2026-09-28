# Trip Balances & Settlements Preflight (Checkpoint 4E.0, hardened by 4E.0A)

**Status: DESIGN/AUDIT ONLY. Nothing in this document has been implemented.** No application code, Firestore Rules, Cloud Functions, or dependencies were touched to produce this document — only this markdown file exists as output.

**Baseline:** `Danielfredrickson11/squadstash`, branch `claude/milestone-3-personal-savings-mvp`, HEAD `cb4b1a2e16afafb99ace39329d21eaa0bbb08ad9` ("Improve expense form accessibility"), clean working tree confirmed before writing this document and re-confirmed before this 4E.0A hardening pass.

**Checkpoint 4E.0A amendments (applied throughout this revision, each marked inline where it changes prior text):** (1) both `fromUid` and `toUid` must now be current Trip members for a NEW Settlement — a departed `fromUid` is deferred, not supported, in 4E MVP; (2) the `Settlement` domain type itself must be extended with `status`/`reversedAt`/`reversedBy`/`reversalReason` as part of 4E.1, before the engine can inspect `Settlement.status` — the original 4E.0 draft had the engine referencing a field the type didn't yet declare; (3) the 4E manual Settlement UI never collects/sends `occurredAt` — no date-only-to-instant invention, mirroring the Expense UI's own frozen no-date-field policy; (4) the implementation sequence is corrected so Firebase emulator execution is never treated as a deployment, and production deployment is split into its own explicit, separately human-authorized checkpoint (4E.2D).

**Purpose:** freeze the safe implementation sequence for Trip Balances & Settlements (4E) against the repository **as it actually exists today** — after Expense persistence (4C), reversal (4D.6), correction (4D.7/4D.7A), and the full 4D UI/accessibility pass (4D.8) — not against the September 13 architecture audit's original assumptions in isolation. Every recommendation below is checked against real, current code, and every place the old audit's assumptions have since been superseded by what actually shipped is called out explicitly.

---

## 1. Current repository findings

Files read in full for this preflight (beyond what earlier 4B–4D checkpoints already established and are reused here without re-verification):

- `docs/audits/TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md` (§§8–19, the Settlement/balance-engine sections)
- `docs/audits/TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_2026-09-13.md` (§§5, 12, the archived-Trip Settlement rule)
- `docs/audits/TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md` (already fully internalized from the 4D checkpoint sequence)
- `src/domain/tripSettlement.ts` (full file — the balance engine)
- `src/domain/__tests__/tripSettlement.test.ts` (full file — 30+ existing tests)
- `src/types/domain/settlement.ts`, `src/types/domain/trip.ts` (full files)
- `functions/src/callables/recordSavingsTransaction.ts` (full file — idempotency/archive-gate-ordering precedent)
- `functions/src/callables/recordTripExpense.ts` / `reverseTripExpense.ts` (re-confirmed against current HEAD; both already deeply read in earlier 4D checkpoints this session)
- `functions/src/index.ts` (callable export registration)
- `firestore.rules` (the `tripExpenses`/`tripExpenseSplits` block and `canAccessTripById()` helper, in full)
- `firestore.indexes.json` (full file — **zero** indexes exist for `tripExpenses`/`tripExpenseSplits` today)
- Repo-wide search for `Settlement`, `tripSettlements`, `recordTripSettlement`, `computeTripBalances`, `fromUid`, `toUid` across `src/`, `functions/`, `app/`

**Headline finding:** the balance **engine** is fully implemented, fully tested, and unchanged since Checkpoint 4B. Absolutely nothing else related to Settlements exists — no service layer, no callable, no Firestore Rules, no UI, no index. The only non-comment repository-wide hits for `Settlement`/`tripSettlements`/`recordTripSettlement` are the type definition, the engine, and its test file. 4E starts from a solid, already-proven foundation but is otherwise a completely green field.

---

## 2. Implemented vs. missing matrix

| Area | Status |
|---|---|
| `Settlement` / `CreateSettlementInput` types (base fields) | **ALREADY IMPLEMENTED** — `src/types/domain/settlement.ts`, unchanged since 4B |
| `Settlement.status`/`reversedAt`/`reversedBy`/`reversalReason` fields | **NOT YET IMPLEMENTED, REQUIRED BEFORE 4E.1's ENGINE CHANGE** — corrected by 4E.0A; §10 freezes the exact extension, §19 places it at the start of 4E.1 |
| `computeTripBalances()` pure engine | **ALREADY IMPLEMENTED** — `src/domain/tripSettlement.ts`, 30+ passing tests |
| `assertValidExpensePaymentShape` / `assertUsdCurrency` | **ALREADY IMPLEMENTED**, reused by the engine |
| `recordTripSettlement` Cloud Function | **NOT IMPLEMENTED** — no file exists, not exported from `functions/src/index.ts` |
| `tripSettlements` Firestore Rules | **NOT IMPLEMENTED** — no `match /tripSettlements/...` block exists |
| `tripSettlements` Firestore index | **NOT IMPLEMENTED** — not present in `firestore.indexes.json` (and, per §14 below, not actually needed) |
| `src/services/firebase/settlements.ts` (or equivalent) | **NOT IMPLEMENTED** |
| Settlement reversal/correction (any shape) | **NEW DECISION REQUIRED** — no prior design commits to a specific shape; §10 (schema/type) and §11 (design) below freeze one together |
| Balances/"Settle Up" UI | **NOT IMPLEMENTED** — no route, no component |
| Departed-member settlement behavior | **NEW DECISION REQUIRED** — never previously resolved; §7 below freezes it (revised by 4E.0A: a NEW Settlement requires both `fromUid` and `toUid` to be current members; a departed member's existing debt remains visible/derived, never newly settleable, until a future design) |
| Over-settlement policy | **DESIGNED, NOT IMPLEMENTED** — Sept 13 audit §19 item 2 recommended soft-warning; §9 below re-confirms this against current architecture |
| Archived-Trip Settlement policy | **ALREADY DECIDED** (not yet implemented) — Archive preflight §5.G / §12 already froze "Settlement creation stays allowed, no archive gate"; §10 below reconfirms this holds |
| Trip membership model (`deriveCurrentMemberUids`, `isCurrentTripMember`) | **ALREADY IMPLEMENTED**, directly reusable |
| Expense reversal idempotency pattern (`clientRequestId`-as-doc-id + stored replay snapshot) | **ALREADY IMPLEMENTED** for Expenses; directly reusable template for Settlements |

---

## 3. Balance-engine assessment

`computeTripBalances(expenses, splits, settlements, tripId)` in `src/domain/tripSettlement.ts` already does everything §4 of the checkpoint asked me to confirm or challenge. Confirmed line-by-line against the current source and its test suite:

- **Reversed Expenses contribute zero** — shape/total validation runs unconditionally (a malformed record can't hide behind `status: "reversed"`), but the debt-accumulation step is skipped via `if (expense.status === "reversed") continue;`. Tested (`tripSettlement.test.ts` #35, plus the dedicated "validation is not skipped" test for a reversed zero-split expense).
- **Payer's own share contributes zero self-debt** — `if (split.userId === payerUid) continue;`. Tested (#24, #25).
- **Shared-Stash-funded Expenses contribute zero member-to-member debt** — `if (expense.paymentSource !== "member_out_of_pocket") continue;`, even when splits exist for reporting. Tested (#36).
- **Direct pairwise netting, not a graph** — a single `Map<"a|b", signedNet>` keyed by the lexicographically-ordered pair. Two different Expenses between the same pair net into one obligation (#28, #29); genuinely transitive chains (A owes B, B owes C) are **never** collapsed into "A owes C" — explicitly tested (#30) with an assertion that no A→C entry is ever produced. **No change recommended** — I found no repository-backed reason to introduce transitive simplification, and the existing test explicitly locks the current behavior in. This preflight does not recommend changing that frozen product rule.
- **Settlement subtraction and over-settlement direction-flipping** — a `Settlement` is applied as `addDebt(fromUid, toUid, -amountMinor)` through the *same* signed accumulator used for Expense-derived debt. An exact settlement nets to exactly zero and produces **no entry at all** (never a stray `{amountMinor: 0}` row) — tested (#32). An over-settlement naturally flips the pair's direction with no clamping and no special-casing — tested (#33).
- **Deterministic output ordering** — sorted by the canonical `"a|b"` key string, independent of input array order. Tested (#45, feeding the same data in two different orders and asserting identical output).
- **Safe-integer protection** — every individual amount (`isSafePositiveInteger`/`isSafeNonNegativeInteger`), every per-Expense split-sum, and the **running accumulated net per pair** are all independently checked after every addition, throwing before an unsafe value could ever be compared or returned. Tested explicitly for both a per-Expense overflow and a cross-Expense running-total overflow.
- **USD-only** — `assertUsdCurrency` rejects any Expense or Settlement whose `currency !== "USD"`, never silently converts or nets mixed currencies. Tested (#42, #43).
- **Malformed-history fail-closed behavior** — non-empty-id checks (including whitespace-only rejection) on every identifier that affects a financial relationship; duplicate-Expense-id, duplicate-split, duplicate-Settlement-id, orphan-split, wrong-`tripId`, self-settlement (`fromUid === toUid`), and mismatched-split-total are all explicit thrown errors, never silent corrections. Every one of these has a dedicated test.

**No code change to `tripSettlement.ts` is recommended by this preflight.** The engine is already exactly the "Expense + ExpenseSplit + Settlement = derived balances" model the checkpoint asked me to keep, with no cached `balance`/`amountOwed`/`amountDue`/`settled`/`settledAt` field anywhere on `Expense`, `ExpenseSplit`, `Trip`, or any membership record — confirmed by reading `src/types/domain/expense.ts` and `src/types/domain/trip.ts` in full: neither type carries any such field today, and nothing in 4C/4D/4D.6/4D.7 introduced one. This preflight recommends **continuing that discipline** for 4E: no cached balance field is introduced anywhere, ever.

---

## 4. Balance UI model

**Recommendation: every current Trip member sees the full pairwise graph, not only balances involving themselves.**

Basis: this app's own established shared-Trip transparency model. The existing 4D Expense-read Rules comment states the precedent explicitly (`firestore.rules`, `tripExpenses`/`tripExpenseSplits` block): *"a current Trip member may read every split belonging to their Trip's Expenses, not only splits where they are the named participant — these are shared Trip financial records, not private-to-the-named-user documents."* The Sept 13 audit's own Settlement-read row (§10) says the same thing: *"Read reimbursements: Any current Trip member (same transparency rationale as expense reads)."* Nothing in the repository suggests member-scoped balance visibility; a Trip is a shared financial context by design, and "who owes whom" is already fully visible today through the raw Expense/Split history — hiding it in the derived Balances view while it's fully reconstructable from data the same member can already read would be security theater, not real privacy.

Recommended information hierarchy for **Trip Detail → Balances / Settle Up**:

```
Trip Detail
  -> Balances card (new, alongside the existing Expenses/My Stash/Shared Stash cards)
       Summary line, from the CURRENT signed-in member's own perspective:
         "You owe $42.00" / "You're owed $42.00" / "You're all settled up"
         (mirrors the existing "You owe"/"You're owed" framing already
         implied by the checkpoint prompt - no new visual language needed,
         reuses this app's existing card/cardHeaderRow/iconBubble shell)
       -> "View all balances" (or inline, space permitting) - the full
          pairwise graph: one row per non-zero TripBalance, "<fromName>
          owes <toName> · $X.XX", using the SAME already-resolved-identity/
          avatar pattern ExpenseRow/MemberSelectRow already establish
          (never a raw uid)
       -> "Settle Up" CTA (recipient-scoped, see §5/§6) opens the Record
          Settlement form/dialog for a specific pairwise debt
```

Loading/error/empty states (mirrors the exact existing Expense-card conventions, per §15/§19 below):
- **No-balance state:** "You're all settled up." — shown once all three source reads succeed and `computeTripBalances` returns `[]`. Never conflated with "still loading."
- **Loading state:** a single `ActivityIndicator` + "Loading balances…", shown until *all* required source reads (§15/§16) have completed at least once — never a partial render from whichever source happened to resolve first.
- **Malformed-data state:** `computeTripBalances` throws (a genuinely corrupted record) → an explicit "We couldn't calculate balances for this trip." + Retry, mirroring the existing "This record couldn't be loaded" philosophy from the UI preflight §30/§8 rather than crashing the screen or silently omitting the bad record.
- **Permission/read failure:** identical treatment to every other Expense-adjacent listener failure in this app — inline error + explicit Retry button, never an assumed self-recovery.
- **Current vs. historical members:** every row still renders using whatever identity facts remain resolvable (§7 below) — a departed member's balance row does not disappear, it uses the same "Trip member"/"Trip member N" fallback already established for a missing profile.

**Never expose:** another member's My Stash, `trip_personal` Bucket balances, or another member's private personal savings — reconfirmed in §17.

---

## 5. Settlement product semantics

**Frozen meaning, unchanged from the Sept 13 audit and reconfirmed against current code: a `Settlement` record means "money was paid externally and the recipient confirms they received it." SquadStash does not move money in 4E — the Sept 13 audit's own `Settlement` doc comment already says as much ("This records that an external payment happened — SquadStash never processes or moves money itself"), and nothing since has touched that type.**

**The `toUid`-only creation rule remains the safest MVP design.** Re-evaluated against current code, not just the old audit's reasoning:
- The only trusted precedent this codebase has for "who may assert a financial fact happened" is **self-attestation of the recipient's own receipt** — `recordSavingsTransaction` already requires `authUid === input.memberUid` (a member can only ever record *their own* contribution/withdrawal, never assert something on someone else's behalf). A Settlement's closest analogue to that self-only precedent is the **recipient** confirming receipt, not the payer asserting they paid (the payer has an obvious incentive to prematurely or falsely clear their own debt; the recipient has none).
- Nothing added since the original audit (Expense reversal, correction, archive hardening) changes this reasoning. If anything, 4D.6/4D.7's own hard-won ambiguous-outcome lessons reinforce it: allowing unilateral payer-side settlement would create exactly the kind of unverifiable, disputed financial claim this codebase's entire reversal/correction design has been fighting to avoid.

**Do not add a pending-payment request/accept state in 4E.** The Sept 13 audit explicitly named this as legitimate future work and deliberately deferred it (§10: *"a payer-initiated pending reimbursement... introduces a new lifecycle/state machine this milestone deliberately avoids"*). I found no repository evidence since then that changes this call — no state-machine infrastructure for a multi-step confirm flow exists anywhere in this codebase yet (the closest analogue, Expense correction, is a two-step **trusted-server** sequence, not a peer-to-peer request/accept flow), and building one exclusively for Settlement would be new complexity introduced without a caller. **Explicitly deferred to a future milestone**, noted again in §22.

---

## 6. Settlement write authority

Freezing the exact backend authorization for the future `recordTripSettlement`, modeled directly on `recordTripExpense`'s already-proven authorization ordering (`functions/src/callables/recordTripExpense.ts`, confirmed current).

**Checkpoint 4E.0A amendment:** the original 4E.0 draft allowed an arbitrary, non-current `fromUid` on the theory that they might be a legitimate departed member. That is corrected below — **both `fromUid` and `toUid` must be current Trip members for a NEW Settlement.** See §7 for the full reasoning.

| Actor | Requirement |
|---|---|
| Authenticated caller | Must be signed in (`requireAuthenticatedUid`, identical guard to every existing callable) |
| Authenticated caller | **Must equal `toUid`** — the recipient, and only the recipient, may create a confirmed Settlement (§5) |
| Authenticated caller | Must be a **current** Trip member (`isCurrentTripMember`-equivalent check, reused verbatim from `recordTripExpense.ts`) |
| `toUid` | Must equal the authenticated caller (same check, stated the other direction) — never independently re-verified as "a current member" via a separate field, since it's definitionally the caller, and the caller is already required to be a current member above |
| `fromUid` (**revised 4E.0A**) | Must be a **non-empty string**, must **not** equal `toUid` (mirrors `computeTripBalances`'s own `ower === owedTo` rejection), **AND must currently be a member of the same Trip** (`isCurrentTripMember`-equivalent check, identical in kind to the check already applied to the caller/`toUid`). A `fromUid` that is not a current Trip member is rejected with `failed-precondition` ("fromUid is not a current member of this trip.") — this is a genuinely new, independent membership check, not merely "any non-empty string." See §7 for why this is now required rather than deferred to a departed-member allowance. |
| Trip owner | Gets **no special authority** merely by being owner — an owner may only create a Settlement when `owner uid === toUid`, exactly like any other member. (Contrast with e.g. Trip archiving, which *is* owner-gated — Settlement authority is deliberately **not** modeled on that precedent.) |
| Ordinary unrelated member | No create authority at all — being a Trip member grants read access to balances/Settlements (§4), never create authority on someone else's behalf |

**The backend independently enforces every line above inside the trusted transaction** — the UI's own visibility of a "Settle Up" CTA (§4/§19) is advisory only, exactly matching this codebase's own repeatedly-stated "advisory only, never a security boundary" convention for `canReverseExpense`/`canClaimCorrection`. A client that somehow calls `recordTripSettlement` with a `toUid` that isn't the caller must receive `permission-denied`, never a silent no-op or a different error code that would let an attacker distinguish "wrong toUid" from some other failure (anti-enumeration, matching `recordTripExpense`'s own established pattern for its replay/collision branch). A `fromUid` that is not a current member gets the honest, specific `failed-precondition` above — this is not an authorization boundary in the anti-enumeration sense (it doesn't leak anything about a *different* user's data), so it does not need the same non-distinguishing treatment as the `toUid` check.

---

## 7. Departed/historical members

This is a genuinely new design question — the current architecture has no precedent that fully answers it, so this section makes explicit, freshly-reasoned decisions rather than citing something already frozen.

**Checkpoint 4E.0A amendment — this section is substantially revised.** The original 4E.0 draft allowed a NEW Settlement to name an arbitrary, non-current `fromUid` on the theory that a departed member's real debt must remain settleable. On reflection (and per explicit correction) that went too far: **the current repository has no authoritative historical-membership registry** capable of proving that an arbitrary client-supplied uid actually belonged to this Trip at any point. `Trip.memberIds` is a live, mutable, present-tense list — there is no persisted record anywhere of *who used to be a member*. Allowing a NEW Settlement to name any non-empty-string `fromUid` would let a client assert a financial relationship (a debt just got paid down) with a uid that was **never actually verified to have any connection to this Trip at all** — not "a departed member whose debt is being resolved," but potentially any account in the system. That is a real authorization gap, not a reasonable relaxation for departed-member convenience.

**Revised decision, split cleanly into two independent questions:**

**A. Does balance DERIVATION continue to show departed members? Yes, unchanged from the original draft — this remains correct and is not affected by the amendment.** `computeTripBalances` takes plain `Expense`/`ExpenseSplit`/`Settlement` arrays and has **no membership awareness at all** — it doesn't call `deriveCurrentMemberUids` or consult `Trip.memberIds` anywhere. It nets whatever `fromUid`/`toUid`/`userId`/`payerUid` values the input records **already contain**, from Expenses/Splits/Settlements that were themselves validly created while every named party WAS a current member at the time. A departed member's historical debt, already embedded in existing Expense/Split records, is **already** structurally preserved and displayed by the engine as it exists today — **this requires no code change and is not what the amendment restricts.** Name representation is unchanged from the original draft too: identical `"Trip member"` / `"Trip member N"` fallback treatment (`missingMemberLabels`, reused verbatim from `create.tsx`/`[expenseId].tsx`/`expenses/index.tsx`), resolved for the union of every uid appearing in any non-zero `TripBalance`, current or departed, via the existing `subscribeToPublicUsersByIdsChunked`. **No raw uid is ever exposed.**

**B. Can a NEW Settlement be recorded naming a departed `fromUid`? No — deferred for 4E MVP, per this amendment.** Both `fromUid` and `toUid` must be current Trip members at the moment a Settlement is created (§6). This means: if Alex owed Daniel $100 and then Alex leaves the Trip before paying, **Daniel cannot record that payment as a Settlement against Alex's now-departed uid in 4E MVP.** The debt remains truthfully visible in the derived balance (§A above — nothing is dropped, nothing is hidden), but there is currently no safe, authoritative way to let a client assert "this specific departed uid is the same person who owes this debt" without either:
- a trustworthy **historical membership provenance** record (e.g., a persisted log of who was ever a member of this Trip and when they left, which does not exist anywhere in this repository today), or
- a dedicated **member-removal/outstanding-balance policy** designed specifically to preserve safe settlement authority across a member's departure (e.g., snapshotting a departing member's own outstanding balances at removal time) — also not designed or implemented anywhere today.

Building either of those is real, separate design work this preflight explicitly declines to invent on the spot merely to unblock a single MVP edge case. **This is a genuine, named MVP limitation, not a silent gap** — flagged again in §21/§22.

**C. `toUid` authority is unchanged from the original draft.** The caller must equal `toUid`, and the caller must be a current Trip member (§6) — not negotiable, since it's the real authorization boundary. If the intended *recipient* has left the Trip, the same already-noted limitation applies (no one else may record a Settlement crediting their receipt, per §6's owner-gets-no-special-authority rule) — this part of the design is unchanged by the amendment.

**D. Does removal from `memberIds` make settlement of a departed member's PAST debt impossible forever?** Not necessarily forever — only until a future checkpoint introduces (B)'s missing provenance/policy design. The debt is never lost from the derived balance in the meantime (§A); it is simply not **recordable as settled** through `recordTripSettlement` until that future work ships.

**E. No product/backend change beyond §6's revised `fromUid` current-membership check is required for 4E MVP.** The engine (§A) needs no change for this section at all — only the callable's own authority rules (§6) changed.

---

## 8. Over-settlement / over-payment policy

**Recommendation: (B) client-side warning, but allow — re-confirming the Sept 13 audit's own item-2 recommendation against current architecture, not merely re-stating it.**

Evaluated against the four options:
- **(A) Hard backend rejection** requires the trusted callable to recompute a live, authoritative aggregate balance for the exact pair inside one Firestore transaction. This means reading *every* Expense + every Split + every Settlement touching that pair before the write — for a busy, long-running Trip (now more plausible than when the original audit was written, given 4D added full reversal/correction history, meaning MORE documents accumulate per logical Expense over time) this risks Firestore's well-known transaction read-set/contention limits, and — more importantly — a stale-but-not-yet-reconciled Expense correction (4D.7) could make a "hard reject" wrong in either direction at the exact moment it matters most. This preflight recommends **against** (A), consistent with the old audit.
- **(C) Client-side hard block based on derived balance** is strictly worse than (A): it enforces a *non-authoritative* number as if it were a hard rule, which can incorrectly block a legitimate settlement (e.g., a second device already recorded a different, unseen Settlement that this client's stale snapshot hasn't reflected yet) while providing zero actual integrity guarantee (a modified/bypassed client could ignore the block entirely, so it isn't real security — the callable itself must be the source of truth for *authorization*, not for *amount* limits).
- **(D)** — no other design surfaced in this preflight; this codebase's own established precedent (the Shared Stash withdrawal-amount check, `app/(tabs)/trips/[tripId]/index.tsx`, cited by the original audit) is already exactly option (B): a non-authoritative, advisory client hint, never a blocking rule.
- **(B) is recommended.** The trusted callable performs its OWN independent validation (positive `amountMinor`, `fromUid !== toUid`, USD, current-membership-of-`toUid`) but does **not** attempt to compute or enforce a live aggregate balance ceiling. The client, having already fetched Expenses/Splits/Settlements to render the Balances screen in the first place (§4), computes the CURRENT pairwise debt via the same `computeTripBalances()` and, if the amount the user is about to record exceeds it, shows a **soft, dismissible warning** — never a submit-blocking error.

**Exact copy/behavior for the soft warning:**
> "This is more than the $X.XX currently owed between you and <name>. You can still record it — the balance will show <name> owing you the difference instead." — with the primary action still labeled "Record Settlement" (not relabeled to something implying a hard confirmation step), and a plain "Edit amount" secondary action. **Never a second confirmation dialog on top of the ordinary submit flow** — this is informational, not a gate, consistent with "soft-warning, not hard-block."

**Concurrency/staleness are explicitly accounted for:** the warning is computed from the same live-subscribed data already driving the Balances screen (§15/§16), so it's as fresh as that screen's own last successful snapshot — never claimed as authoritative, and the callable's own idempotency (§17) guarantees a retry after an ambiguous network outcome can never double-record regardless of what the client's balance snapshot showed at submit time.

---

## 9. Archived Trips — Settlement policy

**Recommendation: Settlement creation remains fully allowed on an archived Trip; viewing balances and past Settlements remains fully allowed. No archive gate on `recordTripSettlement` at all.**

**This is not a new decision — it was already explicitly frozen** in `docs/audits/TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_2026-09-13.md` §5 row G and restated even more explicitly in its own §12 ("Future Expense/Settlement interaction"): *"`recordTripSettlement`: do NOT add an archived-Trip check. A settlement only records that an external payment already happened resolving a pre-existing debt — blocking it after archive would be actively harmful, trapping real obligations between real people with no path to resolve them, often exactly when people go to settle up (right after a trip wraps up)."*

This preflight re-confirms that reasoning still holds against the current, much-more-mature Expense architecture: `reverseTripExpense.ts` (built later, in 4D.6) independently arrived at the **identical** pattern for the identical reason — "reversal is correcting historical state, not new economic activity, and the backend imposes no archive gate on it" (frozen in the 4D UI preflight §28, confirmed unmodified through 4D.8). Settlement creation and Expense reversal are the same *category* of action — resolving/correcting something that already happened, not creating new spending activity — and both should, and now clearly do, share the same archive-exempt treatment. **`recordTripExpense`'s own archive gate is correctly NOT extended to `recordTripSettlement`.**

Concretely for 4E:

| Action on an archived Trip | Allowed? |
|---|---|
| View Balances (derived) | **Yes** — read-only, no different from viewing Expense history |
| View past Settlements | **Yes** |
| Record a new Settlement (even for debt that predates the archive) | **Yes — no archive gate** |
| Create a new ordinary/corrected Expense (existing 4D rule, unchanged) | **No** |
| Reverse an Expense (existing 4D.6 rule, unchanged) | **Yes — no archive gate** (unaffected by this preflight) |

UI presentation mirrors the existing archived-Trip conventions exactly (§19): the Balances card and "Settle Up" CTA remain visible and functional on an archived Trip — there is no honest-explanation-instead-of-button pattern needed here at all, unlike Correct Expense/Add Expense, because nothing is actually being blocked.

---

## 10. Settlement persisted schema

**Recommendation: `tripSettlements/{clientRequestId}` remains the correct current shape — flat top-level collection, document id = `clientRequestId`, matching `tripExpenses` exactly.** This is not merely re-stating the old audit — it's confirmed against the **actual implemented** `recordTripExpense.ts`, which really does use `db.collection("tripExpenses").doc(input.clientRequestId)` today (not a hypothetical), so the pattern this preflight recommends for Settlements has already been proven correct in production-shaped code, not just proposed on paper.

**Checkpoint 4E.0A correction: the original 4E.0 draft claimed "no changes needed to the [`Settlement`] type itself" while, in the very next section (§11), describing an engine that inspects `Settlement.status` — a real contradiction, since the current `src/types/domain/settlement.ts` has no `status`/`reversedAt`/`reversedBy`/`reversalReason` field at all today. That is corrected here: §11's reversal design REQUIRES a client-facing type change, and that change must ship as part of 4E.1 (§19), before `tripSettlement.ts` can reference `.status` on a `Settlement`.**

**Two genuinely different shapes must be kept distinct, exactly mirroring the already-proven `Expense`/persisted-`tripExpenses`-document split:**

**(1) The client-facing `Settlement` domain type** (`src/types/domain/settlement.ts`) — what `computeTripBalances`, the future settlements mapper, and every UI component actually see. **Frozen extension:**

```ts
export type SettlementStatus = "active" | "reversed";

export type Settlement = {
  id: string;
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: CurrencyCode;
  method: SettlementMethod;
  note?: string;
  occurredAt?: PersistedTimestamp;
  createdAt: PersistedTimestamp;
  createdBy: string;

  // NEW (4E.0A correction, required before the engine can inspect
  // Settlement.status at all - see §11):
  status: SettlementStatus;
  reversedAt?: PersistedTimestamp;
  reversedBy?: string;
  reversalReason?: string;
};
```

`status` is **required, not optional** — every Settlement, from the moment it's created, has an explicit `status: "active"` (mirroring `Expense.status`'s own required-from-creation shape exactly, confirmed in `src/types/domain/expense.ts`). `reversedAt`/`reversedBy`/`reversalReason` are present **only** when `status === "reversed"` — the same conditional-shape contract `mapExpenseDocument` already enforces for the identical fields today (reversal metadata forbidden on an active record, required-together on a reversed one).

**(2) Trusted-internal, Firestore-only fields** — `creationRequest` and `reversalRequest`. **These are explicitly NOT part of the client-facing `Settlement` type**, exactly matching `Expense`'s own frozen exclusion (`src/services/firebase/expenses.ts`'s `mapExpenseDocument` module comment: *"Trusted backend-internal fields (creationRequest, reversalRequest) are never read here — their presence or absence has no bearing on whether this mapping succeeds"*). The future `mapSettlementDocument` (§14) must apply the identical exclusion. The full **Firestore document shape** (type + trusted-internal fields together) is:

```
tripSettlements/{clientRequestId}
  tripId: string
  fromUid: string
  toUid: string
  amountMinor: number          // positive safe integer
  currency: "USD"               // literal, MVP-only
  method: "venmo" | "paypal" | "zelle" | "cash" | "other"
  note?: string                 // normalized/trimmed, capped (mirrors reversalReason's own 500-char convention)
  occurredAt?: Timestamp        // optional, preserves an external payment's own real instant. Revised 4E.0A (§3): the 4E MVP manual Settlement UI (4E.6) never sends this - it stays present in the persisted shape/callable contract for a future importer or exact-instant UI, not because 4E's own UI uses it
  createdAt: Timestamp          // FieldValue.serverTimestamp(), never client-supplied
  createdBy: string             // == toUid always, by construction (server-derived from auth, never trusted from input)
  status: "active" | "reversed" // part of the client-facing type, (1) above
  reversedAt?: Timestamp        // part of the client-facing type, (1) above
  reversedBy?: string           // part of the client-facing type, (1) above
  reversalReason?: string       // part of the client-facing type, (1) above

  // Trusted-internal ONLY - never part of (1), never read by the client
  // mapper, mirrors tripExpenses' own creationRequest/reversalRequest
  // fields exactly:
  creationRequest: { tripId, fromUid, toUid, amountMinor, currency, method, note: string | null, occurredAtInstantMs: number | null }
  reversalRequest?: { clientRequestId: string; reversalReason: string | null }
```

**Settlement records are append-only/immutable except for the reversal-transition fields above** — `amountMinor`, `fromUid`, `toUid`, `method`, `note`, `occurredAt`, `createdAt`, `createdBy` never change after creation, mirroring `Expense`'s own frozen "amount/payer/splits are immutable once created" rule exactly. §11 below specifies precisely how an incorrect Settlement is corrected — this preflight does **not** leave that ambiguous, per the checkpoint's own explicit instruction.

---

## 11. Settlement correction / reversal design

**This needed explicit design before any trusted write ships — the checkpoint is right that we learned this from Expenses. Recommendation: (A) immutable Settlement + trusted reversal, modeled field-for-field on `reverseTripExpense.ts`. No compensating-record model, no delete.**

**Why not delete:** matches this codebase's own absolute, repeatedly-applied rule — `allow update, delete: if false` on every trusted financial-history collection (`savingsTransactions`, `tripExpenses`, `tripExpenseSplits`) — extending that identical posture to `tripSettlements` the moment it's created, never a special exception.

**Why not a compensating record (a second, opposite-direction Settlement) instead of a real reversal status:** a compensating Settlement would leave the *original, wrong* Settlement showing as `status: active` forever, meaning any UI that lists "past Settlements" (§4) would show two contradictory-looking entries with no structural link explaining that the first was a mistake — exactly the "unreadable, hard-to-audit history" problem this codebase's Expense reversal design was built specifically to avoid. A real reversal status is strictly more honest and directly reuses code/UI this session already built and hardened three times over (4D.6/4D.6A/4D.7/4D.7A).

**Frozen design, mirroring `reverseTripExpense.ts` and `functions/src/callables/reverseTripExpense.ts`'s exact transaction-step ordering:**

- **Authorization:** the same person who could have created the Settlement in the first place may reverse it — i.e., **`toUid` only** (the recipient who confirmed receipt is the only one positioned to say "actually, I didn't receive that" / "I recorded this by mistake"). Trip owner gets no special reversal authority, mirroring §6 exactly (Settlement authority is never modeled on the Trip-owner-gated pattern). **Unlike Expense reversal** (which additionally allows the Trip owner, and the original creator if still a member), Settlement reversal is deliberately **narrower** — there is no meaningful analogue to "the Trip owner should be able to clean up someone else's mistaken financial confirmation" here, since the owner was never a party to the transaction being confirmed. This is a genuinely new decision, not copied uncritically from Expense.
- **Persisted fields on reversal:** `status: "reversed"`, `reversedAt: FieldValue.serverTimestamp()`, `reversedBy: authUid`, `reversalRequest: {clientRequestId, reversalReason}` (trusted-internal idempotency snapshot), `reversalReason` (top-level, optional, same 500-char normalized-or-omitted convention as `reverseTripExpense.ts`'s own `MAX_REVERSAL_REASON_LENGTH`).
- **Balance-engine behavior:** `computeTripBalances` needs **exactly one new line** — skip debt-reduction contribution for a `status === "reversed"` Settlement, mirroring its existing `if (expense.status === "reversed") continue;` line precisely. This is the only change this preflight recommends to the ENGINE's own logic in `tripSettlement.ts`, and it is a pure, fully-testable addition (new test cases: "a reversed Settlement contributes no debt reduction," "a reversed Settlement's own shape is still validated even though its contribution is skipped" — mirroring the existing reversed-Expense test pair exactly). **This engine change has a hard prerequisite, corrected by 4E.0A: the `Settlement` type itself must already declare `status` (§10) before `tripSettlement.ts` can type-check a reference to `settlement.status` at all** — both the type extension and this one-line engine change ship together in 4E.1 (§19), never the engine change alone.
- **UI status:** identical `StatusChip` treatment — "Reversed" (neutral/slate tone), never coral, never strikethrough, reusing the component that already exists (`components/expenses/StatusChip.tsx`) rather than building a new one.
- **Idempotency:** identical shape to `reverseTripExpense`'s own (§17) — exact-replay-of-my-own-prior-reversal checked first, before any other read; `clientRequestId` + normalized `reversalReason` is the full logical identity; ambiguous failure preserves the pending request id for a safe identical-facts retry.
- **Archived behavior:** **no archive gate**, for the identical reason given in §9 — reversing a Settlement is correcting historical state, not new economic activity.
- **No "Correct a Settlement" (replacement) flow is needed or recommended for 4E.** Unlike an Expense (where amount/payer/split errors are common enough that "reverse, then create the corrected replacement" earned its own two-step flow), a Settlement has no split/participant complexity to get wrong in the same way — reversing a mistaken Settlement and letting the recipient record a fresh, correct one via the **ordinary** creation flow (no `replacesId` linkage) is sufficient and simpler. **If real usage later shows a need for linked Settlement corrections, that is explicitly future work**, not assumed here.

---

## 12. Trusted `recordTripSettlement` callable contract (design only, no code)

Modeled directly on `recordTripExpense.ts`'s already-proven transaction-step ordering, adapted for Settlement's narrower authority model.

**Input:**
```
{
  tripId: string
  fromUid: string
  toUid: string
  amountMinor: number
  currency: "USD"
  method: "venmo" | "paypal" | "zelle" | "cash" | "other"
  note?: string
  occurredAt?: string           // ISO instant, same convention as recordTripExpense/recordSavingsTransaction
  clientRequestId: string       // CLIENT_REQUEST_ID_PATTERN, same regex as every existing callable
}
```

**Transaction step order (mirrors `recordTripExpenseCore` exactly, §6/§9's authority model substituted in):**

1. **A. Idempotent-replay check FIRST**, before the parent Trip is even required to exist — read `tripSettlements/{clientRequestId}`; if it exists, compare `stored.createdBy === authUid` AND an exact normalized `creationRequest` match (field-by-field, never `JSON.stringify`). Match → return the existing result. Mismatch on either → `already-exists` (the same anti-enumeration non-distinguishing error `recordTripExpense` already uses).
2. **B. Only for a genuinely new Settlement:** the parent Trip must exist → `not-found` otherwise.
3. **C. Authorization, before any other Trip-state fact is disclosed:**
   - `authUid === input.toUid` → else `permission-denied` ("You may only record a settlement you personally received.")
   - `authUid` is a current Trip member (via `isCurrentTripMember`) → else `permission-denied`
4. **C2.** Only once authorized: disclose/validate structural integrity (`Array.isArray(tripData.memberIds)` → `failed-precondition` if malformed, matching `recordTripExpense`'s own ordering).
5. **C3 (revised 4E.0A, §6/§7).** `input.fromUid` must ALSO be a current Trip member (same `isCurrentTripMember`-equivalent check, now against `fromUid` rather than the caller) → else `failed-precondition` ("fromUid is not a current member of this trip."). This is deliberately a distinct step from C, evaluated only after the caller's own authorization already succeeded, and deliberately `failed-precondition` rather than `permission-denied` — it is not an authorization boundary about the caller, it is a validity constraint on the *content* of the request.
6. **D. No archive check** — per §9, deliberately omitted (this is the one meaningful divergence from `recordTripExpenseCore`'s own step D).
7. **E. Field validation** (mirrors `recordSavingsTransaction`'s `validateInput` + `recordTripExpense`'s own conventions — note that `fromUid`'s *membership* is validated separately at step C3 above; the checks below are shape/value validation only, run regardless of order relative to C3):
   - `amountMinor`: positive safe integer.
   - `currency`: must equal exactly `"USD"` — reject anything else (MVP policy, matching `assertUsdCurrency`).
   - `fromUid !== toUid` — mirrors `computeTripBalances`'s own self-settlement rejection, enforced here too so a malformed record can never even be persisted in the first place.
   - `fromUid`: non-empty string (its **current-Trip-membership** requirement is the separate C3 check above, revised by 4E.0A — no longer "deliberately not required").
   - `method`: must be one of the exact `SettlementMethod` allowlist values — reject anything else.
   - `note`: optional, trimmed, capped at the same 500-character convention as `reversalReason`/`Expense.description`.
   - `occurredAt`: **the trusted callable itself continues to accept this optional field** (for potential future/internal callers — e.g. a bulk-import tool — that may legitimately know a real external-payment instant), parsed once and validated as a real Date exactly like `recordSavingsTransaction`'s own `Number.isNaN(Date.parse(...))` check, preserved as an exact instant, never a date-only round-trip. **Revised by 4E.0A (§3): the 4E MVP manual Settlement UI (4E.6) never sends this field at all** — see §18/§16 for the UI-side policy. This keeps the callable itself general-purpose while the first shipping UI stays deliberately simple.
   - `clientRequestId`: the existing shared `CLIENT_REQUEST_ID_PATTERN`.
8. **F. Write, inside the same transaction:**
   - `createdAt`: `FieldValue.serverTimestamp()`.
   - `createdBy`: `authUid` — **never** trusted from client input, exactly like every other callable in this codebase.
   - `status: "active"` (new field, absent from ordinary creation would also be acceptable, but explicit is preferred so the reversal transition in §11 is a pure add rather than an implicit-then-explicit shift — matches `tripExpenses`' own `status` field being present from creation).
   - `creationRequest`: the normalized snapshot used for future replay comparison.
9. **Document id = `input.clientRequestId`** — no separate `settlementId` field, exactly like `tripExpenses`/`savingsTransactions`.
10. **Error codes:** `unauthenticated` (not signed in); `invalid-argument` (malformed request shape — bad `amountMinor`/`currency`/`method`/`fromUid === toUid`/`clientRequestId`); `not-found` (missing Trip); `permission-denied` (`authUid !== toUid`, or caller not a current Trip member); `failed-precondition` (**two distinct causes, both covered by this one code**: (a) `fromUid` is not a current Trip member (§6/§7, step C3 above), and (b) malformed trusted Trip structural state, e.g. `tripData.memberIds` not an array); `already-exists` (replay collision) — the exact same vocabulary every existing callable in this codebase already uses; no new error code is introduced. **No archive-related `failed-precondition` exists for this callable at all** — per §9, `recordTripSettlement` has no archive gate, so archived-Trip state never produces any error here.

---

## 13. Firestore Rules / index design (design only, not implemented)

**Rules**, modeled character-for-character on the existing `tripExpenses`/`tripExpenseSplits` block:

```
match /tripSettlements/{settlementId} {
  allow get, list: if resource.data.tripId is string
    && canAccessTripById(resource.data.tripId);

  allow create, update, delete: if false;
}
```

Reuses `canAccessTripById()` **verbatim**, already declared at the correct outer scope for exactly this kind of sibling-`match`-block reuse (confirmed current in `firestore.rules`). No new Rules function is needed. Client access is read-only, full stop — no field-level exception, no creator exception, no owner exception, no archived-Trip exception (§9) — mirrors the Expense collections' identical posture exactly.

**Query compatibility:** `where("tripId", "==", tripId)` is exactly the shape `canAccessTripById(resource.data.tripId)` is designed to authorize (it reads `resource.data.tripId` directly, the same pattern `tripExpenses`/`tripExpenseSplits` already use) — no incompatibility.

**Index requirement: none.** This is a real, repository-verified finding that **corrects** the Sept 13 audit's own assumption (§14 of that document assumed a `tripId + createdAt` composite index would be needed). The **actual, shipped** `tripExpenses`/`tripExpenseSplits` read path (`src/services/firebase/expenses.ts`, `subscribeToExpensesForTrip`) uses **no `orderBy` at all** — a single-field `where("tripId","==",tripId)` query (which Firestore auto-indexes, no entry needed) with sorting performed **client-side** (`sortExpensesForHistory`), explicitly to avoid introducing a composite index (confirmed by that file's own module comment and by `firestore.indexes.json` genuinely containing zero entries for either collection today). **Recommendation: `tripSettlements` follows the identical, already-proven pattern** — `where("tripId","==",tripId)`, client-side sort by `occurredAt ?? createdAt` (mirroring `expenseHistoryTimestamp`'s exact precedence rule), no composite index added to `firestore.indexes.json`.

---

## 14. Client read/service layer design

`src/services/firebase/settlements.ts` (new file), modeled directly on `src/services/firebase/expenses.ts`'s own structure:

- **Strict mapper** (`mapSettlementDocument`) — field-by-field validation exactly like `mapExpenseDocument`: non-empty `tripId`/`fromUid`/`toUid`, positive-safe-integer `amountMinor`, literal `"USD"` currency, `method` against the allowlist, optional trimmed/capped `note`, optional real-Timestamp `occurredAt`, required real-Timestamp `createdAt`, non-empty `createdBy`. **Revised 4E.0A (§10):** since the `Settlement` type's `status` field is present and required from 4E.1 onward (not an optional later add), the mapper validates `status`/`reversedAt`/`reversedBy`/`reversalReason` from day one (4E.3), using the same conditional-shape validation `mapExpenseDocument` already applies — reversal metadata required together when `status === "reversed"`, forbidden when `"active"`. **Never reads `creationRequest`/`reversalRequest`** (trusted-internal only, exactly like the Expense mapper's own documented exclusion).
- **Live vs. one-shot:** **live** (`onSnapshot`), matching Expenses — a Settlement's own `status` can change (reversal, §11) after creation, so a permanent listener is warranted, mirroring `subscribeToExpenseById`/`subscribeToExpensesForTrip`'s own reasoning exactly (not one-shot like immutable Splits).
- **Route-tripId binding:** `settlementBelongsToTrip(settlement, tripId)`, identical pattern to `expenseBelongsToTrip` — re-verified defensively even though the query already filters on `tripId`.
- **Anti-enumeration:** if a single-Settlement detail view is ever built, a Rules-denied read gets the **same** "could not be found" copy as a genuinely missing document — matching the Expense Detail precedent exactly. (Not required for the 4E.5 MVP list-only Balances view, but the mapper/service should be built to support it identically from day one, since retrofitting anti-enumeration onto an already-shipped detail screen is exactly the kind of gap this codebase has learned to avoid up front.)
- **Query shape:** `query(collection(db,"tripSettlements"), where("tripId","==",tripId))` — no `orderBy` (§13).
- **Sorting:** client-side, by `occurredAt ?? createdAt` descending, tie-broken by ascending document id — identical to `sortExpensesForHistory`.
- **Error/retry:** identical terminal-listener-error → explicit Retry pattern already established for every other live Expense subscription.
- **Callable wrapper:** `recordTripSettlement(input): Promise<{settlementId: string}>` and (once §11 ships) `reverseTripSettlement(input): Promise<{settlementId: string}>`, both thin `httpsCallable` wrappers that never catch/wrap errors (matching `recordTripExpense`/`reverseTripExpense`'s own established convention — errors propagate unchanged to the caller).
- **Client request id generator:** `generateSettlementClientRequestId()` = `doc(collection(db,"tripSettlements")).id` — the identical client-SDK-auto-id pattern already used for Expenses/Savings, not a new scheme.
- **No direct writes** — `settlements.ts` contains no `addDoc`/`setDoc`/`updateDoc`/`deleteDoc`/`writeBatch`/`runTransaction` against `tripSettlements`, mirroring the Expense service file's own explicit "must never gain one" module-comment discipline.

---

## 15. Multi-source balance-snapshot consistency

**This is addressed explicitly, not hand-waved, per the checkpoint's own instruction.**

A Balances screen combines **three independent data sources**: live Expenses, one-shot-per-Expense immutable Splits, and live Settlements. The risk: rendering a derived balance from fresh Expenses but stale/missing Splits (or Settlements still loading) would show a **transiently wrong number for real money** — unacceptable.

**Rule: do not render a derived balance until every required source has reached at least one successful snapshot for the current Trip's CURRENT Expense set. Recompute on every subsequent live update from either live source.**

Concretely, the controller (a new `useTripBalances`-shaped hook or equivalent controller state, modeled on `[expenseId].tsx`'s own multi-source-coordination pattern) tracks independent load states for:
1. **Expenses** (live `subscribeToExpensesForTrip`) — status: loading/error/ready.
2. **Splits** — **one for every currently-known Expense id**, not a single flat fetch. This is the one piece of real design work the checkpoint is right to flag as needing explicit treatment: since Splits remain one-shot/immutable per Expense (unchanged, §12 of `TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md` §14's own per-Expense-detail read pattern), a newly-created (or newly-loaded-into-view) Expense's Splits are **not yet fetched** the moment the Expense itself becomes visible via the live Expense listener. **Recommendation:** maintain a `Map<expenseId, ExpenseSplit[]>` cache; on every Expense-list update, diff against the cache's known keys, and `fetchExpenseSplitsForExpense(tripId, expenseId)` **only for expense ids not already cached** (Splits are immutable, so a cached entry never needs re-fetching — this is a pure additive cache, never invalidated for an existing key). The Balances screen's own "ready to compute" gate requires: Expenses ready AND every currently-known Expense id present in the Splits cache AND Settlements ready. A brand-new Expense (created by another member while this screen is open) triggers exactly one new Splits fetch for that one id, not a full re-fetch of everything already cached.
3. **Settlements** (live `subscribeToSettlementsForTrip`) — status: loading/error/ready.

**Recompute trigger:** any live update from Expenses or Settlements (not Splits, which never change after their one-time fetch) re-runs `computeTripBalances` against the current combined snapshot, but **only once the Splits cache is confirmed complete for the CURRENT Expense set** — a live Expense update that introduces a brand-new id transiently holds the screen in "loading" (or, better, keeps showing the last-known-good balance with a small non-blocking "updating…" indicator, never a fabricated stale number presented as current) until that one new Split fetch resolves.

**Failure isolation:** an error on any ONE of the three sources surfaces its own explicit Retry (§4's malformed/permission-failure states), never silently substituting an empty array for a failed source (which would produce a **subtly wrong, not obviously-broken** balance — the single worst possible failure mode for money math).

---

## 16. Idempotency / ambiguous-network-outcome model

Directly reuses the exact lessons already proven across Expense creation (4D.3), reversal (4D.6/4D.6A), and correction (4D.7/4D.7A) — no new pattern is invented.

- **Logical identity facts** for `recordTripSettlement`: `{tripId, fromUid, toUid, amountMinor, currency, method, note (normalized), occurredAtInstantMs}` — field-by-field comparison, never `JSON.stringify` (matching `expenseCreationFactsEqual`'s own documented reasoning for why order-sensitive/accidental-key-order equality is wrong for this purpose). **Revised 4E.0A (§3):** for the 4E MVP manual Settlement UI specifically, `occurredAtInstantMs` is always `null` in the facts the client builds — the field remains part of the shared identity-facts shape (so the same equality/idempotency helper works unmodified for a future caller that does supply it), but the 4E.6 UI itself never populates it.
- **Double-tap protection:** a synchronous `inFlightRef`-style guard checked before the first `await`, identical shape to every existing submit controller in this codebase.
- **Same facts after an unknown network outcome reuse the same `clientRequestId`** — `resolveSettlementClientRequestId(pendingRef, facts, generateSettlementClientRequestId)`, a direct structural copy of `resolveExpenseClientRequestId`/`resolveExpenseReversalClientRequestId`.
- **Changed logical facts mint a new id** — any field in the identity-facts set changing (including switching which pairwise debt is being settled, or a corrected amount before ever confirming) produces a new `clientRequestId`, exactly like a changed `ExpenseCreationFacts` does today.
- **Successful exact replay is distinguishable from a genuine conflict** — the callable's own transaction step A (§12) already encodes this: same `clientRequestId` + matching `creationRequest` → success (idempotent replay); same `clientRequestId` + **different** facts → `already-exists`.
- **No optimistic fake Settlement is ever inserted** — the live `subscribeToSettlementsForTrip` listener is the sole source of truth for "did this actually commit," identical to the existing "no fake optimistic record" discipline already frozen for Expense creation (UI preflight §19).
- **Navigation does not lose an ambiguous request incorrectly** — `pendingRef` (and, for reversal, `pendingReversalRef`) persist across a dialog close/reopen within the same mounted screen exactly like the 4D.6A-hardened Reverse flow; a genuinely new screen mount after navigation re-derives everything fresh from persisted server state (never a client-held draft treated as authoritative) — the identical structural-recovery insight 4D.7A's report explained for correction applies here without any new mechanism.
- **Retry is user-explicit where appropriate** — for Settlement *reversal* specifically, this preflight recommends reusing 4D.6A's exact finalized principle: a live-listener update showing `status === "reversed"` with `reversedBy === currentUid` is **never** treated as proof of success on its own (the same account could be reversing from a second device with a different `clientRequestId`); only an actual successful callable response — the original submission or an explicit user-initiated exact-replay verification — may ever conclude genuine success. `reduceReversalOutcome`'s exact shape (`src/domain/expenseReversal.ts`) is directly reusable, parameterized rather than duplicated, for Settlement reversal too.

---

## 17. Privacy analysis

Reconfirmed, not merely re-asserted, against the actual current repository: a repo-wide search across `src/`, `functions/`, and `app/` for `Bucket`/`trip_personal`/`My Stash`/`myStash` inside every Expense-adjacent file found **zero** real data-access hits — only comments citing other features' precedents (confirmed during the 4D.8 audit and re-checked for this preflight). The same discipline extends to Settlements by construction, since nothing in this design touches Bucket collections at all:

- `Settlement`/`computeTripBalances`/the future `recordTripSettlement` never read, query, or reference `buckets/{bucketId}`, `trip_personal` Bucket balances, or any `savingsTransactions` document scoped to a Bucket.
- **A Trip balance means, and only ever means: "based on shared Trip Expenses and confirmed Settlements."** It does **not** mean net worth, available funds, or ability to pay — this framing should appear verbatim (or near-verbatim) in the Balances screen's own empty/explainer copy if space allows, so the product itself reinforces the boundary, not just the backend.
- No cross-user private data is ever inferred from a Trip balance — the balance is a pure function of shared, Trip-visible facts every current member can already read individually (§4).
- **No privacy-model change is introduced or required.**

---

## 18. Accessibility / responsive UX model

Reuses the current SquadStash design system exactly — no redesign, matching every prior 4D checkpoint's own "audit and confirm, don't reinvent" discipline (this preflight explicitly follows 4D.8's own precedent rather than proposing new visual language).

- **Mobile layout:** Balances card follows the existing card/cardHeaderRow/iconBubble shell (Expenses/My Stash/Shared Stash cards, `[tripId]/index.tsx`); balance rows follow `ExpenseRow`'s own proven `flex:1`/`minWidth:0` truncation pattern so long names + large dollar amounts never overflow.
- **Desktop layout:** reuses the existing `isWide` (`width >= 980`) breakpoint and the same centered `maxWidth` card family already established for every other Trip Detail card and for `expenses/create.tsx`'s own form.
- **Balance cards/rows:** one row per non-zero `TripBalance`, `<fromName> owes <toName> · $X.XX`, using already-resolved member identity (never a raw uid), matching `ExpenseRow`'s exact resolved-identity contract.
- **Member identity labels:** the exact existing `initialsFromName`/`"Trip member"`/`"Trip member N"` fallback chain, reused verbatim (§7).
- **Settle Up CTA:** a standard `Pressable` with `accessibilityRole="button"` and a real label (e.g. `"Settle up with <name>"`), matching every existing CTA in this codebase.
- **Settlement form/modal:** reuse the `ReverseExpenseDialog`/`CorrectExpenseConfirmDialog` Modal architecture exactly — transparent fade Modal, backdrop `Pressable` as a **sibling**, never a parent, of the centered card (the repeatedly-proven RN-Web focus/containment fix); `KeyboardAvoidingView` wrapper; dismissal blocked while a request is in flight. **Revised 4E.0A (§3): no date/"when did this happen" field appears anywhere on this form.** This applies the exact lesson already frozen for the Expense UI (no date-only editor, `occurredAt` is never re-derived from a picked calendar date, per the 4D UI preflight's own `occurredAt` discipline) — the form collects only `fromUid`/`toUid` (implied by which pairwise debt the "Settle Up" CTA was tapped from), `amountMinor`, `method`, and an optional `note`. The record's displayed history time is simply `createdAt` (server-generated, matching `expenseHistoryTimestamp`'s own `occurredAt ?? createdAt` fallback naturally resolving to `createdAt` here since `occurredAt` is never sent).
- **Loading/errors:** identical `ActivityIndicator` + explicit-Retry conventions already audited clean across the Expense UI in 4D.8.
- **Status chips:** reuse `StatusChip` verbatim for a reversed Settlement (§11) — no new chip component.
- **Bottom-nav clearance:** the Balances screen (if a dedicated route) or the in-card presentation (if inline on Trip Detail) reuses the exact `scrollBottomInset` computation already applied everywhere else — no new content-behind-`BottomNav` regression.
- **Keyboard behavior:** `KeyboardAvoidingView` per the existing dialog precedent; Enter-to-submit remains the same known, pre-existing, app-wide gap noted (not fixed) in 4D.8 — not a Settlement-specific blocker.
- **Semantic roles/labels:** per the 4D.8 accessibility fix just applied to `AddExpenseForm`, the Settlement `method` picker (`venmo`/`paypal`/`zelle`/`cash`/`other`) should use `accessibilityRole="radio"` rows in a `radiogroup` container with `accessibilityState={{checked}}` from day one — not `role="button"` — applying the lesson from 4D.8 proactively rather than needing a follow-up hardening pass.

---

## 19. Detailed phased implementation sequence

The checkpoint's own suggested 4E.1–4E.8 shape is directionally right but is adjusted below based on what the current repository actually needs — in particular, splitting Rules from the callable is unnecessary (Expense's own history shows Rules + callable shipped together every time, e.g. 4C never split them), and correction/reversal design is pulled *forward* into the same checkpoint as the callable itself (per the checkpoint's own explicit instruction: "identify that NOW before coding 4E," and this preflight already has — §11 — so there is no reason to defer *implementing* it to a separate late checkpoint the way 4D did, since 4D's own split into 4D.6/4D.7 was driven by not yet having a correction design, which this preflight has already resolved up front).

**Checkpoint 4E.0A correction — deployment discipline:** the original 4E.0 draft's "Deployment required?" column conflated **Firestore emulator execution** with an actual deployment, and implicitly assumed a staging Firebase project exists (it is not confirmed to). Both are corrected below, and a genuinely separate checkpoint, **4E.2D**, is introduced specifically for the one moment real backend code actually reaches production — every other checkpoint either touches no backend at all, or touches it only inside the emulator. **No checkpoint below performs a production deployment implicitly as a side effect of "finishing the code."** Every production deployment is its own explicit, separately human-approved action, matching this session's own repeatedly-stated deployment discipline for every prior 4D checkpoint.

| Checkpoint | Scope | Files/systems touched | Financial risk | Test gate | Manual smoke gate | Deployment required? |
|---|---|---|---|---|---|---|
| **4E.1** | Domain/type reversal support ONLY (§10/§11) — the `Settlement` type extension (`status`/`reversedAt`/`reversedBy`/`reversalReason`) AND the balance-engine's one-line reversed-Settlement skip, shipped together (§11's hard prerequisite note). Domain/type-only. | `src/types/domain/settlement.ts` (extend `Settlement`, add `SettlementStatus`), `src/domain/tripSettlement.ts` (one new `if` branch), `src/domain/__tests__/tripSettlement.test.ts` (new cases per §20) | None — pure types + a pure function, no I/O | `npm test` green, new reversed-Settlement cases pass | None (no UI yet) | **No deployment of any kind.** |
| **4E.2** | `recordTripSettlement` + `reverseTripSettlement` Cloud Functions (§7/§11/§12), `functions/src/index.ts` export, Firestore Rules for `tripSettlements` (§13), Firestore **emulator** tests mirroring `functions/test/`'s existing convention for `recordTripExpense`/`reverseTripExpense`. **Ends with human code review and commit — not a deployment.** | `functions/src/callables/recordTripSettlement.ts` (new), `functions/src/callables/reverseTripSettlement.ts` (new), `functions/src/index.ts`, `firestore.rules` | **High** — first trusted write path for real external-payment records; fully emulator-verified, but the emulator is not production and this checkpoint does not claim otherwise | Emulator Rules tests + callable unit/integration tests green, including the new `fromUid`-current-member cases (§20) | Emulator-only smoke (create, replay, reversal, reversal-replay, unauthorized-caller, wrong-`toUid`, non-current-`fromUid` → `failed-precondition`, archived-Trip-still-allowed) — **entirely inside the emulator; this is validation, not deployment** | **No deployment.** Human code review + commit only. |
| **4E.2D (new)** | **Separate, explicit production backend deployment.** Deploys ONLY the exact `functions`/`firestore.rules` already reviewed and committed in 4E.2 — no new code is written in this checkpoint. | `functions` deploy, `firestore.rules` deploy (whatever the actual deploy tooling is — no staging-project existence is assumed) | **High** — the actual, real production exposure moment for the first Settlement-write backend | N/A (tests already gated 4E.2) | Post-deploy verification that the deployed callables behave as the emulator predicted (e.g. one authenticated `recordTripSettlement`/`reverseTripSettlement` call against a real, expendable test Trip, OR read-only verification if no write is authorized yet) | **Yes — this IS the deployment checkpoint**, requiring its own separate, explicit human authorization, never bundled with 4E.2's own code-authoring work |
| **4E.3** | `src/services/firebase/settlements.ts` (§14) — mapper, live/one-shot reads, callable wrappers, client-request-id generator, query/sort, no direct writes | `src/services/firebase/settlements.ts` (new), its own test file mirroring `src/services/firebase/__tests__/expenses.test.ts`'s mocking convention | Low — read/wrapper layer only, no new write authority beyond what 4E.2/4E.2D already gated | New service tests green, full suite still green | None yet (no UI) | **No backend deployment.** |
| **4E.4** | Balance-aggregation controller (§15/§16) — the multi-source-coordination hook/controller, Splits-cache-by-expense-id logic, idempotency controller for Settlement creation/reversal (parameterizing `reduceReversalOutcome` rather than duplicating it) | New domain/controller file(s) (e.g. `src/domain/settlementSubmission.ts`, `src/hooks/useTripBalances.ts` or equivalent) | Low — no live financial writes yet, this is read-aggregation + idempotency scaffolding | Full domain test coverage for the controller logic (mirroring `expenseSubmission.test.ts`'s convention) | None yet | **No deployment.** |
| **4E.5** | Balances / Settle Up UI (§4/§18) — read-only: summary card, full pairwise list, loading/error/empty/malformed states, archived-Trip presentation (§9) | Trip Detail card + a new list view if warranted | None — read-only screen, no writes | Typecheck/lint/tests green | Full manual responsive/accessibility pass (mirrors 4D.8's own checklist shape) | **No deployment.** (Reads against whatever backend 4E.2D already deployed.) |
| **4E.6** | Record Settlement UI (§12/§16/§18) — the confirm dialog/form, trusted create call wired to 4E.3/4E.4, over-settlement soft warning (§8). **The backend (`recordTripSettlement`) should already be live from 4E.2D** — this checkpoint is client-only. | New `RecordSettlementDialog`/form component + Trip Detail/Balances wiring | **High** — first UI path that can trigger a real trusted write | Full suite green | Controlled, human-authorized production smoke test (one real Settlement, on an expendable test Trip) — explicit separate authorization required, mirroring 4D.6's own gate | **No new backend deployment unless the callable's own code genuinely changed since 4E.2D** (in which case that change gets its own 4E.2D-style deploy checkpoint first, never silently folded into 4E.6) |
| **4E.7** | Settlement reversal UI — mirrors `ReverseExpenseDialog` exactly, wired to `reverseTripSettlement` (already deployed via 4E.2D) | New `ReverseSettlementDialog` component + wiring | **High** — second live-write UI path | Full suite green | Controlled, human-authorized production smoke test against the already-deployed `reverseTripSettlement` backend, on the same expendable record | **No automatic deployment** — same rule as 4E.6 |
| **4E.8** | Responsive/accessibility/final smoke — final cross-breakpoint + a11y pass across every new Settlement screen (mirrors 4D.8's own exact structure) | Audit-only; fixes only where genuinely needed | None expected | Full suite green | Full manual smoke checklist (mirrors 4D.8's own format) | **No deployment** unless a genuine fix requires one, which would again be its own explicitly-authorized deploy, never implicit |

**Why 4E.1 precedes 4E.2** (rather than folding the type extension + one-line engine change into 4E.2): both are pure, zero-I/O changes with their own dedicated, already-excellent test file — landing them as an independently reviewable, trivially-revertible unit keeps the high-risk trusted-callable checkpoint (4E.2) from also carrying an unrelated type/pure-domain diff, mirroring this session's own repeated preference for narrowly-scoped, single-concern checkpoints.

**Why 4E.2D exists as its own checkpoint, separate from 4E.2:** per the checkpoint's own explicit correction, emulator execution is not deployment, and no staging project is assumed to exist. Collapsing "write and emulator-test the callable" and "put it in front of real users" into one checkpoint would mean the single highest-risk action in this entire sequence (the first real trusted Settlement-write backend going live) never gets its own dedicated, nameable, separately-authorized moment — exactly the discipline this session has applied to every prior 4D live-write gate (e.g. 4D.6/4D.7's own "STOP FOR HUMAN REVIEW... DO NOT DEPLOY" gates were never merged into the implementation checkpoint itself).

**Why reversal (4E.7) is a separate checkpoint from creation (4E.6)** despite the callable itself (4E.2/4E.2D) already including both: this mirrors 4D's own proven shape (4D.6 shipped Reverse UI before 4D.7 shipped Correction UI, even though both eventually reused the same backend idempotency principles) — each UI surface gets its own independently-reviewable, independently-smoke-tested checkpoint, since each is its own live-financial-write surface with its own manual-authorization gate.

---

## 20. Test matrix

**Domain/type (`settlement.ts` + `tripSettlement.ts`, 4E.1 — revised 4E.0A to explicitly include the type-level cases the checkpoint asked for):**
- An **active** Settlement reduces debt exactly as before (regression: existing tests #31/#32/#33/#34 still pass unmodified against the now-extended type).
- A **reversed** Settlement contributes zero debt reduction (mirrors reversed-Expense test #35).
- A **malformed reversed** Settlement is still rejected — e.g. `status: "reversed"` with a missing/non-string `reversedBy`, or a negative/malformed `amountMinor`, is still caught by the engine's existing shape validation even though its debt-contribution step is skipped (mirrors the "validation is not skipped" reversed-out-of-pocket-Expense test exactly).
- **Reversal metadata shape validation** (new, explicitly required by the checkpoint): `reversedAt`/`reversedBy`/`reversalReason` required together when `status === "reversed"`; forbidden when `status === "active"` — this is primarily a `mapSettlementDocument` (4E.3) concern, but the domain-level engine test suite gets its own minimal shape-acceptance test too, mirroring how `tripSettlement.test.ts` already accepts a `makeSettlement()`-shaped fixture without needing the full mapper.
- Existing 30+ tests continue passing unmodified (regression gate).

**Domain (new `settlementSubmission.ts`-equivalent, 4E.4):**
- Logical-identity-facts equality (field-by-field, mirroring `expenseCreationFactsEqual`'s own exhaustive per-field test table) — including an explicit case confirming `occurredAtInstantMs` is always `null` in the facts the 4E.6 UI builds (§3/§16).
- `resolveSettlementClientRequestId` — same-facts reuse, changed-facts mint-new, mirroring `resolveExpenseClientRequestId`'s existing test shape exactly.
- Settlement-reversal outcome reducer (parameterized `reduceReversalOutcome` or an equivalent) — same 8-scenario matrix 4D.6A already proved out (success, ambiguous-failure-preserves-pending, definitive-different-request via independent re-verification only, never same-uid-live-update alone, no duplicate success announcements, no auto-retry).
- Over-settlement soft-warning threshold logic — pure function, `{currentDebtMinor, requestedAmountMinor} -> {exceeds: boolean, ...}`, fully unit-testable without any UI.

**Emulator/Rules (`functions/test/`, `tests/firestore-rules/`, 4E.2):**
- `recordTripSettlement`: success (current-member `fromUid`, current-member-recipient `toUid === caller`), exact replay, different-facts-same-id → `already-exists`, non-`toUid` caller → `permission-denied`, non-current-member caller → `permission-denied`, **`fromUid` not a current Trip member → `failed-precondition`** (new, 4E.0A §6/§7/§12 step C3), `fromUid === toUid` → `invalid-argument`, non-USD → `invalid-argument`, malformed `method` → `invalid-argument`, missing Trip → `not-found`, **archived Trip still succeeds** (the one deliberately-different case vs. `recordTripExpense`), **request omitting `occurredAt` entirely succeeds and persists no `occurredAt` field** (confirms the callable doesn't require it even though it still accepts it when present).
- `reverseTripSettlement`: success, exact-replay-of-own-reversal, non-`toUid`-of-original caller → `permission-denied`, already-reversed-by-different-request → `failed-precondition`, archived Trip still succeeds.
- Rules: current member can `get`/`list` `tripSettlements` for their Trip; non-member cannot; `create`/`update`/`delete` always `false` for every role including the original recipient and the Trip owner.

**Service (`settlements.ts`, 4E.3):** mirrors `src/services/firebase/__tests__/expenses.test.ts`'s exact mocking convention (self-contained `jest.mock` factories, no outer-scope references, plain field assignment over TS parameter-property shorthand) — mapper field-by-field validation table (including the `status`/reversal-metadata conditional-shape cases from the Domain/type section above), `settlementBelongsToTrip`, request-builder pure-shaping tests (including confirming the builder never sends `occurredAt` from the 4E.6 UI's own call site).

**Manual smoke (4E.2D for the backend; 4E.6/4E.7 for the UI, human-authorized only):** one real Settlement creation + one real reversal against an expendable test Trip — never performed by an agent without explicit separate authorization, mirroring every 4D live-write gate exactly. 4E.2D's own backend-only smoke is distinct from 4E.6/4E.7's UI-driven smoke (§19).

---

## 21. Risks / blockers

1. **Departed-`fromUid` settlement-recording gap (§7.B, revised 4E.0A)** — an accepted MVP limitation, not a blocker: once a debtor (`fromUid`) leaves the Trip, their outstanding debt remains visible in the derived balance forever, but a NEW Settlement can no longer be recorded against them until a future checkpoint designs trustworthy historical-membership provenance or a member-removal/outstanding-balance policy (§7.B). This is the single most consequential limitation this hardening pass introduces — flagged explicitly, not silently accepted, and stated again in §22.
2. **Departed-recipient settlement-recording gap (§7.C)** — a second, narrower, pre-existing accepted MVP limitation: once a Settlement's intended recipient (`toUid`) leaves the Trip, no one else can record it on the Trip going forward. Flagged, not silently accepted; revisit only if real usage shows it's a frequent problem.
3. **Splits-cache-by-Expense-id coordination (§15)** is the single piece of genuinely new client-side complexity in this design — it's fully specified above, but it is new code, not a reuse of an existing pattern, and deserves careful review at 4E.4.
4. **No hard backend cap on over-settlement (§8)** is a deliberate MVP tradeoff, not an oversight — revisit only if it becomes a real support burden, exactly as the original audit itself anticipated.
5. **Firestore transaction read-set growth over a Trip's lifetime** (more Expenses/Splits/Settlements accumulate the longer a Trip runs, especially with 4D's reversal/correction history now adding *more* documents per logical Expense than before) is a real scaling consideration for the Balances screen's own client-side aggregation — not a blocker for MVP trip sizes, but worth a forward-looking note if this app ever supports very long-running or very large Trips.
6. **No existing precedent in this codebase for a multi-source (3-collection) live-aggregation screen** — Expense Detail combines 2 sources (Expense + its own Splits); Balances combines 3 (Expenses + all their Splits + Settlements). This is flagged for explicit reviewer attention at 4E.4/4E.5, the same way the original 4D preflight flagged the (successfully resolved) "list → nested detail route" pattern as genuinely new before it shipped.

---

## 22. Explicit unresolved decisions (not silently assumed)

1. **Payer-initiated pending Settlement (request/accept)** — explicitly deferred (§5), matching the original Sept 13 audit's own deferral. Stated here again as **future work**, not assumed as an eventual requirement of 4E itself.
2. **Departed-member settlement resolution mechanism, both directions** (§7.B/§7.C, §21.1/§21.2) — for a departed `fromUid`: no historical-membership provenance or member-removal/outstanding-balance policy is designed for MVP (§7.B), so their debt cannot be newly settled until one is. For a departed `toUid`: no delegation/owner-override mechanism is designed either. Neither is a quick patch bolted onto §6's authority model — both need their own dedicated future design pass, and resolving one does not automatically resolve the other (they are different directions of the same underlying "the recipient/debtor is no longer reachable through this Trip's own membership" problem).
3. **Linked Settlement correction (a "replaces" relationship analogous to Expense correction)** — explicitly NOT recommended for 4E (§11); reversal + ordinary re-recording is judged sufficient. Revisit only with real evidence of need.
4. **Multi-currency** — out of scope, USD-only, matching the Sept 13 audit's own unresolved-item #8 and every other financial surface in this codebase today. Not revisited here.
5. **Whether a dedicated "Balances" route is needed vs. an in-card presentation on Trip Detail** (§4/§19) — this preflight recommends starting with an in-card summary + inline full list (matching how Expenses itself started as a summary card before earning its own full-list route in 4D.2), but the exact routing decision is left to 4E.5's own implementation-time judgment, the same way 4D.2's "list → nested detail route" pattern was flagged as novel-but-not-blocking in the original Expense preflight.

---

## 23. Profile / Membership roadmap note

**Not implemented in this checkpoint, and not to be mixed into 4E's own implementation scope.** After the core Trip money lifecycle (Expenses → Reversal/Correction → Balances/Settlements) is complete, SquadStash's V1 still needs a proper Profile / Account hub. Recorded here as a forward-looking roadmap note only, per the checkpoint's own explicit instruction:

- Membership & Billing / subscription plan
- Savings Reports & Insights
- Account information
- Security & privacy
- Notifications
- Linked accounts / money settings (later)
- Automation preferences (later)
- Education / Learn
- Help & Support

None of the above is assumed, required, or partially built by this preflight or by 4E's own implementation sequence (§19). This note exists solely so the roadmap isn't lost track of once the money-lifecycle work is the sole focus of the next several checkpoints.

---

CHECKPOINT 4E.0A BALANCES & SETTLEMENTS PREFLIGHT HARDENED
READY FOR REVIEW

DO NOT IMPLEMENT.
DO NOT COMMIT.
DO NOT PUSH.
DO NOT DEPLOY.
STOP.
