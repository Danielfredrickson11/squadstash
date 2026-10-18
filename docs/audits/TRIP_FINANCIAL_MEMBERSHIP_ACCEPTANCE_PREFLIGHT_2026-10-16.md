# Milestone 5C.0 — Trusted Invitation Acceptance → Financial Membership Preflight

Status: PREFLIGHT / ARCHITECTURE FREEZE ONLY. No source, Rules, or test changes were made. Not committed.

Repository state at time of writing: branch `claude/milestone-3-personal-savings-mvp`, HEAD `20c1760387251db12d3109a93db979eb28b7eb80`.

**Revision history**:
- **5C.0A pass**: fixed an internal contradiction in the replay/idempotency ordering (§9, §11), added explicit invitation/Trip corruption checks (§9), froze the shared terms-validator reuse decision (§9a), corrected the terms-read privacy description and made an (initially Option-A) decision (§16), added a legacy-membership-provenance policy (§15a), corrected the production rollout order (§22), corrected an unproven "second account does not exist" claim (§23), flagged an invitation-review UX gap for 5C.3 (§19a), strengthened the 5C.4 E2E matrix with a positive-balance case (§20), and tightened the callable's input-rejection contract (§8).
- **5C.0B pass (final hardening)**: **reversed** §16's decision from Option A to the safer **Option B** (pre-acceptance terms access now requires a currently-actionable — pending, unexpired — invitation, not merely any historical one), with corresponding Rules-change (§18), scope (§17), and test-matrix (§20) updates; moved the canonical `memberIds` validation into Step 0 so it is **shared by both branches**, not Branch-B-only, and froze the write method as the full canonical array rather than `arrayUnion` (§9); froze reuse of `tripCompositeId.ts`'s delimiter convention for the acceptance id, rather than ad hoc concatenation (§12); restated the completed-replay invariant as an explicit DOES/DOES-NOT-validate list (§9); and restructured §24 into explicit BLOCKING (all now resolved) vs. DEFERRED (non-blocking, later-checkpoint) decisions.

See §25 for the final consolidated recommendation.

## 1. Current architecture (summary)

Milestone 5A built invitation creation (trusted callable), Trip terms versioning (trusted callable + server-authoritative current-pointer document), and an inert `tripMembershipAcceptances` schema/Rules scaffold. Milestone 5B built per-member ownership accounting, proportional pooled-spend depletion, a personal withdrawal ceiling, a migration tool (production-verified), and — in this session's own 5B.5 sub-sequence — cut Trip creation over to a trusted `createTrip` callable and permanently closed direct client Trip creation in production Rules. At no point prior to this preflight has any uid other than the original creator (`ownerId`) ever been added to `trips.memberIds` through a trusted, consent-gated path. 5C is the first checkpoint where that happens.

## 2. Current invitation schema/state machine

`tripInvitations/{tripId}_{inviteeUid}` (deterministic id, duplicated identically in `functions/src/domain` via `tripInvitationId` in `createTripInvitation.ts`, in the client via `src/services/firebase/tripInvitations.ts`'s own `tripInvitationId`, and enforced again inside `firestore.rules`' `tripMembershipAcceptances` create rule). Fields: `tripId`, `inviterUid`, `inviteeEmail` (normalized, display-only), `inviteeUid`, `status` (`"pending" | "accepted" | "declined" | "cancelled"`), `createdAt`, `expiresAt` (14 days, set at creation, never reset), `respondedAt`.

Creation is a trusted callable (`createTripInvitation`/`createTripInvitationCore`): owner-only, resolves `inviteeEmail` to a uid server-side via `getAuth().getUserByEmail` (never a public email-query surface), rejects an archived Trip, rejects inviting an existing member, rejects a second invitation for the same `(tripId, inviteeUid)` pair regardless of its status (no re-invite path exists by design).

**Responding today is a direct client write, not a callable**, via three separate `firestore.rules` `allow update` clauses on `tripInvitations`: invitee `pending+unexpired → accepted`; invitee `pending → declined` (regardless of expiry); owner `pending → cancelled` (regardless of expiry). Each clause pins every other field unchanged and allows touching only `status`/`respondedAt`. `src/services/firebase/tripInvitations.ts` exposes `acceptTripInvitation`, `declineTripInvitation`, `cancelTripInvitation` as thin `updateDoc` wrappers around exactly these three transitions. **Critically: the current `accept` transition has zero financial or membership consequence — it only flips a status string.** No UI in `app/` currently wires any of this (confirmed by repo-wide search: zero matches for `acceptTripInvitation`/`fetchPendingInvitationsForUser`/`publishTripTerms`/`createTripInvitation` anywhere under `app/` or `components/`). The entire invitation/terms/acceptance feature is unbuilt at the UI layer.

## 3. Current terms architecture

`tripTerms/{termsDocId}` (auto-id): `tripId`, `version`, `createdAt`, `createdBy`, and five free-text expectation fields (`contributionExpectations`, `expenseAllocationExpectations`, `sharedStashSpendingAuthority`, `withdrawalExpectations`, `settlementExpectations`, each ≤2000 chars). Immutable once created (`allow update, delete: if false`). Creation is trusted-callable-only (`publishTripTerms`/`publishTripTermsCore`, owner-only, archived-Trip-rejecting) specifically because "the current version" cannot be a client-computed max — a concurrent publish race would be unresolvable without a server-serialized counter.

`tripTermsCurrent/{tripId}` (Trip-id-keyed pointer, one per Trip): `tripId`, `currentVersion`, `currentTermsDocId`, `updatedAt`. Written only inside `publishTripTermsCore`'s own transaction, atomically alongside the new `tripTerms` document. `publishTripTermsCore` and the client's `fetchCurrentTripTerms` both independently implement the identical fail-closed corruption check: an **absent** pointer means "never published" (resolves to version 1 / returns `null`); an **existing** pointer is trusted authoritative state and must be internally valid and must agree with the exact `tripTerms` document it names, or the call/read fails closed (`failed-precondition` / `TripTermsCorruptionError`) — never silently treated as "no terms yet."

## 4. Current acceptance scaffolding — **and a correction to its framing**

`tripMembershipAcceptances/{tripId}_{uid}_{termsDocId}` (deterministic id). Fields (exactly 5, Rules-enforced exhaustive): `tripId`, `uid`, `termsDocId`, `acceptedTermsVersion`, `acceptedAt`. `allow update, delete: if false` — correctly immutable.

