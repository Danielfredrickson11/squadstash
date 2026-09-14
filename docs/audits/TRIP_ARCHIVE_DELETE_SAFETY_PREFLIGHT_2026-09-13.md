# Trip Archive / Delete Safety Preflight

**Preflight date:** 2026-09-13 (amended 2026-09-13, Checkpoint 4B.5A.1 hardening pass)
**Type:** Architecture preflight only — **no production code, Rules, Functions, or dependencies were changed**
**Baseline:** `claude/milestone-3-personal-savings-mvp`, current stable checkpoint = committed 4B "Add trip expense settlement domain foundation" (`c02b7d8`), working tree clean
**Source of truth for the Expense/Settlement architecture referenced throughout:** `docs/audits/TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md` (as hardened by its 4A.1 amendment)
**Status:** DO NOT IMPLEMENT — this document is the design **two** future checkpoints must follow: **4B.5B** (the archive lifecycle itself) and **4B.5C** (trusted-backend enforcement) — see §11/§14. 4B.5B must not be deployed until 4B.5C has also been reviewed and is ready to ship with it (§11).

---

## Executive summary

Trip hard-delete (`deleteDoc(doc(db, "trips", tripId))`, gated only by `allow delete: if isTripOwner()`) has **two real, evidence-confirmed hazards**, one of which is more severe than the audit trail problem this checkpoint was framed around:

1. **A hard-deleted Trip strands its `savingsTransactions` history behind an authorization rule that can no longer resolve** — the transaction documents still physically exist in Firestore, but `canAccessParent()` requires `parentExists("trip", tripId)`, which becomes `false` forever. This is real and confirmed (§3).
2. **More severe: a hard-deleted Trip permanently orphans that member's own `trip_personal` "My Stash" Bucket from every UI surface in the app**, not just from an audit trail. `trip_personal` Buckets are deliberately excluded from the Buckets tab (`visibleBuckets` filters them out — `app/(tabs)/buckets/index.tsx:682`), so **Trip Detail is the only screen that ever renders a My Stash card**. Deleting the Trip makes `fetchTripById` return `null`, Trip Detail renders "Trip not found," and the My Stash card — along with its Add Money/Withdraw controls — never renders again. The Bucket still exists, still holds real money, and is still counted in Home's Total Stashed, but the member can never again view or act on it through any part of the app (§2).

Both hazards are eliminated the same way: **Trips stop being client-hard-deletable at all.** "Delete Trip" becomes "Archive Trip," implemented as a small, owner-only, one-directional Firestore field update (`archivedAt`/`archivedBy`) — no Cloud Function needed, no new collection, no data ever removed. Full recommendation below.

**Amendment note (Checkpoint 4B.5A.1):** this revision corrects four issues found in the original 4B.5A pass before it becomes the frozen plan: (1) the original design hid archived Trips from the active list without ever building any path back to one, which would have silently reintroduced the exact My Stash unreachability hazard this whole preflight exists to fix — 4B.5B must now include a minimal, always-present Archived section on the Trips screen itself; (2) the proposed Rules design compared `resource.data.archivedAt` directly, which is unsafe for a field legacy documents don't have at all — now uses a missing-safe `.get('archivedAt', null)` idiom throughout; (3) the implementation scope named `Trip` type changes but never named `mapTripDocument`, the one place that actually reads persisted fields into a `Trip` object — without mapping `archivedAt`/`archivedBy` there, nothing built on top of them would ever see real data; (4) the original "block all Shared Stash activity" recommendation would have frozen a nonzero balance forever with no resolution path — revised to a wind-down model (contributions blocked, withdrawals allowed) so a trip can actually be brought to zero. A fifth change makes the sequencing between the UI-only and trusted-backend enforcement layers an explicit two-checkpoint requirement (4B.5B / 4B.5C) rather than an informal note. All five corrections are detailed in the relevant sections below; the core recommendation (archive, never hard-delete) is unchanged.

---

## 1. Current delete flow — UI tap → service → rule → navigation

**UI (`app/(tabs)/trips/[tripId].tsx`):**
- A trash-icon `Pressable` (lines 847–851) is rendered only when `isOwner` is true, calling `onDeleteTrip` (lines 194–213).
- `onDeleteTrip` calls `confirmDelete` (lines 155–172), which shows `window.confirm` on web or a native `Alert.alert` with the exact copy: *"Delete trip?" / "This will permanently delete this trip. This cannot be undone."*
- On confirmation, `onDeleteTrip` calls `deleteTrip(tripId)`, then unconditionally `router.replace("/(tabs)/trips")` — there is no re-check of financial state, no warning specific to "this trip still has money in it," and no distinction between an empty trip and one with an active Shared Stash balance and My Stash funds.
- `app/(tabs)/trips/index.tsx` (the Trips list) has **no delete affordance at all** — delete only exists on Trip Detail's own top bar.

**Service (`src/services/firebase/trips.ts:106-108`):**
```ts
export async function deleteTrip(tripId: string): Promise<void> {
  await deleteDoc(doc(db, "trips", tripId));
}
```
A bare `deleteDoc` — no subcollection cleanup (none exists today, but see §2), no check of `saved`/`ledgerBalanceMinor`, no check of linked `trip_personal` Buckets.

