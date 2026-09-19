# Trip Expense UI / UX Architecture Preflight

**Preflight date:** 2026-09-18 (amended 2026-09-19, Checkpoint 4D.0A hardening pass; amended again 2026-09-19, Checkpoint 4D.0B final integrity hardening pass)
**Type:** Architecture/UX design only — **no application code was changed**
**Baseline:** `claude/milestone-3-personal-savings-mvp` @ `34863df` ("Add trip expense correction linking"), working tree clean before and after
**Checkpoint:** 4D.0 — Trip Expense UI/UX Architecture Preflight; hardened by 4D.0A, then 4D.0B
**Production state confirmed:** `recordTripExpense` and `reverseTripExpense` are deployed as v2 callable Cloud Functions in `us-central1`; unauthenticated smoke checks against both returned `401 UNAUTHENTICATED` as expected. No Expense-creation UI exists anywhere in the app today.
**Governing documents:** `docs/audits/TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md` (as hardened by 4C.1A/4C.1B/4C.2C/4C.2D), `docs/audits/TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md` (as hardened by 4C.3A.1/4C.3A.2) — this document does not reopen either; it designs the client experience for the backend they already froze.
**Status:** DO NOT IMPLEMENT — this document freezes the 4D Expense UI/UX architecture before any 4D.1+ checkpoint begins writing code.

**Amendment note (Checkpoint 4D.0A):** this revision corrects several load-bearing gaps found in the original 4D.0 pass before it becomes the frozen plan: (1) the Split query now authorizes on **both** `tripId` and `expenseId` (§6/§7), matching `firestore.rules`' actual `tripExpenseSplits` authorization boundary (`resource.data.tripId`), not `expenseId` alone; (2) Splits are now read **one-shot**, not live-subscribed — they are immutable after atomic creation, so a permanent listener was never buying anything (§6); (3) the Expense/Split mappers now **fail closed** — malformed financial data is never rendered as active, never silently dropped, and always surfaces as an explicit error state, never a fabricated "safe" status (§8); (4) a terminal `onSnapshot` listener error now requires an explicit user-initiated Retry that attaches a fresh listener, rather than assuming Firestore will implicitly recover it (§6); (5) money-input sanitization is now strict-shape-validated before any character stripping, closing a real "abc12.50" → "12.50" coercion hole (§12); (6) member-profile fallback copy no longer uses a shortened UID anywhere — "Loading member…" / "Trip member" (§9); (7) the correction flow now loads and prefills the form **before** the irreversible reversal happens, so the user reviews the corrected record first (§24), and partial-success recovery is split into an honest same-session case vs. a later-session "Finish correction" case that never claims unsaved edits survived a restart (§25); (8) error handling now distinguishes definitive callable rejections (never auto-resubmitted) from truly ambiguous network outcomes, with specific `already-exists` copy (§20); (9) §37's five open decisions are resolved as approved — **this specifically included, at the time, a frozen `occurredAt` local-date→explicit-timezone-instant conversion requirement, which Checkpoint 4D.0B (below) subsequently found insufficient and withdrew**; (10) 4D.1 is split into 4D.1A (pure route restructure) and 4D.1B (Expense read/service + profile foundation), so the mechanical file move is never entangled with feature work (§35). Every other 4D.0 decision not named above — Trip Detail placement (§4), route shape (§5), visual/status semantics (§10/§29), archive behavior (§28), the no-new-index conclusion's own single-equality-filter reasoning (§7), and the overall two-explicit-operations correction model (§2/§4 of the governing reversal preflight) — is unchanged and not reopened.

**Amendment note (Checkpoint 4D.0B):** this revision resolves three final architecture issues found in the 4D.0A pass: (1) **`occurredAt` is now deferred out of 4D entirely** (§11/§19/§26/§37) — 4D.0A's own "convert the local calendar date to an instant with an explicit timezone offset" fix was itself found unsound, because an *instant* and a *calendar date* are not the same kind of fact and no single instant can guarantee every Trip member renders the same calendar day back; 4D now ships with no Expense-date input at all, `createdAt` is the sole displayed timestamp for ordinary creation, and a correction that touches an old Expense with an existing `occurredAt` preserves that instant internally without ever asking the user to re-enter it as a date; (2) **single-Expense reads are now bound to the route's own `tripId`** (§6/§21/§26) — `subscribeToExpenseById`/`fetchExpenseById` both now require `tripId` as well as `expenseId` and verify `mappedExpense.tripId === tripId` before ever returning data, closing a real cross-Trip data-exposure gap the 4D.0/4D.0A drafts left open (a member of two Trips could otherwise have had a Trip B Expense silently render inside a Trip A-scoped screen, since Firestore Rules only answer "may this user read this document," never "does this document belong to this screen's Trip"); (3) **the participant selector's "default all current Trip members" rule is now capacity-gated** (§14) — it was unconditionally correct only for Trips at or under the backend's own `MAX_EXPENSE_PARTICIPANTS = 100` cap, and a Trip with more members than that now gets its own explicit, non-silent selection UX (default to self only, a hard 100-selection cap with a live counter, "Select all" disabled) rather than an undefined or silently-truncated default. Every other 4D.0A decision not named above is unchanged and not reopened.

---

## 1. Current repository UI/service architecture

Confirmed by direct repository inspection (not assumed):

### Routing (`app/(tabs)/trips/`)
Exactly four files: `index.tsx` (Trips list), `create.tsx` (Trip creation — a full pushed **route**, not a modal), `[tripId].tsx` (Trip Detail — **2,052 lines**, a single flat screen), `_layout.tsx`. `_layout.tsx` registers exactly three `<Stack.Screen>` entries (`index`, `create`, `[tripId]`), all under one shared `screenOptions={{ headerShown: false }}` with no per-screen options — no `presentation: "modal"` is used anywhere in this route group. `_layout.tsx` also mounts `SavingsMoneyActionProvider` around the whole subtree plus two globally-rendered overlays, `<MoneyActionSheet />` and `<MoneySuccessSnackbar />` (both from `components/buckets/`, reused across the Buckets and Trips tabs via one shared context).

**Critical structural fact for route design (§6):** `[tripId].tsx` exists as a **file**, not a `[tripId]/` **directory**. Expo Router does not allow a dynamic segment to be both a file and a directory simultaneously. Any nested route under a specific trip (e.g. an Expense list/detail/create route) requires first converting `app/(tabs)/trips/[tripId].tsx` → `app/(tabs)/trips/[tripId]/index.tsx` (a mechanical move with a one-directory-level bump to every relative import in that file — it currently imports via `../../../src/...` and `../../../components/...`). This is real, unavoidable work, not a hypothetical.

Trips index navigates to `[tripId]` via the object form exclusively: `router.push({ pathname: "/(tabs)/trips/[tripId]", params: { tripId } })`. `create.tsx` navigates back via a template string: `` router.replace(`/(tabs)/trips/${tripId}`) `` — a pre-existing minor inconsistency, not something 4D needs to fix, but 4D's own new routes should use the object form consistently.

### Trip Detail screen (`[tripId].tsx`) information architecture
`ScrollView` → `isWide` (`width >= 980`) two-column grid (`gridWide`/`mainCol` flex:1 min-width:560 / `sideCol` width:360) or single vertical stack below that breakpoint. Current card order in `mainCol`: Hero (photo, archive trigger, date-edit, archived badge) → Shared Stash card → My Stash card. `sideCol` (wide only) holds the "Quick Analysis" card (per-person target/remaining, Trip Timeline/savings guidance) — a derived-metrics panel, not primary content. There is **no FAB, no "+"/add-content affordance, and no existing extension point** anywhere in this file. Every card follows one visual shell: `card` / `cardHeaderRow` / `iconBubble` (tinted circle + `MaterialCommunityIcons`) / `cardTitle` / `cardSub`.

Bottom-clearance for the floating `BottomNav` is computed from real exported dimensions, never a guessed constant: `BAR_HEIGHT = 56`, `CENTER_BUTTON_SIZE = 52` (`components/navigation/BottomNav.tsx`), combined into `scrollBottomInset` and applied as `ScrollView`'s `contentContainerStyle.paddingBottom`. `[tripId].tsx` is the **first and reference consumer** of this pattern per `BottomNav.tsx`'s own comment — every new Expense screen must reuse the identical computation, not a hardcoded padding value.

The only `Modal` (react-native) usage in `[tripId].tsx` is `ArchiveConfirmDialog` — an **inline function component in the same file** (not extracted), `transparent animationType="fade" onRequestClose={onCancel}`, with a `Pressable` backdrop as a **sibling** of the centered card `View` (never a parent wrapping it — this exact sibling-not-parent shape is a repeated, deliberate fix across this codebase for an RN-Web focus/containment bug, also seen in `MoneyActionSheet.tsx` and `BucketGridCard.tsx`). This is the established, reusable pattern for any new in-app confirmation dialog (reversal, correction).

### Global create entry point
`components/navigation/CreateActionSheet.tsx` — the bottom-sheet opened by `BottomNav`'s floating center "+" button. It is a dumb router: "New Bucket" navigates to `/(tabs)/buckets?openCreate=1`; "New Trip" pushes `/(tabs)/trips/create`. It has no Trip context, so it cannot reasonably grow a "New Expense" row (an Expense always needs a `tripId`) — Expense creation must be entered from within a specific Trip, not this global sheet.

### Firebase client service layer (`src/services/firebase/`)
Every existing service file (`trips.ts`, `buckets.ts`, `savingsTransactions.ts`) follows one consistent shape, confirmed line-by-line:
- A field-by-field mapper (`mapTripDocument`, `mapBucketDocument`, `mapSavingsTransactionDocument`) — **never** a whole-object cast, and load-bearing discriminant fields (e.g. `SavingsTransaction.type`) are validated, not trusted.
- `generate<X>ClientRequestId(): string` = `doc(collection(db, "<collection>")).id` — the client SDK's own id generator, reused as both the idempotency key **and** the resulting document id (never `crypto.randomUUID()`, which isn't guaranteed on RN targets).
- Trusted writes go through `httpsCallable(functions, "<name>")` called inline per function (there is **no shared callable-wrapper helper** anywhere — `src/services/firebase/functions.ts` is 13 lines and only wraps `lookupUserByEmail`), with a hand-written `parse<X>Response()` validator on the response (never a whole-object cast).
- Non-trusted metadata writes (Trip title, dates) stay direct Firestore `updateDoc`/`setDoc` — Trip has no trusted callable at all today.
- **There is no error-normalization helper anywhere.** Every caller (`useSavingsMoneyAction.tsx`'s `savingsErrorMessage()`, `[tripId].tsx`'s `stashCreateErrorMessage`/`sharedActionErrorMessage`) independently `switch`es on the raw `FirebaseError.code` string (`"functions/failed-precondition"`, `"functions/permission-denied"`, etc.) into user copy. This ad hoc duplication is the established convention, not an oversight.

