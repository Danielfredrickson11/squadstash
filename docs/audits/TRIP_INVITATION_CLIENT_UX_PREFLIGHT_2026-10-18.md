# Milestone 5C.3A — Client / Invitation Review UX Preflight

Status: PREFLIGHT / DESIGN ONLY. No application source, client service, Functions source, or Firestore Rules were modified. Not committed.

Repository state at time of writing: branch `claude/milestone-3-personal-savings-mvp`, HEAD `6d19266420df05190d7d1daa3ca5aa0c7cc3f912`.

## 1. Current client architecture

**Invitation service** (`src/services/firebase/tripInvitations.ts`):
- `tripInvitationId(tripId, inviteeUid)` — deterministic `{tripId}_{inviteeUid}` id, duplicated from the Functions-side formula (documented, intentional duplication across the client/Functions project boundary).
- `createTripInvitation(tripId, inviteeEmail)` — already a trusted callable wrapper (`httpsCallable(functions, "createTripInvitation")`), returning `{invitationId, inviteeUid}`. No response validation beyond the callable's own typed generic.
- `fetchInvitationForTrip(tripId, inviteeUid)` — direct Firestore `getDoc` by deterministic id.
- `fetchInvitationsForTrip(tripId)` — owner-facing, direct Firestore query `where('tripId', '==', tripId)`, any status.
- `fetchPendingInvitationsForUser(inviteeUid)` — invitee-facing, direct Firestore query `where('inviteeUid', '==', inviteeUid)`, then filters in JS to `status === 'pending' && !expired` (no composite index needed; see its own comment).
- `acceptTripInvitation(tripId, inviteeUid): Promise<void>` — **still a direct `updateDoc` write** against `tripInvitations/{tripId}_{inviteeUid}`, setting `status: 'accepted'`. **This is now dead on arrival**: Checkpoint 5C.2 closed this exact Rules clause to `allow update: if false;`, so calling this function today will always fail with `permission-denied`. It has not yet been cut over to the trusted `acceptTripInvitation` callable introduced in 5C.1.
- `declineTripInvitation(tripId, inviteeUid): Promise<void>` — direct `updateDoc`, `status: 'declined'`. Still Rules-permitted (5C.2 left this clause untouched).
- `cancelTripInvitation(tripId, inviteeUid): Promise<void>` — direct `updateDoc`, `status: 'cancelled'`. Still Rules-permitted (owner-only, untouched).