**This checkpoint's framing calls this collection "inert scaffolding." That is only half true.** Reading `firestore.rules` directly (lines 774–800) shows `allow create` for `tripMembershipAcceptances` is **currently a live direct client write**, not `if false`. It requires: `uid == request.auth.uid`; `tripId`/`termsDocId` present with correct types; `acceptedTermsVersion is number`; `acceptedAt == request.time`; `hasActionableTripInvitationRecord(tripId)` (an un-revoked, unexpired invitation relationship — pending-unexpired OR already-accepted); the named `tripTerms` document exists, belongs to this Trip, and its `version` agrees with the client's claimed `acceptedTermsVersion`; the `tripTermsCurrent` pointer exists and names this exact `termsDocId`; and the document id matches the deterministic formula. This is a fairly sophisticated client-facing Rule — and today it is genuinely reachable by any signed-in client holding an actionable invitation record. It is "inert" only in the sense that **nothing currently reads this collection to grant anything** — no financial callable, no Rules clause anywhere consults it. The *moment* 5C makes this collection meaningful (by having a trusted callable also write `memberIds` alongside it, and by other code starting to treat its presence as evidence of consent), this currently-open direct-create path becomes a genuine bypass: a client could write a Rules-valid-shaped acceptance record without ever running the trusted transaction, racing it, or diverging from it. **This must be closed in 5C — see §18.**

## 5. Current `memberIds` trust gap — confirmed real

`firestore.rules`' Trip owner update allowlist (`allow update: if tripIsActive() && (isTripMember() || isTripOwner()) && ...`) includes `'memberIds'` in the **owner's** `affectedKeys().hasOnly([...])` list (non-owner members never had it). The only constraint on the new value is `resource.data.ownerId in request.resource.data.memberIds` (the owner must remain included) — there is no check on who else is added or removed. This is independently confirmed by the existing, currently-passing Rules test `"owner: can update memberIds while keeping themselves included"` (`tripDoc(asOwner(), TRIP_ID).update({ memberIds: [OWNER_UID, MEMBER_UID, OUTSIDER_UID] })` → `assertSucceeds`).

**Confirmed: today, a Trip owner can unilaterally add (or remove) any uid to/from `memberIds` with a single direct Firestore write, bypassing invitation, invitee consent, terms acceptance, and the immutable acceptance record entirely.** This is not hypothetical — it is the exact gap `recordSavingsTransaction.ts`'s own existing comment already names for Buckets ("*A Bucket owner can unilaterally add another registered uid to memberIds with no acceptance step, and no trusted Membership/Invitation-acceptance record exists yet to distinguish that from independently-accepted membership — so financial attribution stays self-only until a future group-sharing milestone adds trusted, accepted membership.*") — the same structural gap applies to Trip, and 5C is that future milestone.

**Removal must close at the same time as addition.** Splitting them (e.g. closing add but leaving remove open) would leave an asymmetric side door with no safety benefit — the owner could still silently evict a member, and a future "add back" via the *trusted* path would then re-run full consent for someone the owner just as easily removed without any process. §15 (member removal) resolves this by closing **both** directions of direct `memberIds` mutation in the same Rules change, while explicitly deferring a *trusted* remove workflow to a later checkpoint.

## 6. Financial/read authority inherited from `memberIds` today

Grepping every trusted financial callable (`recordSavingsTransaction`, `recordSharedStashExpense`, `reverseSharedStashExpense`, `recordTripExpense`, `reverseTripExpense`, `recordTripSettlement`, `reverseTripSettlement`) shows **the identical authorization primitive, duplicated verbatim in each file**: `memberIds.includes(uid) || tripData.ownerId === uid`, read fresh from the Trip's current document inside each callable's own transaction — never cached, never consulting any other collection. There is no secondary check anywhere referencing `tripMembershipAcceptances` or `tripInvitations`. **Presence in `trips.memberIds` (or being `ownerId`) is today's entire and complete financial-authorization mechanism**, for every one of these seven callables, and (via `canAccessTripById`'s identical `memberIds`/`ownerId` check) for every Rules-gated read of `tripExpenses`, `tripExpenseSplits`, `tripSettlements`, `savingsTransactions`, and `tripMemberOwnership` as well.

## 7. Recommended financial-membership source of truth — **GO**

**GO: successful trusted acceptance atomically adds the accepting uid to `trips.memberIds`, inside the same transaction that writes the immutable acceptance record and flips the invitation to `accepted`.** `memberIds` remains the single, sole source of truth every existing financial callable and Rules read-path already consults; `tripMembershipAcceptances` is the audit trail proving *how* each non-owner entry got there, never a second authorization source any callable needs to learn to check.

Rejected alternative: a separate "authorized uids" collection/field, consulted *instead of or in addition to* `memberIds`. This would require touching all seven financial callables' authorization checks (to also, or instead, consult the new source), multiplying the surface area for a missed-check regression, for no benefit — `memberIds` already means exactly "who can transact," which is exactly what 5C needs to grant. The smallest design that preserves proven financial behavior, avoids a dual source of truth, stays auditable, prevents owner-side bypass (once §5's gap is closed), and requires zero changes to any of the seven existing callables is: **keep `memberIds` as the authorization set; add to it only through the trusted transaction.**

## 8. Exact `acceptTripInvitation` request/response (frozen)

```ts
// Request
{
  invitationId: string;        // the exact tripInvitations document id the
                                // client already has from its own prior
                                // read (fetchInvitationForTrip /
                                // fetchPendingInvitationsForUser)
  acceptedTermsDocId: string;  // the exact tripTerms document id the client
                                // actually rendered and displayed to the
                                // user before they pressed Accept
}

// Response
{
  tripId: string;
}
```

Why these two fields, and no others:
- **`invitationId`**, not `tripId`: the client already holds this exact value from the read it just performed to display the invitation; deriving it instead from a client-supplied `tripId` would require the backend to recompute the same deterministic formula the client could have just handed over, for no gain, and it avoids ever needing to ask "does this `tripId` even match this `invitationId`" — there is only one input to validate. `tripId` itself is derived server-side from the read invitation document and never accepted as a separate, independently-trusted field.
- **`acceptedTermsDocId`**, not `acceptedTermsVersion`: this is the anti-TOCTOU mechanism (§10) — the client echoes back *what it actually displayed*, as a doc id (unambiguous), and the backend independently re-derives the version number by reading that exact document itself, never trusting a client-supplied version number at all.
- **Never accepted**: `uid`/`ownerId`/`memberIds` (always `request.auth.uid`); `acceptedAt` (always `FieldValue.serverTimestamp()`); `acceptedTermsVersion` (always derived from the read `tripTerms` document, never from the client); `termsDocId` is accepted only as "what was displayed," never trusted as "what is current" until independently re-verified against the live pointer inside the transaction; no financial/ledger/ownership field of any kind.
- **Response is `{tripId}` only**, mirroring `createTrip`'s own minimal-response precedent from this same session — the client already knows every other fact (it was already viewing this invitation/Trip) and should simply re-navigate using the response's `tripId` as a server-validated confirmation, not a new piece of information.

**Strict input-shape rejection, frozen (mirrors `createTrip`'s own exact-allowlist validator):** the backend must reject, with `invalid-argument`, before any Firestore read: a non-object or `null` request body; either field missing; either field an empty string; either field a non-string type; any unknown/extra top-level key present (exact two-key allowlist, not a blocklist); either field failing a basic safe-document-id shape check (non-empty, no path-delimiter/traversal characters, reasonable max length — the same defensive posture already applied to every other id-shaped input in this codebase, e.g. `createBucket.ts`'s `CLIENT_REQUEST_ID_PATTERN`). No `uid`, `ownerId`, `memberIds`, `acceptedAt`, `acceptedTermsVersion`, `termsDocId`-as-authoritative-truth, or any financial/ledger/ownership field is ever accepted as input, under any key name.

