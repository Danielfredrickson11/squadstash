# Multi-Member Production Rollout — Preflight Refresh (2026-10-29)

**Status: PREFLIGHT / DISCOVERY REFRESH ONLY. No deployment, migration, or production
write occurred as part of producing this document.**

This document refreshes `docs/audits/MULTI_MEMBER_PRODUCTION_ROLLOUT_PREFLIGHT_2026-10-22.md`
(the "October 22 document," preserved unmodified) against the repository's committed
state at HEAD `81d34a3` ("Add trip member departure UI"). The October 22 document's own
factual claims about live production state are now **stale** — live, read-only
verification performed for this refresh shows a backend/Rules deployment has already
happened since it was written, outside of any tracked rollout-execution record in this
repository.

## 1. Executive conclusion

**Amended 2026-11-04.** A review of this document's first pass found a real gap: it
established that `leaveTrip`/`removeTripMember` and two new Rules match blocks were the
only undeployed delta by checking `firebase functions:list` for **function presence**,
which proves a name exists, not that its **currently live revision** contains current
HEAD's code. Live, read-only, per-function revision metadata (`gcloud functions
describe`) now confirms that assumption was wrong for five already-deployed Functions.

- **The October 22 document's deployment picture was already out of date** (confirmed in
  the first pass): `acceptTripInvitation`/`getTripInvitationPreview` are live, and the
  5C.2/5C.6 Rules changes are live.
- **New finding, this amendment: five already-deployed, currently-exported Functions are
  running source code from BEFORE Checkpoint 6.7A** — `createTrip`, `recordTripExpense`,
  `recordTripSettlement`, `reverseTripExpense`, `reverseTripSettlement`. Commit `102079a`
  ("Add Trip expense balance foundation," authored 2026-10-28, five days **after** the
  October 23 live deploy) modified all five to maintain the new `tripExpenseBalances`
  aggregate and to initialize it on new Trips. None of the five has been redeployed
  since `102079a` landed — their live `updateTime`s range from 2026-10-01 to
  2026-10-16, all predating that commit by 12–27 days.
- **Consequence**: `tripExpenseBalances` is not currently maintained by any live
  Function. No new Trip created today receives `expenseBalanceModelState`/`Version` at
  all (the live `createTrip` predates that addition). This is **safe today** — the
  gate code treats a missing/absent state as `"legacy"`, an explicit no-op, not a
  corruption — but it means the real undeployed Function delta is **seven** Functions
  (`createTrip`, `recordTripExpense`, `recordTripSettlement`, `reverseTripExpense`,
  `reverseTripSettlement`, `leaveTrip`, `removeTripMember`), not two, and the five
  existing ones must deploy **before or together with** `leaveTrip`/`removeTripMember`
  — never after — so that any Trip migrated to `"initialized"` for the expense-balance
  model has its aggregate actually kept correct by every subsequent expense/settlement,
  rather than going stale the moment real activity resumes. Full evidence: §5, §7, §8.
- **The Rules finding from the first pass is reconfirmed, unchanged**: the only
  undeployed Rules content is the two new, fully-closed `tripExpenseBalances`/
  `tripMembershipDepartures` match blocks (§6) — this was established by an actual
  byte-level diff of the live Ruleset source, not by name-presence inference, and
  nothing in this amendment's findings changes it.
- **No production data migration is required before any of this is deployed.** All five
  financial callables' `"legacy"`-state handling (including the now-confirmed-universal
  "missing field" case) remains a documented, safe no-op; only the departure callables
  require `"initialized"` state and fail closed otherwise. See §8's corrected A/B/C
  framing.
- **Production-client distribution remains CASE D**, unchanged — no new evidence
  resolves it either direction.
- **Recommendation: READY FOR ROLLOUT-PLAN REVIEW**, with the corrected seven-Function
  scope and the strict ordering constraint above — not the two-Function scope the first
  pass proposed.

## 2. Baseline

- Branch: `claude/milestone-3-personal-savings-mvp`
- HEAD: `81d34a38216830b74f51664228e3d0f8541a22dd` ("Add trip member departure UI")
- Working tree: clean
- Local HEAD == origin HEAD: confirmed

## 3. Prior audit (October 22) — extracted methodology and claims

Read in full (not merely grepped). It recorded, as of its own baseline (HEAD `2387418`):

- **Deployed Functions (12)**: `createBucket`, `createTrip`, `createTripInvitation`,
  `lookupUserByEmail`, `publishTripTerms`, `recordSavingsTransaction`,
  `recordSharedStashExpense`, `recordTripExpense`, `recordTripSettlement`,
  `reverseSharedStashExpense`, `reverseTripExpense`, `reverseTripSettlement`.
- **Undeployed Functions (2)**: `acceptTripInvitation`, `getTripInvitationPreview`.
- **Rules baseline**: active production Ruleset `be6b9b70-639a-4dba-bee8-421c3b251af4`,
  byte-identical to commit `20c1760387251db12d3109a93db979eb28b7eb80` ("OUTCOME A").
- **Undeployed Rules delta (2 commits)**: `6d19266` (close direct `memberIds` write /
  `tripMembershipAcceptances` / `tripInvitations` direct-accept paths) and `160e32b`
  (5C.6 reconciliation-collection Rules).
- **CASE A/B/C/D client-distribution framework**: classified **CASE D** — repository
  evidence (no `eas.json`, no app-store identifiers, no CI publish/deploy step) proves
  absence of distribution *configuration*, not absence of all historical distribution.
  CASE D blocks Rules deployment (Phase D) but not Functions deployment (Phase A/B),
  since Functions deployment is additive.
- **Phase A–F rollout order**: targeted Functions deploy → Functions metadata verify →
  client-distribution/cutover determination (Phase C) → client compatibility verify →
  Rules deploy → management-plane proof (E1) → propagation-safety gate (E2) → controlled
  two-account verification (Phase F).
- **Frozen commands**: `firebase deploy --only functions:acceptTripInvitation,functions:getTripInvitationPreview --project squadstash-6d0f1`;
  `firebase deploy --only firestore:rules --project squadstash-6d0f1`; the Rules
  management-API Release→Ruleset→source read sequence (§11 there) for post-deploy proof.
- **Manual validation requirement**: a controlled two-account (A/B) invitation/preview/
  acceptance flow, explicitly scoped away from any financial transaction.
- **Rollback plan**: Functions are additive and left in place rather than deleted if
  verification fails; Rules are near-instantly revertible by redeploying the prior
  commit's `firestore.rules`.
- **Stop conditions**: dirty working tree/HEAD mismatch, any regression-suite failure,
  wrong deploy target, unexpected Function set, CASE D/C unresolved at Phase D, 60-second
  propagation window not yet elapsed, a pre-deployment listener reused as evidence, any
  Phase F step requiring a financial mutation.

**This refresh treats none of the above as still-current fact without re-verifying it
live — see §4–§6.**

## 4. Current committed architecture (Phase 1 inventory)

`functions/src/index.ts` currently exports **16** callables (all confirmed by direct
read, not inferred):

| Capability | Function(s) | Rules dependency |
|---|---|---|
| Trip creation | `createTrip` | `trips/{tripId}` create path |
| Bucket creation | `createBucket` | `buckets/{bucketId}` |
| Email lookup (invitation support) | `lookupUserByEmail` | none (Auth Admin SDK only) |
| Invitation creation | `createTripInvitation` | `tripInvitations/{id}` |
| Invitation preview | `getTripInvitationPreview` | read-only, trusted callable |
| Invitation acceptance | `acceptTripInvitation` | `tripMembershipAcceptances`, `tripInvitations`, `trips.memberIds` |
| Trip Terms | `publishTripTerms` | `tripTerms/{id}` |
| Savings transactions | `recordSavingsTransaction` | `savingsTransactions`, `tripMemberOwnership` |
| Out-of-pocket expense | `recordTripExpense` / `reverseTripExpense` | `tripExpenses`, `tripExpenseSplits`, `tripExpenseBalances` |
| Shared Stash expense | `recordSharedStashExpense` / `reverseSharedStashExpense` | `tripExpenses`, `tripMemberOwnership` |
| Settlements | `recordTripSettlement` / `reverseTripSettlement` | `tripSettlements`, `tripExpenseBalances` |
| Leave Trip | `leaveTrip` | `trips.memberIds`, `tripMembershipDepartures` |
| Remove Member | `removeTripMember` | `trips.memberIds`, `tripMembershipDepartures` |

Migration/admin scripts (none exported, none callable from any client):
`functions/src/admin/migrateTripOwnership.ts`, `reconcileTripOwnership.ts`,
`migrateTripExpenseBalances.ts` — all single-Trip, dry-run-default, Admin-SDK-only,
crash-recovery-safe.

| Capability | Committed | Known deployed (live-verified, §5) | Deployment required? |
|---|---|---|---|
| Buckets / lookup / Terms / savings / Shared Stash expense/reversal / invitation creation (7 unaffected Functions) | Yes | **Yes, current code** | No |
| Invitation preview + acceptance | Yes | **Yes, current code** | No |
| Trip creation, out-of-pocket expense, settlements (5 Functions) | Yes | **Yes, but STALE code — live revision predates Checkpoint 6.7A** | **Yes — redeploy, not first deploy** |
| Leave Trip / Remove Member | Yes | **No** | **Yes — first deploy** |

**Correction from the first pass**: "known deployed" previously meant only "the
function name appears in `firebase functions:list`." That is necessary but not
sufficient evidence of code parity — see §5 for the per-function revision evidence that
overturns the original "14 of 16 already deployed, only 2 remain" conclusion.

## 5. Live Functions inventory (Phase 3, read-only)

`firebase functions:list --project squadstash-6d0f1` (read-only metadata call; no
callable invoked, no document read/written):

```
acceptTripInvitation      v2  callable  us-central1  256MB  nodejs22
createBucket               v2  callable  us-central1  256MB  nodejs22
createTrip                 v2  callable  us-central1  256MB  nodejs22
createTripInvitation       v2  callable  us-central1  256MB  nodejs22
getTripInvitationPreview   v2  callable  us-central1  256MB  nodejs22
lookupUserByEmail          v2  callable  us-central1  256MB  nodejs22
publishTripTerms           v2  callable  us-central1  256MB  nodejs22
recordSavingsTransaction   v2  callable  us-central1  256MB  nodejs22
recordSharedStashExpense   v2  callable  us-central1  256MB  nodejs22
recordTripExpense          v2  callable  us-central1  256MB  nodejs22
recordTripSettlement       v2  callable  us-central1  256MB  nodejs22
reverseSharedStashExpense  v2  callable  us-central1  256MB  nodejs22
reverseTripExpense         v2  callable  us-central1  256MB  nodejs22
reverseTripSettlement      v2  callable  us-central1  256MB  nodejs22
```

**14 Functions deployed — 2 more than the October 22 document's own confirmed baseline
of 12.** `acceptTripInvitation` and `getTripInvitationPreview`, which that document
explicitly confirmed were undeployed, are now live. **This presence listing alone
proves only that a Function with that name exists — not that its deployed revision
contains current HEAD's code.** That distinction is exactly what this amendment
corrects below.

**Step 1 — which currently-exported Functions changed after the live deployment.**
`git log --oneline --name-only` (actually `git show --stat` per-commit, to avoid a
truncation risk in the combined log) across every commit after the pre-deploy freeze
point (`52a73c6`, 2026-10-22, the commit immediately preceding the October 23 deploy
evidenced in §6) touching `functions/src/callables/*`, shared domain modules, or
`functions/src/index.ts`:

```
8d0f67c / afe113c / f1fe5ed / 1927b33 / 0299f94 / aada44a  (Oct 26-28, client-only UI commits)
  -> zero functions/ changes

102079a Add Trip expense balance foundation (2026-10-28T22:14:13-05:00)
  -> functions/src/callables/createTrip.ts            (+19/-6 relevant lines)
  -> functions/src/callables/recordTripExpense.ts      (+56)
  -> functions/src/callables/recordTripSettlement.ts   (+48)
  -> functions/src/callables/reverseTripExpense.ts     (+143/-?)
  -> functions/src/callables/reverseTripSettlement.ts  (+103/-?)
  -> functions/src/domain/tripExpenseBalance*.ts        (new files)
  -> functions/src/admin/migrateTripExpenseBalances.ts  (new, never exported)

811c1f3 Add trusted trip member departure backend (2026-10-28T23:37:52-05:00)
  -> functions/src/callables/leaveTrip.ts              (new)
  -> functions/src/callables/removeTripMember.ts       (new)
  -> functions/src/callables/tripMembershipDepartureCore.ts (new)
  -> functions/src/index.ts                            (+2 exports)

884452d Close out obsolete former-member residual recovery (2026-10-29T00:22:18-05:00)
  -> functions/src/callables/tripMembershipDepartureCore.ts (comment/logic tidy only)
  -> functions/src/domain/tripMembershipDeparture.ts

81d34a3 Add trip member departure UI (2026-10-29T20:13:29-05:00)
  -> zero functions/ changes (client-only)
```

No other exported callable (`createBucket`, `createTripInvitation`,
`lookupUserByEmail`, `publishTripTerms`, `recordSavingsTransaction`,
`recordSharedStashExpense`, `reverseSharedStashExpense`, `acceptTripInvitation`,
`getTripInvitationPreview`) was touched by any commit after the freeze point — this
search was not limited to newly-exported Functions, and found none beyond the five
named above plus the two brand-new departure Functions.

| Exported Function | Changed after live deploy? | Relevant commit(s) | Why it changed | Redeploy required? |
|---|---|---|---|---|
| `createTrip` | **Yes** | `102079a` | Now initializes `expenseBalanceModelState`/`Version` on every new Trip | **Yes** |
| `recordTripExpense` | **Yes** | `102079a` | Now maintains `tripExpenseBalances` on out-of-pocket expense creation | **Yes** |
| `reverseTripExpense` | **Yes** | `102079a` | Now maintains `tripExpenseBalances` on expense reversal | **Yes** |
| `recordTripSettlement` | **Yes** | `102079a` | Now maintains `tripExpenseBalances` on settlement | **Yes** |
| `reverseTripSettlement` | **Yes** | `102079a` | Now maintains `tripExpenseBalances` on settlement reversal | **Yes** |
| `leaveTrip` | N/A (new) | `811c1f3` | New capability | **Yes (first deploy)** |
| `removeTripMember` | N/A (new) | `811c1f3` | New capability | **Yes (first deploy)** |
| `createBucket`, `createTripInvitation`, `lookupUserByEmail`, `publishTripTerms`, `recordSavingsTransaction`, `recordSharedStashExpense`, `reverseSharedStashExpense` | No | — | Untouched since before the live deploy | No |
| `acceptTripInvitation`, `getTripInvitationPreview` | No (since their own deploy) | — | Untouched since `102079a`/`811c1f3`/`884452d` | No |

**Step 2 — live Function revision metadata, per-Function, read-only
(`gcloud functions describe <name> --gen2 --region=us-central1 --project=squadstash-6d0f1`,
a metadata read — no invocation, no document access):**

| Function | Live `updateTime` | Live revision | Latest source commit before that `updateTime` | Does live revision contain `102079a`? |
|---|---|---|---|---|
| `createTrip` | `2026-10-16T03:16:24Z` | `createtrip-00001-tiw` | `3aed553` (2026-10-15) | **No** |
| `recordTripExpense` | `2026-10-01T03:47:44Z` | `recordtripexpense-00004-jed` | `34863df` (2026-09-18) | **No** |
| `recordTripSettlement` | `2026-10-01T03:47:56Z` | `recordtripsettlement-00002-gab` | `fc9fa6a` (2026-09-28) | **No** |
| `reverseTripExpense` | `2026-10-05T02:47:28Z` | `reversetripexpense-00003-wut` | `2042e9e` (2026-10-04) | **No** |
| `reverseTripSettlement` | `2026-10-01T03:47:58Z` | `reversetripsettlement-00002-lac` | `fc9fa6a` (2026-09-28) | **No** |
| `acceptTripInvitation` | `2026-10-23T02:27:29Z` | `accepttripinvitation-00001-biw` | `febf001`/`f55fec5` (2026-10-18/19) | N/A — matches, no later change |
| `getTripInvitationPreview` | `2026-10-23T02:27:37Z` | `gettripinvitationpreview-00001-jil` | `f55fec5` (2026-10-19) | N/A — matches, no later change |
| `createBucket` (control sample) | `2026-10-01T03:47:44Z` | `createbucket-00003-xiy` | unchanged since before baseline | N/A — unaffected |

**Every one of the five financial Functions' live `updateTime` predates `102079a`'s
commit timestamp (2026-10-28T22:14:13-05:00 / 2026-10-29T03:14:13Z UTC) by 12 to 27
days.** `acceptTripInvitation`/`getTripInvitationPreview`'s live `updateTime`s
(2026-10-23T02:27Z) land exactly where expected: after their own introducing commits
and consistent with the October 23 deploy window evidenced by the Rules `updateTime` in
§6 (2026-10-23T03:08:03Z, ~40 minutes later) — and no commit has touched either of
their source files since, so no further action is needed for them. **This is read-only,
directly-observed revision metadata, not an inference from commit history.**

No stronger immutable build/source identifier beyond `updateTime` + revision name +
`buildConfig.sourceProvenance.resolvedStorageSource.generation` was found necessary or
available via this read-only describe call; the revision-name ordinal (e.g.
`recordtripexpense-00004`) independently corroborates that each Function has been
redeployed only as many times as its own commit history before the relevant
`updateTime` would predict, with no redeploy since.

| Function | In source | Live production (name) | Live revision matches HEAD? | Action required |
|---|---|---|---|---|
| `createTrip` | Yes | Yes | **No — stale** | **Redeploy** |
| `recordTripExpense` | Yes | Yes | **No — stale** | **Redeploy** |
| `recordTripSettlement` | Yes | Yes | **No — stale** | **Redeploy** |
| `reverseTripExpense` | Yes | Yes | **No — stale** | **Redeploy** |
| `reverseTripSettlement` | Yes | Yes | **No — stale** | **Redeploy** |
| `acceptTripInvitation` | Yes | Yes | Yes | None |
| `getTripInvitationPreview` | Yes | Yes | Yes | None |
| `leaveTrip` | Yes | **No** | — | **Deploy (new)** |
| `removeTripMember` | Yes | **No** | — | **Deploy (new)** |
| (7 other unaffected Functions) | Yes | Yes | Yes | None |

No obsolete production Function (present live but absent from source) was found.

## 6. Live Rules inventory (Phase 3, read-only)

Method: identical to the October 22 document's frozen §4/§11 mechanism — an access
token from the already-authenticated active `gcloud` account
(`dano.fred11@gmail.com`), then:

```
GET https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/releases/cloud.firestore
GET https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/rulesets/{id}
```

Both are metadata/source-retrieval calls against the Rules **management** plane — no
Firestore document was queried, no callable invoked, no Rules content written.

**Result:**
- Active Release: `rulesetName: projects/squadstash-6d0f1/rulesets/5eb26f2c-66d4-40e7-99d5-2b31955ce186`,
  `createTime: 2025-10-28T00:35:31Z`, **`updateTime: 2026-10-23T03:08:03Z`**.
- This `updateTime` is **after** the October 22 document's own Ruleset `createTime`
  (`2026-10-16T05:23:27Z`) and after that document itself was written — direct
  confirmation that Rules were redeployed since that document was produced, consistent
  with the Functions finding in §5 (both evidently happened together).
- Ruleset ID also changed (`be6b9b70-...` → `5eb26f2c-...`), confirming a genuinely new
  Ruleset was published, not merely a Release pointer update.

**Byte-level comparison (CRLF-normalized) against current HEAD's `firestore.rules`:**
the diff is **exactly 58 lines**, consisting entirely of two new, fully-closed match
blocks present in HEAD but absent from the live Ruleset:

```
match /tripExpenseBalances/{balanceId} {
  allow read, write: if false;
}

match /tripMembershipDepartures/{departureId} {
  allow read, write: if false;
}
```

Everything else — including the 5C.2 `memberIds`-write closure, the
`tripMembershipAcceptances`/`tripInvitations` direct-write closures, and the 5C.6
`tripOwnershipReconciliationAttempts`/`tripOwnershipReconciliationControl` closures —
is **already live**, matching HEAD exactly.

| Rules element | Committed | Live | Action required |
|---|---|---|---|
| 5C.2 closure (`memberIds`, acceptance/invitation direct-write) | Yes | **Yes** | None |
| 5C.6 reconciliation-collection closure | Yes | **Yes** | None |
| `tripExpenseBalances` (6.7A, deny-all) | Yes | **No** | **Deploy** |
| `tripMembershipDepartures` (6.7B1, deny-all) | Yes | **No** | **Deploy** |

**Reconfirmed, unchanged by this amendment**: this Rules conclusion rests on an actual
byte-level diff of the retrieved live Ruleset source (§6 above), not on function/rule
*name* presence — it is not subject to the same "presence ≠ current code" flaw §5
found in the Functions analysis, since Rules have no separate "revision" concept
distinct from the Ruleset content itself. The Ruleset *is* its own content; there is no
analogous staleness risk once the source bytes are directly compared. See §8 for why
Rules deployment timing relative to the corrected Functions delta still matters.

## 7. Exact source-vs-production delta (Phase 2)

Commits touching `firestore.rules` since the last-known-deployed baseline
(`20c1760`), confirmed by `git log --oneline 20c1760..HEAD -- firestore.rules`:

```
884452d Close out obsolete former-member residual recovery   — comment-only edit to the
                                                                 6.7B1 match block; no
                                                                 rule behavior change
811c1f3 Add trusted trip member departure backend             — adds tripMembershipDepartures
                                                                 (deny-all)
102079a Add Trip expense balance foundation                   — adds tripExpenseBalances
                                                                 (deny-all)
160e32b Add multi-member reversal and reconciliation hardening — ALREADY LIVE (§6)
6d19266 Close direct Trip membership authority paths           — ALREADY LIVE (§6)
```

Direct inspection of each diff (`git show <sha> -- firestore.rules`) confirms: `102079a`
and `811c1f3` each add one new `match` block, both `allow read, write: if false`;
`884452d` only edits the comment text inside the `811c1f3` block (closing out the
originally-planned 6.7B2 residual-recovery feature in prose) — **no rule behavior
changed in `884452d`**.

**These two Rules additions must be deployed together or not at all** in the practical
sense that they belong to the same checkpoint and ship alongside the Functions that are
the only writers of each collection — there is no technical Firestore-level ordering
requirement between them (the Admin SDK bypasses Rules entirely, and `onCall` Functions
are independent of Rules deployment), but shipping them separately has no benefit.

**Corrected answer (supersedes the first pass): what exactly differs between committed
source and live production is NOT limited to Functions/Rules that are entirely absent
from the live environment.** Per §5's revision evidence, it is:

- **Two brand-new Functions**: `leaveTrip`, `removeTripMember` (absent from live
  entirely).
- **Five already-deployed Functions running stale code**: `createTrip`,
  `recordTripExpense`, `recordTripSettlement`, `reverseTripExpense`,
  `reverseTripSettlement` — present live, but their live revision predates `102079a`
  and therefore does not maintain `tripExpenseBalances` or initialize it on new Trips.
- **Two new, fully-closed Rules match blocks**: `tripExpenseBalances`,
  `tripMembershipDepartures`.

**The first pass's "exactly two Functions, nothing else" conclusion was incorrect** —
it inferred code parity from `firebase functions:list`'s name-presence output alone,
which `functions:list` does not and cannot prove. The corrected delta is **seven**
Functions plus the same two Rules blocks.

## 8. Migration / data compatibility audit (Phase 4, read only — no production document was read)

**Reassessed against the corrected seven-Function delta (§5/§7).** Three distinct
concerns, kept explicitly separate per the review's own framing:

**A. Function deployment prerequisite** — existing Functions required to keep
aggregates correct *going forward*, independent of any historical Trip's data.

**B. Historical Trip migration** — per-Trip initialization/backfill of existing data
via the offline admin scripts.

**C. Departure availability** — whether a *particular* Trip can use Leave/Remove today.

These are genuinely different gates, and the first pass's single "no migration needed"
conclusion blurred B and C into one statement without ever separating out A. Restated:

1. **Does every existing production Trip need `ownershipModelState`/
   `expenseBalanceModelState` initialized before current Functions can safely operate
   (category A)?** **No.** `recordSavingsTransaction`, `recordSharedStashExpense`,
   `reverseSharedStashExpense`, and — once redeployed — `recordTripExpense`,
   `reverseTripExpense`, `recordTripSettlement`, `reverseTripSettlement` all treat a
   `"legacy"` Trip's model state (including a Trip where the field is entirely absent —
   confirmed by direct read of `classifyTripExpenseBalanceModelState`: `state ===
   undefined` classifies identically to `state === "legacy"`) as an explicit,
   documented safe no-op: "legacy preserves today's exact behavior unchanged (no
   aggregate write, no rejection)" (comment at `recordTripExpense.ts:540`). **This is
   true of the corrected source on HEAD; it was NOT true of the live, undeployed
   revisions found stale in §5 only in the sense that those live revisions don't yet
   know about `expenseBalanceModelState` at all — they don't fail, they simply don't
   maintain the new aggregate, which is category A's actual concern, addressed next.**
2. **Does deploying the five redeployed Functions require migrating any existing Trip
   first (category A vs. B)?** **No.** The five Functions' own `"legacy"`/missing-field
   handling is unconditionally safe — redeploying them does not require any Trip to be
   pre-migrated. What redeploying them *does* accomplish, which is the actual reason
   they must ship, is ensuring that from the moment they're live, every new expense/
   settlement/Trip-creation event correctly maintains (or correctly initializes)
   `tripExpenseBalances` for Trips that are, or later become, `"initialized"`. Without
   this redeploy, **a Trip migrated to `"initialized"` for the expense-balance model
   (category B) would have its aggregate immediately go stale** the next time any live
   (currently-stale) Function processed a real expense or settlement on it, since that
   live code has no knowledge of the aggregate at all — it would neither update nor
   reject, it would simply skip maintaining a value `leaveTrip`/`removeTripMember`
   would later trust as authoritative.
3. **Which callables lazily initialize, require already-initialized state, or hard-fail
   on legacy (category C)?** Financial callables (once redeployed): lazy-safe no-op on
   legacy/missing, hard-fail-closed only on a genuinely corrupt/unsupported state.
   Departure callables (`leaveTrip`/`removeTripMember`): hard-require `"initialized"`
   on **both** models; `"legacy"`/missing or `"blocked"` (migrating/
   needs_reconciliation) both fail closed with a clean, safe error.
4. **Are the admin migration scripts (category B) dry-run capable, production-safe,
   idempotent, individually authorized, and when are they required?** All three
   (`migrateTripOwnership.ts`, `reconcileTripOwnership.ts`,
   `migrateTripExpenseBalances.ts`) are: single-Trip-only, dry-run-the-default,
   Admin-SDK-only (never exported, never `onCall`, never reachable from client code),
   and explicitly designed for crash recovery / safe resumption. Each requires an
   explicit, separate, unambiguous invocation per Trip to apply. **They remain required
   only per-Trip, on demand** (category B) — not as a prerequisite for the Function/
   Rules deployment itself (category A) — but only **once the five redeployed
   Functions are actually live**, since running `migrateTripExpenseBalances.ts` against
   a Trip and then having the next real expense hit a stale, non-aggregate-aware
   `recordTripExpense` would immediately desynchronize the aggregate it just backfilled.
   **Correct order: A (redeploy the five) before B (migrate any specific Trip) before
   that Trip's Leave/Remove availability (category C), which additionally requires
   `leaveTrip`/`removeTripMember` themselves to have been deployed and verified live —
   a separate, one-time, global precondition, not itself an A, B, or C step, and not
   satisfied by migration alone.**
5. **Could deploying the corrected Function set before any migration break an existing
   single-member Trip flow?** No — every existing flow's legacy/missing-field-safe
   no-op behavior is unchanged by the redeploy itself; the redeploy only adds new,
   gated behavior that activates exclusively for Trips already in `"initialized"`
   state, which is zero Trips until a migration (category B) is deliberately run.
6. **Could deploying current Rules before migration lock users out of valid legacy
   data?** No — both new match blocks only deny access to two collections that have no
   existing readers/writers, so denying client access to them removes nothing anyone
   currently has. Unaffected by this amendment.

**No production Firestore document was read to determine how many production Trips are
currently in `"legacy"`/missing-field state** — that would require a live data query
beyond this preflight's read-only-metadata scope. Given §5's finding that the live
`createTrip` has not deployed since 2026-10-16 and never wrote
`expenseBalanceModelState` at all, **it is reasonable to infer, without querying
document data, that every Trip created at any point up to today is currently missing
this field** (classified identically to `"legacy"`) — not merely Trips created before
some older cutoff. This remains an open operational question for whoever runs the
eventual per-Trip migration — see §15.

**Safe order (category A → B → C), supported by the evidence above:**
```
1. Deploy all five 6.7A aggregate-maintaining/initializing Function revisions
   (createTrip, recordTripExpense, reverseTripExpense, recordTripSettlement,
   reverseTripSettlement) — category A. Safe immediately; no Trip is pre-migrated.
2. Deploy leaveTrip / removeTripMember — new capability, inert until a Trip reaches
   "initialized" state on both models.
3. Deploy the two deny-all Rules blocks (tripExpenseBalances, tripMembershipDepartures)
   — additive, no existing path narrowed.
4. Existing (effectively all) Trips remain fully safe but cannot use Leave/Remove until
   migrated (category B) — not a defect, a documented, deliberate gate.
5. Migrate individual Trips only when intentionally authorized, per-Trip, via the
   offline admin scripts — category B, strictly after step 1 is live, never before.
6. A given Trip's members can actually use Leave/Remove (category C) only once BOTH
   are true: its migration (step 5) has completed, AND `leaveTrip`/`removeTripMember`
   (step 2) are deployed and verified live. Migration alone does not enable the
   callable; the callable's own deployment is step 2 above, not a byproduct of step 5.
```
This is the order the review's own prompt proposed as a hypothesis; the evidence above
supports adopting it, with step 1 now evidenced as a genuine prerequisite (not merely a
good idea) for step 5 to ever produce a trustworthy aggregate.

## 9. Client-distribution CASE status (Phase 5)

Re-inspected, read-only:
- `app.json` — unchanged from October 22: no `extra.eas.projectId`, no `owner`, no
  `ios.bundleIdentifier`/`android.package`, no `updates`/`runtimeVersion` block.
- No `eas.json` anywhere in the repository.
- No `app.config.js`/`app.config.ts` anywhere in the repository.
- `.github/workflows/ci.yml` — re-checked for `eas build`/`eas submit`/`eas update`/
  `expo publish`/`firebase deploy`: **zero matches**, unchanged from October 22.

**No new repository evidence exists to resolve CASE D.** Classification remains
**CASE D** — repository inspection alone proves absence of distribution
*configuration*, not absence of all historical distribution.

**New contextual observation, not a resolution:** the higher-risk part of the already-
executed deploy (§5/§6) — the 5C.2 Rules closure, which removed the previously-live
direct client write path for `memberIds`/`tripMembershipAcceptances`/direct invitation
acceptance — has already shipped to production. Whoever performed that deploy either
confirmed CASE A/B first (outside this repository's own tracked process — no execution
record exists, see §14) or deployed without that confirmation. This repository cannot
tell which. **This is suggestive, not proof,** that no still-dependent old client
exists — it should be asked of Daniel directly, not inferred.

**What external fact is needed to resolve this:** confirmation from whoever owns any
App Store Connect/Google Play Console/EAS account this product may have (or an
authoritative statement that none has ever existed), and/or confirmation of whether the
October 23 deploy was preceded by an actual Phase C determination that simply wasn't
documented.

**Consequence for the remaining delta specifically:** unlike the already-deployed 5C.2
Rules closure, the two **remaining** undeployed Rules additions
(`tripExpenseBalances`, `tripMembershipDepartures`) do not close any existing path —
both are brand-new, fully-denied collections with no current reader or writer. By the
same "additive deploys cannot be made unsafe by an unknown client population" reasoning
the October 22 document already applies to Functions deployment (§8 there), **this
specific remaining Rules delta is not obviously blocked by CASE D** — it removes no
capability any client, old or new, could already depend on. This is a narrower,
evidence-specific conclusion about *this* delta only; it does not reopen or re-litigate
the already-shipped 5C.2 closure, and it is not a license to treat future Rules changes
as automatically CASE-D-exempt.

**Extended by this amendment to the corrected Function delta (§5/§7):** the same
reasoning applies to redeploying `createTrip`/`recordTripExpense`/
`recordTripSettlement`/`reverseTripExpense`/`reverseTripSettlement`. Each one's new
behavior is strictly additive and gated — it only activates for a Trip already (or
later) in `"initialized"` expense-balance-model state, which is zero Trips at deploy
time (§8). A redeploy whose new code path is provably inert for every currently-live
client, old or new, cannot be made unsafe by an unresolved CASE D — **this redeploy is
not blocked by CASE D either**, for the same reason Functions deployment generally
isn't (§8 of the October 22 document).

## 10. Updated rollout sequence (Phase 6)

**Materially revised by this amendment.** The first pass's Phase 2 ("targeted backend
Functions deploy: exactly `leaveTrip`/`removeTripMember`") is now split into two
phases, in strict order, per §8's category A-before-B-before-C finding: the five
aggregate-maintaining redeploys MUST complete and be verified live before
`leaveTrip`/`removeTripMember` deploy — deploying departure first would let a Trip be
migrated (category B) onto an aggregate that live (stale) Functions would then silently
fail to keep correct.

```
PHASE 1 — Pre-deployment gate (read-only verification)
  Prerequisites: none beyond current repo state.
  Scope: confirm git status clean, HEAD == origin, regression suites pass.
  Verification commands (read-only):
    git status --short
    git rev-parse HEAD
    npm --prefix functions run build
    firebase emulators:exec --only firestore "npm --prefix functions test"
    npm test -- --silent
    npm run test:rules
  STOP if: any command fails, or working tree/HEAD has drifted since this document.
  Rollback implication: none — nothing deployed yet.

PHASE 2 — Redeploy the five 6.7A aggregate-maintaining/initializing Functions
  (NEW phase, added by this amendment — supersedes treating these as "already live")
  Prerequisites: Phase 1 clean.
  Scope: exactly createTrip, recordTripExpense, recordTripSettlement,
         reverseTripExpense, reverseTripSettlement. Never a bare `firebase deploy` or
         `firebase deploy --only functions`.
  FUTURE COMMAND — DO NOT RUN DURING PREFLIGHT:
    firebase deploy --only functions:createTrip,functions:recordTripExpense,functions:recordTripSettlement,functions:reverseTripExpense,functions:reverseTripSettlement --project squadstash-6d0f1
  Expected result: each of the five shows a NEW revision (e.g. `createtrip-00002-...`)
         and a live `updateTime` at or after the actual deploy time.
  Verification command (read-only, same per-function method as §5):
    gcloud functions describe createTrip --gen2 --region=us-central1 --project=squadstash-6d0f1 --format="value(updateTime,serviceConfig.revision)"
    (repeat for each of the five)
  STOP if: any of the five does not show a new revision/updateTime after the deploy, or
           any OTHER Function's shape/behavior changes as a side effect.
  Rollback implication: additive and gated — the new aggregate-maintenance code is
         inert for every Trip not already `"initialized"` (zero Trips at this point,
         per §8), so this redeploy cannot regress any currently-live flow. If
         verification fails, redeploy the immediately-prior build for the affected
         Function(s) (available from their own git history, §5) under separate
         explicit authorization.

PHASE 3 — Targeted backend Functions deploy: leaveTrip / removeTripMember
  Prerequisites: Phase 2 verified live (all five redeployed and confirmed). Never
         started before Phase 2 completes — this ordering is the core correctness
         finding of this amendment (§1/§8).
  Scope: exactly the two new, self-contained departure Functions.
  FUTURE COMMAND — DO NOT RUN DURING PREFLIGHT:
    firebase deploy --only functions:leaveTrip,functions:removeTripMember --project squadstash-6d0f1
  Expected result: 16 Functions live total.
  Verification command (read-only):
    firebase functions:list --project squadstash-6d0f1
  STOP if: any previously-deployed Function's shape changes, or any Function beyond
           these two is affected.
  Rollback implication: additive; leaving the two Functions in place while withholding
           later phases is safe, per the same reasoning §19 of the October 22 document
           already established for this class of deploy.

PHASE 4 — Firestore Rules deploy (the two new deny-all collections)
  Prerequisites: Phase 3 verified live.
  Scope: the full current `firestore.rules`, which — per §6 — differs from the live
         Ruleset by exactly the two new fully-closed match blocks.
  FUTURE COMMAND — DO NOT RUN DURING PREFLIGHT:
    firebase deploy --only firestore:rules --project squadstash-6d0f1
  Expected result: a new Ruleset whose content exactly matches current HEAD's
         `firestore.rules` (CRLF-normalized).
  Verification command (read-only, same mechanism as §6):
    TOKEN=$(gcloud auth print-access-token)
    curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: squadstash-6d0f1" \
      "https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/releases/cloud.firestore"
    curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: squadstash-6d0f1" \
      "https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/rulesets/{id}"
  STOP if: the retrieved source does not exactly match current HEAD's `firestore.rules`
           after CRLF normalization, or any unexpected pre-existing rule is affected.
  Rollback implication: near-instantly revertible — redeploy the immediately-prior
           Ruleset's source (available via `git show <sha>:firestore.rules` at the
           commit before this deploy) via the identical deploy command.

PHASE 5 — Propagation-safety gate
  Prerequisites: Phase 4's E1 exact-match check has passed.
  Scope: wait at least 60 seconds after the deployed Release's own `updateTime` before
         relying on any fresh query/listener as Rules-enforcement evidence; use the
         10-minute bound instead if a pre-deployment listener is ever reused (preferred:
         avoid this entirely, use only fresh sessions).
  STOP if: the 60-second window has not elapsed, or a pre-deployment listener is
         proposed as evidence.

PHASE 6 — Manual validation (§11 below)
  Prerequisites: Phases 2-5 complete.
  Scope: the membership-departure-specific manual checks in §11, using fresh,
         post-Phase-5 sessions. No financial transaction of any kind — see §11's
         corrected validation-strategy split.

(Separately, whenever intentionally authorized, not gated to any specific phase above
beyond "after Phase 2 is live"): per-Trip migration via the offline admin scripts
(category B, §8) — never a phase of this rollout itself, always a distinct, individually
authorized, per-Trip action.
```

**Phase 2 must precede Phase 3** — this is the one new hard ordering requirement this
amendment introduces, and it is NOT a Firestore/Rules-level technical constraint (the
Admin SDK still bypasses Rules regardless of order); it is a **data-integrity**
constraint: deploying `leaveTrip`/`removeTripMember` before the five aggregate-
maintaining Functions would make it possible to migrate a Trip (category B) to
`"initialized"` and then have that Trip's very next real expense/settlement processed
by stale code that silently fails to keep the aggregate correct, corrupting the exact
value departure would later trust as authoritative. **No technical ordering
requirement exists between Phase 4 (Rules) and Phases 2/3** — the Admin SDK bypasses
Rules in either direction — but Phase 4 is sequenced last here to match the
already-established precedent from the October 2026 deploy (§5/§6 found Functions and
Rules live together).

**No client distribution/update phase is proposed** — this remaining delta requires no
client source change (the client-side `leaveTrip`/`removeTripMember` wrappers already
ship in 6.7C, and nothing about the new Rules or the five redeployed Functions closes a
path any client, old or new, could depend on — §9).

## 11. Manual validation matrix (Phase 6) — corrected validation-strategy split

**The first pass contained a genuine contradiction**, flagged by the review: it
required verifying the ownership/balance-blocking behavior, then separately stated a
Phase 5/STOP condition that any manual check requiring a financial transaction halts
the rollout — but there was no way to observe a nonzero-balance block in production
without creating the exact nonzero balance that the STOP condition forbids. This is
corrected by explicitly splitting *where* each kind of check is proven, rather than by
weakening either requirement:

**Already proven, emulator/local integration — never to be re-proven in production
with real money (same principle as the October 22 document's §20):** every
nonzero/negative/malformed-ownership-or-balance blocking scenario is already covered by
the existing, passing emulator test suite, confirmed by direct read of
`functions/test/leaveTripCore.ts`:
```
"positive target ownership blocks departure"
"zero target ownership (explicit row) passes"
"absent target ownership row + full set reconciling passes"
"absent target ownership row + full set NOT reconciling blocks"
"a malformed ownership row blocks departure"
"ownership model \"legacy\" blocks departure"
"ownership model \"migrating\" blocks departure"
"ownership model \"needs_reconciliation\" blocks departure"
"an unsupported ownership model version fails closed"
"positive target balance blocks departure"
"negative target balance blocks departure"
"zero target balance (explicit row) passes"
"absent target balance row + valid zero-sum aggregate passes"
```
(`removeTripMemberCore.ts`/`tripMembershipDepartureConcurrency.ts` cover the equivalent
removal/concurrency scenarios.) **Production manual validation must not attempt to
recreate any of this** — it is already authoritatively proven, and manufacturing a
real nonzero balance in production purely to re-observe a block that's already proven
would itself violate the "no financial-transaction-manufacturing-for-test-state" STOP
condition.

**Production manual validation (Phase 6), scoped exclusively to deployment presence,
authorization, and Rules enforcement — never financial-economics re-proof:**
- Use a disposable, newly-created, non-financial test Trip (mirroring the October 22
  document's §15 Option A for Phase F) with **zero** expense/settlement/Shared-Stash
  activity, so the success path is trivially reachable without manufacturing any
  balance.
- An eligible member (on this zero-activity Trip, by construction) can leave; the owner
  cannot leave; the owner can remove an eligible non-owner member; the owner cannot be
  removed.
- Departure behaves identically on an archived Trip (not gated on archive state) — can
  be checked on the same disposable Trip after archiving it, still zero-activity.
- A departed member loses Trip read/write access for all Rules-gated listeners once
  `memberIds` no longer contains their uid.
- Historical expense/settlement/invitation records (if any exist on an already-real,
  pre-existing, already-settled Trip Daniel separately identifies as safe to use —
  never manufactured for this purpose) remain intact after a departure elsewhere.
- Rejoin remains unavailable (expected, documented limitation — not a defect to find).
- A **pre-6.7A ("legacy"/missing-field) Trip**: attempting to leave/remove on it
  returns the clean "not yet ready for departure" error. Given §8's finding that this
  is effectively every current production Trip until migrated, this check can use any
  real, already-existing Trip — it only needs to observe a clean rejection, never a
  success, so no financial state needs to be created or disturbed for it.

**Never performed in production, under any circumstance, to satisfy this matrix**:
creating a real expense, settlement, Shared Stash contribution, or withdrawal solely to
produce a nonzero balance to test blocking. If that specific production behavior ever
needs re-verification beyond what the emulator suite already proves, it requires its
own, separately-authorized, explicit production test-data procedure — not a casual
step inside this rollout's manual validation.

Expected Firestore effects: `trips.memberIds` loses exactly the departed uid; exactly
one `tripMembershipDepartures/{tripId}_{uid}` document is created (fully Rules-closed,
not independently readable by any client); no `tripMemberOwnership` or
`tripExpenseBalances` row changes as a result of departure itself (both must already be
at zero).

## 12. Rollback strategy (Phase 7)

- **Phase 2 (the five redeploys) succeeds, verification fails**: because the new
  aggregate-maintenance code is inert for every currently-`"legacy"`/missing-field Trip
  (§8 — effectively all of them today), leaving the five redeployed Functions in place
  while withholding Phase 3 is safe and cannot regress any currently-live flow. A
  genuine rollback, if needed, means redeploying each affected Function's immediately-
  prior build (available from its own git history in §5) under separate, explicit
  authorization.
- **Phase 3 (`leaveTrip`/`removeTripMember`) succeeds, verification fails**: leave them
  deployed-but-unused (additive; cannot break anything currently working, since no
  Trip can reach `"initialized"` on both models without a deliberate category-B
  migration) while withholding the Rules deploy. Rollback: redeploy a prior build or an
  explicit `firebase functions:delete leaveTrip removeTripMember --project
  squadstash-6d0f1` under separate, explicit authorization.
- **Phase 4 (Rules) succeeds, verification fails**: redeploy the immediately-prior
  Ruleset's source (the current live Ruleset, captured in §6, or `git show
  <pre-deploy-sha>:firestore.rules`) via the same deploy command; confirm via the §6
  management-plane method that the rollback took effect.
- **Functions (Phases 2-3) deployed, Rules (Phase 4) not yet deployed**: safe, stable
  intermediate state — the callables' own trusted writes bypass Rules via the Admin SDK
  regardless, so there is no inconsistency.
- **Rules (Phase 4) deployed, Functions (Phases 2-3) not yet deployed**: equally safe —
  the new deny-all match blocks have no effect on any currently-live capability.
- **Phase 2 deployed, Phase 3 skipped or delayed indefinitely**: also safe and stable —
  this is in fact the expected resting state if Daniel chooses to ship the aggregate
  foundation now and defer the departure feature itself; the five redeployed Functions
  provide no new capability to any client until `leaveTrip`/`removeTripMember` exist.
- **Phase 3 deployed before Phase 2 (the ordering error this amendment exists to
  prevent)**: if this were ever to happen regardless, and a Trip were separately
  migrated (category B) to `"initialized"` in that window, its aggregate could
  silently desynchronize the next time a stale financial Function processed real
  activity on it. Recovery would require re-running `migrateTripExpenseBalances.ts` in
  `--resume`/recompute mode against that specific Trip once Phase 2 actually lands, to
  re-derive the aggregate from the Trip's own immutable history — the tool is
  documented as safe for exactly this recovery case (§8, `migrateTripExpenseBalances.ts`
  header). This is a reason to enforce the Phase 2-before-3 ordering strictly, not
  evidence that recovery is impossible if it's ever violated.
- **One or more redeployed/new Functions fail after deployment**: isolate via
  `firebase functions:log <name>`; because the five redeploys only add new, gated
  behavior (inert for `"legacy"`/missing Trips) and `leaveTrip`/`removeTripMember` are
  self-contained, a defect in one cannot cascade into any unrelated capability.
- **A membership-departure defect is discovered post-deployment**: treat as a backend-
  logic correctness finding, not an infrastructure problem — halt further production
  use of the specific affected path, preserve evidence, fix-and-reverify. No
  irreversible state is created by a single failed departure attempt (the whole
  operation is one atomic transaction).

**No rollout step in this corrected delta is irreversible without data repair** — the
one case requiring repair (Phase 3-before-2 plus an intervening migration) is
recoverable via the existing, already-designed-for-this admin tooling, not a dead end.

## 13. Stop/go criteria

**GO**, scoped to:
- Phase 2 (redeploy the five aggregate-maintaining Functions): unconditionally
  additive and gated-inert for every currently-live Trip — not blocked by CASE D, per
  §9's extended reasoning.
- Phase 3 (`leaveTrip`/`removeTripMember` deploy): additive — not blocked by CASE D —
  **but must not begin until Phase 2 is verified live** (§8/§10's new ordering
  requirement; this is a correctness gate, not a CASE D gate).
- Phase 4 (Rules deploy): additive by the specific evidence in §9 (denies access only
  to two not-yet-existent collections) — **recommended as safe to proceed without
  first resolving CASE D**, a narrower conclusion than the original document reached
  about the (already-shipped) 5C.2 closure, and not to be generalized beyond this
  specific delta.

**STOP conditions** (any one halts progression):
- Working tree not clean, or local HEAD != origin HEAD, at the time of actual
  deployment.
- `firebase functions:list` and the per-function `gcloud functions describe` revision
  check at deploy time show a different live-Functions baseline than §5's confirmed
  state (14 present, 5 of those stale, 2 absent).
- Phase 3 is about to begin and Phase 2's per-function revision check has not yet
  confirmed all five Functions show a new revision/updateTime — **this specific
  condition is the direct safeguard against the ordering error this amendment exists to
  prevent.**
- The live Ruleset at deploy time differs from §6's confirmed state (meaning another
  party deployed Rules changes between this document and the actual rollout).
- Any regression suite (`npm test`, `npm run test:rules`, Functions build/test) fails.
- The Rules deploy command targets anything beyond `firestore:rules`, or either
  Functions deploy command targets anything beyond its own named Functions.
- A Phase 6 manual check would require creating a real financial transaction
  (expense/settlement/contribution/withdrawal) purely to manufacture test state — per
  §11's corrected validation-strategy split, this should never be necessary, and its
  necessity appearing at deploy time is itself a signal something has gone wrong with
  the plan, not a normal step to work around.

## 14. SEC-004 / SEC-006 (Phase 9 — tracked, not fixed)

**SEC-004** (raw Firebase auth-error text shown on an unrecognized error code) —
**confirmed still live**, in both files:
- `app/(auth)/login.tsx:56-59` — `else setError(msg)` fallback, surfacing the raw
  `e.message` string.
- `app/(auth)/register.tsx:66-71` — identical pattern (`else setError(msg)`).

Neither file was modified. **Recommendation: complete during a separate, small
hardening checkpoint — not before this rollout, and not bundled into it.** It is
unrelated to the membership-departure delta, carries no risk to the rollout above, and
mixing it in would blur this checkpoint's single purpose. It is low-effort (replace the
fallback with one generic safe string, matching the exact pattern already used for
`leaveTrip`/`removeTripMember`'s own error mapping) whenever it's convenient to do.

**SEC-006** (`lookupUserByEmail` email-enumeration risk) — **confirmed still open and
still load-bearing**. Read `functions/src/callables/lookupUserByEmail.ts` directly:
requires authentication only (no rate limiting, no App Check); returns a clean
found/`not-found` signal distinguishing whether an email has an account. Confirmed via
repository-wide search that `components/trips/InviteTripMemberDialog.tsx` still calls it
directly as part of the live Trip-invitation flow — **it is not dead code scheduled for
removal; the current invitation architecture still depends on it.**
**Recommendation: same as SEC-004 — a separate, later hardening checkpoint** (e.g. add
App Check and/or a per-account rate limit), not a prerequisite for this rollout. Low
severity, pre-existing, unrelated to membership departure.

## 15. Open questions requiring Daniel's answer

1. **Was the October 23 Functions/Rules deploy (§5/§6) preceded by an actual Phase C
   client-distribution determination?** No execution record exists anywhere in
   `docs/audits/` for it — this repository cannot establish whether that was checked.
2. **Does any production-distributed client (App Store, Play Store, EAS, or otherwise)
   exist today, now or historically?** This is the fact needed to resolve CASE D to
   CASE A or CASE B, and no amount of further repository inspection can answer it.
3. **How many production Trips currently sit in `"legacy"`/missing-field ownership/
   expense-balance model state** — per §8, likely *all* of them, since `createTrip`
   hasn't deployed since 2026-10-16 — **and is there an intended operational process**
   (vs. ad hoc, per-request) for running the admin migration scripts against them once
   Phase 2 is live, so their members can eventually use Leave/Remove once `leaveTrip`/
   `removeTripMember` (Phase 3) are also deployed and verified live? This preflight
   deliberately did not query production Firestore document data to answer this
   itself.
4. Should the already-undocumented October 23 deploy be retroactively written up (even
   briefly) so the audit trail in `docs/audits/` reflects what's actually live, closing
   the gap this refresh found between "what the last tracked preflight assumed" and
   "what's actually in production"?
5. **New, this amendment**: should the project adopt a standing practice of checking
   per-function live revision metadata (not just `functions:list` presence) as a
   routine part of any future "what's deployed" preflight, given that this specific
   gap — five already-deployed Functions silently running stale code for over a
   week — was found only because this review explicitly asked for it, not because the
   first pass's own methodology would have surfaced it unprompted?

## 16. Final recommendation

```
READY FOR ROLLOUT-PLAN REVIEW — with the scope corrected by this amendment.

AMENDED 2026-11-04: the first pass's "exactly two Functions remain undeployed" claim
was wrong. It inferred code parity from firebase functions:list's name-presence
output, which proves a Function exists but not that its live revision matches current
HEAD. Direct, read-only, per-function revision metadata (gcloud functions describe)
now proves five already-deployed Functions - createTrip, recordTripExpense,
recordTripSettlement, reverseTripExpense, reverseTripSettlement - are running source
from 12-27 days before Checkpoint 6.7A (102079a) modified them to maintain the new
tripExpenseBalances aggregate. Their live updateTimes (2026-10-01 through 2026-10-16)
all predate that commit (2026-10-28/29). None has been redeployed since.

Corrected scope: SEVEN Functions require deployment (the five redeploys plus
leaveTrip/removeTripMember), not two, and the five redeploys MUST complete and be
verified live BEFORE leaveTrip/removeTripMember deploy - deploying departure first
would let a Trip be migrated onto an aggregate that live, stale Functions would then
silently fail to keep correct. This ordering constraint is the central new finding of
this amendment (§1/§8/§10).

The Rules finding is reconfirmed unchanged: exactly two new, fully-closed Firestore
match blocks (tripExpenseBalances, tripMembershipDepartures) remain undeployed,
established by an actual byte-level diff of the live Ruleset source - not subject to
the same presence-vs-code-parity flaw, since Rules content has no separate "revision"
to go stale independently of the source itself.

No production data migration is required before ANY of this deploys - every financial
callable's "legacy"/missing-field handling remains a safe no-op, confirmed extended to
the corrected five-Function set. The admin migration scripts (category B) remain
per-Trip, on-demand, and now explicitly sequenced to run only after the five redeploys
(category A) are live, so a migrated Trip's aggregate is never immediately
desynchronized by subsequent stale-code activity.

The manual-validation contradiction the review flagged is resolved by splitting
scope, not by relaxing either requirement: every nonzero/negative/malformed-balance
blocking scenario is already proven in the existing emulator test suite
(functions/test/leaveTripCore.ts, confirmed by direct read) and must never be
re-proven in production with real money; production validation is now scoped
exclusively to deployment presence, authorization, and Rules enforcement, using a
zero-activity disposable test Trip.

Production-client distribution remains CASE D, unresolved by repository evidence - 
unchanged by this amendment, and extended to cover the five redeployed Functions'
own additive/gated-inert nature (§9), not just the two new ones.

This document authorizes nothing beyond itself. The Phase 2/3/4 deployment commands
in §10 remain FUTURE COMMANDS, not executed here, pending Daniel's explicit review and
authorization - in particular of the five open questions in §15, especially whether
the October 23 deploy's own Phase C was ever actually performed, and whether a
standing practice of per-function revision verification should be adopted for future
preflights given what this one otherwise would have missed.
```

**Exact file changed by this amendment**:
`docs/audits/MULTI_MEMBER_PRODUCTION_ROLLOUT_PREFLIGHT_2026-10-29.md` (the only file
this checkpoint was authorized to modify).

No production mutation, deployment, migration, or financial transaction occurred as
part of producing this document or this amendment. No production Firestore document
was read or written. No production callable was invoked. A transient OAuth access
token was generated for this pass's own in-memory, read-only use (identical in kind to
the October 22 document's own §2 disclosure) and was never persisted, logged, or
printed.