**Rule (`firestore.rules:216-217`):**
```
// Delete: only owner
allow delete: if isTripOwner();
```
No condition beyond ownership — an owner may delete a Trip with an arbitrarily large Shared Stash balance and any number of members' My Stash funds still linked to it.

**Existing test coverage (`tests/firestore-rules/trips.rules.test.js:636-654`):** a `describe('firestore.rules: trips - deletes')` block already asserts "owner: can delete the trip" succeeds and non-owner/outsider/unauthenticated attempts fail — this test will need to flip to asserting failure once the Rules change ships (§13).

---

## 2. Dependent-data audit — what breaks, orphans, or becomes ambiguous

| Data | Depends on Trip existence how? | Consequence of hard delete |
|---|---|---|
| `savingsTransactions` (`resourceType: "trip"`) | Read-gated by `canAccessParent("trip", tripId)`, which calls `exists(.../trips/$(tripId))` | **Stranded.** Documents remain in Firestore but become permanently unreadable by any client (§3). |
| `trip_personal` Buckets ("My Stash") | `linkedTripId` field only (informational/creation-time-verified — never re-checked afterward); **the only UI path to reach one is Trip Detail** (`buckets/index.tsx`'s `visibleBuckets` filter excludes `bucketType === "trip_personal"` from every Buckets-tab list) | **Permanently unreachable through any UI**, even though the Bucket document, its balance, and its trusted ledger all remain fully intact and keep counting in Home's Total Stashed. This is the single most severe consequence found in this audit — an active, real-money fund with no remaining control surface. |
| Home Total Stashed / monthly-change (`app/(tabs)/home.tsx`) | Subscribes to `buckets` by `memberIds array-contains uid` — **never reads or joins against `trips` at all** | **Unaffected.** A trip_personal Bucket's balance keeps appearing in the total correctly even after its Trip is deleted (confirmed by reading `subscribeToUserBuckets` and Home's `totals`/`monthlyChange`, neither of which references `linkedTripId` or the `trips` collection). This makes the My Stash unreachability finding above worse, not better — the money is visibly present in a total the user can see, with no way to reach the fund that produces it. |
| Home Recent Activity (`src/domain/recentSavingsActivity.ts`) | Per-Bucket only (`subscribeToRecentSavingsTransactionsForResource`) — no `trips` reference | Unaffected. |
| Trip Detail Shared Stash | `fetchTripById(tripId)` returning `null` renders the existing "Trip not found" early return | Correctly handled today — Shared Stash simply stops being displayable, matching the Trip's own disappearance. No orphaned reference; the Shared Stash *was* the Trip document's own fields (`saved`/`ledgerBalanceMinor`), so there's nothing left to strand once the Trip itself is gone from the *Trip's own* perspective. |
| Future `tripExpenses`/`tripExpenseSplits`/`tripSettlements` (approved audit, not yet implemented) | Would use the identical `canAccessParent()`-style pattern the audit explicitly recommended reusing (audit §13) | Would inherit the **exact same stranding hazard** as `savingsTransactions` the moment Checkpoint 4C ships, if this preflight's recommendation isn't adopted first. This is precisely why this preflight must land before 4C persists a single real Expense. |

**Conclusion:** hard-deleting a Trip does not merely lose a document — it actively stridulates real financial history into an unreadable state and permanently strands a member's own active personal fund. Neither consequence is reversible by any means available to the client once the Trip document is gone.

---

## 3. Confirmed savings-ledger consequence

`firestore.rules:242-246`:
```
function parentExists(resourceType, resourceId) {
  return resourceType == 'bucket'
    ? exists(/databases/$(database)/documents/buckets/$(resourceId))
    : exists(/databases/$(database)/documents/trips/$(resourceId));
}
```
`canAccessParent()` (`firestore.rules:262-272`) requires `parentExists(...)` to be `true` as one of its `&&`-chained conditions before granting `get`/`list` on a `savingsTransactions` document (`firestore.rules:274-276`). **Yes — `parentExists("trip", tripId)` is required for every read.**

**Confirmed exactly as the checkpoint framed it:** a hard-deleted Trip can strand its own savings-transaction history behind an authorization rule that can no longer resolve its parent — the documents are not deleted, but no client can ever read them again. **The `savingsTransactions` rule is not weakened anywhere in this design** — the fix is to keep the parent record in existence (archive, not delete), never to loosen the read rule itself.

---

## 4. Recommended archive schema

```ts
// Added to Trip (src/types/domain/trip.ts) - NOT IMPLEMENTED in this preflight.
archivedAt?: PersistedTimestamp | null;
archivedBy?: string | null;
```

**No separate `status: "active" | "archived"` field.** A `status` field would be a second, independently-settable source of truth for the exact same fact `archivedAt` already carries (`archivedAt` present = archived; absent/null = active) — the two could disagree (e.g. `status: "archived"` with `archivedAt: null` from a bug or a partial write), which is a strictly worse, more fragile design than one field that is unambiguous by construction. `archivedAt`'s own presence/absence *is* the status. This is the "smallest truthful schema" the checkpoint asked for.

**Legacy Trips remain active automatically** — no backfill needed. A document with no `archivedAt` key at all is indistinguishable, for every check in this design, from one explicitly not archived (see §9 for why this matters for query correctness).