## 9. Exact transaction read/write set (frozen) — two-branch replay model

**Revision note (5C.0A hardening): the original draft required `invitation.status === "pending"` as a precondition before ever evaluating the already-accepted/replay case — directly contradicting §11's own replay policy. This is fixed below with an explicit two-branch model: read the invitation and validate its basic shape first, then branch on `invitation.status` before deciding which checks even apply.**

All reads before all writes, one atomic `db.runTransaction`.

**Step 0 — read + corruption checks, both branches, before any branching:**
- `tripInvitations/{invitationId}` must exist
- `invitation.inviterUid` is a non-empty string
- `invitation.inviteeUid` is a non-empty string
- `invitation.tripId` is a non-empty string
- `invitation.expiresAt` is a real Firestore `Timestamp` (not a string, not missing, not any other shape)
- `authUid === invitation.inviteeUid` (the caller IS the invitee — not the owner, not any other member, not a forged uid)
- `trips/{invitation.tripId}` must exist
- `invitation.inviterUid === Trip.ownerId` — proves the invitation was issued by the Trip's *current* authoritative owner; fails closed if Trip ownership has since changed or the invitation's own field is stale/corrupted

**Canonical `memberIds` validation (5C.0B — shared by BOTH branches, moved here from the original Branch-B-only draft):** `trips.memberIds` must be treated as a SET-like authorization list even though Firestore persists it as an array. Before either branch interprets membership state at all:
- `Trip.memberIds` is an array
- every entry is a non-empty string
- every uid in the array is **unique** — a duplicate entry is itself malformed state, never silently deduplicated
- `Trip.ownerId` is a non-empty string
- `Trip.ownerId` appears in `memberIds` **exactly once**

Any failure here fails closed (`failed-precondition`) before status is ever consulted — this check, like every other Step 0 check, applies identically whether the invitation turns out to be in Branch A or Branch B.

Any Step-0 failure rejects closed (`not-found`/`failed-precondition`) before status is ever consulted.

**Branch A — COMPLETED/REPLAY, when `invitation.status === "accepted"`:**

Additional reads: `tripMembershipAcceptances/{tripId}_{authUid}_{acceptedTermsDocId}`; `tripTerms/{acceptedTermsDocId}`.

Checks, all must hold:
- the acceptance record exists at that exact deterministic id
- it is structurally valid and exactly matches: `tripId`, `uid === authUid`, `termsDocId === acceptedTermsDocId`
- its stored `acceptedTermsVersion` agrees with the referenced `tripTerms` document's own `version` field
- `invitation.respondedAt` is a valid Firestore `Timestamp`
- `authUid` is already present in the (already-canonical, per Step 0) `Trip.memberIds` **exactly once**
- the `tripTerms` document the acceptance record names still exists and still agrees with it (`tripId` + `version`)

**If every completed-state invariant matches: return `{tripId}` with ZERO writes.** Any partial/inconsistent match (accepted but no acceptance record; acceptance record but `memberIds` missing the uid; a malformed stored value anywhere in this set) is `failed-precondition`, never repaired.

**Reconfirmed, explicit (5C.0B — restates the 5C.0A decision in full, unchanged in substance):** Branch A **DOES** validate: immutable invitation identity/shape (Step 0); caller == invitee (Step 0); Trip existence (Step 0); canonical, currently-valid `memberIds` (Step 0's shared canonical check); caller currently present in `memberIds` exactly once; the accepted invitation's own state and `respondedAt`; the exact historical acceptance record; and the exact immutable accepted terms document, including that its `version` still matches. Branch A **DOES NOT** re-authorize against: the *current* `tripTermsCurrent` pointer (whether it still names the same `acceptedTermsDocId`); the *current* invitation expiry (`invitation.expiresAt > now` is never re-checked here — only `respondedAt`'s presence/validity matters for a completed record); the Trip's *current* archived state; or the Trip's *current* ownership-model state/version. **Reason:** those four conditions were authorization requirements for the *original* atomic event — they are not conditions for confirming that an already-completed event happened, and must never retroactively invalidate a replay of an acceptance that already, provably, completed. Any partial or mismatched state among the DOES-validate list still fails closed, exactly as before.

**Branch B — NEW ACCEPTANCE, only when `invitation.status === "pending"`:**

Additional reads: `tripTermsCurrent/{tripId}`; `tripTerms/{acceptedTermsDocId}`; `tripMembershipAcceptances/{tripId}_{authUid}_{acceptedTermsDocId}` (must NOT already exist on this branch).

Checks, all fail-closed:
- `invitation.expiresAt > now` (server time, never a client-supplied "now")
- Trip is not archived
- Trip's ownership-model gate: `classifyOwnershipMutationGate(trip.ownershipModelState, trip.ownershipModelVersion).kind === "initialized"` *and* that initialized version equals `CURRENT_TRIP_OWNERSHIP_MODEL_VERSION` (reusing `tripOwnershipModel.ts` verbatim — see §14)
- `authUid` is NOT already present in the (already-canonical, per Step 0) `Trip.memberIds` and is not `Trip.ownerId` — a true inconsistency if reached with a still-`pending` invitation (see §11)
- `tripTermsCurrent` pointer exists and is structurally valid (reusing a shared validator — see §9a)
- `pointer.currentTermsDocId === acceptedTermsDocId` — **the anti-TOCTOU check**: if the pointer has moved on since the client loaded the screen, reject with a specific, distinguishable error (e.g. `"terms_changed"` reason) rather than silently binding to a newer version
- the named `tripTerms` document exists, belongs to this Trip, and its own `version` agrees with the pointer's `currentVersion`
- no acceptance record already exists at the deterministic id

**Writes, atomic, all-or-nothing (Branch B only):**
1. `tripInvitations/{invitationId}.update({ status: "accepted", respondedAt: FieldValue.serverTimestamp() })`
2. `tripMembershipAcceptances/{tripId}_{uid}_{termsDocId}.set({ tripId, uid: authUid, termsDocId: acceptedTermsDocId, acceptedTermsVersion: <derived from the read tripTerms document's own `version`>, acceptedAt: FieldValue.serverTimestamp() })` — exactly the 5 fields the 5A schema already froze; no new field added without justification.
3. `trips/{tripId}.update({ memberIds: [...Trip.memberIds, authUid], lastUpdatedAt: FieldValue.serverTimestamp(), lastUpdatedBy: authUid })` — **the full, explicit canonical array, not `FieldValue.arrayUnion()`** (frozen choice, 5C.0B — see the rationale note immediately below)

**`invitation.status === "declined"` or `"cancelled"`**: rejected closed (`failed-precondition`) — neither branch applies; there is no third path.

No write to `tripMemberOwnership`, `savingsTransactions`, `saved`, or `ledgerBalanceMinor` in either branch.

**Write-method rationale (5C.0B, frozen):** `[...Trip.memberIds, authUid]` is chosen over `FieldValue.arrayUnion(authUid)` because Step 0 has already read and fully validated the exact authoritative pre-write array (unique entries, owner present exactly once) inside this same transaction; Firestore's own transaction-retry semantics already handle any concurrent modification (a concurrent write invalidates the transaction's reads and the whole callback re-runs from scratch, re-validating against fresh state); writing the explicit canonical array makes the post-write state trivially canonical by construction; and `arrayUnion`'s defensive duplicate-avoidance behavior is simply unneeded once duplicates are themselves already treated as corruption that Step 0 would have caught before ever reaching a write.

## 9a. Shared terms-pointer/terms-document validation — reuse decision (frozen architecture, no source change)

Branch B's `tripTermsCurrent`/`tripTerms` validation must never become a second, subtly-different reimplementation of the exact checks `publishTripTermsCore` already performs (pointer shape, pointer-target agreement, `tripId`/`version` cross-checks). **Frozen direction: extract a small, shared, pure validator into the Functions domain layer** (e.g. a new `functions/src/domain/tripTermsPointer.ts`, mirroring how `tripOwnershipModel.ts` already centralizes the ownership-state classifier every financial callable reuses), exposing exactly the pointer-validity and pointer-target-agreement checks `publishTripTermsCore` currently inlines as its own private functions (`assertValidExistingPointer`/`assertPointerTargetValid`). Both `publishTripTermsCore` and the new `acceptTripInvitationCore` import and call this one shared validator; neither ever re-derives its own notion of "is this pointer/terms pair internally consistent." **No behavior change to `publishTripTerms` itself** — this is a pure extraction, not a semantics change. Client-side validation (`fetchCurrentTripTerms`'s own corruption checks) remains advisory/display-only and is never treated as authoritative by the backend — the backend always independently re-derives and re-validates everything itself, exactly as it already does for the ownership-state gate via `tripOwnershipModel.ts`. **No source change is made in this hardening pass** — this is architecture wording only, to be carried out as part of 5C.1's actual implementation.