**Terms service** (`src/services/firebase/tripTerms.ts`):
- `fetchAllTripTermsVersions(tripId)` — direct query, any version.
- `fetchTripTermsById(termsDocId)` — direct `getDoc`.
- `fetchCurrentTripTerms(tripId): Promise<TripTerms | null>` — reads the `tripTermsCurrent/{tripId}` pointer, then the exact `tripTerms` document it names, independently re-validating pointer/target agreement; throws `TripTermsCorruptionError` (a plain `Error` subclass, not a security boundary) on any internal inconsistency; returns `null` only when no pointer exists at all (never-published Trip).
- `publishTripTerms(input)` — trusted callable wrapper, **no explicit response-shape validation** (reads `res.data.termsDocId`/`res.data.version` directly via the typed generic only — looser than `createTrip`'s convention, see below).

**Acceptance-record service** (`src/services/firebase/tripMembershipAcceptances.ts`):
- `acceptTripTerms(...)` — **also now dead on arrival**: direct `setDoc` against `tripMembershipAcceptances/{id}`, a path Checkpoint 5C.2 closed to `allow create, update, delete: if false;`. Its own header comment still describes the pre-5C "terms acceptance has zero membership effect" framing, which 5C has since superseded.
- `fetchTripMembershipAcceptances(tripId, uid)` — direct query, read-only, still valid (reads remain open to self/owner).

**Domain helpers** (`src/domain/tripInvitation.ts`):
- `isPendingTripInvitation`, `isTripInvitationExpired`, `canRespondToTripInvitation` (self-only, pending+unexpired — currently named/framed as covering *both* accept and decline; once accept moves to the trusted callable, this helper's accept-half becomes advisory/UI-only, never authoritative), `canCancelTripInvitation` (owner-only, pending).

**Types** (`src/types/domain/tripInvitation.ts`, `tripTerms.ts`, `tripMembershipAcceptance.ts`): `TripInvitation`, `TripInvitationStatus` (`pending|accepted|declined|cancelled`), `TripTerms` (exactly the five expectation fields plus `id/tripId/version/createdAt/createdBy`), `TripTermsCurrentPointer`, `TripMembershipAcceptance`.

**Repo-wide UI usage**: confirmed via grep across `app/` and `components/` — **zero matches** for `acceptTripInvitation`, `acceptTripTerms`, `declineTripInvitation`, `cancelTripInvitation`, `fetchPendingInvitationsForUser`, `fetchCurrentTripTerms`, `fetchInvitationForTrip`, `createTripInvitation`. The entire invitation/terms/acceptance feature remains completely unwired at the UI layer, exactly as the frozen 5C.0 preflight already established and as every subsequent checkpoint has reconfirmed.

**Routing** (`app/(tabs)/trips/`): Expo Router file-based routing. `_layout.tsx` declares a `<Stack>` with named `<Stack.Screen>` entries for `index`/`create`/`[tripId]`; nested dynamic segments (e.g. `[tripId]/expenses/[expenseId].tsx`) work today with **no additional `_layout.tsx` file and no corresponding `<Stack.Screen>` entry in the parent layout** — Expo Router auto-discovers file-based routes by convention; the `<Stack.Screen>` declarations exist only to set `screenOptions`, not to register the route. Navigation convention is `useRouter()` + `router.push({ pathname: "/(tabs)/trips/[tripId]/expenses/[expenseId]", params: {...} })` for forward navigation and `router.replace(...)` for terminal/success navigation (confirmed in `[tripId]/index.tsx` and `[tripId]/expenses/create.tsx`).

**Response-validation convention for trusted callables** (`src/services/firebase/trips.ts`'s `parseCreateTripResponse`, mirrored in `buckets.ts`'s `parseCreateBucketResponse`): reject non-object/null; require the exact top-level key set (`Object.keys(data).length === 1 && keys[0] === 'tripId'`); require the value to be a non-empty string; for `createTrip` specifically, also cross-check the returned value against a client-known expected value (the submitted `clientRequestId`) as a deployment-skew defense. **This strict convention is not universal** — `publishTripTerms`'s own wrapper skips it entirely, trusting the typed generic alone. Every trusted-callable wrapper that does throw lets `HttpsError`/`FirebaseError` propagate uncaught to its own caller; catching and mapping to a user-facing message happens one layer up, at the hook/UI level (confirmed in `src/hooks/useSavingsMoneyAction.tsx`, which catches, inspects `(e as {code?: string})?.code === "functions/already-exists"`, and maps to a friendly message via its own `savingsErrorMessage(e)` pure helper).

**Double-submit protection convention** (`app/(tabs)/trips/create.tsx`): a synchronous `useRef<boolean>(false)` mutex (`submitInFlightRef`), checked and set `true` at the very start of the submit handler (before any `await`), reset to `false` in a `finally` block. No external library; no debounce — a plain ref guard.

**Trusted read-only callable precedent** (`functions/src/callables/lookupUserByEmail.ts`): already establishes that a trusted, read-only, allowlisted-response callable (no transaction, no write) is an established pattern in this codebase, not a new shape — directly supports Option A below.

## 2. Identified trust/UI gap

Two client-side functions are **currently broken by Checkpoint 5C.2's own Rules closure**, though neither is reachable from any UI today:
- `tripInvitations.ts`'s `acceptTripInvitation(tripId, inviteeUid)` — direct `updateDoc` against a Rules clause now `if false`.
- `tripMembershipAcceptances.ts`'s `acceptTripTerms(...)` — direct `setDoc` against a Rules clause now `if false`.

Neither is a live regression (zero callers exist), but both are stale, dead code that 5C.3 must replace/retire rather than leave as a trap for a future contributor who might call them expecting the old behavior.

The second gap is the one 5C.0's own §19a flagged and explicitly deferred to this checkpoint: **a pending invitee cannot safely see any Trip context today.** `trips/{tripId}`'s read Rule is `isTripMember() || isTripOwner()` — a pending invitee is neither, and that document carries financial state (`saved`, `ledgerBalanceMinor`, `ledgerOpeningBalanceMinor`, `ownershipModelState`, etc.) that must never be exposed pre-join. The `tripInvitations` document itself carries no Trip-descriptive context at all (no title/location/dates/image) — only `tripId`, `inviterUid`, `inviteeEmail`, `inviteeUid`, `status`, timestamps. Today, an invitation-review screen would have nothing user-meaningful to show except raw ids. This preflight resolves that gap (§3/§4 below).

## 3. Preview mechanism comparison

| Dimension | Option A — trusted read-only callable (`getTripInvitationPreview`) | Option B — denormalized safe snapshot on `tripInvitations` at create time |
|---|---|---|
| Security | Backend derives the safe subset fresh, server-side, from the live Trip document on every call — the allowlist is enforced in exactly one place (the callable's own return statement), impossible to bypass from the client. | Safe subset is written once, at `createTripInvitation` time, directly into a client-readable document. Its "safety" depends entirely on `createTripInvitation.ts` never adding a sensitive field to the denormalized snapshot in the future — a regression risk every future edit to that one file must remember to re-check. |
| Stale-data risk | Always reflects the Trip's **current** title/location/image/dates at read time — if the owner renames the Trip or changes its cover image after inviting, the invitee's preview is always current. | Snapshot is frozen at invitation-creation time. If the owner later renames the Trip, changes location, or swaps the image, every outstanding invitation's preview silently goes stale until re-created — there is no re-invite path in this codebase (5A's frozen design, confirmed unchanged), so a stale snapshot could persist for the invitation's entire 14-day life with no mechanism to refresh it. |
| Existing production invitations | No effect — a new callable works against any already-persisted invitation, old or new, with no shape requirement on the invitation document itself. | **Breaking for any invitation created before 5C.3 ships** — such a document has no denormalized snapshot fields at all, so the review screen would need a fallback path (or those invitations simply can't be previewed), and the gap is permanent for any invitation that happened to still be pending across the deploy boundary. |
| Migration requirements | None. | Would require either a backfill migration for existing pending invitations, or accepting that pre-5C.3 invitations never get a usable preview — the frozen 5A schema (§2/§12 of the 5C preflight) would also need a new, additive field set, a schema change this checkpoint's own scope explicitly does not authorize revisiting without a clear need. |
| Current invitation immutability | No interaction at all — `tripInvitations` schema is completely untouched. | Directly conflicts with the project's established "invitation identity fields are immutable once created" posture (every Rules `allow update` clause on this collection pins every field except `status`/`respondedAt` unchanged) — adding new fields is additive and technically compatible, but writing *mutable, denormalized* Trip data onto an otherwise-immutable-by-convention record is a new category of field this collection has never had, and keeping it in sync forever is a new maintenance burden with no expiry (an invitation lives up to 14 days). |
| Client complexity | One more `httpsCallable` invocation, following the exact same pattern already used for `createTripInvitation`/`acceptTripInvitation`/`publishTripTerms`. Trivial addition. | Zero new client code for the *read* path (just read more fields off the existing invitation document) — marginally simpler on the client specifically, but the simplicity is purchased by pushing real complexity onto `createTripInvitation.ts` and onto data-freshness correctness. |
| Backend complexity | One small new trusted callable, read-only, no transaction required (no multi-document atomicity need — it is a pure read, not a decision with consequences). Mirrors `lookupUserByEmail.ts`'s existing shape closely. | Requires widening `createTripInvitation.ts`'s own write set (one new field, or a small nested object, added to its existing transaction) plus deciding and freezing an exact denormalized-field allowlist there instead of here — moves the "what's safe to expose" decision to a different, already-frozen checkpoint's file, re-opening it. |
| Compatibility with pending/unexpired terms privacy (§16, Option B) | Fully independent — the preview callable concerns Trip *metadata* only, never terms content; §16's Rules-level `hasPendingUnexpiredTripInvitation` helper is untouched either way. | Equally independent; no interaction with either option. |
| Future product polish | A trusted callable can later be extended (new allowlisted fields, computed display values) without ever touching `tripInvitations`' schema or Rules again. | Any future addition to "what the invitee can preview" requires another `createTripInvitation.ts` change and, worse, cannot retroactively enrich invitations already sent before that change ships. |
| Production rollout | Fits cleanly into the already-frozen backend→client→Rules order (§22 of the 5C preflight) — it is simply one more trusted backend endpoint deployed alongside `acceptTripInvitation`. | Would require redeploying `createTripInvitation.ts` (a currently-stable, already-production-verified callable from Milestone 5A) specifically to add this field — widening the blast radius of an otherwise-unrelated change for a UI-only feature. |

**No repository fact reveals a blocker for Option A.** Every dimension above favors it, several (existing invitations, immutability posture, migration) are not merely "preferred" but close to disqualifying for Option B given this repository's specific history (14-day-lived invitations with no re-invite path, meaning a stale-snapshot window could last the full 14 days with zero remediation available).

## 4. Final preview decision

**Option A — trusted read-only callable `getTripInvitationPreview`.** Frozen.

## 5. Exact preview request/response

```ts
// Request
{
  invitationId: string;
}

// Response
{
  tripId: string;
  title: string;
  location: string | null;
  imageUrl: string;
  tripStartDate: string | null;
  tripEndDate: string | null;
}
```

**`target` is excluded** (default per the checkpoint's own instruction, and nothing in this repository's product framing — `target` is a savings goal amount, which this codebase has consistently treated as Trip-financial-adjacent context, not neutral metadata — justifies reclassifying it as safe). **Never included**: `saved`, `ledgerOpeningBalanceMinor`, `ledgerBalanceMinor`, `currency`, `memberIds`, `ownerId`, `ownershipModelState`/`Version`, `creationRequest`, any `tripExpenses`/`tripExpenseSplits`/`tripSettlements`/`tripMemberOwnership`/`savingsTransactions`/`tripOwnershipAllocations` content, and no other member's identity or contact information. This mirrors `createTrip`'s own minimal-response precedent (§8 of the frozen 5C preflight) and the explicit non-goal stated there: the client should receive exactly what it needs to render, and nothing a server-authoritative decision depends on.

## 6. Exact preview authorization rules

Frozen, all fail-closed (`HttpsError`), before any Trip metadata is read or returned:
1. Caller must be authenticated (`unauthenticated` otherwise).
2. `invitationId` must pass the same safe-document-id shape check already frozen for `acceptTripInvitation`'s own `invitationId` field (§8 of the 5C preflight, `SAFE_INVITATION_ID_PATTERN`-style check) — reject malformed input before any Firestore read.
3. The named `tripInvitations/{invitationId}` document must exist (`not-found` otherwise).
4. `invitation.inviteeUid`/`inviterUid`/`tripId` must be non-empty strings (Step-0-style corruption check, mirroring `acceptTripInvitation`'s own Step 0).
5. `authUid === invitation.inviteeUid` — **invitee only**; the inviter/owner must never need this preview (they already have full Trip access) and must never be able to preview *as* the invitee.
6. The invitation document's own id must be canonical for its persisted `tripId`/`inviteeUid` (reusing `tripInvitationId(tripId, inviteeUid)` from `functions/src/domain/tripCompositeId.ts` — the exact same canonical-id check `acceptTripInvitation` already performs).
7. `trips/{invitation.tripId}` must exist (`not-found` otherwise).
8. `invitation.inviterUid === Trip.ownerId` — the invitation must have been issued by the Trip's *current* authoritative owner (same staleness guard `acceptTripInvitation` already applies).
9. `invitation.status === 'pending'` — a `declined`/`cancelled`/`accepted` invitation cannot use this preview (an already-accepted invitee has full Trip access already via ordinary membership and needs no preview at all; a declined/cancelled invitee has no standing left to preview anything).
10. `invitation.expiresAt > now` (server time) — an expired-while-still-`pending` invitation cannot preview either, mirroring the exact same expiry re-check `acceptTripInvitation` performs independently of Rules.
11. **Archived Trip: reject.** A pending invitation to a Trip that has since been archived should not preview as if nothing happened — recommend `failed-precondition`, mirroring `acceptTripInvitation`'s own archived-Trip rejection in Branch B. (This also means an invitee cannot be lured into reviewing/accepting an archived Trip — `acceptTripInvitation` would reject the subsequent accept attempt anyway, but failing the preview first gives a clearer, earlier signal.)
12. Read current Trip metadata fresh (no caching) and return exactly the six-field response in §5 — no writes of any kind; this callable is a pure read, needs no `db.runTransaction`, mirroring `lookupUserByEmail.ts`'s own transaction-free shape.

**Owner does not need this callable** — frozen, per the checkpoint's own recommendation: the owner already has full `trips/{tripId}` read access and needs no safe subset of their own data.

## 7. `acceptTripInvitation` client contract

Replaces `tripInvitations.ts`'s existing direct-write `acceptTripInvitation` **in place** (same exported name, same module) — never left alongside it under a different name, mirroring exactly how `createTrip`'s own client wrapper was swapped from a direct write to a trusted callable during this same session's 5B.5B checkpoint.

```ts
export async function acceptTripInvitation(
  invitationId: string,
  acceptedTermsDocId: string
): Promise<{ tripId: string }>
```

Implementation: `httpsCallable(functions, "acceptTripInvitation")`, called with the exact two-key request `{invitationId, acceptedTermsDocId}` rebuilt field-by-field (never a forwarded/spread object), mirroring `createTrip`'s own request-construction discipline. Response validated with the same strict convention as `parseCreateTripResponse`: reject non-object/null; require `Object.keys(data).length === 1 && keys[0] === 'tripId'`; require `tripId` to be a non-empty string. (No "matches an expected value" cross-check here, unlike `createTrip`'s `clientRequestId` comparison — `acceptTripInvitation` has no client-known expected `tripId` to compare against until the response itself supplies it, so this specific defense doesn't carry over; the exact-key-set and non-empty-string checks do.) `HttpsError`/`FirebaseError` propagate uncaught, matching every sibling wrapper. The error's `details.reason` is never stripped or rewrapped — a caller (the eventual review screen) that inspects `(e as {code?: string; details?: {reason?: string}})?.details?.reason === "terms_changed"` must see that value exactly as the backend set it (§8/§10 of the 5C preflight), following the same `(e as {code?: string})?.code === "..."` narrowing style `useSavingsMoneyAction.tsx` already uses for `functions/already-exists`.

**No direct Firestore acceptance fallback of any kind** — not as a retry path, not as a degraded-mode path if the callable is unreachable.

`declineTripInvitation`/`cancelTripInvitation` remain exactly as they are today — unmodified, still direct client writes, still Rules-permitted.

## 8. Terms review flow

Frozen, exactly as the checkpoint's own recommendation, with file/function names resolved against this repository:

**Revision note (this hardening pass): the original draft of this section had the review screen load the preview and the current terms "in parallel," justified by assuming `tripId` was already known from either the preview response or an invitation object the Trips list screen still held in memory. That assumption is unsound — the frozen route (§9) is `app/(tabs)/trips/invitations/[invitationId].tsx`, carrying only `invitationId`. A deep link, a cold app restart landing directly on this route, a restored navigation state, or a manual refresh on this screen can all reach it with no preceding Trips-list fetch in memory at all. The canonical flow below is now strictly sequential and correct in every entry mode — it depends on nothing but the route's own `invitationId` param.**

1. `app/(tabs)/trips/index.tsx` calls `fetchPendingInvitationsForUser(user.uid)` (already exists, already correctly scoped to pending+unexpired) on focus, alongside its existing `fetchMemberTripsOrdered`/`fetchMemberTrips` calls.
2. A pending-invitations section renders separately from the active/archived Trips lists already on that screen.
3. Tapping an invitation card navigates to the new review route (§9), passing only `invitationId` — no `tripId`, and no forwarded invitation object.
4. The review screen receives `invitationId` from the route. It calls `getTripInvitationPreview({invitationId})` and awaits it — this is the screen's *only* starting input; nothing from the Trips list, prior navigation state, or any other preexisting client-held object is read or trusted.
5. The preview response is validated (§5/§6's exact six-field shape). `preview.tripId` becomes the **authoritative** Trip id for the rest of this review session — the client never has, and never needs, any other source for it. (A client-carried `tripId`, if one happened to exist from the list screen, is never consulted ahead of this response — the preview callable is always the one source of truth for which Trip this invitation belongs to.)
6. Only after step 5 resolves does the screen call `fetchCurrentTripTerms(preview.tripId)` and await it.
7. The screen renders only once **both** the preview and the terms have successfully resolved — Trip `title`, safe `location`/`tripStartDate`/`tripEndDate`/`imageUrl` context from the preview, and all five current terms fields (§10) from `fetchCurrentTripTerms`. The screen may use two independent loading substates internally (e.g. "loading preview" then "loading terms") to render incremental progress, but correctness never depends on anything resolving in parallel or on any state that predates this screen's own mount.
8. Accept requires an explicit, unchecked-by-default affirmative action — no default-checked consent of any kind.
9. Accept calls the new `acceptTripInvitation(invitationId, currentlyRenderedTermsId)` — `currentlyRenderedTermsId` must be the exact `id` of the `TripTerms` object the screen actually rendered in step 7, read from local component state, never re-fetched or re-derived at submit time (re-fetching at submit time would reintroduce the exact TOCTOU gap §10 of the 5C preflight exists to close).
10. On success: `router.replace({ pathname: "/(tabs)/trips/[tripId]", params: {tripId: response.tripId} })`, using the `acceptTripInvitation` callable's own returned `tripId` — not `preview.tripId`, even though the two are guaranteed to agree on success; the navigation target stays provably tied to the just-confirmed server decision. This matches the existing `router.replace("/(tabs)/trips")`-after-success convention already used elsewhere in this route subtree, specialized to the typed dynamic route.
11. On `details.reason === "terms_changed"`: re-fetch `fetchCurrentTripTerms(preview.tripId)`, replace the rendered terms content in place, surface a visible "terms were updated — please review again" notice, and require a fresh explicit Accept press. **Never automatically retry** the accept call with the new terms id — the whole point of the anti-TOCTOU design is that silently re-binding to new content the user has not yet seen defeats its purpose.
12. Decline remains a separate, secondary, explicitly-labeled action on the same screen, calling the existing unmodified `declineTripInvitation`.

## 9. Route decision

**`app/(tabs)/trips/invitations/[invitationId].tsx`** — frozen, matching the checkpoint's own suggested path and this repository's existing nesting convention exactly (`[tripId]/expenses/[expenseId].tsx` is the closest structural precedent: a plain subdirectory segment followed by a dynamic leaf, with no new `_layout.tsx` required, confirmed in §1 above). No new `<Stack.Screen>` entry is strictly required in `app/(tabs)/trips/_layout.tsx` for the route to resolve (Expo Router auto-discovers it), though adding one is harmless if a future screen-options customization is ever needed — this preflight does not require adding it now.

- **Navigation into the review screen**: `router.push({ pathname: "/(tabs)/trips/invitations/[invitationId]", params: {invitationId} })` from the Trips screen's new pending-invitations section — `invitationId` only, deliberately never `tripId` (§8's revised flow depends on the route carrying nothing else; adding `tripId` to the route merely to regain parallelism was considered and rejected — see §8's revision note).
- **Navigation after Accept**: `router.replace({ pathname: "/(tabs)/trips/[tripId]", params: {tripId} })` using the `acceptTripInvitation` callable's own returned `tripId` — never `preview.tripId`, even though the two are guaranteed to agree when the call succeeds (§8 step 10); using the response value keeps the navigation target provably tied to the just-confirmed server decision, not merely to the earlier preview read.
- **Navigation after Decline**: `router.replace("/(tabs)/trips")`, returning to the Trips list (the declined invitation will simply no longer appear in the next `fetchPendingInvitationsForUser` call).
- **Back navigation**: ordinary Expo Router back behavior (pop to Trips screen) is sufficient — declining is not the only way to leave this screen, and leaving without responding is a legitimate, harmless "decide later" outcome requiring no special handling.
- **Deep-link feasibility**: the route is a plain dynamic segment under an already-deep-linkable tab stack, carrying only `invitationId` — and because §8's flow is now fully self-contained from that one param (no dependency on Trips-list state), a deep link, a cold start, or a restored navigation state landing directly on this route all work correctly with no special-casing. Not a requirement for 5C.3's scope, but now a natural consequence of the corrected flow rather than an open question.

## 10. Invitation surfacing decision

**Trips screen, a new "Invitations" section**, per the checkpoint's own recommendation — confirmed consistent with this repository's existing structure: `app/(tabs)/trips/index.tsx` already calls `fetchPendingInvitationsForUser`-shaped data on every `useFocusEffect` refresh (it doesn't yet, but the hook/fetch pattern it already uses for Trips is directly reusable), and inserting a section there touches no other tab.

**Per-card preview-loading question (§8 of the checkpoint): Option A (generic card, preview loads only after tap) is frozen.** The Trips screen already has every fact it needs to render a useful, non-generic invitation card **without calling the new preview callable at all**: the `TripInvitation` record itself carries `inviteeEmail` (display-only, already fetched) and `createdAt`/`expiresAt` (for a "invited N days ago" / "expires in N days" line) — a card reading "Trip invitation — expires in 6 days" with a tap-to-review action is not "generic" in the pejorative sense the checkpoint warns about; it simply defers the *Trip-identifying* content (title/image/location) to the review screen, which is the one place that content is actually needed. This avoids N parallel callable invocations for an unbounded list of pending invitations and matches the checkpoint's own explicit instruction not to over-engineer 5C.3 with a batch-preview backend that currently has no proven need (a user with more than a small handful of simultaneous pending Trip invitations is not a scenario this product has any evidence of yet).

## 11. UI states

Frozen required states for the review screen (sequential, per §8's corrected flow — "loading terms" is only ever reached after "loading preview" has already resolved successfully):
- Loading invitation preview (the screen's first, and only unconditional, fetch — depends on nothing but the route's own `invitationId`).
- Loading terms (begins only once the preview has resolved and `preview.tripId` is known).
- Missing invitation (`not-found` from the preview callable, or the invitation no longer resolvable) — distinct message from "expired."
- Expired invitation (`failed-precondition`, distinguishable from "missing").
- Cancelled/declined (the invitation's own already-terminal status — this state is reachable if the user navigates to a stale link to an invitation they, or the owner, already resolved via another device/session).
- Archived Trip (preview callable's own explicit rejection, §6 item 11).
- Terms unavailable (`fetchCurrentTripTerms` returns `null` — a Trip with a pending invitation but no terms ever published; should not be reachable in practice since `acceptTripInvitation`'s own Branch B requires a valid pointer, but the UI must still handle it rather than crash).
- Terms corruption/read error (`TripTermsCorruptionError` — surfaced as a generic "unable to load Trip terms" error, never the raw corruption message).
- Stale terms / `terms_changed` (§8 item 9 — a distinct, actionable state, not a generic failure).
- Accept in progress (button disabled/spinner, mutex held).
- Decline in progress (button disabled/spinner, mutex held).
- Success navigation (brief or no intermediate state — `router.replace` fires immediately on the callable's resolved response).
- Generic callable failure (any `HttpsError`/`FirebaseError` not matching a recognized `code`/`details.reason` — a plain, non-alarming retry-suggesting message, never raw technical text, matching `useSavingsMoneyAction.tsx`'s own `savingsErrorMessage`-style convention).
- Unauthenticated (should be structurally unreachable given this route sits under the authenticated tab stack, but the callable itself still enforces it server-side regardless of client-side routing guarantees).

**Double-submit protection**: a `submitInFlightRef`-style synchronous `useRef<boolean>(false)` mutex, exactly matching `create.tsx`'s established pattern — checked and set at the top of both the Accept handler and the Decline handler, reset in each one's own `finally` block. Because Accept and Decline are two separate user-triggered actions on the same screen (not two branches of one submit path), **a single shared mutex ref covering both** is the correct choice: pressing Decline while an Accept call is in flight (or vice versa) must be blocked exactly like pressing the same button twice, since both mutate the same invitation document and only one terminal outcome can ever be correct.

## 12. Terms UI content

Confirmed from `src/types/domain/tripTerms.ts` — exactly five fields, all required, none to be omitted:

| Field | Recommended label |
|---|---|
| `contributionExpectations` | "Contribution Expectations" |
| `expenseAllocationExpectations` | "Expense Allocation" |
| `sharedStashSpendingAuthority` | "Shared Stash Spending Authority" |
| `withdrawalExpectations` | "Withdrawal Expectations" |
| `settlementExpectations` | "Settlement Expectations" |

Each is owner-authored free text (≤2000 chars, per `publishTripTerms.ts`'s own validation) and must be rendered verbatim — no truncation, no summarization, no paraphrasing that could change its meaning, consistent with this being disclosure/consent content (Master Spec §12.2/§12.3, reaffirmed by the 5C preflight §10).

## 13. Test matrix

**Client service** (new `acceptTripInvitation` wrapper, plus a `getTripInvitationPreview` client wrapper if 5C.3B adds one):
- exact callable request shape (`{invitationId, acceptedTermsDocId}`, no extra keys, field-by-field constructed).
- exact response validation (object, exactly one key, `tripId` only).
- extra top-level response key rejects.
- missing `tripId` key rejects.
- empty-string `tripId` rejects.
- non-string `tripId` rejects.
- callable error (`HttpsError`/`FirebaseError`) propagates uncaught.
- `details.reason === "terms_changed"` is preserved and recognizable by a caller inspecting the thrown error.
- no direct Firestore/`updateDoc`/`setDoc` fallback exists anywhere in the new code path (a static/structural assertion, not a runtime one — confirmed by code review of the final diff, same as every prior checkpoint's "source-authority search").

**Preview backend** (`getTripInvitationPreview`, if/when 5C.3B implements it) — mirrors `acceptTripInvitationCore`'s own test-matrix depth:
- unauthenticated rejects.
- wrong uid (not the named invitee) rejects.
- invitation missing rejects (`not-found`).
- non-canonical invitation id (persisted `tripId`/`inviteeUid` don't reproduce the requested id) rejects.
- declined invitation rejects.
- cancelled invitation rejects.
- accepted invitation rejects (preview is pre-join only).
- expired-while-pending invitation rejects.
- archived Trip rejects.
- stale `inviterUid`/`Trip.ownerId` mismatch rejects (ownership changed since the invitation was issued).
- missing Trip (`invitation.tripId` doesn't resolve) rejects.
- exact safe response shape — exactly the six fields in §5, no more, no fewer.
- no financial field present in the response, for any seeded Trip shape (legacy, native, archived-but-otherwise-valid).
- zero writes occur, for both success and every rejection path (a pure-read regression guard, mirroring every other callable's own "no financial mutation" proof in this session).

**UI/domain helpers** — prefer pure, non-rendering tests, matching this repository's established style (`src/domain/__tests__/tripInvitation.test.ts` already tests pure functions in isolation; the Rules/Functions test suites throughout this session are uniformly logic-first, not snapshot/rendering-first):
- exact accept-response parsing (the `parseAcceptTripInvitationResponse`-style function, mirroring `parseCreateTripResponse`'s own existing test coverage pattern in `buckets.ts`/`trips.ts`'s sibling test files, if any exist — confirm during 5C.3B/5C.3C implementation).
- `terms_changed` classification as a pure predicate over a caught error value (`isTermsChangedError(e): boolean`-style helper), independently testable without mocking `httpsCallable` end to end.
- any deterministic presentation transformation (e.g. "expires in N days" formatting) as a pure function of `(expiresAt, now)`, mirroring `isTripInvitationExpired`'s own existing shape.

Avoid brittle component-rendering tests for the review screen itself unless the repository's test conventions are found to already include such tests elsewhere for comparable screens (not confirmed either way in this preflight — to be checked at 5C.3C's own start, not assumed here).

**Loading-order regression (new, this hardening pass)**: the screen's terms fetch must never fire before the preview response has resolved and supplied `preview.tripId` (§8's corrected flow) — this is a control-flow/sequencing property, not a pure-function property, so it is best proven at 5C.3D's integration level (a real emulator-backed run that asserts `fetchCurrentTripTerms` is never called/observed before `getTripInvitationPreview` resolves) rather than invented as an artificial unit test around a function that doesn't yet exist.

## 14. Rollout implications

**Revision note (this hardening pass): the original draft of this section conflated two different orderings and, in doing so, implied something false — that deploying the 5C.2 Rules closure before the client stops using the old direct-write path would be safe merely because the trusted `acceptTripInvitation` backend already exists in the repository. That is incorrect, and the statement is withdrawn below.**

**SOURCE-CONTROL order and PRODUCTION-DEPLOYMENT order are different things, and must not be conflated:**
- It is perfectly safe that the 5C.2 Rules *source* was implemented and committed to this branch before any 5C.3 client source exists — committing source changes nothing about what is actually running in production.
- It is **NOT** safe to *deploy* those Rules to production before the production client has been cut over to the trusted callable. **Today, the production client still calls the old direct Firestore write** — `tripInvitations.ts`'s `acceptTripInvitation(tripId, inviteeUid)` → `updateDoc(..., {status: "accepted"})` (§1/§2). If the 5C.2 Rules were deployed to production right now, that still-live direct-write path would start failing `permission-denied` for every real user who presses whatever UI currently triggers it — the fact that a trusted *replacement* backend already exists in the repository does not help a client that has not yet been cut over to call it.
- **Status, explicit:** 5C.2 Rules source is already committed to this branch. 5C.2 Rules are **NOT** deployed to production. These are two independent facts and neither implies the other.

**Frozen production rollout order, exact:**

1. Deploy the trusted `acceptTripInvitation` backend.
2. Deploy the trusted `getTripInvitationPreview` backend. (Steps 1–2 may be one jointly-authorized backend deployment, since both are membership-adjacent and both must exist before any client depends on either.)
3. Verify both deployed Functions exist, read-only (`firebase functions:list`).
4. Cut/ship the production client over to: the trusted `acceptTripInvitation` callable (in-place swap, §7), the trusted `getTripInvitationPreview` callable, and the invitation-review UI (§8–§11) — these ship together as one coherent feature; there is no safe intermediate production state where only some of it ships.
5. Verify the shipped client/source no longer has a reachable direct-write acceptance path (source-authority check, matching every prior checkpoint's own convention — confirm `updateDoc`/`setDoc` against `tripInvitations`'/`tripMembershipAcceptances`' status/create paths no longer exists anywhere in the shipped client).
6. **Only once step 5 is verified complete** — deploy the 5C.2 Firestore Rules closure.
7. Verify the deployed Rules, read-only.
8. Controlled second-account production membership verification (§23 of the 5C preflight) — unaffected by this preflight's decisions.

**Until step 4 is verified complete, DO NOT deploy the 5C.2 Rules to production.**

No deployment of any kind occurs as part of this preflight or its eventual 5C.3B/5C.3C/5C.3D implementation checkpoints — those remain local-emulator/local-build verification only, exactly like every other sub-checkpoint in this session, until a future, separately-authorized 5C.5-equivalent production gate.

## 15. Implementation checkpoint decomposition

Frozen, matching the checkpoint's own preferred structure — no smaller decomposition is demonstrably safer, since the preview callable (5C.3B) and the client cutover (5C.3C) are naturally separable the same way every prior backend→client split in this session (5B.5A/5B.5B, 5C.1/5C.2) already proved safe and legible:

- **5C.3A** — this preflight (complete).
- **5C.3B** — trusted `getTripInvitationPreview`/`getTripInvitationPreviewCore` backend + comprehensive emulator tests (mirrors 5C.1's own backend-first, no-Rules-change, no-client-change discipline).
- **5C.3C** — client service cutover (`acceptTripInvitation` in-place swap, retiring the dead `acceptTripTerms` direct-write function), new `getTripInvitationPreview` client wrapper, the invitation-review screen (`app/(tabs)/trips/invitations/[invitationId].tsx`), the Trips-screen invitation-surfacing section, and Accept/Decline actions.
- **5C.3D** — local integrated verification (emulator-backed end-to-end: create → preview → review → accept/terms_changed/decline, using the real deployed-to-emulator callables, not mocks).

**5C.4 remains the dedicated multi-member FINANCIAL emulator E2E and must not be absorbed into 5C.3** — 5C.3's scope is UI/UX and the one new read-only preview callable only; no financial contribution, withdrawal, or pooled-spend interaction is exercised anywhere in 5C.3A–5C.3D.

## 16. Blocking vs. deferred decisions

**BLOCKING** (resolved by this preflight; nothing here blocks starting 5C.3B):
- Preview mechanism: Option A, frozen (§3/§4).
- Exact preview request/response contract: frozen (§5).
- Exact preview authorization rules: frozen (§6).
- `acceptTripInvitation` client contract: frozen (§7).
- Terms review flow: frozen (§8).
- Route: frozen (§9).
- Invitation surfacing placement and per-card loading strategy: frozen (§10).

**DEFERRED** (acceptable to remain open; do not block 5C.3B):
- Exact visual design/styling of the invitation card and review screen — a UI-polish concern for 5C.3C's own implementation, not an architecture decision.
- Whether a future re-consent lifecycle should notify an existing member when terms change — explicitly out of scope per the 5C preflight §10's own non-goal statement, unaffected by this preflight.
- Whether `app/(tabs)/trips/_layout.tsx` should gain an explicit `<Stack.Screen name="invitations/[invitationId]">` entry for future `screenOptions` customization — not required for the route to function (§9), a 5C.3C implementation-time judgment call.
- Whether existing component-rendering test conventions (if any, for comparable screens) should be followed for the new review screen, or whether pure-logic-only tests suffice — to be confirmed at 5C.3C's own start (§13).
- `canRespondToTripInvitation`'s current framing (covers both accept and decline) will need either a rename/split or a doc-comment correction once accept moves to the trusted callable — a small, non-blocking cleanup item for 5C.3C, not an architecture question.

## 17. Final recommendation

```
GO for proceeding to 5C.3B (trusted getTripInvitationPreview backend).

No BLOCKING decision remains open. Option A (trusted read-only preview
callable) is frozen with an exact six-field response contract and a
full fail-closed authorization list mirroring acceptTripInvitation's
own established conventions. The acceptTripInvitation client contract,
terms review flow, route, and invitation-surfacing strategy are all
frozen. 5C.3B must implement: the preview callable and its core
function, request/response validation per §5/§6, and a full test
matrix per §13 - no Rules change, no client change, no UI
implementation, matching this session's own proven backend-first
discipline.
```
