# Multi-Member Production Rollout — Preflight

**Status: PREFLIGHT / ROLLOUT ARCHITECTURE ONLY. Not implemented. Not deployed. Not
committed.**

**Revision note (this pass):** the original draft of this document asserted the 5C.2
Firestore Rules closure was "not yet deployed" and deferred the exact post-Rules
verification mechanism to "a future gate," without ever having actually inspected the
live, active production Rules Release/Ruleset. Both claims are now independently
verified, read-only, against the Firebase Rules management API — see §4. The original
draft also implicitly equated "current committed client source calls the trusted
callables" with "the production-distributed client already contains that cutover" —
these are not the same fact. **A further, final closure pass (this revision) found that
the second determination had itself overstated what repository inspection alone can
prove**: repository-only evidence can conclusively show no production-distribution
*configuration* exists in this repository today — it cannot, by itself, conclusively
prove no production-distributed client has *ever* existed anywhere (a client could in
principle have been manually built, released from another checkout, or distributed
through tooling outside this repository's history). The classification is therefore
corrected from CASE A to **CASE D** (§8) — repository evidence strongly suggests, but
does not prove, no production distribution. The rollback section's prior claim ("nothing
in the currently-committed client calls these two Functions") was also literally
inaccurate — committed source *does* call both Functions — and is corrected in §19 to
state plainly that committed-source behavior and production-client-distribution state
are two separate, independently-tracked facts. Credential terminology (`gcloud auth
print-access-token` vs. "Application Default Credentials") and the Rules-propagation
model (management-plane proof vs. propagation-safety proof, with Firebase's documented
60-second/10-minute windows) are also corrected this pass. See the revision log at the
bottom for the complete list of corrections, across both passes.

This document prepares the exact, controlled production rollout sequence for the
already-completed 5C multi-member architecture (5C.1 through 5C.7, all local-emulator
validated and committed). It freezes what is currently deployed (Functions **and**
Rules), what remains undeployed, the exact backend/Rules deployment scope and commands,
the exact post-Rules verification mechanism, the production verification design, STOP
conditions, and rollback strategy. **No production mutation, deployment, migration, or
financial transaction occurs as part of this document.**

## 1. Baseline

- Branch: `claude/milestone-3-personal-savings-mvp`
- HEAD: `23874181c7c223d9ade9efabf1684550901b90b5`
- Local HEAD == origin HEAD: confirmed
- Working tree (before this correction pass): clean except this document

## 2. Source inspected

**Read in full, prior pass (unchanged this pass):**
- `docs/audits/TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md` (5C.0/5C.1/5C.2
  architecture — `acceptTripInvitation` contract, the `tripMembershipAcceptances`/
  `tripInvitations`/`trips.memberIds` Rules closure list, the originally-frozen, later
  corrected deployment order)
- `docs/audits/TRIP_INVITATION_CLIENT_UX_PREFLIGHT_2026-10-18.md` (5C.3A — `getTripInvitationPreview`
  contract, the corrected backend→client→Rules deployment order, the explicit
  "SOURCE-CONTROL order ≠ PRODUCTION-DEPLOYMENT order" correction)
- `docs/audits/TRIP_INVITATION_INTEGRATION_PREFLIGHT_2026-10-19.md` (5C.3D-A — local emulator
  topology; confirms zero production access occurred during that checkpoint)
- `docs/audits/MULTI_MEMBER_SPENDING_WITHDRAWAL_PREFLIGHT_2026-10-20.md` (5C.4/5C.5 — financial
  callable contracts/invariants, all already local-emulator proven)
- `docs/audits/MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md` (5C.6 — reconciliation
  admin tool, control/attempt model, Rules closure for the two new reconciliation
  collections)
- `docs/audits/MULTI_MEMBER_END_TO_END_VALIDATION_PREFLIGHT_2026-10-21.md` (5C.7 — the frozen
  chained lifecycle this session already implemented, tested, and committed at
  `2387418`)

**Implementation source inspected, prior pass (unchanged this pass):**
- `functions/src/callables/acceptTripInvitation.ts` — committed at `febf001` ("Add trusted
  Trip invitation acceptance backend"); exported from `functions/src/index.ts:9`.
- `functions/src/callables/getTripInvitationPreview.ts` — committed at `f55fec5` ("Add
  trusted Trip invitation preview"); exported from `functions/src/index.ts:10`.
- `functions/src/index.ts` — confirmed exactly 14 exported callables, including both of
  the above.
- `firebase.json` — `functions[0].codebase: "default"`; confirms the deploy-target
  syntax `functions:<name>` (no codebase prefix needed) is correct for this repository.
- `.firebaserc` — `{"projects": {"default": "squadstash-6d0f1"}}` — confirms every future
  command below must carry an explicit `--project squadstash-6d0f1` and must never rely
  on the default alias alone.
- Firebase CLI version installed in this environment: `15.1.0`.

**New this pass — live production Rules state, read-only (full method/evidence in §4):**
- Active Firestore Rules **Release** and its referenced **Ruleset** for project
  `squadstash-6d0f1`, retrieved via the Firebase Rules management REST API
  (`firebaserules.googleapis.com`), authenticated using an access token from the
  already-authenticated **active `gcloud` CLI account/session** already present in this
  environment (`gcloud auth list` → active account `dano.fred11@gmail.com`, the same
  account this session already uses for every other Firebase/Google Cloud operation;
  obtained via `gcloud auth print-access-token`, which prints a token for the active
  `gcloud` CLI account — not the separate `gcloud auth application-default` flow,
  despite the API's own error response, quoted in §4, happening to describe the
  underlying mechanism as "Application Default Credentials"). **A transient OAuth
  access token was generated for this one session's own use; no new persistent
  credential was created, and the token's value was never copied into this document, any
  report, or any log.**
- The active Ruleset's full `firestore.rules` source content (one file, `firestore.rules`,
  46,679 bytes as returned by the API, CRLF line endings).
- `git log --oneline 20c1760387251db12d3109a93db979eb28b7eb80..HEAD -- firestore.rules`
  — the complete commit inventory of every change to this file since the commit named
  in this checkpoint as the last known deployed Rules state.

**New this pass — production client distribution state, read-only (full method/evidence
in §8):**
- `app.json` (the repository's only Expo config file) — read in full.
- Repo-wide search for `eas.json`, any `app.config.{js,ts}`, any `extra.eas.projectId`,
  any `owner` field, any `ios.bundleIdentifier`/`android.package`, any
  `expo.updates`/`runtimeVersion` configuration.
- `.github/workflows/ci.yml` — the repository's only CI pipeline, read in full.

No production Firestore **document data** was read or written at any point. No
production callable was invoked. No production test user was authenticated. **No new
persistent credential was created.** A transient OAuth access token was generated, used
only in-memory for the duration of the read-only Rules-management API calls described
above, and never copied into this document, any report, or any log — its value appears
nowhere here. Every command this pass issued against anything outside this repository's
own local git state was one of: (a) the already-documented read-only `firebase
functions:list` metadata call (prior pass), (b) the new read-only Firebase Rules
management REST API calls (`GET .../releases/cloud.firestore`, `GET .../rulesets/{id}`),
both authenticated via the pre-existing active `gcloud` CLI account/session and both
metadata/source-retrieval operations with zero Firestore document interaction, or (c)
local `git`/file-read commands.

## 3. Current production deployment state — Functions (read-only, confirmed empirically, unchanged this pass)

`firebase functions:list --project squadstash-6d0f1` was run in the prior pass — a
read-only metadata listing; it does not invoke any callable, read/write Firestore, or
authenticate any user. Result: **exactly 12 deployed Functions**, all `v2` callable,
`us-central1`, `nodejs22`:

```
createBucket
createTrip
createTripInvitation
lookupUserByEmail
publishTripTerms
recordSavingsTransaction
recordSharedStashExpense
recordTripExpense
recordTripSettlement
reverseSharedStashExpense
reverseTripExpense
reverseTripSettlement
```

This matches the expected currently-deployed set exactly — **no discrepancy found.**

**Confirmed NOT present in this list**: `acceptTripInvitation`, `getTripInvitationPreview`.
Both remain committed-but-undeployed.

## 4. Active production Firestore Rules state — verified this pass (read-only)

**Method (frozen — the same method §11 freezes for the future post-Rules-deployment
verification):**

1. Obtain an access token from the already-authenticated **active `gcloud` CLI
   account/session** (`gcloud auth print-access-token`) — this reuses the identical,
   already-established Google Cloud identity this environment already uses; it
   produces a transient OAuth access token, used only in-memory for this call, never
   persisted or logged.
2. `GET https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/releases/cloud.firestore`,
   with `Authorization: Bearer <token>` and `x-goog-user-project: squadstash-6d0f1`
   (required — without it, the API returned exactly this error, quoted verbatim because
   it is the one place this document's own evidence uses the phrase "Application Default
   Credentials," describing the API's own diagnostic message, not this session's actual
   authentication method: *"Your application is authenticating by using local
   Application Default Credentials. The firebaserules.googleapis.com API requires a
   quota project..."* — adding the header resolved it; this is a harmless, non-mutating
   error response, not a sign of insufficient authorization). Returns the active
   **Release**: its `name`, the **Ruleset** it currently references (`rulesetName`), and
   timestamps.
3. `GET https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/rulesets/{id}`
   (the exact `id` from step 2's `rulesetName`) — returns the immutable Ruleset's full
   `source.files[].content`.
4. Normalize line endings before any byte comparison: this repository's local working
   tree checks out `firestore.rules` with CRLF line endings (Windows checkout; git
   blobs themselves store LF — the same CRLF/LF distinction already surfaced as a
   benign warning on every `git diff`/`git add` involving `package.json` elsewhere in
   this session). The Ruleset source returned by the API is **also** CRLF — confirmed by
   direct byte inspection (`0d0a` sequences) — meaning it was uploaded from this same
   kind of Windows working-tree checkout, not re-encoded by the API. Stripping `\r` from
   the retrieved source before comparing against a git blob (which is always LF) is
   therefore the correct, like-for-like comparison — not an approximation.

**This is a read-only Rules **management**-API inspection — no Firestore document was
queried, no callable was invoked, and no Rules content was ever written.**

**Result, retrieved this pass:**
- Active Release: `name: projects/squadstash-6d0f1/releases/cloud.firestore`,
  `rulesetName: projects/squadstash-6d0f1/rulesets/be6b9b70-639a-4dba-bee8-421c3b251af4`,
  `createTime: 2025-10-28T00:35:31.078417Z`, `updateTime: 2026-10-16T05:23:27.723468Z`.
- Referenced Ruleset: `name: projects/squadstash-6d0f1/rulesets/be6b9b70-639a-4dba-bee8-421c3b251af4`,
  `createTime: 2026-10-16T05:23:27.489695Z`, one source file (`firestore.rules`,
  46,679 bytes, CRLF).

**Comparison against known source states, after CRLF normalization:**
- **Active Ruleset source vs. commit `20c1760387251db12d3109a93db979eb28b7eb80`'s
  `firestore.rules`** (the "last known deployed Rules checkpoint" this checkpoint
  itself named) — `diff` exit code **0**. **Byte-for-byte identical.** This is also
  independently corroborated by timing: commit `20c1760` was authored
  `2026-10-16T05:16:17Z` (UTC, converted from its recorded `-0500` timestamp), roughly
  seven minutes before the Ruleset's own `createTime` (`2026-10-16T05:23:27Z`) —
  consistent with a deploy immediately following that commit, not a coincidence.
- **Active Ruleset source vs. current `HEAD`'s `firestore.rules`** — **326 lines of
  diff** (after CRLF normalization), consisting exactly of the accumulated changes
  inventoried in §10 below (the 5C.2 closure and the 5C.6 reconciliation-collection
  additions) — **not** identical to HEAD.

## 5. Determination (OUTCOME A — confirmed)

Per this checkpoint's own three-outcome framework:

**OUTCOME A applies.** The active production Firestore Rules source exactly matches the
known previous deployed Rules source (commit `20c1760`) and does **not** contain the
5C.2 closure or any later change (including 5C.6's reconciliation-collection
protections).

**Therefore: the entire accumulated `firestore.rules` delta on current HEAD — every
commit listed in §10 — is confirmed undeployed to production.** This is not an inference
from git history or from `firebase functions:list` (the checkpoint's own §3 explicitly
warned against either) — it is a direct, byte-level comparison of the actual live
Ruleset source, retrieved via the Rules management API, against two known source states.

Neither OUTCOME B nor OUTCOME C applies. No STOP condition under this item is triggered.

## 6. Confirmed undeployed backend scope (unchanged this pass)

**Exactly two Functions require deployment: `acceptTripInvitation` and
`getTripInvitationPreview`.** No other currently-deployed Function needs redeployment
merely because this rollout exists — neither depends on, nor changes the behavior of,
any of the 12 already-deployed Functions.

**No dependency was found that would force deploying any additional Function.**

**Exact Firebase CLI deployment command (frozen; NOT run):**
```
firebase deploy --only functions:acceptTripInvitation,functions:getTripInvitationPreview --project squadstash-6d0f1
```
Confirmed against this repository's actual `firebase.json` (`codebase: "default"` — no
codebase-qualified target syntax required) and the installed CLI version (`15.1.0`).
This command was not executed.

## 7. Backend pre-deployment gate (frozen evidence requirements, unchanged this pass)

Immediately before the eventual backend deployment, require, fresh:
- `git status --short` clean; local HEAD == origin HEAD; HEAD is the exact approved
  implementation commit (or a later one that has itself passed every gate below).
- `npm --prefix functions run build` passes.
- `firebase emulators:exec --only firestore "npm --prefix functions test"` passes
  (established baseline: 291 suites, 1464 tests, 0 fail, exit 0).
- `npm run test:trip-invitation-integration` passes (established: 4 suites, 21 tests,
  `5C.3D: PASS`, exit 0).
- `npm run test:multi-member-financial-integration` passes (established: 5 suites, 38
  tests, `5C.5: PASS`, exit 0).
- `npm run test:multi-member-reconciliation-integration` passes (established: 6 suites,
  38 tests, `5C.6: PASS`, exit 0).
- `npm run test:multi-member-e2e-integration` passes (established: 3 suites, 16 tests,
  `5C.7: PASS`, exit 0).
- `npm test -- --silent` and `npm run test:rules` both rerun fresh immediately before
  deployment (not merely cited from an earlier checkpoint's evidence) — established
  baselines: 38/1131/1 snapshot/exit 0, and 15/456/exit 0, respectively.
- No source drift after the above: `git status --short` re-checked clean immediately
  before deployment.
- Deployment target is explicitly `--project squadstash-6d0f1` on every command.
- The deployment command targets ONLY the two named Functions — never a bare `firebase
  deploy` or `firebase deploy --only functions`.

## 8. Production client distribution state — verified this pass (read-only)

**Method:** read-only inspection of this repository's own Expo/EAS/CI configuration —
no app was built, published, or submitted; no app-store or EAS account was accessed.

**Findings:**
- `app.json` is this repository's **only** Expo configuration file. It contains no
  `extra.eas.projectId`, no top-level `owner` field, no `ios.bundleIdentifier`, no
  `android.package`, and no `expo.updates`/`runtimeVersion` block of any kind.
- No `eas.json` exists anywhere in the repository.
- No `app.config.js`/`app.config.ts` exists (which could otherwise programmatically
  inject EAS/store configuration `app.json` itself lacks).
- `.github/workflows/ci.yml` is this repository's only CI pipeline. It runs
  typecheck/lint/test/Rules-tests/Functions-build only — **it contains no `eas build`,
  no `eas submit`, no `eas update`, no `expo publish`, and no `firebase deploy` step of
  any kind.**

**What this evidence proves, exactly:** no production-distribution *configuration*
exists in the current repository — no store identifier to register a listing under, no
EAS project linkage, no OTA update channel, and no CI/CD step in this repository's own
history that builds, publishes, or submits a client artifact.

**What this evidence does NOT, by itself, conclusively prove:** that no
production-distributed client has ever existed anywhere. A client could in principle
have been manually built and distributed outside this repository's CI, released from a
different checkout or branch, or distributed using configuration that existed at some
past point and was later removed — none of which current repository inspection alone
can rule out.

**Classification framework (frozen):**
- **CASE A** — no production-distributed client exists (independently proven, not
  merely absent from repository configuration).
- **CASE B** — a production client exists and is proven to already contain the
  `acceptTripInvitation`/`getTripInvitationPreview` cutover.
- **CASE C** — a production client exists and is proven older/not cut over.
- **CASE D** — production-client distribution state cannot yet be independently
  proven either way.

**Classification, based on repository inspection alone: CASE D.** No independent,
non-repository fact establishing SquadStash has never been distributed exists in this
session or environment, and this preflight does not invent one, access an App
Store/Play Console/EAS account, or otherwise go beyond read-only repository inspection
to manufacture a CASE A conclusion the evidence does not actually support.

**Consequence (per §6/§13's framework):**
- **CASE D is NOT a blocker for Phase A (targeted backend Functions deploy) or Phase B
  (backend metadata verification)** — both are additive; deploying two new,
  self-contained Functions does not depend on, and cannot be made unsafe by, an unknown
  client-distribution state.
- **CASE D IS a blocker for Phase D (Firestore Rules deployment)** — until
  client-distribution state is independently resolved to CASE A or CASE B (confirmed no
  client exists, or confirmed the existing one is already cut over), Rules deployment
  must not proceed, because it could otherwise close a direct-write path an unknown,
  still-active production client population might depend on.

## 9. Client compatibility gate (revised this pass)

Two distinct facts, kept explicitly separate — never conflated:

1. **Current committed source** (`src/services/firebase/tripInvitations.ts`'s
   `acceptTripInvitation` export, and the `getTripInvitationPreview` client wrapper)
   **already calls both trusted callables** via `httpsCallable(functions, "...")` — not
   a direct Firestore write of any kind. Confirmed by source inspection (prior pass) and
   independently by `TRIP_INVITATION_CLIENT_UX_PREFLIGHT_2026-10-18.md` §1/§7/§14. This
   fact is established and not in question.
2. **Production-distributed client state** (§8): **CASE D — not yet independently
   resolved.** Whether any production-distributed client exists, and if so whether it
   already contains fact 1's cutover, is a *separate* production-distribution question
   that current repository inspection alone does not conclusively answer either way.

**No additional client *source* change is required** — fact 1 already holds. **But
Phase C/C2 is not automatically a source-only confirmation**: because client-distribution
state is CASE D, not CASE A or CASE B, Rules deployment (Phase D) remains blocked until
that state is independently resolved — either CASE A is proven (no production client
exists) or CASE B is proven (the existing production client is confirmed already cut
over) — at the actual time of the future rollout. Backend Functions deployment (Phase
A/B) is unaffected by this, per §8's own consequence framework.

## 10. Firestore Rules closure — exact accumulated delta (revised this pass)

**Complete commit inventory since the confirmed-deployed baseline** (`git log --oneline
20c1760387251db12d3109a93db979eb28b7eb80..HEAD -- firestore.rules`):

```
160e32b Add multi-member reversal and reconciliation hardening
6d19266 Close direct Trip membership authority paths
```

**Exactly two commits.** The accumulated delta that `firebase deploy --only
firestore:rules --project squadstash-6d0f1` would publish, run today against current
HEAD, is the **union** of both — never described as "only the 5C.2 closure":

**From `6d19266` (5C.2 closure):**
- `trips/{tripId}`'s owner `allow update` allowlist (`affectedKeys().hasOnly([...])`)
  no longer includes `memberIds` — no client role may mutate Trip membership directly
  any longer.
- `tripMembershipAcceptances/{acceptanceId}`'s `allow create, update, delete` closes
  from a live, Rules-shaped direct-create path to permanently `if false` —
  trusted-callable-only.
- `tripInvitations/{invitationId}`'s direct `pending+unexpired → accepted` client write
  closes to `if false` — the trusted `acceptTripInvitation` callable becomes the sole
  accept path.
- `hasTripInvitationRecord`/`hasActionableTripInvitationRecord` (any-invitation-status,
  broader pre-join terms access) are removed entirely, replaced by the narrower
  `hasPendingUnexpiredTripInvitation` (pending-and-unexpired only) — pre-join terms
  access now ends the instant an invitation is declined, cancelled, or expires.

**From `160e32b` (5C.6 reconciliation Rules additions):**
- Two brand-new collections, both fully client-closed on every operation
  (`allow get, list: if false; allow create, update, delete: if false;`):
  `tripOwnershipReconciliationAttempts/{attemptId}` and
  `tripOwnershipReconciliationControl/{tripId}`. Neither collection exists at all in the
  currently-active production Ruleset (confirmed by the §4 byte-exact match against the
  pre-5C.2 `20c1760` baseline, which predates both).

**Confirmed present on current HEAD, unchanged from the prior pass's inspection**, and
now additionally confirmed **undeployed** by §4/§5: `trips/{tripId}`'s owner allowlist
exclusion of `memberIds`; `tripMembershipAcceptances`'s closed create rule;
`tripInvitations`'s closed direct-accept rule; `hasPendingUnexpiredTripInvitation`'s
narrowed logic. **No Rules file was edited during this preflight** — `git diff --
firestore.rules` against `HEAD` shows no change relative to the already-committed,
already-reviewed closure.

## 11. Frozen post-Rules verification mechanism — Phase E1, management-plane proof (no longer deferred)

**Phase E has two distinct, required proofs — this section is the first (E1); §12 is
the second (E2). E1 alone is never sufficient to begin Phase F — see §12.**

**The exact E1 mechanism is the same one used to produce §4's evidence, applied again
after the eventual Rules deployment — frozen now, not "to be selected at a future
gate":**

1. `gcloud auth print-access-token` (the already-authenticated session; or the
   equivalent token source available at deployment time).
2. `GET https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/releases/cloud.firestore`
   with `Authorization: Bearer <token>` and `x-goog-user-project: squadstash-6d0f1` —
   retrieve the active Release's `rulesetName`.
3. `GET https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/rulesets/{id}`
   — retrieve the full Ruleset source.
4. Normalize line endings (strip `\r`, per §4 item 4) and compare the retrieved source,
   byte-for-byte, against the exact `firestore.rules` content at the commit actually
   authorized for that deployment (the same content just deployed in Phase D — not a
   later, different `HEAD`).
5. **Require an exact match before Phase F begins.** Any mismatch is a STOP condition
   (§18) — it means either the deploy did not take effect as expected, propagation has
   not completed (§12), or an unexpected ruleset is active.
6. **Record as deployment evidence**: the active Release's `name`, `rulesetName`,
   `createTime`, `updateTime`; the active Ruleset's `name` and `createTime`. (Mirrors
   exactly what §4 recorded for the pre-deployment baseline, so the two can be directly
   compared to confirm the Release/Ruleset identifiers actually changed.)

No Firestore document query is used for this step, matching the checkpoint's own
requirement exactly.

**E1 proves one specific thing, and only that thing: the intended Rules release is
active in the Firebase Rules *management plane*.** It does **not**, by itself, prove
that every Firestore enforcement point (every open connection, every active listener,
every edge) has already received and is applying that release — that is a distinct
propagation question, addressed in §12 (E2). **Do not treat an E1 match as proof that
propagation has completed.**

## 12. Rules propagation safety gate — Phase E2 (required before Phase F; never skippable)

**Firebase's documented propagation characteristics for Cloud Firestore Security
Rules** (the actual, named bound this gate is tied to — not an arbitrary wait):
- Rules updates may take **up to approximately 1 minute (60 seconds)** to affect **new**
  queries and listeners.
- Rules updates may take **up to approximately 10 minutes** to fully affect **already-
  active** listeners that were established before the Rules change.

**E2, frozen, required in addition to E1 — Phase F must not begin until both E1 and E2
are satisfied:**
- E1 has already passed (§11): the active Release references the intended Ruleset, and
  its normalized source exactly matches the authorized, committed `firestore.rules`
  content.
- **No pre-deployment Firestore listener or client session is reused as Rules
  enforcement evidence for Phase F, under any circumstance.** Every Phase F
  authorization check uses a session/listener/read created fresh, strictly after the
  Rules deployment.
- **At least 60 seconds have elapsed after the deployed Release's own `updateTime`**
  before Phase F's first production Firestore authorization check begins, using only
  fresh (post-deployment) queries/listeners. This is the documented new-query/listener
  propagation bound above, not an arbitrary sleep — it is anchored to a specific,
  recorded timestamp (the Release's `updateTime`, captured as part of E1's own
  evidence), not merely "some time passed."
- **If Phase F's design ever intentionally relies on a listener that itself spans the
  deployment moment** (established before the deploy, still open afterward) rather than
  a fresh one, the longer **10-minute** documented bound applies instead of 60 seconds
  before that listener's observed behavior is trusted as Rules-enforcement evidence.
- **Preferred design: avoid this case entirely.** Phase F should use only fresh
  sessions/listeners created after the 60-second gate, never a listener that predates
  deployment — this is simpler to reason about and avoids ever needing the 10-minute
  bound at all.

**E1's match proves the intended release is active in the Rules management plane. It
does not by itself mean propagation to every enforcement point is complete — the
documented propagation window above still applies, and must still elapse, before
client-observed authorization behavior is relied upon as proof of anything.**

## 13. Rollout order (revised this pass — Phase C corrected to CASE D framework, Phase E split)

```
PHASE A — Targeted backend Functions deploy
  firebase deploy --only functions:acceptTripInvitation,functions:getTripInvitationPreview --project squadstash-6d0f1
  (additive; not blocked by CASE D - §8)

PHASE B — Backend Functions metadata verification (read-only)
  firebase functions:list --project squadstash-6d0f1
  (additive; not blocked by CASE D - §8)

PHASE C — Production-client distribution/cutover determination
  Before Rules deploy, independently resolve §8's classification to one of:
    CASE A: independently confirm no production-distributed client exists (repository
      inspection alone, as this pass found, is NOT sufficient by itself - §8).
    CASE B: independently confirm the currently-distributed client already calls
      getTripInvitationPreview/acceptTripInvitation and does not rely on the direct
      Firestore accept path the new Rules will close.
  If CASE C is found instead (a production client exists and is older/not cut over):
    perform a separately-authorized client release/cutover, then verify it, before
    proceeding to Phase D.
  If CASE D still applies (cannot be resolved to A or B):
    STOP before Rules deploy (Phase D). Do not proceed on an assumed classification.
  Phase C must never be described as automatically source/build-only based solely on
  current repository configuration - that was this pass's own correction (§8/§22).

PHASE C2 — Client compatibility verification
  Confirm the client that will receive/has received this Rules closure already calls
  the trusted acceptTripInvitation/getTripInvitationPreview callables, never a direct
  Firestore write - a source/build check once Phase C resolves to CASE A, or an actual
  shipped-client verification once Phase C resolves to CASE B (or completes a CASE C
  cutover).

PHASE D — Firestore Rules deploy
  firebase deploy --only firestore:rules --project squadstash-6d0f1
  (BLOCKED until Phase C resolves to CASE A or CASE B - §8/§18)

PHASE E1 — Management-plane proof: active Release -> Ruleset -> exact-source verification (read-only, §11)

PHASE E2 — Rules propagation safety gate (§12):
  - at least 60 seconds after the deployed Release's own updateTime, for fresh
    queries/listeners
  - no pre-deployment listener/session reused as evidence
  - if a listener spans the deployment, the documented 10-minute bound applies instead

PHASE F — Controlled two-account production membership/authorization verification
  (§14-§17), using only fresh, post-E2 client sessions/reads
```

**This order is confirmed correct** against both governing source documents
(`TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md` §22,
`TRIP_INVITATION_CLIENT_UX_PREFLIGHT_2026-10-18.md` §14's explicit "SOURCE-CONTROL order
≠ PRODUCTION-DEPLOYMENT order" correction) and by this pass's own §8 finding: **Rules
must never deploy while production-client distribution/cutover state remains CASE D or
CASE C** — today's repository evidence leaves that state at CASE D, not CASE A, so
Phase C is a genuine determination step at the actual future rollout time, never a
foregone conclusion. **No technical reason was found requiring Rules to precede
Functions** — the Admin SDK bypasses Rules entirely, so backend deployment has no Rules
dependency in either direction, and CASE D does not block Phase A/B (§8).

## 14. Controlled second-account production verification (design only, unchanged this pass)

This future verification (Phase F) must prove, using the real deployed backend and real
deployed Rules (confirmed active per §11/§12), with a genuinely separate second
controlled account:

1. Account A (owner) creates a disposable Trip (§15) and publishes terms, using the
   real production client.
2. Account A invites Account B (a real `createTripInvitation` call).
3. Account B calls the real `getTripInvitationPreview` and receives the expected
   six-field safe preview (title/location/imageUrl/dates/tripId — never any financial
   field).
4. Account B accepts via the real `acceptTripInvitation` callable.
5. `Trip.memberIds` gains Account B's uid exactly once; a `tripMembershipAcceptances`
   record exists for the correct `tripId`/`uid`/`termsDocId`; the invitation flips to
   `accepted`.
6. Account B gains intended read/navigation access to the Trip.
7. Account A retains intended access, unaffected.

**Hard stop after step 7.** No financial transaction of any kind is performed.

## 15. Test-data strategy (unchanged this pass)

**Frozen: Option A — a newly-created, disposable, non-financial Trip, created solely for
this verification.** Rejected: Option B (an existing known-safe Trip), for the reasons
already frozen in the prior pass.

**Cleanup policy: not determined by this preflight — explicitly documented as unclear,
not invented.** Do not delete or mutate the verification Trip, its invitation, or its
acceptance record as part of this rollout.

## 16. Two-account requirement (unchanged this pass)

- **Account A**: Trip owner, a controlled test account.
- **Account B**: invited second member, a genuinely separate, real, authenticated
  production uid, created via real Firebase Auth sign-up.
- **No manual `memberIds` edit, no Admin SDK acceptance seeding, no direct
  `tripMembershipAcceptances` document creation of any kind.** Membership must arise
  exclusively through the real deployed invitation/preview/acceptance flow.
- Whether a suitable Account A/B pair already exists must be determined at the actual
  future Phase F gate.

## 17. Production verification success criteria (PASS, unchanged this pass)

- **A.** Backend deployment contains `acceptTripInvitation`.
- **B.** Backend deployment contains `getTripInvitationPreview`.
- **C.** All 12 previously-deployed Functions remain present, unchanged in shape.
- **D.** Invitation preview succeeds for Account B.
- **E.** Invitation preview performs zero membership mutation.
- **F.** Member acceptance succeeds through the real deployed callable.
- **G.** `Trip.memberIds` includes the accepted member exactly once.
- **H.** Membership-acceptance evidence persists.
- **I.** Acceptance evidence references the correct Trip/member/terms version.
- **J.** The accepted member receives the intended client access.
- **K.** The owner (Account A) retains intended access, unaffected.
- **L.** No `tripMemberOwnership` row is fabricated merely by membership acceptance.
- **M.** No `savingsTransactions` document is created.
- **N.** No `tripOwnershipAllocations` document is created.
- **O.** No `ownershipModelState`/`ownershipModelVersion` transition occurs — remains
  exactly `"initialized"`/`1` throughout.
- **P.** (Restates O for emphasis, per the checkpoint's own numbering.)
- **Q.** The Rules deployment (Phase D) is confirmed active via §11's (E1)
  management-plane exact-match check **and** §12's (E2) propagation-safety gate, both
  satisfied, before Phase F begins.
- **R.** Unauthorized access remains denied where expected.
- **S.** No production financial mutation occurs at any point during Phase F.
- **T.** Phase F uses only the controlled test accounts/data named in §16.

## 18. STOP conditions (expanded this pass)

Any of the following halts the rollout immediately, with no progression to the next
phase, and requires reporting the exact observed state:

**Carried forward, unchanged:**
- Working tree not clean, or local HEAD != origin HEAD, at any pre-deployment gate.
- Any Functions/Rules/5C.3D/5C.4-5C.5/5C.6/5C.7 regression suite fails.
- The deployment target is not explicitly `--project squadstash-6d0f1`.
- `firebase functions:list` shows an unexpected Function currently deployed, or
  missing, relative to §3's confirmed baseline.
- The rollout would require any unreviewed source change not already covered by this
  document's §2 inspection.
- Production verification (Phase F) would require creating any financial transaction.
- Invitation acceptance unexpectedly creates a `tripMemberOwnership` row or any
  financial artifact.
- The accepted member does not receive the correct access, or an unauthorized party
  receives access that should have been denied.
- The verification Trip transitions to `"migrating"` or `"needs_reconciliation"` at any
  point.
- A deployment command affects any Function beyond the two explicitly targeted in Phase
  A.
- Any command in this rollout appears to target a non-emulator/non-production
  environment contrary to the intended phase.

**From the prior correction pass:**
- The active production Rules state cannot be authoritatively determined (e.g., the
  Rules management API call fails, returns an error, or authentication cannot be
  safely obtained from already-authenticated tooling without inventing credentials).
- The active Rules source, at the time of the actual future rollout, differs from both
  the then-current expected deployed baseline and the then-current approved HEAD
  (OUTCOME C, per §5's framework) — deploying over an unknown production Rules state is
  never permitted.
- The current-HEAD Rules delta (§10) contains any change not already reviewed in its
  own prior checkpoint.
- `git diff -- firestore.rules` shows any content beyond the already-reviewed,
  committed closure.

**New this (final closure) pass — client-distribution/propagation conditions:**
- **Production-client distribution state remains CASE D when Phase D (Rules deploy) is
  reached** — Rules deployment must not proceed until Phase C has independently resolved
  this to CASE A or CASE B (§8/§13). **This blocks Phase D only — it does NOT block
  Phase A or Phase B**, which are additive and unaffected by client-distribution state.
- **Production-client state is CASE C (a client exists and is proven older/not cut
  over) and has not yet been cut over** — Rules deployment must wait for that separately
  authorized client release and its own verification (§13 Phase C).
- The active Rules Release/source (Phase E1, §11) differs from the exact content
  authorized for that specific deployment.
- **The 60-second fresh-query/listener propagation window (§12, E2) has not yet elapsed
  since the deployed Release's own `updateTime` when Phase F is about to begin.**
- **A pre-deployment Firestore listener or client session is being used, or proposed to
  be used, as Rules-enforcement evidence for Phase F** — only fresh, post-deployment
  sessions/listeners are permitted as evidence (§12).
- Phase F's observed behavior contradicts what the deployed Rules (per E1's verified
  source) should produce — an authorization result that the active, verified Ruleset
  does not actually support is itself a STOP condition, not something to rationalize.
- Any step of Phase F would require creating a financial mutation of any kind.

**Any STOP condition means: halt immediately, do not continue to the next phase, report
the exact state — never attempt a silent workaround or substitute action.**

## 19. Rollback / failure strategy (corrected this pass)

- **Backend deploy succeeds, verification fails**: the safest response is to leave the
  two newly-deployed Functions in place (additive — deploying them does not remove any
  existing capability or close any existing path, so it cannot itself break anything
  currently working, regardless of client-distribution state) while withholding Phase
  C/C2/D/E1/E2/F until the specific verification failure is understood and fixed.
  **Preferred over deletion**: a genuine rollback, if ever truly needed, means
  redeploying a prior known-good commit's build output for that Function, or, if full
  removal is required, an explicit `firebase functions:delete <name> --project
  squadstash-6d0f1` under separate, explicit authorization — never leaving a Function
  present-but-silently-broken.
  **Corrected claim (this, final closure, pass):** the prior pass's rollback reasoning
  stated "nothing in the currently-committed client calls these two Functions" and
  called this "true." **It was not true** — this document has, throughout, correctly
  established the opposite: **current committed source *does* call both
  `acceptTripInvitation` and `getTripInvitationPreview`**, through trusted callable
  wrappers (§9 fact 1). That statement about committed source was simply wrong, not
  merely resting on the wrong *type* of evidence. **The accurate, frozen distinction is
  now:**
  - Current committed source **does** call both new Functions (§9 fact 1 — established,
    not in question).
  - Whether any **production-distributed** client calls them is a **separate**
    production-distribution question (§8).
  - Current repository inspection **alone does not conclusively resolve** that latter
    question — classified **CASE D**, not CASE A (§8).
  - **Backend Functions deployment is additive and therefore safe regardless of which
    CASE eventually proves true** — an additive deploy cannot be made unsafe by an
    unknown client population, because it removes no existing path. **Rules deployment,
    by contrast, remains gated on resolving CASE D to CASE A or CASE B first** (§8/§13),
    precisely because a Rules closure *does* remove an existing path that an unknown
    client population might still depend on.
- **Rules deploy succeeds, verification fails**: Firestore Rules deployments are
  themselves close to instantaneously revertible — redeploying the immediately-prior
  Rules content (available from this repository's git history, e.g. `git show
  <prior-commit>:firestore.rules`) via the identical `firebase deploy --only
  firestore:rules --project squadstash-6d0f1` command restores the previous access
  posture, and can itself be confirmed via §11's exact same Release/Ruleset/source
  method. **Preservation over destructive action**: no Firestore data is deleted or
  mutated by a Rules rollback.
- **Second-account verification exposes an authorization mismatch**: a backend- or
  Rules-logic defect, not an infrastructure problem — halt Phase F immediately (§18),
  preserve the exact observed state/evidence for review, and treat it as a
  priority-one correctness finding requiring a fix-and-re-verify cycle.
- **No rollback of any kind is performed as part of this preflight.**

## 20. No financial production verification (hard frozen statement, unchanged this pass)

**5C.7's local-emulator validation (committed at `2387418`, three independent fresh
stability runs, 3 suites / 16 tests each, `5C.7: PASS`, exit 0 every time) is the
authoritative proof of multi-member financial economics: contribution ownership, pooled
depletion, withdrawal ceiling, reversal, reconciliation.**

**The production rollout does NOT need, and MUST NOT create, a real financial
transaction merely to re-prove any of the above.** Production verification (Phase F) is
scoped exclusively to: deployment presence, membership, authorization, Rules
enforcement, and integration compatibility. It is never a vehicle for retesting
financial economics using real production state, real production money, or any real
settlement/withdrawal/contribution/Shared-Stash/reversal/reconciliation/migration
activity.

## 21. Exact future rollout commands (revised this pass; NONE executed by this preflight)

**A. Backend preflight build/tests** (immediately before backend deploy):
```
npm --prefix functions run build
firebase emulators:exec --only firestore "npm --prefix functions test"
npm run test:trip-invitation-integration
npm run test:multi-member-financial-integration
npm run test:multi-member-reconciliation-integration
npm run test:multi-member-e2e-integration
npm test -- --silent
npm run test:rules
```

**B. Targeted Functions deployment:**
```
firebase deploy --only functions:acceptTripInvitation,functions:getTripInvitationPreview --project squadstash-6d0f1
```

**C1. Post-deploy Functions metadata verification (read-only, Phase B):**
```
firebase functions:list --project squadstash-6d0f1
```

**C2. Production-client distribution/cutover determination (Phase C)** (not a fixed CLI
command — a determination step; §8's repository-only inspection is necessary but **not
sufficient** on its own to resolve CASE D to CASE A or CASE B):
```
(re-run §8's repository inspection AND obtain whatever independent, non-repository
evidence is actually needed to resolve CASE D to CASE A or CASE B at that future time -
e.g. confirmation from whoever owns any App Store Connect/Google Play Console/EAS
account this product may have, or an authoritative statement that none has ever been
created. If this cannot be resolved: STOP before Rules deploy (§13/§18). This step
never proceeds on repository evidence alone.)
```

**D. Rules test (Phase C2 verification / immediately before Rules deploy, and only once
Phase C resolves to CASE A or CASE B):**
```
npm run test:rules
```

**E. Rules deployment (Phase D):**
```
firebase deploy --only firestore:rules --project squadstash-6d0f1
```

**F1. Post-Rules management-plane verification (frozen mechanism, read-only, Phase E1,
§11):**
```
TOKEN=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: squadstash-6d0f1" \
  "https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/releases/cloud.firestore"
# then, using that response's own rulesetName:
curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: squadstash-6d0f1" \
  "https://firebaserules.googleapis.com/v1/projects/squadstash-6d0f1/rulesets/{id}"
# normalize line endings and diff the returned source against the exact firestore.rules
# content authorized for that deployment; require an exact match (E1) before proceeding
# to F2.
```

**F2. Propagation safety gate (Phase E2, §12; not a single command — a timing/evidence
gate):**
```
(record the Release's own updateTime from F1's response; wait until at least 60 seconds
have elapsed after that timestamp; then, using only freshly-created Firestore client
sessions/listeners established after this point - never one that predates the Rules
deployment - begin Phase F's production membership/authorization checks. If a listener
spanning the deployment is ever used instead, require the documented 10-minute bound in
its place.)
```

**G. Phase F — controlled two-account production membership/authorization
verification** (§14-§17; begins only after F1 and F2 both pass):
```
(no fixed CLI command - real Account A/Account B invitation/preview/acceptance flow
through the real production client, per §14, using only fresh post-F2 sessions)
```

No destructive cleanup command and no migration command appears anywhere in this list.

## 22. Blockers / open questions (revised this, final closure, pass)

**None blocking for freezing THIS document, and resolved (not assumed) as of this
pass's own evidence:**
- Current production Functions deployment state matches the expected baseline exactly
  (§3) — no discrepancy.
- **Production Rules state: RESOLVED — OUTCOME A** (§4/§5, read-only, via the Rules
  management API). The entire current-HEAD Rules delta is confirmed undeployed. This is
  no longer an assumption.
- **Exact Phase E Rules verification mechanism: RESOLVED** (§11/§12 — E1 management-
  plane proof plus E2 propagation-safety gate, with the documented 60-second/10-minute
  bounds). No longer deferred to "a future gate."
- **Rules delta: RESOLVED** (§10) — exactly two commits (`6d19266`, `160e32b`), both
  fully inventoried, never summarized as "only the 5C.2 closure."
- `acceptTripInvitation`/`getTripInvitationPreview` are confirmed committed, exported,
  and still undeployed.
- No Function dependency was found requiring deployment beyond the two named.

**Production-client distribution state — CORRECTED this pass, now an explicit,
named open item rather than a resolved fact:**
- **CASE D — unless independently established outside repository evidence.** Repository
  inspection alone (§8) proves the absence of production-distribution *configuration*,
  not the absence of all historical distribution. No independent, non-repository fact
  establishing CASE A exists in this session, and none was invented.
- **This is explicitly NOT a blocker for Phase A (targeted backend Functions deploy) or
  Phase B (backend metadata verification)** — both are additive.
- **This IS a blocker for Phase D (Firestore Rules deployment)** — Rules deployment must
  not proceed until this is independently resolved to CASE A (no client exists) or CASE
  B (the existing client is already cut over) at the actual future rollout time. It is
  deliberately **not** labeled non-blocking for Rules specifically, because an unknown
  or stale client-distribution state at deployment time would be a real risk to a live
  user population, not a cosmetic gap.

**Open, non-blocking, explicitly deferred (not invented here):**
- Whether a suitable Account A/Account B controlled test-account pair already exists
  for Phase F (§16) — may remain deferred until Phase F.
- The disposable verification Trip's long-term cleanup/retention policy (§15) — may
  remain deferred.

## 23. GO / STOP recommendation (revised this, final closure, pass)

```
GO for freezing this production rollout architecture, as corrected — PREFLIGHT
DOCUMENT ONLY. This is not authorization for any deployment.

Current production Functions deployment state was independently confirmed, read-only
(firebase functions:list --project squadstash-6d0f1): exactly the 12 expected
Functions are deployed; acceptTripInvitation and getTripInvitationPreview are
confirmed committed but NOT yet deployed.

Current production Firestore Rules state was independently confirmed, read-only, via
the Firebase Rules management REST API (Release -> Ruleset -> source), using the
already-authenticated active gcloud CLI account/session (a transient access token was
generated for this one-time read-only check and was never persisted, logged, or
printed): the active Ruleset is byte-for-byte identical (after CRLF normalization) to
commit 20c1760 (the last known deployed checkpoint) and does NOT contain the 5C.2
closure or the 5C.6 reconciliation-collection additions - OUTCOME A, confirmed, not
assumed. The exact accumulated delta a future Rules deployment would publish is fully
inventoried (two commits, §10). The exact post-Rules verification mechanism is frozen
as a two-part gate (§11 E1 management-plane proof; §12 E2 propagation-safety proof,
tied to Firebase's documented 60-second new-query/listener and 10-minute active-
listener propagation bounds) - never a single Release/source match treated as proof
that propagation itself is complete.

Production-client distribution state was reassessed this pass: repository inspection
alone proves absence of distribution CONFIGURATION, not absence of all historical
distribution - correctly classified CASE D, not CASE A. CASE D does not block Phase A
or Phase B (additive backend deployment); it DOES block Phase D (Rules deployment)
until independently resolved to CASE A or CASE B at the actual future rollout time.
Current committed client source is separately, correctly established as already
calling both trusted callables (§9 fact 1) - this is a true, distinct fact from
production-client distribution state, and the rollback section's prior inaccurate
claim about committed source (§19) is corrected.

The rollout order (targeted backend Functions deploy -> metadata verification ->
client-distribution/cutover determination -> client compatibility verification ->
Rules deploy -> management-plane verification -> propagation-safety gate ->
controlled second-account verification) is confirmed correct and internally
consistent. Production verification remains scoped to membership/authorization/
deployment only - financial economics remain authoritatively proven by 5C.7's
local-emulator evidence and must never be re-proven with real production money. No
STOP condition was encountered in producing this corrected preflight document itself.
This document authorizes nothing beyond itself - the actual Phase A-F deployment
sequence remains a separate, future, independently-authorized
action.
```

**No production mutation, deployment, migration, or financial transaction occurred as
part of this preflight. No production Firestore document was read or written. No
production callable was invoked. No new persistent credential was created; a transient
OAuth access token was generated for this pass's own read-only use and was never
persisted, logged, or printed — its value appears nowhere in this document.**

---

## Revision log (prior correction pass)

1. **Active production Rules state verified, read-only** (§4/§5): the prior draft's
   unverified "not yet deployed" claim is replaced with a direct, byte-level comparison
   of the live Firestore Rules Release/Ruleset source (via the Rules management REST
   API, authenticated through the already-established `gcloud` ADC session) against
   both the current `HEAD` and the named prior deployed checkpoint (`20c1760`).
   **OUTCOME A confirmed**: active Rules exactly match `20c1760`; the entire
   current-HEAD delta is undeployed.
2. **Complete Rules delta inventoried** (§10): exactly two commits since `20c1760`
   (`6d19266` — 5C.2 closure; `160e32b` — 5C.6 reconciliation-collection additions), both
   explicitly described, never summarized as "only the 5C.2 closure."
3. **Exact post-Rules verification mechanism frozen** (§11): every "mechanism to be
   selected at a future gate" statement removed; the Release → Ruleset → source method
   is now the one frozen mechanism, reused identically for both the pre-deployment
   baseline (§4) and the future post-deployment check (§11).
4. **Rules propagation gate added** (§12): Phase F may not begin on deploy-command
   success alone; requires the exact-match check plus fresh post-deployment
   reads/listeners; no arbitrary sleep is used as proof.
5. **Production-client distribution state determined, read-only** (§8): classified
   **CASE A** (no production-distributed client exists), based on the absence of any
   EAS/store/publish configuration or CI deployment step — not inferred from git source
   cutover state.
6. **Client-cutover assumption corrected** (§9): the document now explicitly
   distinguishes "current committed source already calls the trusted callables" from
   "the production-distributed client already contains that cutover," and states the
   second fact (CASE A) as its own independently-determined conclusion.
7. **Rollback language corrected** (§19): the prior draft's "nothing in the
   currently-committed client calls these two Functions ... no in-flight production
   traffic" claim — which cited a git-source fact as if it were a production-traffic
   fact — is replaced with the actually-supporting evidence (§8's CASE A finding), with
   an explicit caveat that this reasoning must be re-derived, not assumed, if a future
   rollout finds a different CASE.
8. **Rollout order reassessed and Phase C split** (§13): Phase C is now explicitly a
   production-client distribution-state gate (re-checked at the actual future rollout
   time), with Phase C2 as the client-verification step; Rules deployment (Phase D)
   explicitly may not proceed while client compatibility is unknown.
9. **STOP criteria expanded** (§18): added explicit conditions for an undeterminable
   active Rules state, an active Rules state matching neither expected baseline
   (OUTCOME C), an unreviewed Rules-delta change, an unprovable client-distribution
   state, a Rules deployment that would close a path a live client still depends on, and
   a Phase E mismatch.
10. **Blockers/open questions updated** (§22): the Rules-deployment-state and
    client-distribution-state questions are no longer listed as deferred/non-blocking
    assumptions — both are now evidence-backed conclusions for *today*, with an explicit
    instruction that client-distribution state must be re-proven, not assumed, at the
    actual future rollout time.
11. **Final consistency pass**: every instance of "not yet deployed," "exact mechanism
    to be selected," "currently-committed client," and "no in-flight production
    traffic" was individually re-reviewed; each now rests on the evidence in §4/§8/§11
    rather than on an unverified assumption.

**Note (superseded by the final closure pass below): this pass's own item 5
classification of "CASE A" (§8) was itself an overstatement of what repository
inspection alone can prove, and is corrected to CASE D in the final closure pass.**

## Revision log (final closure pass)

1. **Production-client classification corrected from CASE A to CASE D** (§8): the prior
   pass's repository-only evidence (no `eas.json`, no app-store identifiers, no
   publish/deploy CI step) is re-characterized accurately — it proves no
   production-distribution *configuration* exists in the current repository; it does
   **not**, by itself, conclusively prove no production-distributed client has ever
   existed anywhere (a client could have been manually built, released from another
   checkout, or distributed outside this repository's own history). Every instance of
   "conclusive," "categorically," and "no production client has ever been distributed"
   describing this finding was removed.
2. **CASE A/B/C/D framework formalized** (§8): CASE A (no client exists, independently
   proven), CASE B (client exists, proven cut over), CASE C (client exists, proven
   older/not cut over), CASE D (cannot yet be independently proven either way).
   Classified **CASE D** based on repository inspection alone, since no independent,
   non-repository fact establishing CASE A exists in this session, and none was
   invented or looked up via an App Store/Play Console/EAS account.
3. **CASE D's exact blocking scope frozen** (§8/§18/§22): explicitly **not** a blocker
   for Phase A (targeted backend Functions deploy) or Phase B (metadata verification),
   both additive; explicitly **is** a blocker for Phase D (Firestore Rules deployment)
   until independently resolved to CASE A or CASE B.
4. **Phase C corrected** (§13/§21): no longer describable as automatically
   source/build-only based solely on current repository configuration. Phase C is now
   a genuine determination step requiring independent (non-repository-inspection-alone)
   evidence to resolve CASE D to CASE A or CASE B, with an explicit STOP if it cannot be
   resolved before Rules deploy.
5. **Rules propagation model corrected** (§11/§12): the prior pass's "if §11's
   comparison passes immediately, propagation is already complete" claim — stated
   explicitly false by this checkpoint — is removed. Phase E is now split into **E1**
   (management-plane proof: Release → Ruleset → source exact match) and **E2**
   (propagation-safety proof), with Firebase's documented propagation bounds frozen
   explicitly: **60 seconds** for new queries/listeners, **10 minutes** for listeners
   already active before the deployment. E1 passing proves the intended release is
   active in the Rules management plane only — never equated with propagation
   completion.
6. **Phase F now explicitly gated on E1 AND E2**, using only fresh, post-deployment
   Firestore sessions/listeners — a pre-deployment listener is never reused as Rules
   enforcement evidence, under any circumstance (§12/§17/§18).
7. **Rollback section's factual error corrected** (§19): the prior pass's own
   explanation stated "nothing in the currently-committed client calls these two
   Functions" and called this "true" — it was not true; this document has throughout
   correctly established that committed source *does* call both Functions. The
   corrected, accurate distinction is frozen: committed source calling the Functions
   (true, established) is a separate fact from production-client distribution state
   (CASE D, unresolved); backend deployment's safety rests on its additive nature, not
   on an absent-client claim that was itself inaccurate reasoning in the prior pass.
8. **Credential terminology corrected throughout** (§2/§4/§23 and the closing summary):
   every description of `gcloud auth print-access-token` as using "Application Default
   Credentials"/"ADC" is corrected to "the active `gcloud` CLI account/session" — the
   one legitimate exception is a verbatim-quoted API error message that happens to use
   that phrase itself, now clearly marked as a quotation rather than this document's own
   characterization. Every "no credential was generated or printed" claim is corrected
   to the accurate security fact: a transient OAuth access token *was* generated for
   this pass's own in-memory, one-time use; no new *persistent* credential was created;
   the token's value was never copied into this document, any report, or any log.
9. **Rollout order relettered** (§13/§21) to the full Phase A / B / C / C2 / D / E1 / E2
   / F structure, with each phase's exact blocking/non-blocking relationship to CASE D
   stated explicitly.
10. **STOP conditions expanded** (§18): added explicit conditions for CASE D/CASE C
    remaining unresolved at Phase D, the 60-second propagation window not yet elapsed,
    a pre-deployment listener being reused as evidence, and Phase F behavior
    contradicting the verified deployed Rules.
11. **Blockers/open questions corrected** (§22): production-client distribution state
    is no longer listed as resolved — it is now an explicit, named CASE D open item,
    with its exact blocking scope (blocks Rules, not Functions) stated directly rather
    than left to be inferred.
12. **Final consistency search performed** across the whole document for every term
    this checkpoint named (`CASE A`, `CASE D`, `conclusive`, `categorically`,
    `production-distributed`, `currently-committed client`, `ADC`, `Application Default
    Credentials`, `print-access-token`, `propagation`, `immediately`, `sleep`, `60
    seconds`, `10 minutes`, `Release`, `Ruleset`, `Phase C`, `Phase D`, `Phase E`, `Phase
    F`) — no unresolved contradiction, stale CASE-A claim, or ADC mischaracterization
    remains.

**Nothing beyond this one document was created or modified.**
