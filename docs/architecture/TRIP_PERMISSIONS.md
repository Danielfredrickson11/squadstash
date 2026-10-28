# Trip Permissions — Architecture Reference

Status: current, frozen (Checkpoint 6.6).

This document is the source of truth for SquadStash's Trip organizational
role model and the permission matrix it governs. It reflects verified
behavior read directly from `firestore.rules` and the trusted Cloud
Functions in `functions/src/callables/` as of Checkpoint 6.6 — it is not
a design proposal.

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
role, including the owner). There is no member-removal path today —
membership is monotonic.

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
- Owner removal/leave/transfer semantics (including "can the owner leave
  a Trip" and "what happens if the last owner disappears") are deferred
  to Checkpoint 6.7's own architecture work. This document establishes
  the current model that 6.7 must reason from — it does not attempt to
  answer those questions.

## Security note

Every client-side `isOwner`/role check (including the shared
`isTripOwner` domain helper in `src/domain/tripPermissions.ts`) is UI
convenience only. It is never a security boundary. Every privileged
action listed above remains independently enforced by Firestore Rules or
a trusted Cloud Function, regardless of what the client renders or
computes locally.
