# Trip Permissions — Architecture Reference

Status: current, frozen (Checkpoint 6.6; extended by Checkpoint 6.7A for
the social expense-balance aggregate, by Checkpoint 6.7B1 for trusted
membership departure — see that section's own explicit
production-readiness caveat below — and by Milestone 6.8 for membership
activity history, IMPLEMENTED IN BRANCH ONLY as of 6.8D; see that
section's own explicit not-yet-deployed caveat).

This document is the source of truth for SquadStash's Trip organizational
role model and the permission matrix it governs. It reflects verified
behavior read directly from `firestore.rules` and the trusted Cloud
Functions in `functions/src/callables/` as of Checkpoint 6.6 (plus the
6.7A/6.7B1 additions below) — it is not a design proposal.

## Membership authority

Trip membership is determined **only** from the Trip document itself:

```text
Trip.ownerId
Trip.memberIds
```

The owner is always also present in `memberIds` (enforced at Trip
creation and re-validated on every invitation acceptance). No other
collection is ever consulted to answer "is this uid a current member of
this Trip," and none of the following is membership authority:

```text
tripInvitations            — an invitation record, not membership
tripMembershipAcceptances  — historical proof of HOW someone joined, not WHO currently is a member
tripMemberOwnership        — financial ownership accounting, not organizational role
```

`Trip.ownerId` is established once, at Trip creation, and is immutable
thereafter (Firestore Rules reject any write that changes it, for every
role, including the owner). Checkpoint 6.7B1 added a trusted *backend*
departure path (see "Member departure" below) — membership is no longer
strictly monotonic at the backend level, though no UI exposes this yet.

## Organizational roles

Exactly two roles exist:

```text
Owner   — the single uid in Trip.ownerId
Member  — any uid in Trip.memberIds (which always includes the owner)
```

No Admin, Organizer, Treasurer, Viewer, or Co-owner role exists. This was
evaluated and deliberately rejected during the Checkpoint 6.6 preflight —
no concrete, current product requirement survived scrutiny for a third
role, and the existing financial authorization model (below) is already
more precise than a role system would naturally express.

## Current permission matrix (organizational)

| Action | Who |
|---|---|
| View Trip | Owner + Member |
| Edit title/location/image | Owner + Member |
| Edit target/dates | Owner only |
| Archive Trip | Owner only |
| Delete Trip | Nobody (Trips are never hard-deletable) |
| View members | Owner + Member |
| Invite members | Owner only |
| Cancel invitations | Owner only |
| Publish Trip Terms | Owner only |
| View Trip Terms | Owner + Member (and a pending, unexpired invitee, pre-join) |

## Financial authorization (kept separate from organizational role)

Financial authorization is **not** derived from Owner/Member status. It
is independent, per-transaction-type logic, keyed to the identity the
transaction actually concerns (self, any member, the original creator,
or the named recipient) — never to organizational role. The Owner has no
general financial authority merely by being Owner.

| Action | Who |
|---|---|
| Contribute personal savings | Self only |
| Withdraw owned funds | Self only |
| Spend Shared Stash | Any current member |
| Record expense | Any current member (may record one paid by another member) |
| Reverse expense | Owner OR the expense's original creator, if still a current member |
| Record settlement | Recipient (`toUid`) only — the owner has no override |
| Reverse settlement | Recipient (`toUid`) only — narrower than expense reversal; the owner has no override at all |
| View balances / financial activity | Current members |

Do not read this table as implying the Owner has universal financial
authority — it does not. The Owner's only financial-adjacent privilege is
the creator-or-owner expense-reversal rule, which is a narrow, explicit
exception documented in `reverseTripExpense.ts`/
`reverseSharedStashExpense.ts`, not a general pattern.

## Social expense/settlement balances (Checkpoint 6.7A)

A Trip's **social** expense/settlement net position (who currently owes
whom, from ordinary member-to-member expenses and settlements) is a
wholly separate system from the Shared-Stash ownership cache described
above:

```text
tripMemberOwnership   — custodial Shared-Stash ownership (who owns what
                         share of the Trip's pooled Shared Stash fund)
tripExpenseBalances   — social net position (who owes whom from ordinary
                         member expenses/settlements) — Checkpoint 6.7A
```

`tripExpenseBalances` is a backend-authoritative aggregate, maintained
transactionally by `recordTripExpense`, `reverseTripExpense`,
`recordTripSettlement`, and `reverseTripSettlement` as each financial
event commits. It exists specifically to give a future member-departure
feature a bounded, race-safe source of truth for "does this member have
an outstanding social balance" — it is not itself a UI-facing balance
display. The existing client-side balance computation
(`src/hooks/useTripBalances.ts` / `computeTripBalances`) remains the
UI's own display/informational mechanism, derived live from Expense/
Split/Settlement history, and is unaffected by this aggregate's
existence.

Like the Shared-Stash ownership model, this aggregate has its own
independent two-field lifecycle marker — `Trip.expenseBalanceModelState`
/ `expenseBalanceModelVersion` (absent, or one of `"legacy"` /
`"migrating"` / `"initialized"` / `"needs_reconciliation"`) — never
merged with `ownershipModelState`/`ownershipModelVersion`, which track
the unrelated Shared-Stash system. A Trip created from Checkpoint 6.7A
onward starts already `"initialized"`; a pre-existing Trip remains
`"legacy"` (no aggregate maintained for it) until a future, explicitly
authorized migration runs.

Checkpoint 6.7A shipped this aggregate's foundation and lifecycle ahead
of any way to leave or remove a Trip member, specifically so the
departure feature below could be built on a bounded, race-safe source
of truth rather than a live history scan. It also shipped a forward-
looking safety rule, ahead of departure existing at all:
`reverseTripExpense` and `reverseTripSettlement` both refuse to reverse
a historical record once any named party to it (payer, split
participant, settlement `fromUid`/`toUid`) is no longer a current Trip
member. Checkpoint 6.7B1 (below) is what makes this rule reachable for
the first time — a departed member's historical expenses and
settlements become permanently unreversible rather than reopening that
member's balance after they have left.

## Member departure (Checkpoint 6.7B1 backend + 6.7C client UI)

**Production-readiness note:** the trusted backend logic described in
this section (6.7B1) is now exposed end to end through a client UI
(Checkpoint 6.7C) — a "Leave trip" action for a non-owner current
member, and a per-row "Remove" action on `TripMembersSection` for the
owner. Both go exclusively through the trusted `leaveTrip`/
`removeTripMember` callables via `src/services/firebase/trips.ts`'s own
thin wrappers; neither the client service layer nor either confirmation
dialog (`components/trips/LeaveTripDialog.tsx`,
`components/trips/RemoveTripMemberDialog.tsx`) mutates `memberIds`
directly, reads/writes `tripMembershipDepartures`, or treats any
client-side financial value as authorization — the backend remains the
sole authority for whether a departure succeeds. Checkpoint 6.7B2 —
originally planned as a former-member residual Shared-Stash recovery
feature — was evaluated and closed as unnecessary; see "Former-member
residual recovery (6.7B2) was closed as unnecessary" below for why no
further backend work was needed before 6.7C.

### Who can leave/remove, and the Owner's own status

```text
leaveTrip({tripId})                     — a non-owner current member leaves
removeTripMember({tripId, targetUid})   — the Owner removes a non-owner current member
```

- A non-owner current member may leave a Trip themselves.
- Only the Trip Owner may remove another member; an ordinary member has
  no removal authority over anyone, including themselves (they use
  `leaveTrip` instead).
- **The Owner can never leave and can never be removed** — there is no
  ownership transfer in 6.7, so a Trip would otherwise be left without
  an owner. This is not deferred or partial; it is a frozen, permanent
  rule for this checkpoint's scope.
- Both operations derive every fact (actor, target, Trip state) from
  `request.auth.uid` and trusted Firestore state — `ownerId`,
  `memberIds`, financial balances, and the departure actor/timestamp
  are never accepted as client input.

### Both financial positions must be exactly zero before departure