## 10. Terms-version anti-TOCTOU design (evaluated, GO)

Frozen answer: **acceptance MUST bind to the `tripTermsCurrent` pointer's value at transaction time.** If terms were republished between the invitee loading the screen and pressing Accept, the call must fail, requiring the user to re-review the new version — never silently accept content they never saw. The checkpoint's own suggested design — client echoes back what it displayed (`acceptedTermsDocId`), backend independently re-verifies that value still equals the live pointer before accepting — was evaluated against the alternative (backend always derives "current" itself, ignoring what the client saw) and is the correct one: the alternative would silently bind the user to content they may never have read, which is the exact failure mode a consent-acceptance flow exists to prevent.

The accepted historical record (`tripMembershipAcceptances`) is immutable by Rules (`allow update, delete: if false`) and nothing in this design ever rewrites it — confirmed by construction (the trusted transaction only ever `.set()`s a brand-new document at a deterministic id keyed by the exact `termsDocId` accepted; a later terms version produces a *different* id, never an update to this one).

**Does publishing a later terms version automatically deauthorize existing members? NO.** 5C does not implement, and should not implement, any re-consent lifecycle. Publishing a new `tripTerms` version has zero effect on any already-member uid's standing — `memberIds` membership, once granted, is not conditioned on continuing to hold the single latest terms version. This is an explicit non-goal: the Master Spec/current roadmap gives no requirement for mandatory re-consent-on-change, and inventing one here would be scope creep into a genuinely separate product decision (what should happen to an existing member who hasn't re-accepted new terms — warn them? restrict them? nothing?) that 5C's own instructions explicitly warn against inventing speculatively.

## 11. Idempotency / replay / corruption policy (frozen)

Following this project's own strong, consistent house style (already visible in `migrateTripOwnership.ts`'s `evaluateAlreadyCompleted`, `publishTripTermsCore`'s pointer-corruption guards, and `createTrip.ts`'s replay-hardening): **never silently repair trusted state; fail closed and name the specific inconsistency.** This policy is now fully implemented by §9's two-branch model (Branch A = replay, Branch B = new acceptance) — the table below restates it as a single reference, resolving the contradiction the original draft had (requiring `status === "pending"` before ever considering the already-`"accepted"` case).

| State | Resolution |
|---|---|
| Retry after response lost, transaction actually committed (`status === "accepted"`, acceptance record + `memberIds` entry all consistent) | **Branch A — success, idempotent, zero writes.** |
| `status === "accepted"` but the acceptance record is missing, OR the acceptance record exists but `memberIds` is missing the uid, OR `respondedAt` is malformed | **Branch A — any partial match fails `failed-precondition`, no repair.** Structurally unreachable once §18's Rules closures are in place (the only writer of `status: "accepted"` is this same transaction, which never writes one of the three Branch-B writes without the other two). Reachable today only through the still-open direct-write paths this checkpoint closes — not a reason to add a repair branch. |
| `memberIds` contains uid but invitation still `pending` | **Branch B's own pre-mutation check** — corruption, fails closed, reachable only via §5's owner-direct-`memberIds`-write gap. Never silently treated as "already accepted." |
| `Trip.memberIds` is malformed (not an array, a non-string/empty-string entry, a duplicate uid, missing `ownerId`, or `ownerId` appearing more than once) | **Step 0's shared canonical check (5C.0B) — corruption, fails closed on both branches, never deduplicated or normalized.** Reachable only via §5's owner-direct-write gap, which the Rules closure (§18) removes. |
| "Duplicate" acceptance record (same uid, a *different* `termsDocId`) | Not actually a failure mode — a member legitimately accumulating one `tripMembershipAcceptances` document *per distinct terms version* they've accepted over a Trip's lifetime is the intended 5A design, not corruption. A true duplicate (identical `tripId`/`uid`/`termsDocId` triple) is simply Branch A's replay case. |
| Malformed/corrupt acceptance document encountered during either branch's own id-based read | Corruption — `failed-precondition`, fail closed, never repaired or reinterpreted. |
| `status === "declined"` or `"cancelled"` | Rejected closed — neither branch applies; there is no third path. |

## 12. Acceptance document id / shape / immutability (frozen, unchanged formula)

`{tripId}_{uid}_{termsDocId}` **remains correct** and requires no change. It already correctly supports: one historical acceptance per member per terms version (a new terms version naturally produces a new id, never overwriting an older acceptance); immutability (nothing about the id implies or requires mutability — `allow update, delete: if false` is unconditional and correct as-is); a possible future re-consent record (a later acceptance of a newer version is simply a new document at a new id, requiring zero schema change to support if a re-consent feature is ever built); and deterministic idempotency (a retried request computes the identical id and lands on the identical document, the same pattern this codebase already uses for `tripInvitations`, `tripPersonalBucketId`, and `tripMemberOwnershipId`).