`subscribeToPublicUsersByIds(uids, onChange, onError?)` (`src/services/firebase/users.ts:58`) already exists — a **live** `onSnapshot` on `where("__name__", "in", uids)` against `publicUsers`. It performs **no chunking internally**; the one existing call site (`app/(tabs)/buckets/index.tsx`) chunks uids into groups of 30 itself and merges the results. This is a concrete, load-bearing finding for §10 below.

`src/services/firebase/savingsTransactions.ts` is the closest architectural precedent for an Expense read service: one shared query builder (`resourceTransactionsQuery`: `where(resourceType,"==",...)`, `where(resourceId,"==",...)`, `orderBy(createdAt,"desc")`), reused by a one-shot fetch, a full-history live subscription, and a `limit()`-bounded recent-N live subscription — all three sharing the **one** composite index this query shape requires (see `firestore.indexes.json`, confirmed below).

**No Expense client service exists at all.** `grep -rl "recordTripExpense|reverseTripExpense" app/ src/` returns nothing outside `src/types/domain/expense.ts` and `src/domain/tripExpenseSplits.ts`. This preflight is greenfield on the client side; the backend contract is already frozen and deployed.

### Pure domain modules available for direct client reuse
- `src/domain/tripExpenseSplits.ts` — the **client-side twin** of `functions/src/domain/tripExpenseSplits.ts` (deliberately duplicated across the two separate TypeScript projects, per this repo's existing `tripPersonalBucketId`-style convention). Exports `computeEqualSplit`, `computePercentageSplit`, `computeCustomSplit`, `computeExpenseSplits` — pure, no Firestore imports, framework-independent. **Directly reusable for client-side split PREVIEW** (§18) — never for the actual persisted write, which the backend computes and validates independently regardless of what the client shows.
- `src/domain/tripSettlement.ts` — `computeTripBalances`, `assertValidExpensePaymentShape`, `SUPPORTED_CURRENCY` — pure balance derivation. **Explicitly out of scope for 4D** (§3).
- `utils/format.ts` — `formatCurrency(dollars)`, `formatTransactionTimestamp(timestampLike)` (Timestamp-or-Date-safe, falls back to `"Unknown date"`, never throws), `parseDollarsToMinorUnits(input, {allowZero})` (deterministic digit-string parser, no floating-point round-trip, rejects >2 decimals/unsafe integers/non-positive-unless-allowZero). **All three are directly reusable for Expense amount entry and date display — no new money/date-string parsing needs to be invented.**
- `src/domain/savingsMoneyAction.ts` — `resolveAmountMinor`, `normalizeTransactionNote`, `moneyActionFactsEqual`, `resolveMoneyActionClientRequestId`. This is the exact idempotent-retry precedent §19 must mirror.

### Firestore Rules and indexes (current, unmodified — 4D changes neither)
`firestore.rules`'s `tripExpenses`/`tripExpenseSplits` match blocks: `allow get, list` gated by `canAccessTripById(resource.data.tripId)` (current Trip `memberIds`/`ownerId` only, `archivedAt` never inspected — an archived Trip's Expense history stays fully readable); `allow create, update, delete: if false` unconditionally, for every role. `publicUsers/{uid}` allows `read` (get+list) to any signed-in user regardless of Trip membership — a member-profile query needs no per-Trip authorization check of its own.

`firestore.indexes.json` currently defines exactly three composite indexes (`buckets`, `trips`, `savingsTransactions` — each `memberIds`/`resourceType`+`resourceId` equality + `createdAt` DESC + `__name__` DESC). **No `tripExpenses` or `tripExpenseSplits` index exists.** See §7 for the exact analysis of whether 4D needs one.