Departure (leave or remove) requires ALL of the following, verified
inside the same Firestore transaction that mutates membership:

- `Trip.ownershipModelState` and `Trip.expenseBalanceModelState` are
  both `"initialized"` at their currently-supported version — `"legacy"`,
  `"migrating"`, `"needs_reconciliation"`, and corrupt/unsupported-version
  states all block departure. Neither system is auto-migrated or
  repaired by departure.
- The Trip's own trusted ledger (`ledgerOpeningBalanceMinor`/
  `ledgerBalanceMinor`) is itself already validly initialized.
- The departing member's Shared-Stash ownership is proven exactly zero —
  but never by reading their own cache row in isolation. The COMPLETE
  `tripMemberOwnership` set for the Trip is read, shape-validated, and
  reconciled against the trusted ledger total first; only once the
  complete set is proven consistent is a missing/absent row for the
  departing member trusted to mean zero. Any drift blocks departure
  outright, with no repair attempted.
- The departing member's social expense/settlement position
  (`tripExpenseBalances`) is proven exactly zero under the identical
  discipline — the complete aggregate set must sum to exactly zero
  before a missing row for the departing member is trusted as zero.
  Both a positive and a negative position block departure identically;
  the sign is never distinguished, and this applies equally whether the
  member is leaving voluntarily or being removed — the Owner can never
  seize or redistribute a departing member's funds or position merely
  by removing them.

This "full aggregate set must independently reconcile before trusting
an absence as zero" discipline exists specifically so a cache row
deleted out-of-band (whether by bug or tampering) can never be
mistaken for a legitimately-zero position.

### Archive state does not gate departure

Leaving/removing is allowed on an archived Trip, exactly like expense
reversal and settlement — departure is a wind-down operation, not new
Trip activity.

### Departure evidence is immutable audit history, never membership authority

`tripMembershipDepartures/{tripId}_{uid}` records that a specific uid
left or was removed, by whom, and when. It is created in the same
transaction that removes the uid from `Trip.memberIds` — these two facts
can never diverge. It is audit evidence only; it is **never** itself
consulted to answer "is this uid currently a member" (that remains
exclusively `Trip.ownerId`/`Trip.memberIds`, per "Membership authority"
above), and — per the 6.7B2 closeout below — it does not authorize any
former-member recovery flow either, because no such flow is needed. It
is fully Firestore-Rules-closed — no client role, including the departed
member themselves, may read, create, update, or delete it; only the
trusted `leaveTrip`/`removeTripMember` callables ever touch it. Former
members receive no new Firestore-Rules-based Trip access of any kind as
a consequence of this collection existing.

### Former-member residual recovery (6.7B2) was closed as unnecessary

Checkpoint 6.7B2 was originally planned (during the 6.7 architecture
preflight rounds, before 6.7B1 was implemented) as a former-member
residual Shared-Stash recovery feature — a `withdrawFormerMemberResidual`
callable plus a narrow Rules exception, for a member who left while still
holding Shared-Stash ownership.

That need does not exist under the architecture 6.7B1 actually shipped.
"Both financial positions must be exactly zero before departure" (above)
is a *precondition* for departure to succeed, not a post-departure
cleanup step: a departure that would leave the target with a nonzero
Shared-Stash ownership or a nonzero social expense/settlement position is
rejected outright, for both `leaveTrip` and `removeTripMember`. Combined
with `recordTripExpense`/`recordTripSettlement` already requiring every
named party to be a *current* member, and 6.7A's reversal-freeze gate
(`reverseTripExpense`/`reverseTripSettlement` refuse to reverse a record
naming a departed party), a successfully departed member's position in
both systems is zero at the moment of departure and provably stays zero
forever after — there is no mechanism, race, or legacy path by which it
could become nonzero post-departure. There is therefore nothing left to
recover, and 6.7B2 was closed without implementation. No
`withdrawFormerMemberResidual`-style callable, no `tripMembershipDepartures`
read path for former members, and no Rules widening of any kind were
built or are planned.

