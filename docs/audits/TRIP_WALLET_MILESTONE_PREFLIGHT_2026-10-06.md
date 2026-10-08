# Trip Wallet Milestone Gap Preflight — 2026-10-06

**Status:** Architecture / gap analysis only. No application code, Functions
code, Firestore Rules, or indexes were modified to produce this document.

**Amendment 5.0A (2026-10-07):** This document has been hardened after the
original 5.0 pass. Two changes of substance: (1) a new §4A traces a
concrete cross-member pooled-withdrawal exposure in the current
`recordSavingsTransaction` backend and reclassifies it as a Multi-Member
Wallet Authorization / Accounting Dependency; (2) the checkpoint-ordering
recommendation in §10 was revised so that no checkpoint can make a second
uid a financially-authorized Trip member before a withdrawal-ceiling rule
exists. §1 and §5's wording about "every Trip is single-member today" was
also corrected — that claim was never verifiable from this repository
alone and has been restated as a repository-code finding only. See §4A,
the revised §9/§10, and the corrected wording in §1/§5 for the specifics;
all other findings from the original pass are preserved unchanged.

**Baseline:** HEAD `670f92de010bb72eafce8c3d8717c87d4024141f`
("Extract shared savings ledger primitive"), branch
`claude/milestone-3-personal-savings-mvp`, clean working tree. Checkpoint
4F (Shared-Stash-Funded Expenses) is complete, committed, and — per the
checkpoint's own statement — deployed.

**Source of truth:** `docs/product/SQUADSTASH_MASTER_SPEC_V2.md`
(3,136 lines), specifically §6 (Trip Wallet Model), §7 (Roles/Permissions/
Governance), §12 (Invitations and Joining), §13 (Contributions), §14
(Expenses and Expense Splitting), §15 (Reimbursements, Refunds and
Settlement), §16 (Double-Entry Financial Ledger), and §37 (Development and
Launch Milestones — "Milestone 5: Trip Wallets in Sandbox").

---

## 1. Executive Assessment

The repository does **not** follow the Master Spec's milestone numbering.
The Master Spec's Milestone 5–7 sequence assumes a strict build order
(wallet → contributions → commitment → cards/expenses → reimbursement/
settlement), but the actual codebase has already built large pieces of
Milestones 6 and 7 (member-paid and shared-stash expenses, splits,
reversals, corrections, settlements, settlement reversal) while several
Milestone 5 items that those later features implicitly depend on —
**member invitations/acceptance** and **a true member-ownership ledger
that survives pooled spending** — were never built at all. The spec's own
§6.3 and §13 describe exactly the member-ownership-ledger and
contribution-lifecycle concepts the codebase is missing; nothing here is
guesswork about what "ownership ledger" should mean, because the spec
already defines it.

Three concrete, previously-undocumented gaps were confirmed by reading
current source (not by trusting prior audit docs):

1. **A Trip can never acquire a second member through the app today.**
   `createTrip` writes `memberIds: [ownerId]` and there is no
   `addTripMember`/invite function anywhere in `src/services/firebase/`,
   no invitation UI on any Trip screen, and the only in-app reference to
   invitations is decorative copy ("invite friends later") on the Trip
   creation screen that calls nothing. The equivalent Bucket feature
   (`addBucketMember`/`removeBucketMember`, wired to a UI via
   `lookupUserByEmail`) was never ported to Trips. Firestore Rules
   already *permit* an owner to update `memberIds` directly (§7 below),
   so the gap is in the client/service layer and product surface, not
   the trust boundary. **Corrected wording (5.0A):** what this repository
   proves is narrower than "every Trip is single-member today" — it
   proves only that *no code path in this repository can create a
   second Trip member after creation*. That says nothing about whether
   production Firestore already contains a legacy multi-member Trip
   document, whether an administrator ever edited `memberIds` directly,
   or whether a prior, now-superseded version of the app once supported
   this. Treat this finding as a statement about the current source
   tree, not a verified fact about production data.
2. **`Membership`/`Invitation` are pure, unused type definitions.**
   `src/types/domain/membership.ts` and `invitation.ts` exist (confirmed
   by reading both files in full) but are never imported by any service,
   callable, or screen except their own module and a grep hit in
   `activity.ts`'s type union. No `invitations/{id}` or
   `.../members/{uid}` collection exists in Firestore Rules. These files
   are, by their own code comments, "architecture documentation only at
   this stage — no security rules exist yet."
3. **Pooled (shared-stash) spending does not deplete any member's
   tracked ownership share.** This is the central finding of §4 below.
4. **(5.0A) The current backend has no per-member withdrawal ceiling at
   all — a current member can withdraw up to the Trip's entire pooled
   balance regardless of what they personally contributed.** This is
   distinct from finding 3: finding 3 is about a *missing derivation*
   (nothing computes ownership); finding 4 is about a *missing
   enforcement* (even if ownership were computed, nothing today would
   stop a withdrawal from exceeding it). Traced in full in the new §4A.
   This is latent, not exploited, only because of finding 1 above (no
   Trip has a second member yet) — it becomes live the moment any
   checkpoint adds one without first closing this gap.