---

## 5. Archive semantics — exact recommendation

| Area | Recommendation |
|---|---|
| **A. Trip lists** | Archived Trips are removed from the ordinary active list, but the Trips screen must ALSO render a minimal, always-visible **Archived** section listing them (Checkpoint 4B.5A.1 correction — see §9/§10 for why "hidden with no path back" was a real regression, not a simplification). No separate route, restore, or management UI is required — just a normal in-app path to reach one. |
| **B. Direct Trip Detail navigation** | **Still fully readable** — Rules already grant `get` to any current member/owner regardless of archive status, and nothing in this design changes that. Trip Detail is **not** blanket "read-only": Shared Stash balance/history, My Stash, Quick Analysis, and dates all remain visible. Trip Detail should visibly show an **"Archived"** indicator once `trip.archivedAt` is set (exact visual styling not designed here - product behavior only). Only the *specific* actions in C/E/F/G below are restricted — "read-only" is too blunt a rule once My Stash, Shared Stash withdrawals, and Settlement recording (C/D/G) must keep working. |
| **C. Shared Stash** | **Wind-down model, not a blanket freeze (Checkpoint 4B.5A.1 correction):** **contributions are BLOCKED; withdrawals remain ALLOWED.** An archived trip is "wrapping up" - members may still need to reclaim unused Shared Stash money, redistribute a leftover balance, or reconcile a cancelled trip. Blocking withdrawals too would freeze any nonzero balance permanently with no resolution path, since this design deliberately supports no unarchive (§7). Withdrawals remain subject to every existing invariant (non-negative resulting balance, etc.) - nothing about the withdrawal PATH itself changes, only that it stays open post-archive while the contribution path closes. The specific product question of *automatic* redistribution logic (e.g., an even split back to members) is explicitly **not decided here** - members can already withdraw manually, and automatic redistribution remains future product work (§ "Unresolved decisions"). |
| **D. My Stash** | **Archiving the Trip must NOT freeze My Stash in either direction.** It is the member's own private money; the Trip's lifecycle has no authority over it. A member (owner or not) may continue to both Add Money AND Withdraw their own My Stash after the linked Trip is archived - e.g., a cancelled trip's members should be able to reclaim their planned spending money immediately, not be locked out until some future unarchive action. Trip ownership continues to grant **zero** access to another member's My Stash, archived or not — this absolute boundary is unchanged. |
| **E. Metadata editing** | Title/location/dates become **frozen** once archived — an archived trip is historical, and further edits would be confusing set against that. Enforced by the Rules design in §7 (once `archivedAt` is set, no further client update to the Trip document is permitted at all, of any kind). |
| **F. Membership** | Frozen along with metadata — no adding/removing members from an archived trip's roster. Same mechanism as E (§7's blanket post-archive freeze). |
| **G. Future Expenses/Settlements** | **Reject new Expense creation on an archived Trip; continue to allow Settlement creation.** This is the "new spending activity" vs. "resolving obligations that already existed" distinction: a Settlement only *records* that an external payment already happened (per the approved audit, SquadStash never moves money itself) — blocking it after archive would trap real outstanding debts between real people with no path to resolution, often exactly when people actually go settle up (right after a trip ends). See §12 for the exact future callable-level recommendation. |

### Archived Trip Detail — expected UX state (Checkpoint 4B.5A.1, product behavior only, no visual design)

- A visible **"Archived"** indicator somewhere on the screen (exact placement/styling deferred to the implementation checkpoint).
- **Shared Stash:** balance and history remain fully visible; the Add Money control is unavailable (hidden or disabled); the Withdraw control remains available and functional.
- **My Stash:** fully usable in both directions, unaffected by the Trip's archive state.
- **Quick Analysis / savings-pace guidance:** an archived Trip should **NOT** continue showing forward-looking planning copy like "save $X/week until your trip" — that guidance assumes the trip is still being actively saved toward, which is no longer true once it's archived (and is often exactly *why* it was archived - the trip already happened, or was cancelled). Recommend replacing it with a neutral archived/wind-down state instead (e.g., a plain summary of what was saved, with no forward-looking pace language) - the precise copy/layout is an implementation-time decision, not fixed here.

---

## 6. Hard-delete policy

**Recommendation: Model A — no client hard deletion at all, once this checkpoint ships.**

Evaluated against the other two options:
- **Model B** (delete allowed only with zero trusted financial history) requires the trusted layer to check *every* current and future financial-child-record type before allowing a delete: `savingsTransactions` today, plus `tripExpenses`/`tripExpenseSplits`/`tripSettlements` the moment 4C ships. This is exactly the "detect every possible financial child record" burden the checkpoint itself warned against — it is fragile (trivially easy to forget updating when a new record type is added later) in exchange for preserving a destructive feature that archive already makes unnecessary.
- **Model C** (trusted backend decides) is the same fragility as Model B, just moved server-side — it doesn't remove the maintenance burden, only relocates it.
- **Model A** removes the entire problem class: if nothing can ever be hard-deleted, there is no "did we check every child collection" question to get wrong, ever again, as the schema grows.