**Frozen: clients can never create, update, or delete acceptance records, in any role.** This requires closing the currently-open direct-create Rule (§4's finding) to `allow create, update, delete: if false;`, matching `tripOwnershipAllocations`/`tripOwnershipMigrationState`'s own posture exactly — the trusted `acceptTripInvitationCore` transaction becomes the sole writer, via the Admin SDK, which bypasses these Rules entirely.

**5C.1 implementation requirement (5C.0B, new): do not hand-build this id with ad hoc string concatenation.** Reuse this repository's established composite-id delimiter/validation convention from `functions/src/domain/tripCompositeId.ts` (`ID_DELIMITER`/`assertNoDelimiter`), the same primitive `tripInvitationId`/`tripMemberOwnershipId` already build on. A new exported helper (e.g. `tripMembershipAcceptanceId(tripId, uid, termsDocId)`) should be added to the appropriate shared domain module, applying `assertNoDelimiter` to all three parts before concatenation. **The final id remains exactly `{tripId}_{uid}_{termsDocId}`** — this does not change the frozen schema; it only prevents 5C.1 from inventing a second, independent identifier-construction convention that could drift from the one the rest of the codebase already uses. Malformed inputs or delimiter violations fail closed (an `HttpsError`, per the existing helpers' own behavior), never silently sanitized.

## 13. Ownership-model interaction (frozen)

**Recommend Option A: the new member's `tripMemberOwnership` row remains absent until their first contribution, relying entirely on 5B.3C's already-proven lazy-initialization path.** This is the same decision already made for native Trip creation itself in 5B.5A ("no `tripMemberOwnership` row at creation — `sum(empty set) == 0`"), and 5B.3C's missing-row-plus-contribution path (already implemented, tested, and production-verified earlier in this session) was *designed* for exactly this "a current, authorized member has simply never personally transacted yet" case. Option B (explicitly writing a `ownershipMinor: 0` row at acceptance time) is rejected per the checkpoint's own stated preference: it would be unnecessary state, created purely for convenience, with zero safety or product benefit, and an extra write inside an already-nontrivial transaction for no reason.

Confirmed, by tracing the existing (unmodified) code paths, not by assumption:
- **New member's first contribution works**: `recordSavingsTransactionCore`'s existing missing-row-plus-contribution branch (5B.3C.1) treats an empty existing-ownership-row set as reconciling trivially against the Trip's current aggregate (`balances.length === 0 ? currentBalanceMinor === 0 : ...`) — unmodified by 5C, needs no new code.
- **Immediate withdrawal before contribution fails**: the existing missing-row-plus-withdrawal branch unconditionally rejects (`"This withdrawal exceeds your own Shared Stash ownership."`) and never lazily creates a row for a withdrawal — unmodified by 5C.
- **Pooled spending never assigns negative ownership**: the existing proportional-depletion/largest-remainder allocation math (5B) already enforces non-negative results by construction; 5C writes nothing to `tripMemberOwnership` or `tripOwnershipAllocations` at all.
- **Existing members' ownership sum is unaffected by membership acceptance**: the acceptance transaction's write set (§9) touches only `tripInvitations`, `tripMembershipAcceptances`, and `trips.memberIds`/`lastUpdatedAt`/`lastUpdatedBy` — never `tripMemberOwnership`, `savingsTransactions`, `saved`, or `ledgerBalanceMinor`.

## 14. Ownership-model-state gate (frozen, GO)

**5C financial membership is permitted ONLY when `ownershipModelState == "initialized"` AND `ownershipModelVersion == CURRENT_TRIP_OWNERSHIP_MODEL_VERSION`.** Every other state — `legacy`, `migrating`, `needs_reconciliation`, or an unrecognized/corrupt version — fails closed. This reuses `classifyOwnershipMutationGate`/`classifyTripOwnershipModelState` from `functions/src/domain/tripOwnershipModel.ts` **verbatim**, never a parallel reimplementation.

Why: a `legacy` Trip has no per-member ownership tracking at all yet — granting a second financially-authorized member there would introduce multi-member access to a Trip whose accounting model cannot even attribute ownership per member, defeating 5B's entire purpose. A `migrating` Trip is financial-write-quiescent by design; membership grants are new activity and must be blocked exactly like every other new-activity gate 5B already enforces. A `needs_reconciliation` Trip's ownership rows are provably inconsistent with its aggregate — adding a member whose future contributions would be measured against an already-broken accounting base is actively unsafe, not merely cautious. This is the identical reasoning every one of 5B's financial callables already applies via the same classifier's `"blocked"`/`"fail_closed"` outcomes; 5C's join-gate is that same gate, reused.

## 15. Member-removal decision (frozen)