`trip_personal` Buckets ("My Stash for this trip") are unaffected by any
of this and were never part of the departure-residual problem in the
first place: a `trip_personal` Bucket's access is governed entirely by
its own `ownerId`/`memberIds`, set at Bucket creation and never
re-synced with the parent Trip's membership (see
`functions/src/callables/createBucket.ts`). A member's `trip_personal`
savings are not affected by leaving or being removed from the Trip they
are linked to.

### Invitation/acceptance history is never rewritten by departure

`tripInvitations`, `tripMembershipAcceptances`, and Trip Terms records
are never modified or deleted by departure. If a departed member
originally joined through an invitation that was accepted, that
invitation remains `accepted` forever as historical evidence — it is
never reverted to `pending`/`cancelled`, and the acceptance record is
never deleted.

### Rejoin is currently terminal (a known, disclosed limitation)

Because `tripInvitations`/`tripMembershipAcceptances` use deterministic
ids keyed by `(tripId, uid)`, a departed member cannot currently be
re-invited to the same Trip. 6.7B1 does not attempt to work around this
backend-side; it is a real, current limitation to be disclosed in the
eventual departure UI (6.7C), not silently patched over.

## Membership activity history (Milestone 6.8)

**IMPLEMENTED IN BRANCH ONLY as of Checkpoint 6.8D — not yet deployed to
production.** This section describes code and Firestore Rules that
exist in this repository's working tree (backend, client, Rules,
indexes, admin tooling, and UI, per Checkpoints 6.8A through 6.8D) but
have not been deployed, and no production data has been written or
migrated. The final controlled rollout follows the frozen A–G cutover
contract (6.8A4), not yet executed — see that checkpoint's own sequence
and "Proposed A–G production rollout checklist" in the 6.8D report for
the exact commands this will eventually require.

### `tripMembershipActivity` — a human-readable membership log, separate from `tripMembershipDepartures`

A new top-level collection, `tripMembershipActivity/{activityId}`,
records a human-readable history of Trip membership events for display
in the SquadStash UI. It is a **parallel, narrower-purpose log**,
entirely separate from the pre-existing `tripMembershipDepartures`
collection described above — that collection remains completely
untouched, unmodified, and still the sole immutable security/audit
evidence for leave/remove events; `tripMembershipActivity` is never
consulted for any authorization decision anywhere in this codebase, and
`tripMembershipDepartures` is never read by, or exposed through, the
new activity UI.

Seven REAL event types, each written exclusively inside the same
trusted-backend transaction as the authoritative mutation it twins
(`createTripCore`, `createTripInvitationCore`,
`acceptTripInvitationCore`, the new `declineTripInvitationCore`/
`cancelTripInvitationCore`, and `executeTripMembershipDeparture`):
`trip_created`, `invitation_created`, `invitation_accepted`,
`invitation_declined`, `invitation_cancelled`, `member_left`,
`member_removed`. Every activity document id is deterministic
(`"{eventType}:{authoritativeId}"`, reusing each event's own existing
authoritative composite-id formula) — never random, and the document's
own `id` is never duplicated as a field inside its persisted data (that
distinction is enforced by a dedicated client-side parser check, not
merely convention).

One SYSTEM/backfill event type, `history_tracking_started`, with
`actorUid`/`targetUid` both exactly `null` — never attributed to a
human uid. Its approved UI copy is exactly: **"Complete membership
activity is tracked from this point forward."** It means the boundary
after which membership activity for that Trip is guaranteed complete —
never that no earlier activity exists; a pre-cutover Trip may have
genuine real events recorded before this marker. It is written, at
most once per Trip, only by the offline admin tool
`functions/src/admin/backfillTripMembershipActivity.ts` (Phase G of the
cutover contract) — never automatically, never for a Trip that already
has a genuine `trip_created` event (which proves it was created under
the new activity-aware `createTrip` and needs no marker at all).

Explicitly **not** implemented, by deliberate scope decision, not
oversight: no persisted `invitation_expired` event (expiry remains a
derived fact from `expiresAt`, exactly as before 6.8 — see "Current
permission matrix" above); no `member_role_changed` event (no mutable
organizational role exists — see "Organizational roles" above; this
event type would require a role system this document already states
was deliberately rejected); no re-invite support (an invitation's
deterministic `{tripId}_{inviteeUid}` id remains a lifetime-unique key
once resolved — unchanged from the pre-6.8 model described under
"Rejoin is currently terminal" above).