Archive already satisfies the real product need (get a trip out of the way, stop new activity on it) without ever destroying data. If a genuine need for permanent deletion later arises (e.g., a privacy/data-deletion compliance request), that should be its own separate, deliberately manual/admin-scoped trusted operation, designed with its own dedicated safety analysis at that time — not a client-reachable feature this checkpoint builds or leaves half-open. Flagged as an explicit unresolved item below, not assumed away.

---

## 7. Firestore Rules design (not implemented — design only)

**Checkpoint 4B.5A.1 correction: every check below is missing-safe.** The original draft compared `resource.data.archivedAt == null` directly, which is unsafe for a legacy document that has no `archivedAt` key at all — direct missing-field access in Firestore Rules does not behave like a JavaScript `undefined` read; the expression can fail rather than gracefully evaluating. The fix is a `.get(fieldPath, default)` read everywhere archive state is inspected, wrapped in one named helper so every call site stays consistent:

```
// Missing-safe: returns true for (a) no archivedAt key at all (legacy), and
// (b) archivedAt explicitly present and null. Returns false only when
// archivedAt holds a real timestamp value.
function tripIsActive() {
  return resource.data.get('archivedAt', null) == null;
}

// Replaces the current unconditional owner-delete rule:
allow delete: if false;

// Archive is a direct owner-only field update, layered onto the EXISTING
// update rule rather than a new match block:
allow update: if (isTripMember() || isTripOwner())
  && (
    // Existing ordinary update path - UNCHANGED, but now additionally
    // guarded to only apply while the trip is not yet archived (see the
    // blanket freeze below). Uses the missing-safe helper, not a direct
    // field comparison.
    tripIsActive()
    && request.resource.data.ownerId == resource.data.ownerId
    && (resource.data.ownerId in request.resource.data.memberIds)
    && ...(all existing shape/allowlist checks, unchanged)...
  )
  || (
    // NEW: the one-directional archive transition. Owner-only. Exactly
    // these two keys change, in exactly this direction, once.
    isTripOwner()
    && tripIsActive()
    && request.resource.data.diff(resource.data).affectedKeys()
         .hasOnly(['archivedAt', 'archivedBy'])
    && request.resource.data.archivedAt == request.time
    && request.resource.data.archivedBy == request.auth.uid
  );
```

Key properties this design enforces:
- **A legacy Trip with no `archivedAt` key is active** — `tripIsActive()` returns `true` via the `.get(..., null)` default, so its otherwise-valid owner/member updates keep working exactly as they do today. This must hold both for the ordinary update branch (legacy Trips can still be edited normally) and is explicitly regression-tested (§13, new test).
- **A Trip with `archivedAt` explicitly set to `null`** (should that state ever be written by some other path) is also active — same `.get(..., null) == null` evaluation.
- **A Trip with a real `archivedAt` timestamp is archived** — `tripIsActive()` returns `false`, so the first branch's guard fails for any ordinary update attempt.
- **Only the owner may archive** — ordinary members cannot, matching the existing owner-only pattern for `tripStartDate`/`tripEndDate`.
- **`archivedAt` is server-timestamp-validated** (`== request.time`, the standard Firestore Rules idiom for a `serverTimestamp()` write) — a client cannot backdate or forward-date its own archive.
- **`archivedBy` must equal the authenticated caller** — never forgeable to name someone else.
- **Once archived, the FIRST branch's `tripIsActive()` guard makes every ordinary update path fail** — title, location, dates, membership, everything on the Trip document itself is frozen. This directly implements E and F above with one guard, not per-field special-casing.
- **The second branch's own `tripIsActive()` guard means an already-archived Trip can never be re-archived or have `archivedAt`/`archivedBy` changed again** — there is no client path to remove or alter archive metadata once set, so **unarchive is not possible** unless a future checkpoint deliberately adds a new, explicitly-approved branch for it. This directly satisfies "clients cannot remove archive metadata to silently unarchive unless explicit restore behavior is intentionally approved."
- **Financial fields remain completely locked** — `saved`/`ledgerBalanceMinor`/`ledgerOpeningBalanceMinor` were never in either allowlist before this change and are not added now; nothing here touches that lockdown.

---

## 8. Service/API design

**Recommendation: a direct `updateDoc`-based `archiveTrip(tripId, uid)` service function — no Cloud Function.**

```ts
// Replaces deleteTrip's role in the UI (src/services/firebase/trips.ts) - design only.
export async function archiveTrip(tripId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, "trips", tripId), {
    archivedAt: serverTimestamp(),
    archivedBy: uid,
  });
}
```

This mirrors the **existing** `updateTripDates` precedent exactly (also a direct client write, also owner-gated purely by Rules, also touching zero financial fields) rather than the `createBucket`/`recordSavingsTransaction` precedent (callables used specifically *because* those mutate trusted ledger fields that Rules alone cannot safely arbitrate — multi-document transactions, idempotency, non-negative-balance invariants). Archiving needs none of that: it's a single-document, non-financial, Rules-fully-expressible field transition. A callable here would be pure ceremony with no integrity benefit, directly contradicting the checkpoint's own "do not default to a Cloud Function unless it provides a real integrity benefit" instruction.