**5C closes ALL direct client `memberIds` mutations — both addition and removal — in the same Rules change (§18), implements trusted ADD-only via `acceptTripInvitationCore`, and explicitly defers a trusted remove-member workflow to a later, dedicated checkpoint.** Member removal has genuinely unresolved financial-obligation semantics (what happens to a removed member's existing positive ownership balance — forfeited to the pool? refunded? held?) that must not be improvised as a side effect of a join-only checkpoint. Until that future checkpoint exists, Trip membership is monotonic: a Trip can only gain members via accepted invitation, never lose one, through any role, including the owner. This is a deliberate, acknowledged product limitation for 5C's scope, not an oversight — no legitimate removal need exists yet for a feature (group sharing) that has not shipped its first join path at all.

## 15a. Legacy membership provenance policy (new, frozen)

5C makes trusted acceptance the ONLY way to add a future non-owner member. It cannot retroactively prove anything about non-owner uids that may already exist in production `trips.memberIds` today — the old Rules permitted direct owner writes to `memberIds` (§5), and historical/manual/admin behavior cannot be disproven from repository source alone.

**Frozen policy:**
- 5C MUST NOT fabricate a historical `tripMembershipAcceptances` record for any pre-existing non-owner member.
- 5C MUST NOT claim or imply a legacy member accepted any terms when no such proof exists.
- 5C MUST NOT automatically remove or deauthorize an existing non-owner member merely because no acceptance document exists for them.
- `trips.memberIds` remains runtime authority for any pre-existing member, unconditionally — their standing is not retroactively revoked by 5C landing.
- The immutable `tripMembershipAcceptances` record proves provenance only for members who join through the 5C-era trusted path going forward; its *absence* for a pre-existing member proves nothing one way or the other about how they came to be a member, and must not be interpreted as either "consented" or "unauthorized."
- Legacy membership provenance (if any non-owner members exist in production today), where it exists at all, must remain explicitly distinguishable from 5C-era, acceptance-evidenced membership — never silently merged into "looks the same as everyone else."

**Required future production pre-deploy audit (5C.5, read-only, design only — not performed now):** before 5C.5's Rules closure deploys, inventory (read-only, zero mutation): every Trip whose `memberIds` contains a non-owner uid; every `accepted` `tripInvitations` record; every `tripMembershipAcceptances` record; cross-reference to identify any pre-existing non-owner membership lacking acceptance provenance. **Do not mutate or "repair" anything found.** If any such ungrounded membership exists, STOP and decide an explicit grandfathering/migration policy (e.g. a one-time, clearly-labeled "legacy membership, predates trusted acceptance" marker, decided deliberately) before proceeding — this preflight does not know, and cannot know from source alone, whether production currently contains any such case.

## 16. Privacy/read transition before vs. after acceptance (frozen — Option B, 5C.0B final decision)

**Revision note (5C.0B — supersedes 5C.0A's Option-A recommendation):** 5C.0A correctly identified that `hasTripInvitationRecord()` is status-agnostic (`exists()` only, no status filter), but recommended *preserving* that breadth. **This is reversed: 5C freezes the tighter Option B.** Pre-acceptance Trip-terms access must exist only while the caller holds a **currently actionable** invitation — not merely any historical one.

**Frozen 5C.2 design:**
- Pre-acceptance terms access requires: an invitation exists for `(tripId, authUid)`; `status == "pending"`; `expiresAt > request.time`.
- The instant an invitation becomes `declined`, `cancelled`, or expires while still `pending`, the invitee loses invitation-derived access to `tripTerms`/`tripTermsCurrent` — the immutable invitation *document* itself may remain readable by its named invitee under the existing, unchanged invitation-record read policy (§2); this decision concerns **terms-collection** access specifically, not the invitation record's own readability.
- After successful acceptance, terms access continues through ordinary Trip membership (`canAccessTripById(tripId)`), never through the invitation relationship. **5C must not rely on `invitation.status == "accepted"` for post-join terms access** — `memberIds` is the sole authoritative membership source once joined, exactly as frozen in §7.
- Conceptually, the eventual `tripTerms`/`tripTermsCurrent` read Rule becomes: `canAccessTripById(tripId) || (signedIn() && pending-and-unexpired named invitee for tripId)`. This requires a **new, narrower Rules helper** — distinct from both `hasTripInvitationRecord()` (any status, used elsewhere, left unchanged for the invitation record's own read rule) and `hasActionableTripInvitationRecord()` (pending-unexpired OR accepted, currently used *only* by `tripMembershipAcceptances`' soon-to-close create rule — see §18's note below). The new helper checks exactly `status == 'pending' && expiresAt > request.time`, nothing broader.

**Reasoning (frozen):** pre-join terms access exists solely to support informed consent before a decision is made; once an invitation is revoked, declined, or has expired, that purpose has concluded. A declined or cancelled invitee should not retain indefinite visibility into *future* terms revisions merely because the immutable invitation document persists. Trip financial collections remain exactly as `memberIds`-gated as before, independent of this change. No current UI depends on the broader behavior (confirmed: zero UI exists at all — §2/§19), so 5C.2 is the correct, cost-free time to close it rather than carrying forward an unexamined default.

**After acceptance**: unchanged in substance — the instant `acceptTripInvitationCore` adds the uid to `memberIds`, every `canAccessTripById`-gated Rules clause (including the now-tightened `tripTerms`/`tripTermsCurrent` rule above) grants exactly the same current-member access every other member already has, because all of them re-read `trips.memberIds` fresh on every access. This remains the direct, free consequence of choosing `memberIds` as the sole source of truth (§7) — the only change from the original draft is that the *pre*-acceptance half of the rule is now narrower (§18).

## 17. Expiry/decline/cancel scope (frozen)

5C must implement: re-enforcing "expired invitations never become accepted" **inside the new trusted callable itself**, independently of Rules (`invitation.expiresAt > now`, server time) — once the direct-accept Rules path closes, Rules alone no longer protects this, so the callable must own the check completely. 5C must preserve, unchanged: decline (invitee, `pending → declined`, any expiry) and owner cancellation (`pending → cancelled`, any expiry) — both remain direct client writes exactly as today, since neither ever grants anything, only narrows. Reinvite-after-decline/cancel remains explicitly out of scope — 5A's frozen design already has no such path, and 5C should not add one.

**New consequence of §16's Option-B decision**: each of decline, cancellation, and expiry now has an additional, immediate effect beyond the invitation's own status — it also **terminates that invitee's terms-read access** (§16/§18), since the narrowed `tripTerms`/`tripTermsCurrent` read Rule depends on `status == "pending" && expiresAt > now`, which stops holding the instant any of these three transitions occurs. No new code path is required for this — it falls out automatically from the Rules condition itself re-evaluating on the invitee's next read attempt.

## 18. Required Rules changes (frozen list — design only, not implemented)

1. **Trip update (`match /trips/{tripId}`)**: remove `'memberIds'` from the **owner's** update `affectedKeys().hasOnly([...])` allowlist entirely. (The non-owner allowlist never included it — no change needed there.)
2. **`tripMembershipAcceptances`**: change `allow create` from its current direct-client-write expression to `allow create, update, delete: if false;` — trusted-callable-only, matching `tripOwnershipAllocations`/`tripOwnershipMigrationState`'s posture. **(This is a correction to the checkpoint's "inert scaffolding" framing — see §4; this path is live today and must close.)**
3. **`tripInvitations`**: change the invitee's `pending+unexpired → accepted` `allow update` clause to `if false;` — accept becomes trusted-callable-only. The decline and owner-cancellation `allow update` clauses are **unchanged**.
4. **Pre-acceptance invitation record reads** (`tripInvitations.allow get,list`): **unchanged** — a named invitee's own invitation document remains readable under its existing policy regardless of status (§2), confirmed already correctly scoped.
5. **Pre-acceptance terms reads — NARROWED (5C.0B, supersedes 5C.0A's "unchanged")**: `tripTerms`/`tripTermsCurrent`'s `allow get, list`/`allow get` clauses change from `hasTripInvitationRecord(tripId)` (any invitation status) to a new, narrower condition — `signedIn() && exists(.../tripInvitations/{tripId}_{auth.uid}) && that record's status == 'pending' && that record's expiresAt > request.time` (effectively a new helper, e.g. `hasPendingUnexpiredTripInvitation(tripId)`, distinct from `hasTripInvitationRecord`). This is the §16 Option-B decision — pre-join terms access ends the instant an invitation is declined, cancelled, or expires.
6. **`hasActionableTripInvitationRecord()` becomes dead code once this checkpoint lands** — today it is used *exclusively* by `tripMembershipAcceptances`' direct-create rule (item 2 above, being closed to `if false`). Once that create rule closes, nothing in `firestore.rules` calls `hasActionableTripInvitationRecord()` any longer; 5C.2 should remove it rather than leave an unused helper behind.
7. Existing accepted-member reads (every `canAccessTripById`-gated collection): **unchanged** — the `memberIds`-as-source-of-truth design means acceptance grants this automatically, with no Rules edit at all.

Admin SDK trusted callables bypass all of the above by construction, as with every other trusted write path in this file.

## 19. Required client/UI changes (design only)

Confirmed by repo-wide search: **zero existing UI wires any of this today** — there is no invitation list screen, no terms-review screen, no accept/decline action anywhere in `app/`. 5C's client work is therefore new construction, not a retrofit:

1. **Replace, in place, the existing direct-write `acceptTripInvitation` function** in `src/services/firebase/tripInvitations.ts` with a trusted-callable wrapper of the identical name (`httpsCallable(functions, "acceptTripInvitation")`), mirroring exactly how `createTrip`'s own direct-write function was swapped for a trusted-callable function of the same name during 5B.5B in this same session — not left alongside it under a different name, which would leave a confusing, easily-misused duplicate.
2. New invitation-review screen: reads the pending invitation (`fetchInvitationForTrip`, exists) and the Trip's current terms (`fetchCurrentTripTerms`, exists), displays the terms content, and requires an explicit affirmative Accept action (never a pre-checked default).
3. On Accept: calls the new trusted wrapper with `{invitationId, acceptedTermsDocId}` (the exact doc id the screen is currently displaying), validates the response shape (`{tripId}` only, mirroring `createTrip`'s own response-validation convention), and on success `router.replace`s into the Trip using the response's `tripId`.
4. Decline: a separate, smaller action using the existing, unmodified `declineTripInvitation` direct write — recommend bundling into the same screen/checkpoint (5C.3) as a secondary action, since it introduces zero new trust surface and is the natural pairing, rather than a separate substep (a judgment call the user may override).
5. Surfacing pending invitations to a signed-in user (e.g. on Home or a Trips list) using the existing, unmodified `fetchPendingInvitationsForUser`.

## 19a. Invitation-review UX gap (new, flagged for 5C.3 — not solved here)

A pending invitee correctly cannot read `trips/{tripId}` before acceptance, since that root document carries financial state (`ledgerBalanceMinor`, `saved`, etc.) no non-member should see. But `tripInvitations` itself carries no Trip context at all today — no title, location, dates, or image — so an invitee reviewing an invitation has nothing to look at except raw invitation metadata (`inviterUid`, `inviteeEmail`, dates). **5C.3 must explicitly decide how the invitation-review screen obtains safe, non-financial Trip context without granting pre-member access to the full Trip document.** Candidate directions to evaluate at that checkpoint (neither chosen nor implemented here): (a) a trusted, read-only invitation-preview callable that reads the Trip server-side and returns only a safe, non-financial subset; (b) denormalizing a carefully-chosen, explicitly-safe snapshot (title/location/dates/image only — never any financial field) onto the `tripInvitations` document itself at `createTripInvitation` time. **Do not weaken `trips/{tripId}`'s read Rules for UI convenience under any circumstance** — whichever direction 5C.3 picks, the Trip's own financial-bearing root document must remain exactly as gated as it is today for a non-member.

## 20. Exhaustive test matrix (frozen, adopting the checkpoint's own structure with corrections)

The checkpoint's own §R structure (AUTH/IDENTITY, INVITATION, TERMS, TRIP STATE, ATOMIC RESULT, IDEMPOTENCY/CORRUPTION, RULES, FINANCIAL E2E/EMULATOR) is adopted as the frozen matrix for 5C.1/5C.2/5C.4, with these corrections/additions this audit surfaced:

- **RULES**: add explicit tests that the **old direct-accept Firestore Rules path** (`tripInvitations` invitee `pending → accepted` update) is closed (`assertFails`), and that the **`tripMembershipAcceptances` direct-create path** (currently open today) is closed (`assertFails` even with a perfectly Rules-shaped payload) — both are real, currently-passing-today behaviors this checkpoint must prove are gone, not merely untested gaps.
- **TRIP STATE**: explicitly test the ownership-gate using the real `classifyOwnershipMutationGate` outcomes (`"blocked"` for migrating/needs_reconciliation, `"fail_closed"` for corrupt/unsupported-version, `"legacy"` for pre-migration, `"initialized"` for the only accepted case) rather than ad hoc state strings, to keep the test and the production gate using the identical classifier.
- **IDEMPOTENCY/CORRUPTION**: explicitly test each row of §11's table, including the "memberIds contains uid but invitation still pending" state reachable only via the (now-closed, but worth regression-testing) owner-direct-write gap.
- **ATOMIC RESULT**: explicitly assert `lastUpdatedAt`/`lastUpdatedBy` are set on the Trip by the transaction (per §9's write set) and that no `tripMemberOwnership` document of any kind exists after acceptance (proving §13's "absent until first contribution" decision).
- **FINANCIAL E2E/EMULATOR — realistic multi-member case (new)**: a Trip where the owner already has a *positive* `tripMemberOwnership` row (not a brand-new $0 Trip); a newly-accepted member has no row at all; the new member makes their first contribution; the existing ownership rows' sum exactly equals the pre-contribution aggregate (proving the lazy-row-initialization reconciliation check — §13 — passes against a *non-trivial* existing set, not merely an empty one); the new member receives ownership equal to only their own new contribution; the owner's pre-existing ownership is unchanged by the join itself (it may only ever change later, through a legitimate subsequent pooled-spend allocation, never as a side effect of the acceptance transaction). This proves 5B.3C's lazy-initialization path works for the realistic case 5C actually introduces — an existing Trip with real history gaining a second member — not merely a brand-new, never-contributed-to Trip.
- **MEMBERSHIP CANONICALITY (new, 5C.0B)**: duplicate `memberIds` entries → reject; an empty-string uid in `memberIds` → reject; a non-string `memberIds` entry → reject; `ownerId` absent from `memberIds` → reject; `ownerId` duplicated within `memberIds` → reject; Branch A (completed replay) encountering malformed `memberIds` → reject; Branch A encountering the invitee genuinely absent from `memberIds` → reject; Branch B (new acceptance) encountering the invitee already present in `memberIds` → reject.
- **TERMS PRIVACY (new, 5C.0B — proving §16's Option-B closure)**: a pending, unexpired invitee can read the Trip's current terms; an *expired* pending invitee cannot; a *declined* invitee cannot; a *cancelled* invitee cannot; a current accepted member can read terms through ordinary `canAccessTripById` membership (never through the invitation relationship); an outsider with no invitation relationship at all cannot.

Everything else in the checkpoint's own §R (unauthenticated/wrong-invitee/owner-cannot-accept-for-invitee; missing/wrong-Trip/expired/non-pending/malformed invitation; missing/malformed pointer/terms, version/Trip mismatch, stale-displayed-terms-rejects/exact-match-succeeds; archived/legacy/migrating/needs_reconciliation/unknown-version rejects, initialized succeeds; exact retry after commit, partial/inconsistent fail-closed, concurrent accepts, concurrent terms republish, concurrent archive; owner-can-no-longer-add/remove memberIds, exact native payload cannot bypass, client cannot forge acceptance, pending invitee scoped reads, accepted member normal access; post-acceptance first-contribution/withdrawal-ceiling/pooled-spend/other-members-unaffected/existing-owner-still-works) is adopted as written and frozen.

## 21. Proposed 5C sub-checkpoints (frozen sequence)

1. **5C.0** — this architecture preflight.
2. **5C.1** — trusted `acceptTripInvitation`/`acceptTripInvitationCore` backend + comprehensive core tests against the emulator. **No Rules change yet** — the old direct-write accept/tripMembershipAcceptances-create paths remain technically reachable during this checkpoint, but nothing in the new backend relies on them.
3. **5C.2** — Rules closure: owner `memberIds` removal from the update allowlist, `tripMembershipAcceptances` create-closure, `tripInvitations` accept-closure, plus the corresponding updated/new Rules tests. Sequenced *after* 5C.1 so the trusted replacement exists and is fully tested before the old paths close — mirroring this session's own proven 5B.5A→5B.5B→5B.5D ordering discipline (build the trusted path, prove it, only then close the old one).
4. **5C.3** — client service swap + invitation/terms review UI + Accept/Decline actions.
5. **5C.4** — multi-member financial emulator E2E (second member's first contribution, withdrawal ceiling, pooled-spend interaction, existing-owner/member unaffected) — emulator only, never production.
6. **5C.5** — controlled production deployment/verification, using the **corrected** rollout order in §22 below (this ordering was wrong in the original draft of this preflight — see the revision note there).

## 22. Deployment sequence (corrected — 5C.0A hardening)

**Revision note: the original draft of this preflight had the production rollout order wrong** — it placed Rules deployment *before* "ship client," which would close the old direct-write accept path in production before any client existed that could use the new trusted callable, breaking every in-flight app version with no working replacement. The actual safe order, proven in this session's own real 5B.5A→5B.5B→5B.5D production rollout (backend deployed first while Rules stayed open; client cut over next; Rules closed only *after* the client was already using the trusted path), is:

1. Deploy the trusted `acceptTripInvitation` backend to production (Functions only).
2. Verify the deployed callable exists, read-only (`firebase functions:list`), matching 5B.5A's own verification pattern.
3. Ship/cut the client over to call the trusted callable (commit + whatever client release process applies).
4. Verify the shipped client is actually using the callable path (code-level confirmation, matching 5B.5B's own source-authority check convention — no direct-write Trip/invitation-create path remains in the client).
5. **Only then** deploy the Rules closure that removes the old direct-write paths (owner `memberIds` update, `tripMembershipAcceptances` create, `tripInvitations` accept-update).
6. Verify the active deployed Rules read-only (matching 5B.5D's own Firebase Rules REST API verification method).
7. Controlled second-account production membership verification (§23) — invitation + acceptance only, no financial mutation.

**Do not deploy the Rules closure before the client cutover (steps 3-4) unless there is an explicitly documented reason to do otherwise.** No production financial contribution, withdrawal, or expense testing occurs at any step.

## 23. Production-verification plan (design only — not executed)

**Correction to this preflight's own earlier wording**: the original draft claimed a second real test account "does not currently exist." Repository inspection cannot prove or disprove that. **Corrected statement: 5C.5 requires access to a second real test account. Whether a suitable second account already exists must be determined at that future gate** — not assumed either way here. This preflight does not create or check for one now.

Production verification (5C.5, future, separately authorized, following §22's corrected order) should prove, with minimal mutation: a real invitation is sent to the second account; the second account can see it with the correct, current terms; accepting it results in `memberIds` gaining the second uid, a matching immutable acceptance record, and the invitation flipping to `accepted`; the Trip's financial state remains untouched (`$0`/zero-ledger if a dedicated verification Trip is used, mirroring 5B.5C's own `$0` verification-Trip discipline). **What must stay emulator-only, never production**: the second member's actual contribution, withdrawal, and pooled-spend interaction — exercising real financial mutation merely to prove a code path works is exactly what every prior production-verification step in this session has refused to do, and 5C should not be the first exception. Do not create a second account, send an invitation, or add money now — all deferred to a future, separately-authorized 5C.5.

## 24. Identified risks / unresolved decisions — final architecture status (5C.0B)

**BLOCKING architecture decisions** (all now resolved by this preflight; none remain open):
- The replay-ordering contradiction (original §9) — resolved by the two-branch model (5C.0A).
- The production rollout order (original §22) — resolved, corrected to backend→client→Rules (5C.0A).
- The `tripMembershipAcceptances` live-direct-create gap (§4) — identified and accounted for in §18's Rules-closure list (5C.0A).
- The `memberIds` canonical-validation requirement and its write method — resolved: shared Step-0 validation across both branches, full canonical-array write (5C.0B, this pass).
- The terms-read privacy scope — resolved: Option B frozen (§16, this pass), no longer an open judgment call.
- The composite-id construction convention for the acceptance id — resolved: reuse `tripCompositeId.ts` (§12, this pass).
- **None of these remain unresolved. Nothing on this list blocks starting 5C.1.**

**DEFERRED, non-blocking product/UI decisions** (acceptable to remain open — they do not affect 5C.1's correctness):
- **Legacy membership provenance** (§15a): whether production currently contains any non-owner `memberIds` entry lacking acceptance provenance is unknown until the read-only audit is actually performed, at the future 5C.5 gate — not a 5C.1 blocker, since 5C.1 only concerns the backend code path for *new* acceptances going forward.
- **Member removal**: a real, acknowledged, explicitly out-of-scope product gap, deferred to a dedicated future checkpoint (§15) — does not affect 5C.1's join-only correctness.
- **Invitation-preview UI mechanism** (§19a): how 5C.3's review screen safely obtains non-financial Trip context is unresolved, deferred to that checkpoint — purely a client/UI concern, no bearing on the backend.
- **Decline UI placement**: whether Decline ships bundled with Accept in 5C.3 or as a separate substep — a reversible UI sequencing choice, no bearing on 5C.1.
- **Composite index needs**: whether 5C.3's actual query shapes require a new Firestore index — unknown until that checkpoint designs its exact queries, no bearing on 5C.1.
- **Client function naming**: recommended (replace `acceptTripInvitation` in place) but not yet implemented — a 5C.3 concern, not a 5C.1 blocker.

## 25. Final recommendation

```
GO for freezing 5C.0 and proceeding to 5C.1 (trusted backend).

No BLOCKING architecture decision remains open (see §24). 5C.1 must
implement: the two-branch replay model (§9), Step 0's shared canonical
memberIds validation (§9), the full-canonical-array write method (§9),
the shared terms-pointer validator extraction (§9a), the reused
tripCompositeId.ts convention for the acceptance id (§12), and the
Option-B terms-read narrowing's backend-side expiry re-check (§16/§17,
primarily a 5C.2 Rules concern but the callable must also independently
enforce expiry per §17). Every other open item (§24, DEFERRED list) is
a later-checkpoint product/UI decision with no bearing on 5C.1's
correctness.
```

Across both hardening passes, this preflight found and fixed: one genuine internal contradiction (the replay-ordering bug in the original §9), one incorrect production-rollout-order claim (Rules-before-client in the original §22), two framing inaccuracies (§4's `tripMembershipAcceptances` create being live, not inert; §16/§17's `hasTripInvitationRecord` being status-agnostic, not pending-only), one reversed design decision (§16, Option A → Option B), one strengthened shared invariant (§9's canonical `memberIds` validation, now shared across both branches rather than Branch-B-only, with a frozen write-method choice), and one implementation-convention requirement (§12, reuse `tripCompositeId.ts`). None of these change the overall recommendation.