### Shared UI components available for reuse
- `components/buckets/AvatarCircle.tsx` — `{index, label, photoURL?, size?}`, photo-or-initials fallback, exports `initialsFromName(name?)` and `shortUid(uid)`. Takes a plain `{label, photoURL}` pair, **not** a `PublicProfile` object directly — callers resolve UID→display identity themselves (see `avatarForUid` callback pattern in `BucketCard`/`BucketGridCard`).
- `components/buckets/GoalReachedBadge.tsx` — a trivial, **unparameterized** pill badge (`colors.mintSurface`/`colors.mintText`, `radii.pill`, text-only per an explicit accessibility requirement in its own header comment: "not color/icon-only"). Template for a new parameterized `StatusChip({label, tone})`.
- `components/buckets/TransactionRow.tsx` — the closest existing "financial history row" precedent. Deliberately does **not** show the acting member at all (no name, no UID, no avatar) — an explicit "field-exposure limit" per its own header comment. **There is no existing precedent for showing "who did this" in a history row** — Expense rows need new work here (payer avatar/name), not a copy-paste.
- `components/buckets/MoneySuccessSnackbar.tsx` — react-native-paper `<Snackbar>`, driven by a shared `successMessage: string | null` + `dismissSuccess()` pair on the owning hook, `AUTO_DISMISS_MS = 4000`. The sanctioned cross-platform success-toast mechanism (`Alert.alert` is explicitly rejected in this component's own comment as unreliable on web).
- `components/buckets/MoneyActionSheet.tsx` — a `Modal`-based bottom sheet, tightly coupled to `useSavingsMoneyAction()`'s contribution/withdrawal-only shape, **no keyboard avoidance**. Not directly reusable for Add Expense (too many additional fields), but its Modal/sibling-backdrop shell, disabled/submitting/error conventions, and token usage are the pattern to copy.
- `src/theme/useSemanticColors.ts` — `theme.dark ? darkColors : lightColors`, delegating entirely to react-native-paper's active theme (currently pinned to Light).

---

## 2. Exact 4D scope

4D covers, and only covers:
- Expense read/history experience (Trip Detail entry point + a full list view).
- Add Expense flow (`paymentSource: "member_out_of_pocket"` only).
- Expense detail experience, including split breakdown and correction lineage.
- Reverse Expense experience (`reverseTripExpense`).
- Correct Expense experience, as the two frozen, explicit trusted operations (`reverseTripExpense` then `recordTripExpense` with `replacesExpenseId`) — never a `correctTripExpense` callable, which does not exist and is not proposed here.
- Loading/error/empty states, active-vs-archived-Trip behavior, mobile/web responsive behavior.
- The trusted-callable client integration plan, Firestore read/subscription architecture, member/profile display strategy, and idempotent client retry behavior for both create and reverse.

## 3. Explicit 4E/4F exclusions

4D does **not** implement, and no section below smuggles in: Settlements, mark-as-paid, Venmo/PayPal/Zelle flows, an overall "You owe / You're owed" debt UI, Shared-Stash-funded (`paymentSource: "shared_stash"`) Expenses, receipt upload, multi-currency, permanent Expense deletion, direct Expense editing, or any Expense mutation through a direct Firestore client write.

`src/types/domain/settlement.ts` already defines a fully-designed `Settlement`/`CreateSettlementInput` type — but **no trusted callable, no service file, and no UI reference it anywhere** (confirmed by inspection). There is no technical dependency forcing 4D to touch it. **No blocker found; 4E/4F remain deferred exactly as instructed.**

---

## 4. Recommended Trip Detail information hierarchy

Trip Detail (`[tripId].tsx`, post route-conversion — §5) gains exactly **one new card**, in `mainCol`, immediately after the My Stash card (Shared Stash → My Stash → **Expenses**), following the existing `card`/`cardHeaderRow`/`iconBubble` shell byte-for-byte:

```
Expenses
Recent activity for this trip
[icon bubble: receipt-outline, bluePale/blue — a new accent leg, not yet used by Shared/My Stash's blue/mint pairing, keeping Expenses visually distinct]

<3 most recent ExpenseRow items, or an empty-state message>

[Add Expense]   [View all expenses →]
```

This is a **summary card, not the full management surface** — exactly the checkpoint's own instinct, now confirmed correct against the actual current screen: `sideCol`'s Quick Analysis panel is reserved for derived/summary metrics (not primary content, so Expenses does not belong there), and `mainCol` already holds every other "do a financial thing on this Trip" card, so Expenses joins that list rather than displacing anything. "Add Expense" and "View all expenses" navigate to dedicated routes (§5) rather than expanding this card in place — keeping `[tripId].tsx` from regrowing into a second 2,000-line monolith the way it already has once.

Archived-Trip presentation of this card: history stays fully visible; "Add Expense" is hidden (mirroring the exact existing pattern already used for Shared Stash's "Add Money," which the same file already hides when `isArchived`); "View all expenses" remains available (history is always readable).

---

## 5. Recommended routes/files

**Step 0 (mechanical, its own isolated change, no behavior change):** convert `app/(tabs)/trips/[tripId].tsx` → `app/(tabs)/trips/[tripId]/index.tsx`, bumping every relative import in that file by one directory level (`../../../src/...` → `../../../../src/...`, etc.), and registering it in `_layout.tsx` the same way (`<Stack.Screen name="[tripId]" />` still resolves to the folder's `index`). This must land and be verified (Trip Detail renders identically) **before** any nested route is added.

**New routes**, all under the now-existing `[tripId]/` directory:

```
app/(tabs)/trips/[tripId]/expenses/index.tsx      — full Expense list/history
app/(tabs)/trips/[tripId]/expenses/create.tsx     — Add Expense (ordinary AND correction mode)
app/(tabs)/trips/[tripId]/expenses/[expenseId].tsx — Expense detail
```

registered in `_layout.tsx` as three additional `<Stack.Screen>` entries, same `headerShown: false` convention.

**Why routes, not modals, for these three (evaluated against §6's own instruction to inspect convention first, not blindly adopt):** this codebase's only two "modal" precedents (`ArchiveConfirmDialog`, `CreateActionSheet`, `MoneyActionSheet`) are all small, single-purpose confirmations or 1–2-field pickers. `create.tsx` (Trip creation) — the closest precedent for a **multi-field creation form** — is a full pushed route, not a modal. Add Expense (description, amount, payer, participant multi-select, split strategy, category, date) is materially closer in shape to Trip creation than to a money-action sheet. Routes also give web URL/back-button behavior and a natural place to resume an interrupted correction (§24) without inventing a bespoke navigation-state machine. **Correction mode is a query param, not a second screen:** `expenses/create.tsx?replaces=<oldExpenseId>` — the create screen detects the param and fetches the old Expense (already readable via Rules) to prefill itself, rather than serializing a full Expense object through route params.

**Genuine open decision (flagged in §37, not silently resolved):** this is a **new pattern for this codebase** — there is currently zero precedent anywhere (Trips or Buckets) for a "list screen → tap → nested detail route." This recommendation is architecturally sound (it's the standard Expo Router shape, and the codebase already uses `[tripId]`/`[bucketId]` dynamic segments elsewhere), but because nothing existing confirms it by imitation, it deserves explicit reviewer sign-off before 4D.1 builds on it, rather than being accepted purely on convention-following grounds.

The Expense **list** rendered inline on Trip Detail (§4's summary card) and the full list route (`expenses/index.tsx`) share one `ExpenseRow` component and one subscription hook — the route is not a second, differently-shaped implementation.

---

## 6. Expense query/read architecture

New file `src/services/firebase/expenses.ts`, following the exact shape of `savingsTransactions.ts`:

```ts
export function subscribeToExpensesForTrip(
  tripId: string,
  onChange: (expenses: Expense[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe

export function subscribeToExpenseById(
  tripId: string,
  expenseId: string,
  onChange: (expense: Expense | null) => void,
  onError?: (error: unknown) => void
): Unsubscribe

export async function fetchExpenseById(
  tripId: string,
  expenseId: string
): Promise<Expense | null>

export async function fetchExpenseSplitsForExpense(
  tripId: string,
  expenseId: string
): Promise<ExpenseSplit[]>

export function generateExpenseClientRequestId(): string // doc(collection(db, "tripExpenses")).id

export async function recordTripExpense(input: RecordTripExpenseInput): Promise<{ expenseId: string }>
export async function reverseTripExpense(input: ReverseTripExpenseInput): Promise<{ expenseId: string }>
```

Conventions match every other service file exactly (§1): field-by-field mapping (never a whole-object cast), direct Firestore reads for both the live subscriptions and the one-shot fetches above, `httpsCallable` for the two trusted writes with an explicit, hand-written response parser on each, raw `FirebaseError`/`HttpsError` codes propagate unchanged (no generic callable wrapper is invented, matching this codebase's own established convention of one inline `httpsCallable` call per function).

**Checkpoint 4D.0A: Expenses are LIVE, Splits are ONE-SHOT — these are not symmetric, and must not be implemented as if they were.**
- **`tripExpenses` (via `subscribeToExpensesForTrip`/`subscribeToExpenseById`): live `onSnapshot`.** An Expense document's `status`, `reversedAt`/`reversedBy`, and the two correction-link fields (`replacesExpenseId`/`replacedByExpenseId`) can all change *after* the document is first read — a reversal or a correction landing while a screen is open must reconcile automatically, matching Bucket Detail's own `subscribeToSavingsTransactionsForResource` precedent.
- **`tripExpenseSplits` (via `fetchExpenseSplitsForExpense`): one-shot `getDocs`, never a subscription.** Split documents are immutable after their single atomic creation inside `recordTripExpenseCore`'s own transaction (confirmed by the persistence preflight's own frozen model — no write path anywhere ever updates an existing Split) — a permanent listener on data that can never change again buys nothing and only adds a second thing to leak/clean up. Expense Detail and the correction-prefill flow (§26) both read Splits once, when needed, and never re-subscribe.

**Query shape, corrected for Rules compatibility:**
- `subscribeToExpensesForTrip`: `where("tripId", "==", tripId)` against `tripExpenses`, **no `orderBy`** (§7).
- `fetchExpenseSplitsForExpense(tripId, expenseId)`: **`where("tripId", "==", tripId)` AND `where("expenseId", "==", expenseId)`** against `tripExpenseSplits`, **no `orderBy`**. `tripId` is included not merely as a convenience filter but because it is the actual Rules authorization boundary: `firestore.rules`' `tripExpenseSplits` match block authorizes strictly on `resource.data.tripId` via `canAccessTripById()` (confirmed by direct inspection of `firestore.rules` and by `tests/firestore-rules/tripExpenses.rules.test.js`'s own tripId-scoped query tests) — `expenseId`/the Split document id convey **no** authority on their own. A query that filtered on `expenseId` alone would still be correctly *authorized* by the Rules engine per-document, but would not reflect the actual boundary the Rules design freezes the read around, and would silently stop working the moment any future Rules tightening keyed off `tripId` more strictly. No Rules change is proposed or required here — this is a client query-shape correction only.

**Route-`tripId` binding (Checkpoint 4D.0B, new — load-bearing):** Expense Detail lives at `/trips/[tripId]/expenses/[expenseId]`, and a signed-in user may legitimately be a current member of more than one Trip. Firestore Rules answer only "may this signed-in user read this Expense document?" — they say nothing about "does this Expense belong to the Trip this specific screen is rendering?" Those are different questions, and only the client can answer the second one, because only the client knows which route it's on. **`subscribeToExpenseById`/`fetchExpenseById` therefore both take `tripId` as a required parameter, and both enforce, after reading and mapping the document:**

```
1. read tripExpenses/{expenseId}
2. map/validate it (§8)
3. REQUIRE expense.tripId === tripId (the caller's OWN expected value)
4. if it does not match: treat the result exactly as "not found" for this
   route context - the mismatched Expense is never returned to the screen,
   never rendered, never partially exposed
```

This is not a Rules workaround and does not imply Rules are insufficient for their own job — it is a distinct, client-side **route-integrity** check on top of Rules' own **access** check, closing a real class of bug where a caller who is a member of both Trip A and Trip B could otherwise have Trip B's Expense silently render inside a Trip A-scoped screen simply because they were permitted to read it at all. The identical invariant applies everywhere a single Expense is read by id, not only Expense Detail:
- **Expense Detail** (this section).
- **Correction prefill** (§26) — the old Expense fetched for prefill must belong to the same `tripId` the correction is being created under.
- **"Finish correction"** (§25) — the same fetch-and-validate step applies when resuming.
- **`replacesExpenseId`/`replacedByExpenseId` lineage navigation** (§21/§29) — correction-linked Expenses are *expected* to belong to the same Trip (the backend's own D2 authorization step already enforces same-Trip correction linking, per the reversal preflight §9.5 step 5B), but the client still performs this same validation rather than assuming the backend-enforced invariant holds forever without ever checking — cheap insurance against a future backend change or a corrupted/legacy record, exactly the same "trust but verify" posture §8 already takes toward Expense data generally.

**Mapping/runtime validation:** covered in full in §8 (fail-closed, not "map to a safe/inert shape").

**Ordering:** client-side sort by `occurredAt ?? createdAt`, descending — identical fallback precedence already established by `TransactionRow.tsx`/`RecentActivityRow.tsx`'s own `formatTransactionTimestamp(transaction.occurredAt ?? transaction.createdAt)` call, extended here to the sort key itself, not just the display string.

**Cleanup and listener-error retry (Checkpoint 4D.0A correction):** the Expense live subscription is torn down and re-attached exactly like `subscribeToBucketById`'s existing effect pattern in `[tripId].tsx` (a ref holding the current unsubscribe function, cleared and reassigned on `tripId`/`expenseId` change, called again on unmount) — that part is unchanged. **What changes:** once a subscription's `onError` callback has fired even once, that listener is treated as permanently failed, full stop — it is never assumed to silently recover on its own (Firestore's own terminal-error semantics, already documented elsewhere in this codebase for exactly this class of listener error, do not guarantee otherwise). The UI shows an explicit error state with a "Retry" action; pressing Retry disposes the existing (dead) unsubscribe reference and calls `subscribeToExpensesForTrip`/`subscribeToExpenseById(tripId, expenseId, ...)` again to attach a genuinely new listener. Route change/component unmount continues to unsubscribe normally regardless of error state. `fetchExpenseSplitsForExpense`/`fetchExpenseById(tripId, expenseId)`, being one-shot, have no listener to retry at all — a failed call is simply re-invoked directly by the same "Retry" affordance.

**Archived-Trip reads:** unaffected — Rules never inspect `archivedAt` for `tripExpenses`/`tripExpenseSplits` reads, so reads behave identically on an archived Trip; only the UI hides/disables the mutating actions (§28).

**Correction-link navigation:** `Expense.replacesExpenseId`/`replacedByExpenseId` are plain id-shaped strings already present on documents the current subscription already has (or can fetch by id) — no separate query is needed to walk a chain; Expense Detail resolves a linked id via `fetchExpenseById(tripId, linkedExpenseId)` (or a lookup in the already-subscribed list, when present) rather than a new live subscription per link hop — always passing the **current screen's own `tripId`**, per the route-`tripId`-binding requirement above, never the linked Expense's own (as-yet-unverified) `tripId`.

## 7. Index analysis

**No new Firestore index is required for 4D, by design.** `where("tripId", "==", tripId)` alone (no `orderBy`) is a single-field equality filter — Firestore never requires a composite index for that shape on its own. Adding `.orderBy("createdAt", "desc")` (or any field other than the one equality filter) **would** require a new composite index, mirroring `savingsTransactions`' own existing index exactly (`tripId` ASC + `createdAt` DESC + `__name__` DESC).

**Tradeoff evaluated, not assumed:** Expense volume per Trip is expected to be small-to-moderate for this milestone's realistic usage (a single group trip's out-of-pocket purchases) — client-side sorting of the full, unordered `where("tripId","==",tripId)` result costs nothing meaningful at this scale and avoids an index-creation step entirely. **Recommendation: no index for 4D.** If Expense volume per Trip later grows enough to need server-side pagination (`limit()` + `orderBy`), that is the concrete trigger to add the composite index then — not a speculative addition now.

`tripExpenseSplits`' own corrected query (`where("tripId","==",tripId)` **AND** `where("expenseId","==",expenseId)`, no `orderBy` — §6) also needs no composite index, at any scale: Firestore does not require a composite index for a query composed **only** of equality (`==`) filters, however many fields are involved — it satisfies that shape using the automatic single-field indexes every field already has, without a manual composite. A composite index only becomes necessary once an inequality filter or an `orderBy` on a field *other than* the equality filters is added — neither is present here, and none is proposed.

**This preflight does not create any index.** Confirming this is not merely asserted here — it is 4D.1B's own required validation step: run both real query shapes (`subscribeToExpensesForTrip`'s and `fetchExpenseSplitsForExpense`'s) against the Firestore emulator during 4D.1B's own implementation. If the emulator or a production dry run ever reports a missing-index error for either shape, **STOP and report it** rather than silently adding an index to make the error go away — that would mean this analysis missed something real, and the discrepancy needs to be understood before anything is added to `firestore.indexes.json`.

## 8. Expense mapper/runtime-validation plan

`mapExpenseDocument(id, data)` and `mapExpenseSplitDocument(id, data)`, field-by-field, mirroring `mapSavingsTransactionDocument`'s own discipline exactly — never a whole-object cast.

**Checkpoint 4D.0A correction — fail closed, do not invent a third safe status.** `Expense.status` (`src/types/domain/expense.ts`) is a closed union of exactly two values: `"active" | "reversed"`. There is no third, UI-only "record unavailable"/"inert" status, and 4D.0's earlier suggestion to map a malformed document into one is withdrawn — it would have been inventing public API surface (a status value nothing else in the system, including the backend's own type, recognizes) purely to paper over a mapping failure. Frozen behavior instead:
- `mapExpenseDocument` validates every load-bearing/discriminant field (`status`, `amountMinor`, `payerUid`/`paymentSource` shape, `tripId`) — a malformed value in any of them is a mapping **failure**, not a lossy best-effort mapping.
- **Malformed financial data must never render as `"active"`.** A document that fails validation is never silently coerced into looking like a normal, healthy Expense.
- **Malformed data must never be silently omitted** from a list while the remaining Expenses are presented as if the history were complete — that would misrepresent the Trip's own financial history by quietly hiding part of it.
- **A mapper failure becomes an explicit feature-level data-error state**, surfaced to the UI as such (e.g. a dedicated "This expense record could not be loaded" row/state in the list and in Expense Detail — see §30) — never a thrown exception that crashes an unrelated screen, and never a value indistinguishable from a genuine active/reversed Expense.
- **Mapper exceptions inside a subscription's `onSnapshot` callback must be caught there and routed into the same UI read-error state described above** (and, per §6, the listener-error-retry treatment) — an uncaught throw inside a snapshot callback is an uncaught exception in application code, not a Firestore-level error, and must never be allowed to propagate unhandled.
- `mapExpenseSplitDocument` applies the identical discipline to its own load-bearing fields (`tripId`, `expenseId`, `userId`, `amountMinor`) — a malformed Split fails closed the same way, never silently contributing a wrong or missing amount to a rendered split breakdown.

One additional freeze, unchanged from the original pass: the mapper must **never** surface `creationRequest` or `reversalRequest` to any UI-facing type — both are frozen as server-internal (per the reversal preflight's own §9.7/§18 "no client-suppliable audit field" principle, and per `src/types/domain/expense.ts`'s own comment that `creationRequest`/`reversalRequest` are deliberately absent from the public `Expense` type despite being persisted). The client-facing mapped `Expense` shape is exactly `src/types/domain/expense.ts`'s existing `Expense` type — no new parallel UI-only type is needed.

## 9. Member/public-profile resolution strategy

**Confirmed, concrete blocker (not a hypothetical):** `subscribeToPublicUsersByIds` uses a single `where("__name__","in",uids)` query with **no internal chunking**. Firestore's `in` operator is capped (30 comparison values in the current SDK). The backend's own `MAX_EXPENSE_PARTICIPANTS = 100` (`functions/src/callables/recordTripExpense.ts`), and `Trip.memberIds` carries **no cap at all** anywhere in this codebase — so a participant picker that needs profiles for "every current Trip member" can realistically exceed 30 on nothing more than a moderately large group trip, long before hitting the Expense-specific 100 cap.

**Required (not optional) new work:** extract the existing ad hoc chunking loop — today duplicated exactly once, inline in `app/(tabs)/buckets/index.tsx` — into one canonical helper in `src/services/firebase/users.ts`:

```ts
export function subscribeToPublicUsersByIdsChunked(
  uids: string[],
  onChange: (users: PublicProfile[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe
```

This becomes the one shared implementation for both the Trip member picker (payer/participant selection, §13/§14) and Expense-row/detail avatar resolution — never a second copy of the chunking loop.

**Checkpoint 4D.0A hardening — exact required behavior, not just "chunk it":**
- **Dedupe uids before querying.** The caller may legitimately pass an id more than once (e.g. a payer who is also a participant, resolved from two different source lists) — dedupe once, up front, so the same uid is never queried twice across chunks.
- **An empty input array must not issue an invalid `in` query.** `where("__name__","in",[])` is a malformed/empty-clause query; `uids.length === 0` short-circuits to an immediate empty result with no Firestore call at all.
- **Chunks of at most 30 ids** (Firestore's own `in`-operator cap), matching the existing `buckets/index.tsx` precedent exactly.
- **Each chunk's listener maintains that chunk's own current result set**, and the helper **emits one merged aggregate** across all chunks on every change — never a partial/stale merge where one chunk's update silently overwrites the combined result with only its own slice.
- **A profile that disappears from a later snapshot of its chunk is removed from the aggregate**, not left behind as a stale entry (Firestore's own `onSnapshot` already reports removals within a single chunk's snapshot; the merge step must honor that removal in the combined output, not just additions/updates).
- **One combined `Unsubscribe`** stops every chunk's underlying listener together — a caller never has to track N separate unsubscribe functions.
- **Listener errors surface through the single `onError` callback** — a failure on any one chunk is reported, not silently swallowed while other chunks continue.
- **Consumers may reorder the merged result by `Trip.memberIds`'s own order** (or any other order they need) — the helper itself makes no ordering guarantee of its own, since Firestore's `in` query result order is not meaningful here.

**Fallback copy when a profile is temporarily missing or confirmed absent (Checkpoint 4D.0A correction — no UID exposure of any kind, ever):** `shortUid(uid)` (or any other UID-derived string) is **withdrawn** as acceptable fallback UI copy — a shortened UID is still a real, internal identifier leaking into user-facing text, which the original 4D.0 pass incorrectly treated as an acceptable stopgap. Frozen copy instead:
- **Profile not yet resolved** (subscription still pending): **"Loading member…"**
- **Profile confirmed absent** (the id has no `publicUsers` document at all, or the subscription resolved without it): **"Trip member"**
- **Multiple simultaneously-missing profiles in one selector/list** (e.g. several rows in the participant picker with no resolved name): disambiguated as **"Trip member 1"**, **"Trip member 2"**, etc., in stable order — never all rendered as the identical unlabeled "Trip member" with no way to tell them apart.

`AvatarCircle`'s avatar graphic itself still falls back to its own existing generic/initials-from-nothing rendering in either case — only the **text label** convention changes; no UID-derived string is ever used as that label.

---

## 10. Expense history visual model

Rows must answer, at a glance, without raw UIDs: what, how much, who paid, when, and current status. Concrete presentation rules, by state:

| State | Treatment |
|---|---|
| Active ordinary Expense | Normal weight/color, no chip. |
| Active replacement Expense (`replacesExpenseId` set) | Normal weight/color + a small, text-based, blue-toned "Correction" chip (not a warning color — this is informational lineage, not a problem state). |
| Reversed Expense, no replacement | Muted `textMuted`-colored amount/description (not strikethrough — avoids "unreadable history"), a text-based "Reversed" chip in a neutral slate tone (`colors.slatePale`/`colors.textSecondary` — explicitly **not** `colors.coral`, which this codebase's own frozen Light Mode palette reserves for real destructive/error states only, never a decorative or past-tense-state color). |
| Reversed Expense, with replacement | Same muted treatment + "Reversed" chip + a tappable "Replaced by [description]" line navigating to the replacement. |
| Replacement Expense that is itself later reversed | Both facts shown: muted treatment + "Reversed" chip (current truth) + the "Correction" chip and its own "Replaced by …" line if it too has since been replaced — a chain (`A → B → C`) is walked one link at a time, each Expense showing only its own immediate neighbors, never a flattened all-at-once chain view (avoids over-building a feature nothing has asked for yet).

Reversed Expenses are **never** hidden from history — they remain full-fidelity audit rows, per the reversal preflight's own frozen "reversal is historical reconciliation, never destruction" principle.

## 11. Add Expense form model

Fields, strictly bounded to the current callable contract (`functions/src/callables/recordTripExpense.ts`'s own documented input shape):

```
description   (required, trimmed, ≤500 chars — MAX_DESCRIPTION_LENGTH)
amount         (required, positive, ≤2 decimals — §12)
payerUid       (required, current Trip member — §13)
participants   (required, ≥1, each a current Trip member — §14)
splitStrategy  ("equal" | "percentage" | "custom" — §15–17)
category       (optional, ≤100 chars — MAX_CATEGORY_LENGTH)
```

**Checkpoint 4D.0B: `occurredAt` is deliberately NOT an Add Expense field in 4D — no date input is shown at all.** The persisted `occurredAt` is an *instant* (a specific point in time), while a date-only user choice ("September 19") is a *calendar date* — the two are not the same kind of fact, and no single instant can guarantee every Trip member, in every timezone, renders it back as the same calendar date (an instant chosen at a member's own local midnight on September 19 can legitimately display as September 18 or September 20 for a member elsewhere). 4D.0A's own proposed fix (convert the chosen local date to an instant using the device's own timezone offset) does not actually resolve this — it just picks one arbitrary local midnight as the canonical instant, which still renders as a different calendar date for members in other timezones. This is a genuine schema/product question (whether a future checkpoint adds a true instant-with-time picker, or a dedicated calendar-date-only field such as `occurredOn`), not something 4D should half-solve with an ad hoc conversion. Since `occurredAt` is already optional on the existing callable, omitting it entirely is not a blocker for 4D — ordinary Expense creation simply never sends it, and `createdAt` (server-generated, unambiguous, already the fallback everywhere `occurredAt` is absent — §6/§9-of-the-governing-preflight) is the sole displayed timestamp/date for every 4D-created Expense. See §26 for the one exception (preserving an *existing* `occurredAt` during correction, never asking the user to re-enter it as a date).

`replacesExpenseId` is **never** a user-entered field — supplied internally only when the screen was opened in correction mode (§24). `paymentSource` is never shown as a choice — 4D always sends (or omits, since it's optional and defaults server-side to) `"member_out_of_pocket"` only. The following are never exposed as input, anywhere: `createdBy`, `status`, `reversedAt`, `reversedBy`, `replacedByExpenseId`, `creationRequest`, `reversalRequest`, `clientRequestId` — all system/trusted fields, matching the backend's own strict top-level allowlist exactly (the form simply has no field for any of them, rather than a disabled/hidden one).

## 12. Money-input strategy

**Checkpoint 4D.0A correction: the original 4D.0 recommendation (`text.replace(/[^0-9.]/g, "")` as a pre-clean, copied from `[tripId].tsx`'s own `submitCreateStash`) is withdrawn.** Blind character-stripping validates nothing about the *shape* of what was typed — it only removes characters from *whatever* was typed, silently accepting garbage as a side effect. Concretely: `"abc12.50"` strips to `"12.50"`, which then parses as a valid $12.50 — a real, user-facing money-entry hole where a stray character (a fat-fingered letter, a pasted label like "amt:") silently produces a plausible-looking but never-actually-intended amount, with no error shown at all.

**Frozen instead — validate the whole shape FIRST, strip formatting characters only AFTER the shape is confirmed acceptable:**

1. Trim surrounding whitespace.
2. Match the **entire, trimmed** string against one strict pattern that recognizes only the accepted money shapes below (an optional leading `$`, digits with optional thousands commas in valid groups, an optional `.` plus 1–2 decimal digits) — if the full string does not match this pattern, reject immediately with "Enter a valid amount" and stop. Nothing is stripped or coerced at this stage.
3. **Only once step 2 accepts the shape**, remove the recognized formatting characters (`$`, `,`) and hand the remaining plain digit-and-decimal-point string to the existing `parseDollarsToMinorUnits` (`utils/format.ts`) unchanged — still the sole source of the actual dollars-to-minor-units arithmetic, never re-implemented.

This is a new, small, pure normalization helper (`normalizeMoneyInput` or similar) sitting *in front of* `parseDollarsToMinorUnits`, not a replacement for it — `parseDollarsToMinorUnits`'s own digit-string, no-floating-point-round-trip arithmetic is unchanged and still authoritative for the actual conversion.

Frozen behavior table (Checkpoint 4D.0A: every row below must have explicit 4D.3 test coverage, not just documentation):

| Input | Result |
|---|---|
| `12` | 1200 minor units |
| `12.5` | 1250 |
| `12.50` | 1250 |
| `$12` | 1200 |
| `$12.50` | 1250 |
| `1,234.56` | 123456 |
| `$1,234.56` | 123456 |
| Leading/trailing whitespace around any valid shape above | Parsed identically after trimming |
| `-12` / `-$12` | Rejected at shape-validation — "Enter a positive amount" (never reaches stripping, never silently coerced to positive) |
| `abc12` / `12abc` / `abc12.50` | Rejected at shape-validation — "Enter a valid amount" (the whole string must match the accepted shape; a stray letter anywhere is a hard rejection, never silently dropped) |
| `12.555` (too many decimals) | Rejected — "Enter an amount with at most 2 decimal places" |
| `1..2` (malformed punctuation) | Rejected at shape-validation — "Enter a valid amount" |
| `0` | Rejected — "Enter an amount greater than $0" (matches backend's own `amountMinor <= 0` rejection) |
| An amount whose minor-unit value exceeds `Number.isSafeInteger` | Rejected via `parseDollarsToMinorUnits`'s own safe-integer check — "Enter a smaller amount" |
| Any other unsupported punctuation/malformed currency shape | Rejected at shape-validation — "Enter a valid amount" |

The client's rejection is a friendly, immediate pre-check; the backend independently re-validates `amountMinor` regardless (`Number.isSafeInteger`, `> 0`) — the client never becomes the sole authority. Floating-point arithmetic (`Number(text) * 100` or similar) is never used anywhere in this path, matching `parseDollarsToMinorUnits`'s own established discipline.

## 13. Payer UX

`payerUid` defaults to the current authenticated uid ("You") but **must remain changeable** — the frozen backend model explicitly allows `createdBy !== payerUid` (any member may log an expense paid by another member). Single-select list of current Trip members (`Trip.memberIds` ∪ `ownerId`, matching `isCurrentTripMember`'s own backend semantics exactly), each row using `AvatarCircle` + resolved display name (§9), current user's own row labeled "You" in addition to their name. The backend remains the sole authority — a stale client-side membership snapshot that no longer matches reality simply surfaces as the existing `failed-precondition` ("payerUid is not a current member") through the normal error-mapping path (§20), never a client-side security assumption.

## 14. Participant UX

Multi-select over the same current-member list as §13. "Select all"/"Clear" affordance (subject to the >100 rule below). Current user's row always shown, labeled "You". Save is disabled with an inline message ("Select at least one participant") when the selection is empty — matching the backend's own `participants must be a non-empty array` rejection, caught client-side first. A member whose profile hasn't loaded yet still appears in the list (never silently dropped), rendered with the "Loading member…"/"Trip member" fallback copy until resolved (§9) — never a UID of any kind.

**Checkpoint 4D.0B — default selection is capacity-dependent, not unconditional.** The backend caps a single Expense at `MAX_EXPENSE_PARTICIPANTS = 100` (`functions/src/callables/recordTripExpense.ts`), but `Trip.memberIds` itself carries no such cap anywhere in this codebase (§9) — "default all current Trip members" is therefore only safe when the Trip actually has 100 members or fewer. Frozen behavior, branching on the current Trip's own member count:

- **Trip member count ≤ 100:** default selection is **all current Trip members** (the original 4D.0 behavior, unchanged) — the common case is "split evenly among everyone," and defaulting to that minimizes taps for the majority path while remaining fully editable. "Select all" works normally (selects everyone, always ≤100 by construction in this branch).
- **Trip member count > 100:** the "default everyone" behavior is **withdrawn** for this Trip. The form never silently selects, or silently truncates to, the first 100 members — that would create a real Expense whose participant list the user never actually chose. Instead:
  - Default selection is **only the current authenticated member** (assuming they remain a current Trip member) — never an arbitrary or truncated subset of others.
  - Shown copy: *"This expense can include up to 100 people. Choose the members sharing this expense."*
  - The selector enforces a **hard maximum of 100 selected members**: once 100 are selected, every remaining unchecked row stays visible (never hidden) but cannot be selected until another member is first deselected.
  - A live counter is shown once any selection exists in this branch: *"100 of 100 selected"* (or the current count out of 100).
  - "Select all" is hidden or disabled with explanatory copy in this branch, rather than silently selecting only the first 100 members it can fit — silently picking a subset for the user is exactly the failure mode this freeze exists to prevent.
  - The payer remains independently selectable via §13 and is never required to also be a selected participant, in either branch.
  - The backend remains the sole authority regardless of branch — a stale client-side member count (e.g. the Trip crossed the 100-member line between the form opening and submission) simply surfaces through the ordinary error-mapping path (§20) if it ever causes a genuine backend rejection.

**Scalability (2 / 5 / 20+ / 100+ members):** a single scrollable checklist (bounded-height `ScrollView` or `FlatList` inside the form, not an unbounded inline row of checkboxes) — this pattern scales acceptably from 2 up through the enforced 100-selection cap without a new component class, in both branches above. A search/filter box is explicitly **not** built for 4D — noted as a future add-on only if a real large-Trip case shows the plain scrollable list is actually unusable, not built speculatively now. Future test coverage (4D.3/4D.4) must include: exactly 99 members, exactly 100 members, 101 members (the `>100` branch activates), and an explicit attempt to select a 101st participant (must be blocked client-side, never reaching the network).

## 15. Equal split UX

No additional input beyond the participant selection itself — the backend computes exact per-cent allocation (largest-remainder method, already proven in `computeExpenseSplits`'s own test suite). Client shows a live preview (§18) computed via the same pure function, purely for display.

## 16. Percentage split UX

One numeric field per selected participant, entered as an ordinary percentage (e.g. `50`), converted to integer basis points (`percentage * 100`) at the wire boundary. **No existing parser fits this** (`parseDollarsToMinorUnits` is money-shaped, not percentage-shaped) — a new, small, pure helper (`parsePercentageToBasisPoints`, mirroring `parseDollarsToMinorUnits`'s exact no-floating-point-round-trip, digit-string-based approach) is required. Sum of entered percentages must equal exactly 100.00% (10000 basis points) before Save is enabled — a client-side gate mirroring `computePercentageSplit`'s own backend rejection of any total ≠ 10000, never a substitute for it.

## 17. Custom split UX

One dollar-amount field per selected participant (reusing `parseDollarsToMinorUnits`, `allowZero: true` — the backend explicitly permits an intentional $0 share, per `computeCustomSplit`'s own test coverage). Sum must equal exactly the Expense's total `amountMinor` before Save is enabled.

**Switching strategies (frozen for 4D.3, revisited in 4D.4):** switching resets the just-abandoned strategy's per-participant inputs rather than attempting to carry values over — the simplest correct behavior, avoiding stale/mismatched partial state feeding a preview. Carrying the equal-split preview values forward as smarter percentage/custom starting points is named as a legitimate 4D.4 enhancement, not required for the form to ship.

**Payer participation:** the payer is not automatically forced into (or out of) the participant list — the backend has no rule linking the two fields (a member may pay for something they don't personally share in, e.g. a gift). The payer is pre-checked among participants by default (the common case), remaining independently deselectable.

## 18. Per-Expense split preview

Before submission, a plain, non-financial-calculation preview using the client-side `computeExpenseSplits` (§1) and already-resolved display names:

```
Alex paid $240
Split between:
  You     $80
  Alex    $80
  Jordan  $80
```

Deliberately **no** "you owe / you're owed" framing anywhere in this preview — that composite, cross-Expense calculation is `tripSettlement.ts`'s own `computeTripBalances`, explicitly reserved for 4E (§3).

## 19. Create idempotency controller

**This is the most safety-critical section of this document**, mirrored as closely as possible from the proven `useSavingsMoneyAction.tsx`/`src/domain/savingsMoneyAction.ts` precedent (§1) — not a new, unrelated mechanism.

New pure module `src/domain/expenseSubmission.ts`:

```ts
export type ExpenseCreationFacts = {
  tripId: string; payerUid: string; amountMinor: number; currency: "USD";
  description: string; category: string | null; splitStrategy: SplitStrategy;
  participants: NormalizedParticipant[]; // uid-sorted, matching the backend's own canonicalization
  paymentSource: "member_out_of_pocket"; occurredAtInstantMs: number | null;
  replacesExpenseId: string | null;
};
export function expenseCreationFactsEqual(a, b): boolean; // field-by-field, including a deep participants compare
export function resolveExpenseClientRequestId(pendingRef, facts, generateExpenseClientRequestId): string;
```

`ExpenseCreationFacts` is deliberately shaped to match `NormalizedCreationRequest` (`functions/src/callables/recordTripExpense.ts`) field-for-field, **including `replacesExpenseId`** — since 4C.3D froze that field as part of creation identity, a client-side idempotency comparison that ignored it would risk the exact same "same id, silently different request" hazard `savingsMoneyAction.ts`'s own header comment already warns about for `note`.

**Checkpoint 4D.0B: `occurredAtInstantMs` is `null` for every ordinary 4D-created Expense**, since 4D exposes no `occurredAt` input at all (§11) — this is not an omission in the fact set, it is the correct, explicit value given what 4D actually sends. The **one** exception is a correction that deliberately preserves an existing old Expense's own `occurredAt` (§26): in that specific case, `occurredAtInstantMs` carries the preserved instant, and it participates in the replacement's own idempotency comparison exactly like every other fact — a retry of that same correction with the same preserved instant reuses the same `clientRequestId`; a retry that ends up with a *different* `occurredAtInstantMs` (e.g. the preservation logic failed differently on a second attempt) is correctly treated as a different logical request, mints a fresh id, and must never silently proceed as if it were the same one.

Controller behavior, mirroring `useSavingsMoneyAction` line-for-line:
- **Synchronous `inFlightRef` guard** (a ref, never state) set at the top of `submit()` before any `await` — a rapid double-tap cannot race past it.
- **`pendingRef`** holds `{...facts, clientRequestId}` across a failed/uncertain attempt.
- **New logical Expense → new `clientRequestId`** (`generateExpenseClientRequestId()` = `doc(collection(db,"tripExpenses")).id`, matching every other `generate*ClientRequestId` in this codebase).
- **Retry with unchanged facts → reuse the same id.** Any changed fact (including `replacesExpenseId`) → mint a fresh id.
- **`already-exists` is definitive** (the backend's own atomic transaction proves this exact id was already committed under different facts) → clear `pendingRef`, next attempt gets a fresh id.
- **Every other failure (`unavailable`, `deadline-exceeded`, unknown) is ambiguous** → `pendingRef` is deliberately left untouched, so a retry of the same facts reuses the same id rather than risking a duplicate Expense.
- Double-tap prevention is synchronous (`inFlightRef`), never React state alone.

**On success:** dismiss the form, show a success snackbar (`MoneySuccessSnackbar`'s exact pattern, a new shared `announceExpenseSuccess`), and navigate back to the Expense list/Trip Detail. The list's own live subscription (§6) reconciles the real persisted Expense — **no fake optimistic financial record is ever inserted locally that could later disagree with the backend.**

## 20. Error mapping

A local `expenseErrorMessage(e)` switch, matching the exact existing per-feature convention (`savingsErrorMessage`, `stashCreateErrorMessage`, `sharedActionErrorMessage`) rather than introducing a new shared abstraction (this is the fourth near-identical copy — approved as a deliberate choice in §37, not silently "fixed" here).

**Checkpoint 4D.0A correction: do not infer a *specific* `failed-precondition` reason from the callable/error code alone when the client has no independent way to know it's true.** The original 4D.0 draft's "selected from the callable/step context the UI already knows it's in" was too permissive — a generic `failed-precondition` from the backend does not, by itself, tell the client *which* precondition failed (archived Trip? a member removed mid-flight? already reversed?), and guessing risks telling the user something false. The rule going forward:
- **If the client independently already knows the specific fact** (e.g. it already knows, from its own already-loaded Trip data, that this Trip is archived), it may show that specific, honest copy: *"This trip is archived and no longer accepts new expenses."*
- **Otherwise**, `failed-precondition` gets one honest, generic copy that names no unverified specific cause: *"We couldn't save this expense because its trip or member information changed. Refresh and try again."*

**Definitive vs. ambiguous, applied consistently to every callable (create and reverse alike):**

| Code | Meaning | Behavior |
|---|---|---|
| `invalid-argument` | Definitive — this request did not commit. | The specific client-side validation message already shown inline where possible (§12/§14/§15–17); otherwise a generic "That information isn't valid — please check and try again." Should rarely reach the network at all. |
| `permission-denied` | Definitive — this request did not commit. | "You don't have permission to do that." (never discloses *why* — matches the backend's own information-leak discipline) |
| `failed-precondition` | Definitive — this request did not commit. | See the client-knowledge rule above — specific copy only when independently verified, generic safe copy otherwise. |
| `not-found` | Definitive — this request did not commit. | "This expense/trip could not be found." |
| `already-exists` | Definitive — this exact request id was already committed under **different** facts; this attempt did not commit. | The idempotency controller (§19/§23) clears the conflicting pending request id immediately (a fresh id is minted for the next attempt), and shows: *"We couldn't safely reconcile this expense request. Review it and try again."* This is **not** silently swallowed as "internal only" — the user is told plainly that this specific attempt needs a fresh look, and a fresh explicit retry is required. |
| `unavailable` / `deadline-exceeded` / any unrecognized/unknown transport or response failure | **Ambiguous** — the write may or may not have actually committed server-side before the response was lost. | "We couldn't reach the server, so we can't confirm this went through — it's safe to try again." The pending facts + `clientRequestId` are deliberately **preserved** (§19/§23) so the retry the user is told is safe actually is safe — an exact retry with unchanged facts reuses the same id and can never produce a duplicate. |

**No automatic resubmission for any definitive rejection** — `invalid-argument`/`permission-denied`/`failed-precondition`/`not-found`/`already-exists` all require the user to take an explicit new action (edit and resubmit, or acknowledge and retry) before another network call is made. Only the ambiguous row above is framed as "safe to retry" — because it is the only row where a same-facts retry is actually risk-free by construction, never because the UI is guessing.

No internal backend detail (raw error text, field names, stack traces) is ever surfaced, in any row.

## 21. Expense detail design

New route `expenses/[expenseId].tsx`, reading its `tripId` from the route itself and passing it into every single-Expense read (`subscribeToExpenseById(tripId, expenseId, ...)`, `fetchExpenseSplitsForExpense(tripId, expenseId)`) — per §6's route-`tripId`-binding requirement, an Expense whose own `tripId` doesn't match this route's `tripId` is treated as not found, never rendered. Shows: description, amount, payer (resolved name, never a UID), date (`occurredAt` if present, else `createdAt`, via `formatTransactionTimestamp` — `occurredAt` is present only for a correction that preserved an old instant, §26, never for an ordinary 4D-created Expense), category, split strategy, full participant/split breakdown (each participant's resolved name + share amount, using the already-fetched `ExpenseSplit` rows — never recomputed client-side for the persisted record, only for the create-time preview), status, and correction lineage in user-friendly terms:
- Active replacement: **"Corrected version of [old Expense's description]"**, tappable → navigates to the old Expense's own detail route.
- Reversed with replacement: **"Replaced by [new Expense's description]"**, tappable → navigates forward.
- No technical id is ever shown to a normal user — the tappable link text uses the *linked Expense's own description*, resolved via `fetchExpenseById(tripId, replacesExpenseId | replacedByExpenseId)` (§6) — always the current screen's own `tripId`, with the same route-binding check applied to the linked record before it is ever shown or navigated to.

## 22. Reversal UX and authorization

`reverseTripExpense` accepts `{expenseId, reversalReason?, clientRequestId}`. UI: an in-app confirmation dialog, structurally identical to `ArchiveConfirmDialog` (Modal, sibling backdrop, centered card — **never** `window.confirm`), explaining plainly: "This expense will stop counting toward balances. Its history will remain — nothing is deleted." An optional, free-text reason field.

**Authority in the UI is advisory only, never a security boundary:** the client computes `canReverse = isOwner || (expense.createdBy === currentUid && isCurrentTripMember)` purely to decide whether to show/enable the "Reverse" action — the backend independently re-validates every time (per the reversal preflight's own frozen §5 model, with `payerUid`/participant status granting no authority whatsoever). A stale client computation (e.g. the user was just removed from the Trip) correctly surfaces as the existing `permission-denied` mapping (§20) — this is never treated as a bug, it's the system working as designed.

## 23. Reversal idempotency

A second, small controller mirroring §19's exact shape, with its own fact set: `{expenseId, reversalReason: string | undefined}`. `reversalReason` normalization matches the backend's own frozen rule (`docs/audits/TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md` §8.2/§14) exactly: trim, and treat omitted-or-whitespace-only as the same normalized value (`undefined`, mirroring `normalizeTransactionNote`'s own `trim() → undefined-if-empty` convention) — so a client retry with a slightly different amount of whitespace in the reason field is still recognized as the same logical request, never spuriously minting a new id. The reversal's own `clientRequestId` needs no chunking/collision namespace of its own (per the reversal preflight's own §17, it's never used as a Firestore document id) — any collision-resistant string works; reusing `doc(collection(db, "tripExpenses")).id` purely as a convenient generator is sufficient. Synchronous double-submit guard and definitive-vs-ambiguous error handling mirror §19 exactly.

## 24. Correct Expense UX

**Checkpoint 4D.0A — REQUIRED PRODUCT CHANGE: the original 4D.0 "reverse first, then open the form" flow is replaced.** Irreversibly reversing the old Expense *before* the user has even seen or approved what the corrected version will look like put the destructive step ahead of the user's own review — the frozen flow instead loads and prefills the correction **before** anything irreversible happens:

```
A. User taps "Correct expense" on Expense Detail (subject to §27's authority
   check, and only ever offered when the old Expense's current state
   qualifies - see "Active vs. already-reversed correction mode" below).

B. Navigate immediately to expenses/create.tsx?replaces=<oldExpenseId>
   (§5) - WITHOUT mutating anything. No reversal has happened yet.

C. The create screen loads the old Expense (fetchExpenseById) and its
   immutable Splits (fetchExpenseSplitsForExpense(tripId, oldExpenseId)) -
   both one-shot reads, per §6's corrected read architecture.

D. The form is prefilled from those facts (§26).

E. The user reviews the prefilled correction and edits whatever was wrong.

F. The user taps "Save correction".

G. An in-app confirmation dialog explains, plainly, before anything
   irreversible happens:
     - the original expense will first be reversed
     - the corrected replacement will then be created
     - the original's history remains, nothing is deleted
     - if the replacement fails to save AFTER the reversal succeeds, the
       original stays reversed and the replacement can be retried (§25)

H. On confirm, and ONLY on confirm:
     1. reverseTripExpense(oldExpenseId) (§22/§23's own controller).
     2. After reversal succeeds: recordTripExpense(the reviewed/edited
        facts, replacesExpenseId: oldExpenseId) (§19's own controller).
```

This is still, honestly, **two separate trusted operations** under the hood — never a `correctTripExpense` callable, never a rollback, never an un-reverse — matching this app's own established principle (already applied to Expense/Shared-Stash-withdrawal linkage in the original architecture audit) that "an atomic combined callable would be the first time this app's money layer silently performs a financial side effect a human didn't independently trigger." What changes from the original 4D.0 draft is purely the **ordering**: the user now reviews the corrected record *before* the irreversible step, not after being told it already happened.

**Active vs. already-reversed correction mode (Checkpoint 4D.0A, new):** step A's entry point and step H's exact behavior both depend on the old Expense's state at the moment the flow is entered — this is not a single fixed behavior:
- **Old Expense is currently `"active"`:** the button reads **"Save correction"**, and confirming performs the full two-call sequence in step H exactly as written above (reverse, then create).
- **Old Expense is currently `"reversed"` and `replacedByExpenseId` is absent** (i.e. someone already reversed it — possibly the current user in an earlier, interrupted attempt — but no replacement exists yet): the button instead reads **"Finish correction"**, and confirming performs **only** step H.2 (`recordTripExpense` with `replacesExpenseId`) — **no second `reverseTripExpense` call is ever issued.** The confirmation copy in step G is adjusted accordingly (§25 gives the exact wording for this case).
- **Old Expense already has `replacedByExpenseId` set** (a canonical replacement already exists): "Correct expense"/"Finish correction" is **not offered at all** from this old Expense. Expense Detail instead shows/links to the existing canonical replacement (§21's own "Replaced by …" navigation) — claiming a second correction slot is not authorized by the backend (the reversal preflight's own frozen one-to-one replacement rule) and the UI must not offer an action that can only fail.

## 25. Partial-success recovery

**Load-bearing, not a theoretical edge case:** reversal can succeed while replacement creation fails or returns an ambiguous network result. The old Expense is *truthfully* reversed either way — this is never treated as corruption. Two genuinely different cases are frozen separately below; they must not be conflated.

### Same session / current mount

If, within the same still-mounted create-screen session, step H.1 (reversal) succeeds but step H.2 (replacement creation) fails or returns an ambiguous result:

> "The original expense was reversed, but we couldn't save the corrected version. Your edits are still here — try saving again."

The already-entered replacement facts **remain in the mounted form** exactly as the user left them — nothing is cleared. The retry button re-attempts **only** replacement creation (step H.2), reusing §19's own idempotency controller unchanged: as long as the replacement's facts (including `replacesExpenseId`) are unchanged, the same `clientRequestId` is reused, so a retry can never produce a duplicate replacement. **The reversal is never repeated** — it already succeeded, and there is no un-reverse/rollback operation anywhere in the backend to reconsider.

### Later session / app restart

If the user navigates away, backgrounds the app, or the process is killed before the replacement is saved, **the in-memory form contents do not survive** — 4D is **not** adding any persisted-draft storage, and the UI must never imply that unsaved edits from a prior process/session are still sitting there waiting. Instead, this is detected structurally: whenever an Expense is loaded (in the list, in Expense Detail) with `status: "reversed"` and `replacedByExpenseId` absent, that is durable, persisted evidence that a correction was started but never finished — regardless of which device, session, or app process started it. That Expense's own detail screen shows a **"Finish correction"** action (per §24's own state-dependent labeling above) with the copy:

> "The original expense was reversed, but no corrected replacement has been saved yet. Finish the correction below."

Tapping it opens a **brand-new** prefilled correction form, freshly built from the currently-persisted old Expense + its Splits (§26) — never a restored draft. The user re-enters/re-confirms whatever fields matter to them and taps "Finish correction" (§24's create-only path) to complete it. This is a dead-end-free recovery path by construction: as long as the old Expense's own `status`/`replacedByExpenseId` fields are visible (which Rules always allow to any current Trip member), the correction can always be resumed from scratch, from any device, at any later time.

## 26. Correction prefill

**Checkpoint 4D.0A: prefill now happens BEFORE any reversal, not after (§24).** Prefilled from the old Expense and its Splits, both read via one-shot fetches — `fetchExpenseById(tripId, oldExpenseId)`, `fetchExpenseSplitsForExpense(tripId, oldExpenseId)` (§6), with the route-`tripId`-binding check applied to the old Expense exactly as it is everywhere else a single Expense is read by id — when the `replaces` route param is present: `description`, `amount`, `payerUid`, `participants` (+ their split values, mapped from the old `ExpenseSplit` rows back into per-strategy inputs), `splitStrategy`, `category`. The user is free to change any of these before confirming. This always creates a **brand-new** Expense — the old record's own `creationRequest`/financial facts are never touched (per §2's own frozen "reversal/correction never mutates original financial facts" principle), and the old Expense's own reversal (§24 step H.1) is a separate, later write against a separate document. `replacesExpenseId` is attached internally by the create screen from its own route param — the user never types or sees the old Expense's raw id.

**Checkpoint 4D.0B: `occurredAt` preservation, not re-entry.** Since 4D exposes no date-only editor for `occurredAt` (§11), the correction form never asks the user to re-enter or re-confirm a date at all. Instead: if the old Expense being corrected already has an `occurredAt` value, and the correction is not specifically changing what that instant represents, the replacement's own creation request **internally carries the old Expense's exact preserved instant** (`occurredAtInstantMs`, §19) — it is read, held, and resubmitted as-is, never formatted into a date-only field and round-tripped back through any timezone conversion (which is precisely the lossy operation §11 explains this preflight is avoiding). If the old Expense has no `occurredAt` at all, the replacement likewise omits it (`occurredAtInstantMs: null`), matching ordinary 4D creation. **If an implementation cannot preserve an existing `occurredAt` instant without loss or ambiguity, it must STOP and report that before silently dropping the value** — silently losing a previously-recorded instant during a "correction" would itself be an unreviewed, unintended data change, exactly the kind of silent side effect this whole correction model is designed to avoid.

## 27. Correction authorization

The correction-link authority model (`docs/audits/TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md` §9.4, implemented in `recordTripExpense.ts`'s D2 step) is **narrower** than ordinary Expense-creation authority — not every current Trip member may claim a correction slot. UI visibility mirrors §22's pattern exactly: `canClaimCorrection = isOwner || (isCurrentTripMember && (oldExpense.createdBy === currentUid || oldExpense.reversedBy === currentUid))`. `payerUid` and mere participant status grant nothing, matching the frozen model precisely. As always, this gates only what the UI *offers* — the backend is the sole authority, and an unauthorized attempt (however it happened) surfaces as the ordinary `permission-denied` mapping.

## 28. Archive behavior

Confirmed against the exact backend facts (`docs/audits/TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md` §6, `recordTripExpense.ts`'s own archive gate): new Expense creation (ordinary or correction — a replacement is created through the same, unmodified `recordTripExpense`) is blocked on an archived Trip; reversal has no archive gate at all. Frozen UI presentation, matching this exactly (and matching the existing, precedented Shared-Stash-on-archive treatment already shipped in this same file):

- **Expense history:** fully visible.
- **"Add Expense":** hidden on Trip Detail's summary card and on the full list route (mirrors "Add Money" already being hidden for Shared Stash when `isArchived`).
- **"Correct expense" / "Finish correction":** hidden/disabled on Expense Detail — both require a `recordTripExpense` call, which the archive gate blocks unconditionally regardless of which label applies (§24). The honest reason, shown as inline copy rather than silently disappearing: "This trip is archived, so a corrected replacement can't be created here."
- **"Reverse expense":** remains available to an authorized caller — reversal is correcting historical state, not new economic activity, and the backend imposes no archive gate on it.

## 29. Correction/reversal lineage presentation

Covered concretely in §10 (list) and §21 (detail). Summary of the frozen visual semantics: muted (`textMuted`), not struck-through; small text-based chips, never color-only; chip tones are "Reversed" (neutral slate) and "Correction"/"Replacement" (informational blue) — **coral is never used for either**, reserving it exclusively for genuine destructive/error states per this app's own frozen Light Mode palette convention. Chains are walked one link at a time from whichever record is currently open, never flattened into a single pre-computed timeline view.

## 30. Loading/error/empty states

| Scenario | Treatment |
|---|---|
| Trip has no Expenses | Empty-state message in the summary card + full list route: "No expenses yet. Add the first one." + the same "Add Expense" action (never hidden merely because the list is empty). |
| Expense list loading | `ActivityIndicator`, matching every existing loading treatment in this codebase (Trip Detail's own `loading` branch, My Stash's `undefined` state). |
| Expense list subscription error (Checkpoint 4D.0A correction) | An inline error message + an **explicit "Retry" button** — never an implicit "it'll recover on its own" assumption. Per §6, a terminal `onSnapshot` error is treated as a dead listener; Retry disposes it and attaches a genuinely new one. |
| A malformed/fail-closed Expense or Split record (§8) | Rendered as its own explicit "This record couldn't be loaded" row/state — never silently omitted from the list, never rendered as if it were a normal active Expense. |
| Expense detail missing (`not-found`) | "This expense could not be found. It may have been part of a trip you no longer have access to." + a back action. |
| Expense detail inaccessible (Rules denial) | Same copy as "missing" — never distinguished from "doesn't exist," matching this codebase's own established anti-enumeration instinct (already applied server-side to `recordTripExpense`'s own `already-exists` design). |
| Member profile loading/missing (Checkpoint 4D.0A correction) | "Loading member…" while pending, "Trip member" (or "Trip member 1"/"Trip member 2" when several are missing at once) once confirmed absent — per §9, never a UID-derived fallback of any kind. |
| Split loading | `fetchExpenseSplitsForExpense` is a one-shot call (§6), not a subscription — the split breakdown section shows its own small `ActivityIndicator` only until that single fetch resolves, then never again for that mount. |
| Old/replacement link inaccessible | The lineage line still renders ("Replaced by …") using whatever fact is already known (the id/description if cached) but is not tappable, with a small "unavailable" note, rather than disappearing entirely or crashing the detail screen. |
| Network submission pending | Submit button shows a spinner + "Saving…" label (mirrors `MoneyActionSheet`'s exact existing convention), all inputs disabled. |
| Network submission unknown outcome | Explicit copy per §20's ambiguous-outcome row — the user is told it's safe to retry, and the idempotency controller (§19/§23) guarantees that retry is actually safe. |

No blank screens; no indefinite spinner without accompanying explanatory text, anywhere.

## 31. Responsive behavior

Reuse the exact `isWide` (`width >= 980`) breakpoint already established in `[tripId].tsx` for whether the Expense list renders full-width or alongside other wide-layout content. `expenses/create.tsx` reuses `create.tsx`'s own centered `maxWidth: 560` card pattern on wide/desktop screens (the same visual family as Trip creation, since both are multi-field forms). The participant/member selector is a bounded-height scrollable list at every width (§14) — no separate mobile/desktop implementation. Every new screen recomputes and applies the exact `scrollBottomInset` pattern from `[tripId].tsx` (§1) — no new content-behind-`BottomNav` regression is introduced.

## 32. Accessibility baseline

- Every `Pressable` gets `accessibilityRole="button"` + a real `accessibilityLabel`, matching the existing convention exactly ("Archive trip", "Back", etc. in `[tripId].tsx`).
- Touch targets follow the existing `hitSlop` convention (8–10px) for any icon-only control.
- The `StatusChip` (§10/§29) is text-based, never color-only, matching `GoalReachedBadge`'s own explicit accessibility requirement.
- Form validation errors are shown as plain adjacent `Text` under the field, matching every existing form in this app (`ArchiveConfirmDialog`, Trip date editing, `create.tsx`) — this is an app-wide pre-existing baseline (no `aria-live`/formal field association exists anywhere today), not a gap unique to 4D to solve alone.
- Selected-member state in the participant list is conveyed by more than color (a checkmark icon + the row's own selected-background treatment, never a color change alone).
- Keyboard submission (Enter-to-submit) on web is **not** currently established anywhere in this app (`MoneyActionSheet` itself has no keyboard avoidance or submit-on-Enter) — noted as a reasonable future improvement, not a 4D blocker, since it would be a new baseline for the whole app, not an Expense-specific gap.

## 33. Privacy / two-fund boundary

Expense participants/payers are Trip-level shared records, visible to any current Trip member per `firestore.rules`' existing, unmodified read rule. **My Stash / `trip_personal` Bucket balances are never surfaced anywhere in the Expense UI** — no Expense screen reads or displays a `Bucket` document, and no Expense field is ever cross-referenced against a member's private fund. The two-fund model (Shared Stash vs. My Stash) is completely orthogonal to, and untouched by, 4D.

---

## 34. Expected files for implementation (across the full 4D sequence)

```
New:
  src/services/firebase/expenses.ts
  src/domain/expenseSubmission.ts
  src/domain/expenseCorrectionPrefill.ts        (old→prefill mapping, §26)
  components/expenses/ExpenseRow.tsx
  components/expenses/StatusChip.tsx
  components/expenses/AddExpenseForm.tsx (+ split-strategy sub-components)
  components/expenses/ReverseExpenseDialog.tsx
  components/expenses/CorrectExpenseDialog.tsx
  app/(tabs)/trips/[tripId]/index.tsx           (moved from [tripId].tsx, §5, 4D.1A)
  app/(tabs)/trips/[tripId]/expenses/index.tsx
  app/(tabs)/trips/[tripId]/expenses/create.tsx
  app/(tabs)/trips/[tripId]/expenses/[expenseId].tsx

Modified:
  app/(tabs)/trips/_layout.tsx                  (register 3 new routes)
  src/services/firebase/users.ts                (add subscribeToPublicUsersByIdsChunked)
  utils/format.ts or a new small module         (percentage/basis-point parser, §16)
```

No change to: `functions/`, `firestore.rules`, `firestore.indexes.json`, `src/domain/tripSettlement.ts`, `src/types/domain/settlement.ts`, dependencies, or runtime/config.

## 35. Checkpoint sequence

**Checkpoint 4D.0A: 4D.1 is split into 4D.1A and 4D.1B** — the mechanical route move and the Expense-feature service work are genuinely different kinds of change (one is a zero-behavior-change refactor, the other is new functionality) and must not be entangled in one commit/review:

- **4D.1A — Trip route restructure ONLY.** `[tripId].tsx` → `[tripId]/index.tsx`, adjusting every relative import by one directory level, and nothing else — no Expense feature behavior of any kind. Automated validation (typecheck/lint/existing test suite green) + a manual Trip Detail navigation/visual smoke pass (the screen renders and behaves identically to before the move). Reviewed and committed on its own before 4D.1B begins.
- **4D.1B — Expense read/service + profile foundation.** `src/services/firebase/expenses.ts` (full surface, §6), the Expense/Split mappers (§8), the callable wrappers + response parsers, query/read tests (including the emulator index-verification step required by §7), `subscribeToPublicUsersByIdsChunked` (§9). No real Add Expense UI yet — this checkpoint proves the data layer, not the screens. Reviewed and committed on its own.
- **4D.2 — Expense history / Trip Detail entry point.** The real Expenses summary card (§4), `ExpenseRow`, the full list route, three-state loading/empty handling (§30).
- **4D.3 — Add Expense form foundation.** `expenses/create.tsx`, all fields except split-strategy hardening (equal split only), the idempotency controller (§19), the strict money-input normalizer (§12) with its full test table, success/error flow (§19/§20).
- **4D.4 — Split strategy UX hardening.** Percentage + custom strategies, the new basis-point parser, per-participant validation gating, split preview (§18), strategy-switching behavior.
- **4D.5 — Expense detail.** `expenses/[expenseId].tsx`, full field display, split breakdown, correction-lineage links (§21).
- **4D.6 — Reversal UI.** `ReverseExpenseDialog`, reversal idempotency controller (§23), authority-based visibility (§22), `StatusChip` wiring.
- **4D.7 — Correction UX.** `CorrectExpenseDialog`, the review-before-reverse correction flow (§24), the active-vs-already-reversed branching (§24), partial-success recovery for both the same-session and later-session/"Finish correction" cases (§25), correction authority visibility (§27).
- **4D.8 — Responsive / accessibility / production smoke.** Cross-breakpoint pass, accessibility baseline pass (§32), archived-Trip presentation pass (§28), a manual production smoke test — matching this milestone's own established pre-exposure verification convention.

Each checkpoint is independently reviewable and shippable without exposing an incomplete feature (per §19's own "no fake optimistic record" discipline, a partially-built 4D never risks showing an untrustworthy financial UI).

## 36. Risks / blockers

1. **The `[tripId].tsx` → `[tripId]/index.tsx` conversion** is mechanical but real — every relative import shifts one directory level. Confirmed isolated as its own checkpoint, 4D.1A, so a broken import can never be mistaken for a genuine Expense-feature regression introduced in 4D.1B.
2. **The `subscribeToPublicUsersByIds` 30-item `in`-query cap vs. up to 100 Expense participants / an uncapped `Trip.memberIds`** is a confirmed, concrete blocker for the participant picker — `subscribeToPublicUsersByIdsChunked` (§9, with the full dedupe/empty-array/removal-on-disappearance hardening now frozen) must exist in 4D.1B, before 4D.3, not as an optional hardening pass after.
3. **No existing precedent for a percentage/basis-point text parser** — new, small, pure code, needing its own test coverage before 4D.4 ships (mirroring `parseDollarsToMinorUnits`'s own test rigor). The same strict-shape-before-stripping discipline now frozen for money input (§12) applies here too — this parser must not be a naive `replace(/[^0-9]/g, "")`.
4. **No existing precedent anywhere in this app for a "list → nested detail route" pattern** — the recommended route shape (§5) is architecturally sound but genuinely new to this codebase, not merely following an established convention; flagged for explicit reviewer confirmation, not silently assumed correct.
5. **The `tripExpenseSplits` query's authorization-boundary correction (§6/§7) must be verified against the real Firestore Rules engine, not just reasoned about on paper** — 4D.1B's own emulator validation step is the actual proof that both the `tripId`+`expenseId` query shape and the "no composite index needed" conclusion hold; if the emulator disagrees, that is a STOP-and-report event, not something to patch around silently.
6. **Malformed/fail-closed financial records (§8) must never silently degrade the perceived completeness of a Trip's Expense history** — the explicit "this record couldn't be loaded" state (§30) has no existing precedent in this codebase (every other list in the app already trusts its own data shape unconditionally), so its exact visual treatment deserves a first, dedicated look in 4D.1B/4D.2 rather than being treated as an afterthought.
7. **A terminal `onSnapshot` listener error now requires an explicit user-initiated Retry (§6)** — this is a small but real behavior change from "assume it recovers," and every Expense screen with a live subscription (the list, and Expense Detail) needs this Retry affordance wired identically, not reinvented per screen.
8. **Unsaved correction-form edits never survive an app/process restart (§25)** — this is a deliberate, frozen product decision (4D adds no persisted-draft storage), not an oversight, but it should be stated plainly to product/design so "Finish correction" is never mistaken for a draft-recovery feature it isn't.
9. **The correction flow's form-review-then-reverse ordering (§24) means the confirmation dialog in step G is now the last and only checkpoint before an irreversible reversal** — its copy deserves particular care, since it is the sole moment a user is warned before a truthful, permanent state change.
10. **(Checkpoint 4D.0B) A route's own `tripId` and the Expense document's own `tripId` must be checked for equality before any single-Expense data is ever rendered** (§6/§21/§26) — this check has no existing precedent anywhere in this app (no other screen in this codebase reads a single document by id from a route param the way Expense Detail does), so it deserves its own explicit test coverage in 4D.5 (and in 4D.1B's own service-level tests) rather than being assumed correct because "the Rules already checked access."
11. **(Checkpoint 4D.0B) Trip membership is not capped, but a single Expense's participants are (`MAX_EXPENSE_PARTICIPANTS = 100`)** — the capacity-gated default-selection behavior (§14) is new, untested UX in this app (nothing else in this codebase has ever had to reason about a selection list that can legitimately exceed what a single record may reference), so its exact copy/behavior deserves a first, dedicated look in 4D.3/4D.4 with the explicit 99/100/101-member test matrix (§14) run against it.
12. **(Checkpoint 4D.0B) `occurredAt` is now deliberately absent from 4D's own Add Expense form** — this is a scope reduction from 4D.0A, not a simplification for its own sake; product/design should be aware that "when did this actually happen" is answered by `createdAt` alone for every 4D-created Expense, and that a true calendar-date or instant-with-time feature remains explicitly open future work (§37 item 2), not silently abandoned.

## 37. Resolved decisions (Checkpoint 4D.0A, as further corrected by 4D.0B — no longer open)

The five items 4D.0 left open are now approved, explicitly, as follows:

1. **Routes vs. modals for Add Expense / Expense Detail** (§5) — **APPROVED: dedicated pushed routes** for the list, create, and detail screens. A `Modal` remains appropriate only for compact, single-purpose confirmations (reversal, the correction confirmation in §24 step G) — never for the multi-field Add Expense form itself.
2. **`occurredAt` exposure** (§11) — **Checkpoint 4D.0B correction: 4D.0A's approval of a date-only "Expense Date" field, converted to an instant via the device's local timezone offset, is WITHDRAWN.** That conversion does not actually solve the problem it was meant to: `occurredAt` is persisted as an *instant*, a date-only user choice is a *calendar date*, and no single instant can guarantee every Trip member in every timezone renders it back as the same calendar day — picking "local midnight in the submitting device's own timezone" as the canonical instant is still an arbitrary choice that misrepresents the date for members elsewhere. **APPROVED FOR 4D instead:**
   - no user-editable Expense Date / `occurredAt` field is shown anywhere in the Add Expense form (§11).
   - Ordinary 4D Expense creation omits `occurredAt` entirely (`occurredAtInstantMs: null` in the creation-identity facts, §19).
   - `createdAt` (server-generated, unambiguous, already the established fallback everywhere `occurredAt` is absent) supplies the normal history timing/date display for every 4D-created Expense (§6/§21).
   - A correction may **preserve** an existing old Expense's own `occurredAt` internally, without ever exposing it as an editable date field (§26) — read, held, and resubmitted as the exact original instant, never reformatted or reinterpreted.
   - A true calendar-date-valued Expense field (e.g. a dedicated `occurredOn`) or a full instant-with-time picker remains legitimate **future schema/product work**, explicitly out of scope for 4D, not something this checkpoint half-designs. This is not a 4D blocker, since `occurredAt` was already optional on the existing, unmodified callable.
3. **Full "View all expenses" list route timing** (§5) — **APPROVED: ships in 4D.2**, alongside the summary card, not deferred. Unchanged by 4D.0B.
4. **Split-strategy-switching value preservation** (§15–17) — **APPROVED: reset strategy-specific values on switch for 4D.3.** No smart carry-over in this milestone; it remains a legitimate, explicitly-deferred 4D.4-or-later enhancement, not a requirement. Unchanged by 4D.0B.
5. **Error-code-to-copy mapper** (§20) — **APPROVED: an Expense-local mapper**, matching the existing per-feature duplication convention exactly. No app-wide shared abstraction is introduced now. Unchanged by 4D.0B.

---

## Conclusion

**DO NOT IMPLEMENT ANY PART OF THIS DESIGN YET.** This document (as hardened by Checkpoint 4D.0A, then further corrected by Checkpoint 4D.0B) freezes the 4D Expense UI/UX architecture — information hierarchy, route structure, read/subscription design (Expenses live, Splits one-shot, with the Rules-correct `tripId`+`expenseId` Split query and route-`tripId`-bound single-Expense reads), index posture, fail-closed mapping, listener-error retry, member-profile resolution (with no UID exposure in any fallback copy, and capacity-gated participant defaults above the backend's own 100-participant cap), strict money-input validation, form/split/idempotency design for both create and reverse (with `occurredAt` now deliberately deferred out of 4D's own scope, preserved-not-re-entered during correction), definitive-vs-ambiguous error handling, the review-before-reverse correction flow with its active-vs-already-reversed branching, honest same-session-vs-later-session partial-success recovery, visual/status semantics, and the recommended (4D.1A/4D.1B-split) checkpoint sequence — against the actual current repository state, not from memory or generic UI advice. Every recommendation above cites the specific existing file, function, or component it either reuses or deliberately departs from. No application code, Firestore Rules, indexes, or configuration were modified to produce the original 4D.0 pass or either the 4D.0A or 4D.0B amendments — only this markdown file was ever touched.

---

**CHECKPOINT 4D.0B FINAL PREFLIGHT INTEGRITY HARDENING READY FOR REVIEW**

**DO NOT IMPLEMENT.**
**DO NOT COMMIT.**
**DO NOT PUSH.**
**DO NOT DEPLOY.**
**STOP.**