`deleteTrip` itself should be **removed** from `trips.ts` once no UI calls it (Rules will reject it either way once `allow delete: if false` ships, but leaving a dead, now-always-failing exported function around invites future misuse/confusion).

### `mapTripDocument` must map the new fields (Checkpoint 4B.5A.1 correction)

The original draft of this preflight added `archivedAt`/`archivedBy` to the `Trip` type and to a new `archiveTrip` writer, but never named `mapTripDocument` — the private function in `src/services/firebase/trips.ts` that is the **sole place** raw Firestore document data becomes a `Trip` object for `fetchMemberTripsOrdered`/`fetchMemberTrips`/`fetchTripById`. Without updating it, `archivedAt`/`archivedBy` would be written correctly by `archiveTrip` but **never read back by anything** — every consumer (the active/archived list split in §9, the archived indicator in Trip Detail, §5's UX) would see `undefined` regardless of what's actually persisted. This must be explicit, non-optional scope:

```ts
// mapTripDocument, src/services/firebase/trips.ts - add alongside the
// existing per-field reads, following the exact same convention (no
// defaulting, no runtime validation, absent stays undefined):
archivedAt: data.archivedAt as PersistedTimestamp | null | undefined,
archivedBy: data.archivedBy as string | null | undefined,
```

No fabricated defaults — a legacy document with no `archivedAt` key maps to `archivedAt: undefined`, exactly matching every other optional field this mapper already handles (`tripStartDate`, `tripEndDate`, etc.).

**Test coverage limitation, stated plainly:** `mapTripDocument` is a private, unexported function — per instruction, it is not exported merely to make it directly unit-testable. The most appropriate existing coverage is indirect: `fetchTripById`/`fetchMemberTripsOrdered` are the actual exported surface, so a future test should seed a Firestore-emulator Trip document (with and without `archivedAt`/`archivedBy`) and assert on the `Trip` object those functions return, exactly like the existing pattern in `functions/test/createBucketCore.ts` seeds documents and asserts on trusted-function output. This is emulator-backed integration coverage of the mapping behavior, not an isolated unit test of the mapper itself — that limitation is acceptable here since the mapper is a simple, non-branching field-by-field read with no independent logic worth isolating.

---

## 9. Query / list behavior

**Hazard confirmed exactly as the checkpoint warned:** `where("archivedAt", "==", null)` in Firestore only matches documents where the field is **explicitly present and set to `null`** — it does **not** match documents where the field is entirely absent. Since every legacy Trip has no `archivedAt` key at all, that query would silently exclude **every trip that existed before this checkpoint**, which is the opposite of the intended behavior.

**Recommendation: client-side PARTITIONING after the existing query — no new Firestore query, no new index.** (Checkpoint 4B.5A.1 correction: the original draft only filtered archived Trips *out*, with nothing rendering the other side of that filter anywhere - see §10 for why that's a real regression, not a simplification. The fix is a two-way split, not a one-way hide.)

```ts
// fetchMemberTripsOrdered/fetchMemberTrips stay EXACTLY as they are today.
// The calling screen (or a thin new helper) partitions the already-fetched
// array into both groups - neither is ever discarded:
const activeTrips = trips.filter((t) => !t.archivedAt);
const archivedTrips = trips.filter((t) => !!t.archivedAt);
```

`!t.archivedAt` is `true` for both "field absent" (legacy) and "field null" (never archived) and "field present but falsy" - simple, correct, and zero new backend surface. This is the same client-side-derived-filtering approach already proven in this exact codebase for an analogous problem: `app/(tabs)/buckets/index.tsx`'s `visibleBuckets = buckets.filter((b) => b.bucketType !== "trip_personal")` - the difference here is that BOTH halves of the partition are rendered somewhere (§10), where the Buckets-tab precedent only ever needed one half. Rejected alternatives:
- **Explicit status backfill** — an unnecessary migration with its own operational risk, for a distinction already trivially computable from data that's already being fetched.
- **Dual queries** — real added complexity/latency for a filter this cheap to do client-side on an already-small per-user trip list; no query currently paginates or truncates in a way that would make "fetch everything, filter locally" a scaling concern.

---

## 10. Archived Trips surface — minimal MVP required, richer management deferred

**Checkpoint 4B.5A.1 correction: this section originally treated ANY archived-Trip UI as deferrable.** That was a real contradiction, not a simplification: §5.D and §11 both require My Stash to remain fully usable after archive, but §2 already established that **Trip Detail is the only screen that ever renders a My Stash card**. If archived Trips are hidden from the active list and no other in-app path reaches them, an archived Trip's My Stash becomes exactly as unreachable as it was under hard-delete — the entire premise of this preflight (never strand a member's own money from every UI surface) would be silently violated by the "solution" meant to prevent it. Reachability is therefore **required MVP scope for 4B.5B**, not a future nice-to-have.

**4B.5B MUST include (minimal MVP):**
- The existing Trips screen (`app/(tabs)/trips/index.tsx`) renders **both** groups from §9's partition:
  ```
  ACTIVE TRIPS
  [current normal Trip cards, unchanged]

  ARCHIVED
  [archived Trip rows/cards - may be visually subdued and/or collapsible]
  ```
- Tapping an archived Trip row navigates to the **same** Trip Detail route as any other Trip - no separate route, no separate component.
- This gives every ordinary user a normal, discoverable, in-app path: **Trips → Archived Trip → Trip Detail → My Stash** - never dependent on a bookmark, a remembered URL, browser/app history, or a future screen that doesn't exist yet.

**What this minimal surface does NOT need (still legitimately deferred):**
- A dedicated Archived Trips *route* separate from the ordinary Trips screen.
- Restore/unarchive UI or Rules support (§7 makes this structurally impossible until a future checkpoint deliberately adds it).
- Any complex archived-Trip management UI (bulk actions, sorting/filtering the archived set, etc.).
- Any form of permanent deletion (§6).

**Recoverability without a restore feature:** an archived Trip remains completely intact in Firestore and, with the Archived section above, is now reachable through ordinary navigation, not just a direct `fetchTripById(tripId)` call. Restore/unarchive is still deferred - "reachable and usable" (required now) and "can be turned back into an active Trip" (deferred) are different features, and only the first is necessary to prevent the hazard this preflight addresses.

---

## 11. `recordSavingsTransaction` interaction — Shared Stash vs. My Stash, analyzed separately

**Checkpoint 4B.5A.1 hardening: this is now formally split into two named checkpoints, 4B.5B and 4B.5C, with an explicit deployment gate between them — not an informal "later, separately-scoped step."** The archive lifecycle must never be considered safely shipped with UI-only Shared Stash restrictions alone, because a UI-only guard is not a real enforcement boundary: any direct API caller (a stale client build, a hand-crafted request, anything bypassing the app's own UI) could still invoke the unmodified `recordSavingsTransaction` callable with `resourceType: "trip"` against an archived Trip's id, and nothing server-side would stop it.

### 4B.5B — Trip archive lifecycle (UI-only guard; does not modify `recordSavingsTransaction`)

- Hide/disable the Shared Stash **contribution** control on Trip Detail once `trip.archivedAt` is set (§5.C's wind-down model — contribution blocked, not the whole Shared Stash).
- **Leave the Shared Stash withdrawal control fully enabled** regardless of archive status (§5.C).
- Leave My Stash Add Money/Withdraw fully enabled regardless of archive status (§5.D/below).
- This is a pure presentation change to `app/(tabs)/trips/[tripId].tsx` — no backend involved, `recordSavingsTransactionCore` is untouched.
- **4B.5B must NOT be deployed until 4B.5C has also been completed and reviewed.** Shipping 4B.5B alone would leave a real window where a contribution to an archived Trip's Shared Stash is blocked only by the app's own UI, not by the trusted backend - acceptable to *build and review* on its own, not acceptable to *deploy* on its own.

### 4B.5C — Trusted savings archive enforcement (the real boundary; a separate, narrowly-scoped, deliberately later step)

A focused, minimal change to `recordSavingsTransactionCore` (`functions/src/callables/recordSavingsTransaction.ts`) — **not implemented in this preflight or this revision**:
- For `resourceType === "trip"`, after the existing Trip lookup: if the Trip is archived (`archivedAt` set) **and** `type === "contribution"` → reject with `failed-precondition`.
- If the Trip is archived **and** `type === "withdrawal"` → **continue through every existing invariant unchanged** (non-negative resulting balance, idempotency/replay, currency match, etc.) - archive adds no new withdrawal restriction, it only closes the contribution path.
- The Bucket path (`resourceType === "bucket"`, which is how every My Stash write flows) is **completely unchanged** - see below for why it needs no new check at all.
- `trip_personal` Bucket behavior is unaffected.
- Idempotency/replay semantics are unaffected.
- Add focused Functions/emulator tests for exactly this new precondition (§13).

This is a real, scoped change to the single most safety-critical function in the app, and per instruction must be its own reviewed step, never bundled invisibly into 4B.5B's schema/Rules/UI work. **Only after both 4B.5B and 4B.5C are reviewed should the archive lifecycle actually be deployed together** - this sequencing is what closes the "stale client / direct caller adds a new Shared Stash contribution to an archived Trip" window completely, rather than leaving it open indefinitely behind a UI-only guard.

### My Stash (`resourceType: "bucket"`) — analyzed separately, because it is architecturally independent

`recordSavingsTransactionCore`'s bucket path only ever reads `buckets/{bucketId}` — it has **no dependency on the linked Trip's existence or archive status today**, confirmed by re-reading the function. Per §5.D's product decision (a member's own money is never frozen by someone else's trip-lifecycle action), **this is already correct as-is and needs no change, in either 4B.5B or 4B.5C** — My Stash Add Money/Withdraw should continue working after the linked Trip archives, and the current code already behaves exactly that way by construction. No new precondition, no new check, nothing to add.

---

## 12. Future Expense/Settlement interaction (4C, not yet built)

Recommendation for the future `recordTripExpense`/`recordTripSettlement` callables (per the approved audit, neither exists yet):

- **`recordTripExpense`: reject creation on an archived Trip.** It already needs to read the Trip document inside its transaction for membership verification (per the audit's own design) — add one more precondition there: if `tripData.archivedAt` is set, throw `failed-precondition`. This is new spending activity, exactly what archiving is meant to stop.
- **`recordTripSettlement`: do NOT add an archived-Trip check.** A settlement only records that an external payment already happened resolving a pre-existing debt — blocking it after archive would be actively harmful, trapping real obligations between real people with no path to resolve them, often exactly when people go to settle up (right after a trip wraps up).

This mirrors §5.G exactly and should be treated as a design note for whenever 4C is actually built — **not implemented now.**

---

## 13. Test plan (for the future 4B.5B implementation)

**Rules tests (`tests/firestore-rules/trips.rules.test.js`), for 4B.5B:**
1. Owner can archive an active Trip (sets `archivedAt`/`archivedBy` correctly).
2. Ordinary member cannot archive.
3. Outsider/unauthenticated cannot archive.
4. Archived Trip cannot be hard-deleted from the client (`allow delete: if false` — flip the existing "owner: can delete" test to assert failure).
5. Archive metadata cannot be forged: `archivedBy` set to a uid other than the caller is rejected; `archivedAt` set to an arbitrary (non-`request.time`) timestamp is rejected.
6. Archive metadata cannot be silently removed/changed once set (no unarchive path) — attempting to null out `archivedAt` or change `archivedBy` on an already-archived Trip fails.
7. All other Trip fields (title, location, dates, memberIds) are frozen once archived — an otherwise-valid update attempting any of them fails.
8. Financial fields (`saved`, `ledgerBalanceMinor`, `ledgerOpeningBalanceMinor`) remain unmodifiable by the client both before and after archive (no regression on the existing lockdown).
9. Existing `savingsTransactions` for a now-archived Trip remain readable by a current member (`parentExists` still resolves, since the Trip document was never deleted) — a direct regression test for the exact hazard this preflight addresses.
10. A legacy Trip document with no `archivedAt` field at all is treated as active by every relevant rule/query path (no accidental exclusion).
11. **(New, 4B.5A.1)** A legacy Trip with NO `archivedAt` field can still perform an otherwise-valid owner update (e.g. a title rename) *before* ever being archived — a direct regression test for the `tripIsActive()` missing-safe helper (§7), proving the fix actually works, not just that it was written with good intentions.

**Domain/service tests:**
12. Client-side partitioning (§9) puts an archived Trip in the archived group and a legacy (no-`archivedAt`) Trip in the active group, given the same input array — both groups checked, not just the active one.
13. Direct fetch of an archived Trip by id still returns its full data (no special-casing needed in `fetchTripById` itself).
14. **(New, 4B.5A.1)** `mapTripDocument`'s mapping of `archivedAt`/`archivedBy` — via the exported `fetchTripById`/`fetchMemberTripsOrdered` surface, emulator-backed (see §8's stated test-coverage limitation: the mapper itself stays private/unexported): a legacy-seeded document maps to `archivedAt: undefined`/`archivedBy: undefined`; an archived-seeded document maps to the real persisted `archivedAt`/`archivedBy` values, unaltered.

**Manual/product verification for 4B.5B (no automated screen-test harness exists in this codebase for this kind of UI, consistent with prior checkpoints' own stated limitation):**
15. **(New, 4B.5A.1)** Trips screen renders both an Active section and an Archived section; tapping an archived Trip row navigates to that Trip's ordinary Trip Detail route (§10) — confirms the reachability fix works end-to-end, not just that the underlying data partition is correct.
16. **(New, 4B.5A.1)** On an archived Trip's Detail screen: the "Archived" indicator is visible; Shared Stash Add Money is unavailable; Shared Stash Withdraw remains available and functional; My Stash Add Money/Withdraw remain fully available; Quick Analysis no longer shows forward-looking savings-pace copy (§5).

**Deferred until 4B.5C exists (documented now, not written now):**
17. `recordSavingsTransactionCore`, `resourceType: "trip"`, archived Trip, `type: "contribution"` → rejected with `failed-precondition`.
18. **(New, 4B.5A.1)** `recordSavingsTransactionCore`, `resourceType: "trip"`, archived Trip, `type: "withdrawal"` → **succeeds**, going through every existing invariant unchanged (this is the wind-down model's core guarantee — withdrawal must NOT be rejected just because the Trip is archived).
19. `recordSavingsTransactionCore`, `resourceType: "bucket"` (My Stash), regardless of the linked Trip's archive status → succeeds unchanged — a regression test proving §11's "already correct, no change" finding stays true even after 4B.5C ships.
20. Idempotency/replay behavior for both contribution-rejection and withdrawal-success on an archived Trip is unchanged from the existing (non-archived) behavior.

**Deferred until their respective future callables exist (documented now, not written now):**
21. Future `recordTripExpense` rejects creation for an archived Trip.
22. Future `recordTripSettlement` continues to succeed for an archived Trip.

---

## 14. Exact implementation scope — split across 4B.5B and 4B.5C

### 4B.5B — Trip archive lifecycle

**In scope:**
- `src/types/domain/trip.ts`: add `archivedAt?: PersistedTimestamp | null` and `archivedBy?: string | null` to `Trip`.
- `src/services/firebase/trips.ts`:
  - `mapTripDocument`: map `archivedAt`/`archivedBy` from the raw document (§8's correction) — without this, nothing else in this list can actually see persisted archive state.
  - Add `archiveTrip(tripId, uid)`.
  - Remove `deleteTrip` (and its import/usage in `[tripId].tsx`).
- `app/(tabs)/trips/index.tsx`:
  - Partition fetched Trips into an **Active** section (unchanged Trip cards) and an **Archived** section (§9/§10) — both rendered, both reachable through ordinary navigation.
  - Legacy Trips (no `archivedAt`) render in the Active section, unaffected.
- `app/(tabs)/trips/[tripId].tsx`:
  - Replace the delete icon/flow with an archive icon/flow and matching confirmation copy ("Archive this trip?", not "permanently delete").
  - Render a visible "Archived" indicator when `trip.archivedAt` is set.
  - Hide/disable the Shared Stash **contribution** control only when archived; **leave the Shared Stash withdrawal control enabled** (§5.C's wind-down model — this is a correction from the original draft's "block both").
  - Leave My Stash Add Money/Withdraw fully enabled regardless of archive status (§5.D).
  - Replace forward-looking Quick Analysis/savings-pace guidance with a neutral archived/wind-down state when archived (§5's Archived Trip Detail UX note).
- `firestore.rules`: `allow delete: if false`; the missing-safe `tripIsActive()` helper; the archive-transition `allow update` branch plus the post-archive freeze on the existing branch (§7).
- `tests/firestore-rules/trips.rules.test.js`: update the existing delete-tests block; add the new archive-specific tests, including the legacy-Trip-can-still-update-before-archive regression test (§13, items 1–14).

**Explicitly OUT of scope for 4B.5B** (belongs to 4B.5C or later):
- Any change to `recordSavingsTransactionCore` — see 4B.5C below.
- `recordTripExpense`/`recordTripSettlement` archived-Trip checks (§12) — these callables don't exist yet; this is a design note for whenever 4C is built.
- A dedicated Archived Trips route, restore/unarchive capability, or archived-Trip management UI (§10).
- Any form of permanent Trip deletion, admin-scoped or otherwise (§6).

**4B.5B must not be deployed on its own** — see 4B.5C below and §11.

### 4B.5C — Trusted savings archive enforcement

**In scope:**
- `functions/src/callables/recordSavingsTransaction.ts` (`recordSavingsTransactionCore`): for `resourceType === "trip"`, after the existing Trip lookup, add exactly one new precondition — reject `type: "contribution"` on an archived Trip with `failed-precondition`; `type: "withdrawal"` continues through every existing invariant unchanged. The `resourceType === "bucket"` path (My Stash) is untouched.
- Focused new Functions/emulator tests for this precondition (§13, items 17–20), added to the existing `functions/test/` suite alongside `recordSavingsTransactionCore`'s current tests, following that file's established conventions.

**Explicitly OUT of scope for 4B.5C:**
- Anything already covered by 4B.5B (schema, mapper, service, UI, Rules) — 4B.5C touches exactly one function, nothing else.
- `recordTripExpense`/`recordTripSettlement` (§12) — not built yet.

**Deployment gate:** the archive lifecycle (4B.5B + 4B.5C together) should be deployed as one reviewed unit — never 4B.5B alone. See §11 for why a UI-only contribution guard is not a real enforcement boundary on its own.

---

## Unresolved decisions (explicitly flagged, not silently assumed)

1. **(Narrowed, 4B.5A.1) Automatic redistribution of a nonzero remaining Shared Stash balance** — members can already manually withdraw down to zero post-archive (§5.C, now resolved), so the *basic* "can this money be resolved at all" question is answered. What remains genuinely open is only whether the product should ever offer *automatic* redistribution (e.g., an even split back to members) rather than relying on manual withdrawals — a product/UX enhancement, not a safety gap.
2. **Whether/when to build a dedicated Archived Trips *route* or richer management UI** — the minimal reachability requirement (§10) is now in-scope for 4B.5B; a separate route/screen beyond the Trips-screen Archived section remains deferred with no committed timeline.
3. **Whether unarchive will ever be supported**, and if so, its own Rules/UI design — the current Rules design makes it structurally impossible until explicitly added later (§7).
4. **Whether a narrow, admin/support-only permanent-deletion escape hatch is ever needed** (e.g., for a privacy/data-deletion compliance request) — distinct from, and should never be reintroduced as, an ordinary user-facing feature (§6).
5. **(Narrowed, 4B.5A.1) Exact scheduling of 4B.5C** — the *content* and *necessity* of the `recordSavingsTransactionCore` archived-Trip check, and the requirement that it ship together with 4B.5B (never deployed as 4B.5B alone), are now decided (§11/§14). Only the calendar timing of when that checkpoint is actually scheduled/built remains open.

---

### Validation

```
git diff --check     -> no output
git status --short   -> ?? docs/audits/TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_2026-09-13.md
```

No production code, Firestore Rules, Cloud Functions, or dependencies were modified to produce this preflight or its 4B.5A.1 hardening pass — only this markdown file was ever touched.

CHECKPOINT 4B.5A TRIP ARCHIVE DELETE SAFETY PREFLIGHT READY FOR REVIEW (hardened by 4B.5A.1)

DO NOT IMPLEMENT.
DO NOT COMMIT.
DO NOT PUSH.
DO NOT DEPLOY.
STOP.