Given these gaps, Checkpoint 5.0's own instinct to treat the spec's
Milestone 5 as a checklist to verify, rather than a feature set to build
in order, is correct: **accepted membership and a real ownership ledger
are prerequisites that are more foundational than most of what's already
been built**, and the recommended checkpoint sequence (§10) front-loads
them for that reason — §10 was revised in Amendment 5.0A specifically so
that enabling a second financially-authorized member (finding 1's fix)
never happens before finding 4's withdrawal-ceiling gap is closed.

---

## 2. Current Trip Wallet Architecture (as of HEAD)

| Subsystem | Current implementation | Evidence |
|---|---|---|
| Trip model | `trips/{tripId}`: `ownerId`, `memberIds: string[]`, `title`, `location`, `target`, `saved` (legacy dollars), `ledgerOpeningBalanceMinor`/`ledgerBalanceMinor` (minor-unit, backend-only), `imageUrl`, `tripStartDate`/`tripEndDate`, `archivedAt`/`archivedBy`, `createdAt`/`lastUpdatedAt`/`lastUpdatedBy`, `currency?` | `src/types/domain/trip.ts`, `src/services/firebase/trips.ts` |
| Trip creation | Direct client `addDoc` (not a trusted callable) via `createTrip()`; Rules' `allow create` enforces shape and forces `saved == 0` | `trips.ts:85-107`, `firestore.rules:117-173` |
| Trip detail | `app/(tabs)/trips/[tripId]/index.tsx` — Shared Stash balance card, Add-Money/Withdraw, My Stash (per-member personal bucket linked to the Trip), Expenses summary, Shared Stash Activity history, balances, settlements | confirmed file read during 4F.x work |
| Ownership / membership | Flat `memberIds` array + `ownerId`; `isTripOwner`/`isTripMember` Rules helpers and `deriveCurrentMemberUids` client helper both just union the two | `firestore.rules:73-79`, `recordTripSettlement.ts:340-356` |
| Archive/delete lifecycle | One-way `archivedAt`/`archivedBy`, owner-only, no unarchive; missing-safe (`archivedAt` absent ⇒ active) | `firestore.rules:100-115, 242-269` |
| Shared Stash | Trip-level pooled fund; backend-managed `ledgerOpeningBalanceMinor`/`ledgerBalanceMinor`; all mutation via `recordSavingsTransaction`/`recordSharedStashExpense`/`reverseSharedStashExpense` | 4F.x work |
| My Stash | Per-member personal `trip_personal` Bucket linked to a Trip; governed entirely by its own Bucket `memberIds`, not Trip membership | known from Trip Detail code |
| SavingsTransactions | `savingsTransactions/{id}`: `resourceType`,`resourceId`,`memberUid`,`type`,`amountMinor`,`currency`,`recordedBy`,`reversalOf`,`linkedExpenseId?`,`clientRequestId`; fully trusted-write-only (Rules: `create/update/delete: if false`) | `firestore.rules:281-298`, `savingsTransactions.ts` |
| Trip Expenses | Both `member_out_of_pocket` and `shared_stash` payment sources; `tripExpenses`/`tripExpenseSplits` fully trusted-write-only; reversal/correction (`replacesExpenseId`/`replacedByExpenseId`) for both sources | 4F.x work, `firestore.rules:419-443` |
| Balances / Settlements | Pairwise debt derived from `member_out_of_pocket` splits only (never shared-stash, by design — zero pairwise debt for pooled spending); `tripSettlements` fully trusted-write-only via `recordTripSettlement`/`reverseTripSettlement` | `firestore.rules:445-467` |
| Functions authorization | Every trusted callable re-derives membership from the Trip's/Bucket's *current* `memberIds`/`ownerId`, never from request-supplied data; idempotent-replay checked before existence/membership; authorization resolved before any resource-state fact is disclosed | established across 4F.0–4F.5 |
| Subscriptions / read models | `onSnapshot` on `trips/{id}`, `savingsTransactions` queries by `resourceType`/`resourceId`, `tripExpenses`/`tripExpenseSplits`/`tripSettlements` queries by `tripId` — all client reads gated by the Rules above, not by a separate read-model service | confirmed during 4F.4B |

**Member invitations/add-member — confirmed absent for Trips specifically:**

- `src/services/firebase/buckets.ts` has `addBucketMember`/
  `removeBucketMember` (direct `arrayUnion`/`arrayRemove` writes, no
  consent step), wired to UI via `lookupUserByEmail`.
- `src/services/firebase/trips.ts` has **no equivalent function at all** —
  `createTrip`, `fetchTripById`, `archiveTrip`, `updateTripDates` are the
  entire exported surface.
- Firestore Rules' Trip `allow update` clause *does* permit the owner to
  change `memberIds` as part of a general update (same shape as Bucket),
  so the trust boundary is not the blocker — the product/service/UI layer
  simply never built it for Trips.
- The only textual reference to Trip invitations anywhere in `app/` is
  static copy on the Trip creation screen ("Add a destination and target —
  then invite friends later") that is not wired to any action.

---

## 3. Milestone 5 Feature Matrix

| Master Spec item | Status | Evidence |
|---|---|---|
| **Trip creation** | COMPLETE for current test-money scope | `trips.ts:85-107`; owner/title/target/imageUrl/dates captured; no terms/agreement fields (see "Trip terms" below) |
| **Trip terms** | NOT STARTED | `CreateTripInput` (`trip.ts:97-110`) has exactly `title/location/target/imageUrl/ownerId/tripStartDate/tripEndDate` — no contribution-expectation, schedule, commitment-date, withdrawal-rule, spending-authority, settlement-expectation, or acknowledgement field exists anywhere in the Trip type, the create screen, or Firestore Rules. Master Spec §12.2/§12.3 describe a full pre-join disclosure + affirmative acceptance of trip terms; none of that exists. |
| **Member invitations** | NOT STARTED | See §2 above. No invitation record is ever created; membership requires no acceptance; an owner cannot even add a member today because no UI/service path exists for Trips (Rules would permit it, nothing calls it). `lookupUserByEmail` exists and is used only by the Bucket add-member flow. |
| **Trip wallet** | PARTIALLY COMPLETE | The Shared Stash + `ledgerOpeningBalanceMinor`/`ledgerBalanceMinor` + `savingsTransactions` ledger + Shared Stash Activity UI together already satisfy most of Master Spec §6.1's tracked-fields list (contributions, available funds, funds spent) for the current test-money model. Missing: pending contributions, committed funds, refundable/reserved/disputed/returned funds (§6.1), and — critically — "each member's remaining financial interest," which is the §4 ownership-accounting gap below. |
| **Member ownership ledger** | NOT STARTED (see dedicated §4 deep-dive) | `deriveMemberSavingsBalanceMinor` tracks per-member *contribution history*, explicitly excluding `linkedExpenseId`-tagged transactions — it is not, and was never intended to be, a post-spending ownership ledger. Master Spec §6.3 requires one explicitly. |
| **Contributions** | COMPLETE for current test-money architecture | `recordSavingsTransaction` is trusted, idempotent, membership/currency/archive-validated, ledger-init-safe (see `savingsLedger.ts`), with full history. Master Spec §13.1/§13.3's richer fields (funding source, transfer reference, commitment status, refund eligibility) do not apply yet — those presume a real money-movement partner, out of scope pre-Milestone-9. |
| **Commitment rules** | NOT STARTED (do not implement — see §9) | No concept of "committed" vs "uncommitted" funds exists anywhere. A contribution is immediately and permanently spendable from the moment `recordSavingsTransaction` succeeds. Master Spec §13.4/§6.5 describe a funding-lock transition this codebase has no analog for. |
| **Refunds** | PARTIALLY COMPLETE, but conflated — five distinct concepts exist in the spec and only some are implemented (see breakdown below) | |
| **Wallet restrictions** | PARTIALLY COMPLETE | Membership/owner-permission checks, archived-Trip spending blocks, insufficient-balance rejection, and currency-match enforcement all exist and are consistently applied across every trusted callable. Missing: withdrawal restrictions tied to commitment state (because commitment doesn't exist), and any distinction between "uncommitted, freely withdrawable" vs "committed" funds. |

**Refund-concept disambiguation (Master Spec uses "refund" for at least
five different things; the codebase implements some, not others):**

| Spec concept | Codebase equivalent | Status |
|---|---|---|
| §15.1 Reimbursement (member paid out-of-pocket, gets paid back by the group) | `tripSettlements` / `recordTripSettlement` | COMPLETE for test-money |
| Shared-Stash Expense reversal (an Expense against pooled funds is undone) | `reverseSharedStashExpense` | COMPLETE (4F.2/4F.2A) |
| Savings-transaction/contribution reversal generally | `reversalOf` field, used by `reverseSharedStashExpense`'s offsetting refund | COMPLETE for that one caller |
| §15.2 Contribution Refund (member withdraws/returns their own still-uncommitted contribution) | Ordinary `recordSavingsTransaction` withdrawal — no "eligibility" gating (money already spent, commitment terms, disputes) exists; any current balance is withdrawable by anyone recording against their own `memberUid` | PARTIALLY COMPLETE — mechanically possible, but with none of §15.2's eligibility rules |
| §15.3 Unused Funds / return-of-remaining-Trip-funds at settlement, allocated across members by ownership | Nothing | NOT STARTED — this is exactly the §4 gap: there is no persisted or derivable per-member "remaining ownership interest" to allocate from |

---

## 4. Member Ownership Accounting — Deep-Dive Findings

**Worked example (as given in the checkpoint):** Daniel contributes
$600, Friend A contributes $400 (Shared Stash total = $1,000). The group
then spends $300 via a Shared-Stash Expense (Shared Stash balance → $700).

**What the codebase actually tracks today:**

- The Trip's `ledgerBalanceMinor` correctly becomes $700 — this is a
  simple scalar balance, verified correct by the 4F.1/4F.5 test suites.
- `deriveMemberSavingsBalanceMinor(savingsTransactions, "daniel")` still
  returns **$600**, and the same call for Friend A still returns **$400**
  — because `recordSharedStashExpense`'s withdrawal transaction is written
  with a `linkedExpenseId`, and `deriveMemberSavingsBalanceMinor`
  (`src/domain/savingsBalance.ts`) explicitly filters out every
  `linkedExpenseId`-tagged transaction before summing (this exclusion was
  deliberately added in Checkpoint 4F.3, specifically so a pooled
  Expense would not get misread as one member's personal withdrawal).
- Consequence: **$600 + $400 = $1,000 ≠ $700.** The sum of per-member
  tracked totals no longer equals the actual resource balance once any
  Shared-Stash Expense has occurred. This is not a bug in 4F.3's own
  logic — `deriveMemberSavingsBalanceMinor` was never specified to be an
  ownership ledger, only a *personal contribution/withdrawal history*
  view, and it correctly does that job. The gap is that **no other
  function in the codebase computes anything different** — there is no
  second derivation that *does* allocate the $300 depletion against
  Daniel's and Friend A's shares.

**Answering the checkpoint's six sub-questions directly:**

1. *What is each member's remaining ownership interest under current
   code?* — Undefined. No function computes it. The only two things the
   code computes are (a) the Trip's scalar balance ($700) and (b) each
   member's raw contribution/withdrawal history ($600 / $400, unaffected
   by pooled spending).
2. *Is either value persisted?* — The scalar Trip balance is persisted
   (`ledgerBalanceMinor`). A per-member post-spending ownership figure is
   not persisted anywhere.
3. *Is it derivable from existing data?* — Not without a *policy decision*
   first. The raw `savingsTransactions` history contains enough data to
   compute several different candidate answers (pro-rata of original
   contributions, pro-rata of current remaining balance, FIFO consumption
   order, etc.), but which one is "correct" is a product/accounting
   decision the Master Spec deliberately leaves open at the implementation
   level (see below) — the data is necessary but not sufficient.
4. *What does `deriveMemberSavingsBalanceMinor` actually represent?* —
   **Contribution/withdrawal history**, explicitly *not* ownership-after-
   pooled-spending. This should be treated as a naming/documentation risk
   going forward: a future reader could easily mistake "per-member savings
   balance" for "per-member ownership share," and they are not the same
   number as of any Trip with Shared-Stash Expense activity.
5. *How should a future $700 refund be allocated?* — **Open.** Master
   Spec §15.3 ("Unused Funds") lists multiple *supported methods*
   explicitly as a menu, not a single mandated rule: "Return proportionally
   according to remaining ownership," "Return based on net contributions,"
   "Apply approved custom distribution," or "Preserve a documented reserve
   temporarily" — and states "a manager cannot unilaterally claim unused
   funds," but does not pick one method as canonical. §6.3 requires the
   per-member ledger to show "remaining refundable interest" as a tracked
   field, confirming the *need* for a persisted number, but not the
   *formula* that produces it.
6. *Has the architecture already frozen an answer anywhere?* — No. A
   search of all eight prior `docs/audits/*.md` documents (the full
   current inventory: `SQUADSTASH_REPOSITORY_AUDIT_2026-08-01.md`,
   `TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_2026-09-13.md`,
   `TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md`,
   `TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md`,
   `TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md`,
   `TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md`,
   `TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md`,
   `TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md`) turns up only one
   relevant prior decision: the 4F.0 preflight froze that Shared-Stash
   Expenses create **zero pairwise debt** between members (no one "owes"
   anyone for pooled spending) — a deliberate, narrow, and still-correct
   decision about *debt*, but it says nothing about *ownership
   depletion*, which is a different accounting question (debt is about
   who-owes-whom; ownership is about whose money the remaining balance
   actually is). **This is an architectural decision required before any
   future-fund-return feature is implemented — it must not be decided as
   a side effect of implementing that feature.**

---

## 4A. Member Withdrawal Authority — Cross-Member Pooled-Fund Withdrawal (Amendment 5.0A)

**Scenario traced, as specified:** Daniel contributes $900, Friend A
contributes $100 (Shared Stash total = $1,000). If Friend A is an
accepted current Trip member under the proposed 5A membership work,
could Friend A, under *current* `recordSavingsTransaction` backend rules,
submit a Trip withdrawal larger than their own $100 — up to the full
$1,000 — as long as the Trip's aggregate Shared Stash balance supports it?

**Answer: yes.** Traced directly against
`functions/src/callables/recordSavingsTransaction.ts` (the sole trusted
write path for Trip withdrawals; line numbers below refer to that file
as it exists at HEAD):

1. **Authentication** (`requireAuthenticatedUid`, called from the `onCall`
   wrapper) — caller must be signed in. No ownership/role distinction.
2. **Idempotent-replay check** (lines 136–155) — short-circuits before any
   authorization if `clientRequestId` was already used; not relevant to a
   first-time withdrawal.
3. **Trip membership check** (lines 157–168) —
   `parentData.memberIds.includes(input.memberUid)`. This is purely "is
   this uid currently present in the Trip's `memberIds` array" — it does
   not consult that member's own contribution history at all.
4. **Self-only check** (lines 173–178) —
   `authUid !== input.memberUid` is rejected. This answers *only* "who is
   allowed to submit the transaction" (must be acting on your own behalf),
   never "how much of the pooled balance do you economically own."
5. **Archive gating** (lines 199–208) — applies to `trip` + `contribution`
   only; explicitly **does not apply to withdrawals** ("withdrawals
   continue through every existing invariant unchanged").
6. **Currency match** (`resolveEffectiveCurrency`) — no per-member
   relevance.
7. **Ledger-state classification + balance transition** (lines 233–300) —
   this is the only place any balance is consulted, and it is **the
   Trip's own aggregate `ledgerBalanceMinor`** (`currentBalanceMinor`,
   sourced from `classifyLedgerInitialization(parentData)` —
   `parentData` is the **Trip document**, not any per-member record).
   `applyLedgerTransition(currentBalanceMinor, "withdrawal",
   input.amountMinor)` rejects only if the *Trip's* resulting aggregate
   balance would go negative or unsafe. There is no second ceiling check
   anywhere in this function, and no call to
   `deriveMemberSavingsBalanceMinor` or any per-member derivation at all
   — that function lives in `src/domain/savingsBalance.ts` (client-side
   domain code) and is never imported by, or available to, the backend
   callable.

**Distinguishing the two questions precisely, as requested:**

- *"Who is allowed to submit the transaction?"* — Answered completely:
  must be signed in, must be a current Trip member, must be acting on
  their own `memberUid` (self-only).
- *"How much of this pooled balance does this member economically own /
  have authority to withdraw?"* — **Not answered at all.** The backend has
  no second concept here. A withdrawal is approved or rejected purely
  against the Trip's own total balance, never against any per-member
  figure.

**Concretely, for the Daniel-$900/Friend-A-$100 scenario:** once Friend A
is a current Trip member (`memberIds` contains Friend A's uid) and calls
`recordSavingsTransaction` with `memberUid: "friendA"`, `type:
"withdrawal"`, `amountMinor` up to the Trip's full $1,000
`ledgerBalanceMinor`, the call **succeeds** — self-only and membership
checks both pass, and the only balance check is against the $1,000
aggregate, not Friend A's own $100. Friend A's withdrawal is implicitly,
indirectly funded by Daniel's $900. **Another member's contributions can
therefore directly fund an unrelated member's withdrawal, with no backend
rule preventing it.**

**Risk reclassification (per Amendment 5.0A):** this is elevated from a
generic "future refund gap" to an explicit:

> **MULTI-MEMBER WALLET AUTHORIZATION / ACCOUNTING DEPENDENCY** — the
> current `recordSavingsTransaction` withdrawal path is safe *only* under
> the single-member-per-Trip condition that happens to hold today (§1
> finding 1). It was never designed with a per-member ceiling because,
> until a Trip has two or more financially-authorized members, "the
> Trip's balance" and "this member's balance" are the same number by
> construction (any Bucket/My-Stash personal fund is single-member by
> definition and has the identical property, which is why this gap has
> never surfaced there either). The moment any future checkpoint adds a
> second financially-authorized member to a Trip without closing this
> gap first, that equivalence breaks and the exposure traced above
> becomes real and exploitable by any member, not a theoretical edge
> case.

**This is explicitly not a regression introduced by the proposed 5A
work.** It is a latent limitation that has existed in
`recordSavingsTransaction` since it was first written for the
single-member-per-resource case (Buckets and, until now, Trips) — 5A-style
membership work does not create this gap, it would merely be the first
feature to make it reachable. The fix belongs to a dedicated checkpoint
(revised §10, checkpoint 5B) that must land *before* any checkpoint grants
a second uid financial authorization over an existing pooled balance.

---

## 5. Membership Trust Model — Deep-Dive Findings

Traced the full authorization chain: owner creates Trip (direct client
write) → `memberIds: [ownerId]` only → **no further step exists today**
(no invite, no add-member, no acceptance) → every financial callable
(`recordSavingsTransaction`, `recordSharedStashExpense`,
`reverseSharedStashExpense`, `recordTripExpense`, `reverseTripExpense`,
`recordTripSettlement`, `reverseTripSettlement`) derives "is this caller
authorized" from the *same* two fields, `memberIds`/`ownerId`, read fresh
from Firestore at call time.

**Can a user become financially authorized without explicitly accepting
membership?** Yes, in principle — Firestore Rules let a Trip owner add any
uid to `memberIds` with a plain `allow update` and zero consent gate
(identical to the already-shipped Bucket behavior). In practice, no code
path in this repository currently *exercises* that for Trips (§2 above) —
**corrected wording (5.0A):** this is a statement about the repository's
code paths, not a verified claim about production Firestore data; it does
not rule out a legacy multi-member Trip document, a manual administrator
edit, or behavior from a superseded prior version of the app. Within the
repository's own code, though, the question is latent rather than
actively exploited today, and (per the new §4A) it is not merely a
consent question — even a *consenting*, properly-invited second member
would hit the uncapped-withdrawal gap traced there. It becomes live the
moment anyone builds the "add a Trip member" feature using the same
pattern as `addBucketMember` — which is the obvious, lowest-effort way to
build it, and would silently inherit both the no-consent gap and the
no-withdrawal-ceiling gap unless deliberately designed otherwise.

**This is explicitly flagged, by name, in `recordSavingsTransaction.ts`'s
own code comment** (lines 51–58), quoted here verbatim as the clearest
existing acknowledgment of the gap:

> "Owner-on-behalf recording (an owner recording for another member) is
> intentionally NOT permitted right now (Milestone 2C Checkpoint 2C-1). A
> Bucket owner can unilaterally add another registered uid to memberIds
> with no acceptance step, and no trusted Membership/Invitation-acceptance
> record exists yet to distinguish that from independently-accepted
> membership — so financial attribution stays self-only until a future
> group-sharing milestone adds trusted, accepted membership."

That comment is about Buckets, but it describes the identical mechanism
Trips use, and the same caveat applies: every "is this a real, consenting
member" question in the current system is actually answered by "is this
uid present in an array some owner can edit," never by any acceptance
record.

**Every trusted backend permission that inherits this assumption:**
contribution/withdrawal authorization, Shared-Stash-Expense create/
reverse/correct authorization, member-out-of-pocket Expense create/
reverse/correct authorization, settlement create/reverse authorization,
and all client-side Rules read access (`isTripMember`/`canAccessTripById`)
— i.e., literally every Trip-scoped financial and data-access decision in
the codebase.

**Should resolving accepted membership happen before further Trip Wallet
features?** Yes, for two independent reasons, one security and one
accounting (the checkpoint's own framing): (1) *Security* — once a
same-pattern "add Trip member" feature is built, any Trip owner can
silently grant another uid read access to that Trip's full financial
history and co-equal spending authority with no notice or consent to the
added party; this is a materially different risk than the Bucket case,
because Trip financial stakes (shared pooled money, Expense authority)
are higher. (2) *Accounting* — §4's ownership-ledger gap cannot be
designed correctly without first knowing when a member's contribution
became genuinely "theirs to share" vs. merely present in an array; an
ownership model built against ambiguous membership would have to be
revisited once membership semantics are fixed.

**Invitation state vs. financial membership (Amendment 5.0A, per the
checkpoint's instruction not to invent unnecessary state):** two states
are enough — **invited (pending)** and **accepted member** — not three.
"Accepted member" should mean the uid has affirmatively accepted the
invitation; it should not, by itself, mean "safe to treat as a current
financially-authorized Trip member" if that set is the same `memberIds`
array every trusted callable already consults for withdrawal rights. The
invariant to freeze is:

> **An invitation alone must never grant Trip financial authorization or
> access to Trip financial data intended only for accepted members.**
> Acceptance is necessary; today's two-state model (invited/accepted) is
> sufficient to express *that* gate. It is not, by itself, sufficient to
> express the *withdrawal-ceiling* gate traced in §4A — that is a property
> of the backend's balance-checking logic, not of the membership state
> machine, and must be solved there (§10, checkpoint 5B), not by adding a
> third membership state.

What event should make a uid eligible to enter the `memberIds` set the
financial callables consult? **Acceptance of the invitation**, exactly as
Master Spec §12.3 requires ("Joining requires affirmative acceptance of
Trip terms...") — but per the dependency analysis in the revised §10,
that write should not be considered safe to ship as a *second*
financially-authorized member until the §4A withdrawal-ceiling
enforcement already exists. The membership-state model and the
withdrawal-ceiling enforcement are two separate pieces of work that both
gate the same event; neither alone is sufficient.

**Terms-version/acceptance record (Amendment 5.0A):** Master Spec §12.3
states plainly: "The accepted terms version must be recorded." This
preflight does not implement that, per this amendment's own instructions,
but establishes what must be recorded, using the spec's own terminology
where it provides it: an acceptance record tying together (a) the
accepting member's uid, (b) the Trip id, (c) an identifier for the
specific accepted terms version (the spec does not name a field for this
beyond "terms version" — a future checkpoint will need to decide what
constitutes a new "version," e.g. any edit to trip terms vs. only
explicit re-publication), and (d) a server-set acceptance timestamp
(`acceptedAt`, mirroring this codebase's existing `serverTimestamp()`
convention for every other trusted timestamp). The purpose, stated
explicitly so a later checkpoint cannot skip it: if Trip terms are ever
edited after a member accepted an earlier version, that member's
historical acceptance record must continue to reflect what they actually
saw and agreed to — never be silently reinterpreted as consent to the
new text.

---

## 6. Trip Wallet Lifecycle — Findings

**Current lifecycle:** exactly two states — active (default, including a
brand-new Trip) and archived (`archivedAt` present), one-way, owner-only,
no unarchive transition. New spending (contributions, new Expense
creation of either payment source) is archive-gated; resolving existing
facts (withdrawals as part of a reversal/refund, Settlement create/
reverse, Expense reversal/correction) is explicitly not archive-gated.

**Master Spec's ten-state model** (`draft`, `funding_open`,
`funding_locked`, `active_spending`, `spending_paused`, `settling`,
`settled`, `frozen`, `canceled`, `closed`, §6.4) has no present analog
beyond the active/archived binary.

**What's needed for the next stage vs. deferred to later milestones:**
Only `funding_open` → `funding_locked` (i.e., some representation of
"commitment," §13.4) is plausibly in scope for the *next* checkpoint
tranche, and only once commitment rules themselves are designed (§9) —
this checkpoint does not recommend adding lifecycle states speculatively.
`active_spending`/`spending_paused`/`settling`/`settled`/`frozen`/
`canceled` presume a card/webhook/live-money partner integration
(Milestones 6–11) and should remain deferred. `draft` (a Trip visible only
to its creator before any invitations are sent) only becomes meaningful
once invitations exist (§9/§10).

**Recommendation: preserve the existing missing-safe `archivedAt`
semantics as-is.** No evidence was found that any near-term checkpoint
needs to supersede it; a future `funding_locked`/`settling` state, if
built, should be modeled as an *additional* field or state machine
alongside `archivedAt`, not a replacement for it, since `archivedAt`'s
specific job (one-way, owner-only, "no more edits of any kind") is
orthogonal to funding/spending state.

---

## 7. Firestore / Trust-Boundary Findings

| Collection | Client read | Client create | Client update | Client delete | Authorization source |
|---|---|---|---|---|---|
| `trips` | `isTripMember() \|\| isTripOwner()` | Direct client write, Rules-validated shape, forces `saved == 0` | Owner: `title/location/target/imageUrl/memberIds/tripStartDate/tripEndDate`; member: `title/location/imageUrl` only; ledger fields excluded from both allowlists; separate owner-only archive-only clause | `if false` (archive is the only "delete") | `memberIds`/`ownerId` on the resource itself |
| `savingsTransactions` | via `canAccessParent` (Bucket/Trip current membership) | `if false` | `if false` | `if false` | Trusted callables only (Admin SDK bypasses Rules) |
| `tripExpenses` | `canAccessTripById(resource.data.tripId)` | `if false` | `if false` | `if false` | Trusted callables only |
| `tripExpenseSplits` | `canAccessTripById(resource.data.tripId)` | `if false` | `if false` | `if false` | Trusted callables only |
| `tripSettlements` | `canAccessTripById(resource.data.tripId)` | `if false` | `if false` | `if false` | Trusted callables only |
| Membership/Invitation collections | **Do not exist** | — | — | — | N/A — `Membership`/`Invitation` types are unused |

**Remaining client-authoritative financial/membership field:** `trips`'
`memberIds` is client-writable by the owner with no shape validation
beyond "is a list" and no check that added uids correspond to real,
consenting users — this is the same trust posture Buckets already have in
production, not a new regression, but it is the field every future
invitation/acceptance design will need to either keep, wrap, or replace.
No other Trip-Wallet-related collection has any remaining
client-authoritative financial field; every ledger-affecting write across
`trips` (ledger fields only), `savingsTransactions`, `tripExpenses`,
`tripExpenseSplits`, and `tripSettlements` is already fully closed to
direct client writes.

No Rules changes are proposed or needed as output of this checkpoint.

---

## 8. Architectural Gaps Beyond Milestone 5's Own List

- **Naming risk:** `deriveMemberSavingsBalanceMinor` reads, at a glance,
  like it could answer an ownership question it was never designed to
  answer (§4). No code change is proposed here, but any future ownership-
  ledger work should introduce a clearly differently-named function
  rather than overloading this one.
- **Asymmetric member-management feature parity:** Buckets have a full
  add/remove-member feature; Trips have none. Any future Trip invitation
  design should treat this as a chance to design accepted-membership
  correctly from the start, rather than copying Bucket's no-consent
  pattern forward by habit.
- **`CreateTripInput`/Trip creation Rules currently hard-code `saved == 0`**
  and a fixed field allowlist; any future "Trip terms" capture at creation
  time will need both the type and the Rules' `keys().hasOnly([...])`
  allowlist extended — flagged here only as a dependency to plan for, not
  as something to change now.

---

## 9. Architectural Decisions That Must Be Frozen Before Implementation

For each, the Master Spec's own answer is used where one exists; where the
spec deliberately leaves the question open, that is stated rather than a
convenient default being chosen here.

1. **How does pooled (Shared-Stash) expense spending consume individual
   members' ownership interest, and — the Amendment 5.0A addition — what
   ceiling, if any, limits how much of the pooled balance a single member
   may withdraw?** — Open. Spec §6.3 requires the ledger to track
   ownership; §15.3 lists multiple distribution *methods* as options, not
   a mandated single rule. **Must be decided before any ownership-ledger
   feature is built** (directly blocks §4/§8's gap) **and, separately,
   before any checkpoint grants a second uid financial authorization over
   an existing pooled Trip balance** (§4A) — the second requirement is
   stricter and binds earlier, since an enforceable withdrawal ceiling is
   needed even before the full ownership-ledger derivation is built (a
   simple "may not withdraw more than you have personally contributed,
   net of your own prior withdrawals" rule would already close §4A's gap,
   independently of which unused-funds distribution formula is eventually
   chosen for #2 below).
2. **How are unused funds distributed at settlement?** — Open by the
   spec's own design (§15.3's bulleted menu, explicitly not a single
   rule); the spec does fix one constraint: "A manager cannot unilaterally
   claim unused funds."
3. **Pro-rata of original contribution vs. pro-rata of remaining balance
   vs. FIFO consumption order, for ownership depletion?** — Open; the spec
   does not choose among these for pooled-spending allocation specifically.
4. **When do contributions become "committed"?** — Spec §13.4 gives five
   named triggers (immediately / on a specified date / after member
   confirmation / after a trip threshold / when spending begins) as
   options the *trip terms* must choose among and disclose — the spec's
   answer is "trip-configurable, not a single global rule," which is
   itself the decision to freeze: commitment rules are a per-Trip setting,
   not a platform constant.
5. **Can the owner remove a member who has contributed funds?** — Spec
   §7.5: no, "a member may not be removed while unresolved financial
   obligations exist" and remaining contributions/expense responsibility/
   reimbursements/disputes/refunds/settlement must first be addressed.
   This is already answered by the spec; it is not yet implemented
   (there is no member-removal feature for Trips at all today).
6. **What happens to a member's ownership interest when membership ends?**
   — Follows from #5: it must be resolved (refunded/settled) as part of
   the removal itself, not left dangling. Not yet implementable until #1/
   #2 are decided, since "resolved" requires knowing the allocation
   formula.
7. **Must invite-acceptance precede financial authorization?** — Spec §12.3
   says joining *requires* affirmative acceptance of trip terms/
   contribution rules/expense-allocation rules/manager authority/refund
   and settlement terms, with the accepted version recorded. The spec's
   answer is yes; the current codebase does not implement any acceptance
   step at all (§5 above) — this is a confirmed gap, not an open question.
8. **Who may lock funding (end the "funding_open" stage)?** — Not
   explicitly named in the spec beyond "a defined lock date or member
   confirmation" (§6.5/§13.4); whether that action belongs to the owner
   alone, a manager, or requires group confirmation is left open and
   should be decided alongside the commitment-rules checkpoint (§9.4).
9. **May committed funds still be withdrawn?** — Spec §6.5 ("Committed
   Funding"): "Withdrawals may require manager or group approval" — stated
   as a possible restriction, not an absolute prohibition; the exact rule
   per Trip is left to the trip terms, matching #4's "trip-configurable"
   framing.
10. **(Amendment 5.0A) Is "accepted invitation" the same event as "entry
    into the `memberIds` set financial callables consult"?** — Open, and
    this preflight deliberately does not choose an answer beyond the
    invariant in §5: an invitation alone must never grant financial
    authorization. Two state-machine states (invited/accepted) are enough
    (§5); whether "accepted" writes directly into the existing
    `memberIds` field or into some other gating field is an implementation
    choice for checkpoint 5C (§10) to make once checkpoint 5B's
    withdrawal ceiling already exists — at that point either choice is
    safe, which is precisely why 5B is sequenced first.

---

## 10. Recommended Next Checkpoints (Dependency Order) — Revised by Amendment 5.0A

Derived from the gaps found above, not from the example sequence in the
original checkpoint prompt (treated as illustrative only). **This section
replaces the original 5.0 version in full** — the original sequence
(`5A Accepted Trip Membership → 5B Ownership Accounting → 5C Trip Terms`)
is superseded because it would have let 5A grant a second uid financial
authorization before any withdrawal ceiling existed (§4A). The checkpoint
labels below are reassigned; they do not preserve the original 5.0
document's 5A/5B/5C meanings.

For each checkpoint: objective, dependencies, the architectural decision
that must already be frozen before it starts, whether it may make a
second uid financially authorized, backend/Rules/deploy impact, and risk.

1. **5A — Trip Terms & Membership State Architecture (decisions +
   non-financial scaffolding only).** *Objective:* (a) freeze the
   invited/accepted two-state membership model and the terms-
   version/acceptance-record shape (§5); (b) freeze the withdrawal-
   ceiling *policy* question from §9 decision #1 (even if only to the
   minimal "cannot withdraw more than net-personal-contribution" rule) —
   this checkpoint may freeze the decision without yet enforcing it in
   code, but must not proceed past this checkpoint unenforced; (c) build
   the `invitations`/terms-acceptance data model and Rules as inert
   scaffolding. *Dependency:* none. *Decision that must already be
   frozen:* none — this checkpoint's job is to produce the freeze.
   *May this checkpoint make a second uid financially authorized?* **No.**
   It must not write any new uid into `trips/{id}.memberIds` or any
   equivalent financial-authorization set. *Backend impact:* none to
   `recordSavingsTransaction`/other existing callables. *Rules impact:*
   yes (new `invitations`-equivalent collection). *Deploy required:* yes.
   *Risk:* low — no new financial authorization is granted by this
   checkpoint.
2. **5B — Withdrawal-Ceiling Enforcement + Ownership Accounting Model.**
   *Objective:* implement the per-member ownership/remaining-interest
   derivation (resolving §4) **and** add the corresponding ceiling check
   to `recordSavingsTransaction`'s (and any Shared-Stash-Expense-adjacent)
   withdrawal path, per the policy frozen in 5A. *Dependency:* 5A's
   frozen withdrawal-ceiling policy. *Decision that must already be
   frozen:* §9 decision #1 (at minimum the ceiling formula; the full
   unused-funds distribution formula, #2, is not required yet). *May this
   checkpoint make a second uid financially authorized?* No — it changes
   backend behavior for whichever member(s) are *already* authorized
   today (safe to build and test against the current single-member
   case). *Backend impact:* **yes — a real behavior change to an
   already-deployed callable** (`recordSavingsTransaction`'s withdrawal
   path gains a new rejection case); needs careful regression testing
   against every existing withdrawal test in `functions/test/` to confirm
   single-member Trips/Buckets are unaffected (for a single-contributor
   resource, "net personal contribution" and "aggregate balance" are the
   same number, so no currently-passing test should change outcome).
   *Rules impact:* no. *Deploy required:* yes. *Risk:* medium — correctness-
   critical, but contained because no new party is authorized yet.
3. **5C — Trusted Invitation Acceptance → Financially-Authorized
   Membership (bundled with Trip-terms acceptance).** *Objective:*
   implement the actual invite → accept-terms → become-current-Trip-member
   flow, writing the accepting uid into the set financial callables
   consult. Terms acceptance (Master Spec §12.3) is bundled into this same
   action, not a later checkpoint, because the spec requires acceptance to
   gate joining itself, not follow it. *Dependency:* 5A (state model +
   terms-acceptance shape) **and 5B (withdrawal ceiling must already be
   enforced)**. *Decision that must already be frozen:* §9 decision #7
   (yes, acceptance precedes authorization — already answered by the
   spec) and confirmation that 5B is live. **This is the first checkpoint
   at which a second user can actually become a financially-authorized
   Trip member**, and it is only sequenced here because 5B already closed
   the §4A gap beforehand — reaching this checkpoint before 5B would
   reproduce exactly the exposure traced in §4A. *Backend impact:* yes
   (membership-grant write path, likely a new or extended trusted
   callable rather than a direct client `memberIds` update, closing the
   owner-can-silently-add-anyone gap found in §2/§7). *Rules impact:* yes
   (narrowing or replacing the current free-form owner `memberIds` update
   path). *Deploy required:* yes. *Risk:* medium-high — the first real
   multi-member financial-authorization change, but bounded risk because
   its only prerequisite (5B) is already in production by this point.
4. **5D — Commitment / Funding Lifecycle.** *Objective:* implement the
   `funding_open`→`funding_locked` transition and the resulting
   withdrawal-restriction rules, per the per-Trip configuration decided in
   §9.4/§9.8/§9.9. *Dependency:* 5C (commitment rules must be part of the
   trip terms a member already accepted) and 5B (the ceiling it further
   restricts must already exist). *Decision that must already be frozen:*
   §9 decisions #4/#8/#9. *May this checkpoint make a second uid
   financially authorized?* No — multi-member authorization already
   exists by this point (from 5C); this only adds a stricter funding-
   state gate on top of it. *Backend impact:* yes (extends the existing
   callable further). *Rules impact:* yes (new owner-only lock
   transition, mirroring `archivedAt`'s pattern). *Deploy required:* yes.
   *Risk:* medium.
5. **5E — Unused-Funds Refund / Settlement Distribution.** *Objective:*
   implement the §15.3 "distribute unused money" step using the ownership
   model from 5B. *Dependency:* 5B (ownership formula) and 5D (a defined
   settlement entry point). *Decision that must already be frozen:* §9
   decision #2 (unused-funds distribution method). *May this checkpoint
   make a second uid financially authorized?* No. *Backend impact:* yes
   (new or extended settlement callable). *Rules impact:* possibly.
   *Deploy required:* yes. *Risk:* high — the first feature that actually
   moves "ownership" into an outbound financial action.

---

## 11. What Should Explicitly Remain Deferred

- Trip Wallet legal/operational structure selection (§6.2) — a legal/
  partner decision, not an engineering one, and explicitly out of scope
  pre-partner-integration.
- Full ten-state lifecycle (§6.4) beyond the `funding_open`/
  `funding_locked` transition — presumes card/webhook/live-money
  integration (Milestones 6–11).
- Card-based spending, authorization webhooks, settlement webhooks (all of
  Milestone 6) — explicitly later-milestone scope.
- Disputes (§14.6) — no current Expense/Settlement feature has any dispute
  concept, and nothing in the current gap analysis makes it urgent ahead
  of ownership/commitment.
- Double-entry ledger / PostgreSQL financial database (§16, Milestone 2) —
  a foundational infrastructure milestone the spec places *before*
  Milestone 5 entirely; the current Firestore-only ledger is a deliberate,
  already-reviewed test-money simplification, not a gap this checkpoint
  is flagging for near-term correction.
- Any live-money, partner-integration, or regulatory-gated feature
  (Milestones 8–12) — categorically out of scope until the sandbox/test-
  money model above is complete and reviewed.

---

## 12. Conflict Check Against Completed 4F Architecture

No conflicts found. Checked explicitly against each named 4F invariant:

- **Server-authoritative ledger writes** — unaffected; any future
  ownership-ledger derivation (5B) reads existing trusted-write data, it
  does not need a new write path of its own unless storage is later
  chosen over pure derivation.
- **No direct financial balance edits** — unaffected; nothing proposed
  here suggests a client-writable ownership field.
- **Deterministic/idempotent financial writes** — unaffected; 5A/5D/5E
  would each need their own deterministic-id scheme following the
  established `sha256([parentId, discriminant])` convention, but that is
  additive, not a change to existing schemes.
- **Shared-Stash Expense atomicity** — unaffected; not touched by any
  recommended checkpoint.
- **Expense-linked SavingsTransactions excluded from personal
  attribution** — this is the exact mechanism §4 identifies as
  insufficient *on its own* for ownership accounting, but 5B's
  recommended fix is an *additional* derivation, not a change to this
  existing, already-correct-for-its-purpose exclusion. No migration of
  historical `linkedExpenseId` data is implied.
- **(Amendment 5.0A) Revised checkpoint 5B's withdrawal-ceiling
  enforcement change to `recordSavingsTransaction`** — this is the one
  recommended checkpoint in this document that alters behavior of an
  already-deployed trusted callable rather than only adding new,
  independent surface area. It does not conflict with any 4F invariant
  (it adds a rejection case to the existing `applyLedgerTransition`
  insufficient-funds check, using the same `savingsLedger.ts` primitive
  pattern 4F.5 already established), but it is flagged here explicitly
  because, unlike every other recommended checkpoint, it requires
  re-running the full existing withdrawal-path regression suite (not just
  adding new tests) to confirm no currently-passing single-member
  Trip/Bucket withdrawal test changes outcome.
- **Zero pairwise debt for Shared-Stash Expenses** — explicitly preserved;
  §4 is careful to distinguish ownership depletion from pairwise debt, and
  no recommended checkpoint reintroduces debt for pooled spending.
- **Current reversal/correction history** — unaffected; no migration
  required for any existing `reversalOf`/`replacesExpenseId`/
  `replacedByExpenseId` record.
- **Current settlement accounting** — unaffected; 5E extends settlement
  with a new unused-funds step rather than changing existing
  reimbursement-settlement behavior.
- **Current archive safety** — explicitly preserved and recommended to
  remain the sole archive signal (§6 above); no supersession proposed.

**No historical-document migration is required by anything recommended in
this preflight.** Every proposed checkpoint is additive (new fields, new
collections, new derivations) rather than a reinterpretation of existing
persisted financial data.

---

## 13. Technical Baseline / Validation

- HEAD: `670f92de010bb72eafce8c3d8717c87d4024141f`, branch
  `claude/milestone-3-personal-savings-mvp`, `git status --short`: clean
  before this checkpoint began.
- Functions runtime target: Node 22 (`functions/package.json` →
  `engines.node: "22"`). Root app: no `engines` field declared; prior
  checkpoint work in this session established the dev baseline as Node 20.
- Existing tests spot-checked for presence/shape only (no new tests
  written or run as product validation, per this checkpoint's read-only
  constraint): `functions/test/savingsLedger.ts` (38 cases),
  `functions/test/reverseSharedStashExpenseCore.ts` (26),
  `functions/test/reverseTripExpenseCore.ts` (73),
  `functions/test/reverseTripSettlementCore.ts` (28),
  `functions/test/tripExpenseSplitsParity.ts` (69) — all present and
  consistent with the full-suite counts recorded at the end of Checkpoint
  4F.5 (547/140).
- Post-write validation (run after this document was created):
  `git status --short` shows exactly one new, untracked file —
  `docs/audits/TRIP_WALLET_MILESTONE_PREFLIGHT_2026-10-06.md` — and
  nothing else changed, added, or deleted.