### Firestore Rules: current-member-only reads, all client writes denied

```
match /tripMembershipActivity/{activityId} {
  allow get, list: if resource.data.tripId is string
    && canAccessTripById(resource.data.tripId);
  allow create, update, delete: if false;
}
```

Reuses the pre-existing `canAccessTripById(tripId)` cross-collection
helper verbatim (already used by `tripExpenses`/`tripExpenseSplits`) —
no new Rules helper was introduced. Read access follows exactly the
same "current Trip member or owner" rule as every other Trip-scoped
financial collection: a former member (removed from `memberIds`) and a
pending/declined/cancelled invitee (never added to `memberIds`) are
both denied, by construction, the same way they are denied everywhere
else in this document. Writes are unconditionally denied for every
role, including the Trip owner — the trusted backend transactions that
write real events, and the offline backfill tool that writes the
system marker, both use the Admin SDK, which bypasses these Rules
entirely.

### `declineTripInvitation`/`cancelTripInvitation`: moved to trusted callables, with a temporary rollout compatibility window

Both transitions are now trusted Cloud Functions
(`functions/src/callables/declineTripInvitation.ts`/
`cancelTripInvitation.ts`), each atomically twinning its invitation
status change with the matching `invitation_declined`/
`invitation_cancelled` activity event. **The legacy direct-client
Firestore Rules clauses that previously authorized these same two
transitions remain intentionally, temporarily open** — this is a
deliberate rollout-compatibility decision (6.8A3), not an oversight:
during the production cutover window, old and new client builds must
both keep working, so the old Rules path is only closed in cutover
Phase F, after the new callables are deployed, the client has cut over
to them, and old-client-distribution risk is confirmed resolved. As of
this document's current state, that closure has **not** happened —
both paths currently coexist in the Rules file.

### Client UI scope

The new `MemberActivitySection` (`components/trips/
MemberActivitySection.tsx`) is **Trip-membership-specific** — it
renders only the seven real event types plus the system marker, for one
Trip's membership history. It is not, and does not replace, any future
general-purpose cross-Trip Activity Feed that a later milestone may
introduce.

## Archive semantics

| Action | Once a Trip is archived |
|---|---|
| Read historical Trip data (Trip, members, terms, expenses, settlements, balances) | Allowed |
| Invite members | Blocked |
| Publish Trip Terms | Blocked |
| Accept a new invitation | Blocked |
| Edit Trip metadata (title/location/dates/target) | Blocked |
| Create new expenses (member or Shared Stash) | Blocked |
| Reverse expenses (either kind) | Allowed |
| Record settlement | Allowed |
| Reverse settlement | Allowed |
| Personal savings contribution/withdrawal | Allowed |

The asymmetry above — new expense activity is blocked, while expense
reversals, settlements, and personal savings movements remain allowed —
is intentional, documented directly in each callable's own source
comments (e.g. "correcting historical activity is deliberately allowed
on an archived Trip") — it is not a gap, and Checkpoint 6.6 does not
change any of it.

## Ownership transfer

Ownership transfer is not currently supported.

- `Trip.ownerId` is established at Trip creation and never reassigned by
  any trusted Function or Firestore Rule afterward.
- There is no owner-transfer flow today.
- There is no Co-owner role.
- Checkpoint 6.7B1 resolved "can the owner leave/be removed": no, in
  every case, permanently for this checkpoint's scope — see "Member
  departure" above. This is a direct consequence of there being no
  ownership transfer: removing the only owner would leave the Trip
  without one.

## Security note

Every client-side `isOwner`/role check (including the shared
`isTripOwner` domain helper in `src/domain/tripPermissions.ts`) is UI
convenience only. It is never a security boundary. Every privileged
action listed above remains independently enforced by Firestore Rules or
a trusted Cloud Function, regardless of what the client renders or
computes locally.
