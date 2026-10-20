# Milestone 5C.3D-A — Local Emulator Topology & Integrated Verification Preflight

Status: PREFLIGHT / DESIGN ONLY. No firebase.ts, firebase.json, package.json, jest config, application source, Functions source, or Firestore Rules were modified. No harness was implemented. No emulator was run. Not committed.

Repository state at time of writing: branch `claude/milestone-3-personal-savings-mvp`, HEAD `7147e4d64c794e1e5b7b34139886cbedbd69d94d`.

**Revision history**: a hardening pass corrected one BLOCKING project-identity contradiction in the original draft (the chosen client strategy redirected `firebase.ts`'s production-project-id singletons to emulator transports, which conflicts with this document's own single-demo-project-id requirement — connecting an SDK instance to an emulator changes its transport endpoint, never its Firebase App's project identity) and several accuracy corrections (Functions export count, a harness-owned-only sequencing proof that didn't actually exercise the shipped screen, a trusted-inspector choice that would have required adding `firebase-admin` to the root package, a missing Functions-build step, and POSIX-only timeout syntax on a Windows/PowerShell project). This revision supersedes the original draft everywhere the two differ.

No command was run against the production project `squadstash-6d0f1` at any point during this preflight.

## 1. Current emulator topology

**`firebase.ts`** (verified by direct read): initializes the app with the real, hardcoded production config (`projectId: "squadstash-6d0f1"`, real `apiKey`/`authDomain`/etc.), then calls `getAuth(app)`, `getFirestore(app)`, `getFunctions(app)` with **no region argument** (so `functions` implicitly targets `us-central1`, matching every exportable callable — confirmed zero callables specify a custom region). **Zero emulator connectors exist** — no `connectAuthEmulator`, `connectFirestoreEmulator`, or `connectFunctionsEmulator` call anywhere in this file or anywhere else in the repository (confirmed by a repo-wide search returning no matches).

**`firebase.json`**: configures `functions` (source, codebase, predeploy lint+build) and `firestore` (rules/indexes path), and under `"emulators"` **only**:
```json
"emulators": { "firestore": { "port": 8080 } }
```
No `auth`, `functions`, `ui`, or `hub` block exists.

**`.firebaserc`**: `{"projects": {"default": "squadstash-6d0f1"}}` — the default alias is the **production** project. Any command that omits an explicit `--project` flag resolves to production unless an emulator host env var happens to redirect the specific SDK call being made.

**`.gitignore`**: `.env` and `.env.*` are both ignored. No `EXPO_PUBLIC_*` variable is defined or referenced anywhere in the repository today (confirmed by a repo-wide search).

**Repo-wide search results** (`connectAuthEmulator` / `connectFirestoreEmulator` / `connectFunctionsEmulator` / `EXPO_PUBLIC_` / `emulators:exec` / `emulators:start`): the only real hits are in `functions/test/*.ts` (each file's own `FIRESTORE_EMULATOR_HOST`-presence guard), in `tests/firestore-rules/helpers/testEnv.js` (hardcodes `127.0.0.1:8080`, matching `firebase.json`'s explicit Firestore port exactly, and uses project id `demo-squadstash-rules-test`), and in two npm scripts: `test:rules` (`firebase emulators:exec --only firestore "jest --config jest.rules.config.js --runInBand"`) and `functions/package.json`'s `serve`/`shell`/`start` (`firebase emulators:start --only functions` / `firebase functions:shell`).

**Notable pre-existing fact, not a 5C.3D defect but directly relevant to the guards this checkpoint freezes**: none of `test:rules`, `serve`, `shell`, or `start` pass an explicit `--project` flag — they implicitly resolve to `.firebaserc`'s default (`squadstash-6d0f1`) even though they only ever touch local emulators. For Rules-only testing this is low-risk (no Admin SDK, no Auth, no Functions involved at all). For a flow touching Auth + Functions, it is not low-risk, which is exactly why §15 below freezes a single, explicit, non-defaultable project-id requirement enforced at every layer.

## 2. Production-risk findings

**Finding 1: `createTripInvitationCore` depends on a real Admin Auth lookup by default, and the project's own code already documents the gap.** `functions/src/callables/createTripInvitation.ts`'s `defaultResolveInviteeUid(email)` calls `getAuth().getUserByEmail(email)` (Admin SDK). The exported `createTripInvitation` onCall wrapper always calls `createTripInvitationCore(getFirestore(), authUid, request.data)` with no injected resolver — the real HTTPS-triggered callable always uses the real Admin Auth lookup. Its own JSDoc states this project has never configured an Auth emulator, working around it only via dependency injection inside unit tests — a technique unavailable through the real `onCall` HTTPS path 5C.3D must exercise. This is the deciding fact that makes the Auth emulator mandatory, not optional (§3).

**Finding 2**: `createTrip.ts`, `publishTripTerms.ts`, `acceptTripInvitation.ts`, and `getTripInvitationPreview.ts` import zero Admin Auth APIs (confirmed by grep). Auth is required for the overall flow because of (a) `createTripInvitation`'s email resolution and (b) the independent reason below.

**Finding 3 (independent reason Auth is required)**: every `onCall` trigger validates the caller's Firebase ID token to populate `request.auth`. For the client harness to invoke any of these five callables as an authenticated user without a production token, the signing-in identity must come from the Auth emulator.

**Finding 4 (corrected — see §6/§7 for the full resolution)**: `firebase.ts`'s module-level singletons (`auth`, `db`, `functions`) are permanently bound to the real production project id (`squadstash-6d0f1`) at construction time. `connectXEmulator(...)` calls on those instances redirect only their *transport endpoint* (which host:port they talk to) — they do **not**, and cannot, change the underlying Firebase App's `options.projectId`. For Auth + Firestore + Functions to behave as one consistent, cross-service identity (an ID token minted by the Auth emulator for project A being accepted by a Firestore/Functions emulator instance keyed to project A), **every** client and tool in the flow must agree on the *same* project id end-to-end. Redirecting the production-project-id singletons to emulator transports would create exactly the contradiction this document's own single-demo-project-id rule exists to prevent: a Web SDK App whose identity is `squadstash-6d0f1` talking to emulators configured (via `--project demo-squadstash-5c3d`) for a *different* project id. **This is why the original draft's chosen strategy is withdrawn and replaced in §6/§7.**

**Finding 5**: this repository already has an in-house pattern for exactly this class of guard: `functions/src/admin/migrateTripOwnership.ts`'s `resolveExecutionTarget` — a pure function that requires `FIRESTORE_EMULATOR_HOST` to be set (or an exact production-project match plus a confirm echo-back) before permitting any run. This is the correct model to reuse for 5C.3D's own fail-closed guard (§15).

**Finding 6 (new)**: the Firestore Emulator's default **single-project mode** actively helps enforce the single-identity rule — when a Firestore emulator instance has accepted connections under one project id, it is designed to warn/reject a *different* project id connecting to the same emulator instance. Leaving this at its default (not disabling it) is itself an extra, emulator-enforced layer of protection against exactly the class of mismatch this hardening pass corrects — this is why §13 freezes "do not add `singleProjectMode: false`."

## 3. Required emulator set

1. **Firestore emulator: YES, required.** Every scenario reads/writes `trips`, `tripInvitations`, `tripTerms`, `tripTermsCurrent`, `tripMembershipAcceptances`.
2. **Functions emulator: YES, required.** 5C.3D's entire premise is exercising the real callables as deployed-shape `onCall` triggers, not as directly-imported Core functions.
3. **Auth emulator: YES, required — not optional.** Two independent reasons, both confirmed by source inspection (§2, Findings 1 and 3). Any topology omitting the Auth emulator cannot run the full, real, unmocked flow.

## 4. Frozen demo project id

**`demo-squadstash-5c3d`** — the **one and only** project id permitted anywhere in the 5C.3D topology. Matches this repository's own established naming convention (`demo-squadstash-rules-test`, `demo-squadstash-functions-test-accept-trip-invitation`, etc.).

**Why this is safe, confirmed by the repository's own existing documentation**: `tests/firestore-rules/helpers/testEnv.js`'s own comment states — *"A 'demo-' projectId prefix is a Firebase convention that guarantees emulator-only behavior: no login, no real project, no billing checks."* This is an officially documented platform behavior, already relied upon twice in this exact repository.

**Hardening correction, frozen**: this same id must be used, with no exception, by **every** layer of the topology — the CLI (`--project` flag), the integration test's own Firebase Web SDK App (§6/§7), the trusted inspector's Firestore-emulator test environment (§11), and (empirically, via the Functions Emulator's own environment injection — see §15) the Functions-emulator/Admin SDK context. There is exactly one project id in this design, never two, never a "client project differs from CLI project" configuration.

## 5. Exact ports

| Emulator | Host:Port | Status |
|---|---|---|
| Auth | `127.0.0.1:9099` | Not yet configured — new |
| Firestore | `127.0.0.1:8080` | **Already** configured in `firebase.json`; matches `tests/firestore-rules/helpers/testEnv.js`'s own hardcoded value |
| Functions | `127.0.0.1:5001` | Not yet configured — new (Firebase's conventional default) |

Region: **`us-central1`** (zero callables specify a custom region; the client's `getFunctions(app)` call also specifies none).

## 6. Client integration strategy comparison (revised)

| | Option A — permanent env-gated `firebase.ts` | Option B — fully separate harness-owned Firebase app (production-config singletons redirected) | **Option C, revised — test-only module injection with a demo-project-identity app** | Option D |
|---|---|---|---|---|
| Production isolation | Safe only if the flag is always correctly absent in every real build — a standing risk | Introduces the exact project-identity contradiction corrected in this pass (§2 Finding 4) — **rejected outright, not merely de-prioritized** | Safe — the demo app's identity is `demo-squadstash-5c3d` from construction, never derived from or related to the production config at all | — |
| Proves real Functions callable protocol | Yes | Yes, but against a self-contradictory identity | Yes | — |
| Proves real Auth token propagation | Yes | Yes, but against a self-contradictory identity | Yes — the demo app's own Auth instance mints tokens the demo-identity Functions/Firestore emulators correctly recognize | — |
| Proves real Firestore Rules | Yes | Yes | Yes | — |
| **Proves the actual 5C.3C client service wrappers** | Yes, but requires a permanent production-file change | **No longer applicable as originally framed** — it would have proven the wrappers while contradicting project identity | **Yes** — the service-wrapper files' own `import { db, functions } from "../../../firebase"` resolves, via Jest module injection, to the demo app's instances; the wrapper code itself is never touched or mocked | — |
| Complexity | Medium (permanent production source branch) | Low, but architecturally broken | Low-to-medium (one Jest `jest.mock` factory building a small demo app) | — |
| Risk of project-identity mismatch | New, standing | **The exact risk this revision removes** | None by construction — there is only ever one project id in play | — |
| Source changes requiring commit | Yes — `firebase.ts` itself | No | No | — |

**No Option D was found that fits this repository better.**

## 7. Chosen strategy (revised — supersedes the original draft)

**Revised Option C — test-only Jest module injection, backed by a dedicated, demo-project-identity Firebase Web SDK App.** Frozen exactly as follows:

1. The integration harness creates its **own, separately-named** Firebase Web SDK App (e.g. `initializeApp({projectId: "demo-squadstash-5c3d", apiKey: "demo-api-key", ...}, "integration-demo-app")`) — a minimal config whose `projectId` is **exactly** `demo-squadstash-5c3d`. No field in this config is ever derived from, or shares a value with, `firebase.ts`'s production config.
2. From that demo app, it creates `Auth`, `Firestore`, and `Functions` (`getFunctions(demoApp, "us-central1")`) instances.
3. **Before any real application service wrapper module is imported or used**, it connects all three to the frozen loopback ports (§5): `connectAuthEmulator(demoAuth, "http://127.0.0.1:9099")` (Auth's client connector is URL-based, not host/port-based), `connectFirestoreEmulator(demoFirestore, "127.0.0.1", 8080)`, `connectFunctionsEmulator(demoFunctions, "127.0.0.1", 5001)`.
4. It registers a **Jest module mock** for the repository-root `firebase.ts` module (`jest.mock("<path-to>/firebase", () => ({ auth: demoAuth, db: demoFirestore, functions: demoFunctions }))`), with the demo app/instance construction and the three `connectXEmulator` calls performed **inside the mock factory function itself** — this is the concrete mechanism that satisfies "must not import/use the production `firebase.ts` instances before the Jest module replacement is active": Jest's `babel-plugin-jest-hoist` hoists `jest.mock(...)` calls above every other import in the same file, and the mock factory does not execute until the mocked module is first required by anything in the dependency graph — so by construction, nothing can observe the real `firebase.ts` singletons during this test run; every transitive importer of `firebase.ts` (including `src/services/firebase/trips.ts`, `tripInvitations.ts`, `tripTerms.ts`, `tripMembershipAcceptances.ts`) receives the demo instances instead, automatically, with zero change to those files.
5. The test file then imports the **real, unmodified** service-wrapper modules normally (a plain top-of-file `import`, not a special dynamic form — Jest's hoisting already guarantees correct ordering, so no additional "dynamic import" mechanism is required). The service implementations are never mocked; only their one shared dependency (`firebase.ts`) is substituted, and only for the duration of this test process.
6. **Hard guard, before any user/data creation**: the harness asserts `demoApp.options.projectId === "demo-squadstash-5c3d"` immediately after construction (inside the same mock factory, or in a `beforeAll` that inspects the already-mocked `db`/`auth`/`functions`' own `.app.options.projectId`) and fails immediately, before any Auth user is created or any Firestore write occurs, if it does not match.

This preserves everything Option C originally promised — the actual shipped service-wrapper code executes, the actual `httpsCallable` protocol executes, actual Auth-emulator identity/tokens flow through, the actual Firestore SDK and Rules execute, the actual Functions emulator executes — while removing the project-identity contradiction entirely, because the demo app's identity *is* `demo-squadstash-5c3d` from the moment it is constructed, never borrowed from or related to `squadstash-6d0f1` in any way.

## 8. Why alternatives rejected

- **Option A rejected**: permanent `firebase.ts` change, standing "must always be absent in every real build" risk, for no proof benefit Option C(revised) doesn't already provide.
- **Option B (production-singleton redirection) rejected, and withdrawn as this document's prior choice**: it is the specific design this hardening pass corrects — redirecting `squadstash-6d0f1`-identity instances to emulator transports creates a cross-service identity mismatch the moment Auth, Firestore, and Functions are all involved together, which 5C.3D's full flow requires. A Firestore/Functions emulator pair keyed to `demo-squadstash-5c3d` (via `--project`) has no principled reason to accept, or correctly interpret, requests arriving from an App object whose own identity claims to be `squadstash-6d0f1` — at best this relies on undocumented emulator leniency; at worst (and by design, per Finding 6's single-project-mode behavior) it fails outright. Revised Option C avoids this by never constructing an App with the production project id in the first place.

## 9. Exact scenarios frozen (unchanged)

All five scenarios from the checkpoint (A — normal accept, B — terms_changed/anti-TOCTOU, C — decline, D — direct accept write must fail, E — pre-join Trip/terms privacy) remain frozen exactly as originally specified, verified compatible with the current, already-implemented source. No financial contribution/withdrawal/expense/settlement action appears in any scenario — the only financial-adjacent check anywhere is the trivial post-accept absence check in §11, never a transaction.

## 10. Loading-order proof (revised — supersedes the original draft)

**Decision, revised: render the actual shipped screen, instrumented only at its two real network-call boundaries, against real emulators — not a harness-owned pass-through wrapper.**

**Why the original harness-owned event-log design was insufficient**: a wrapper that itself calls `getTripInvitationPreview()` then `fetchCurrentTripTerms()` in the correct order proves the *harness* calls them correctly — it says nothing about whether `app/(tabs)/trips/invitations/[invitationId].tsx`'s own `loadPreviewAndTerms` function actually does the same thing in production. The whole point of this specific regression proof is to catch a **future** change to the shipped screen that reintroduces parallelism or a client-carried `tripId` — a harness that never touches the screen's own code cannot catch that regression no matter how carefully it is written.

**Revised approach, frozen**: render the real screen component with `react-test-renderer` — a tool **already used throughout this repository's existing component tests** (confirmed: `components/**/__tests__/*.test.tsx` already render components this way under the `jest-expo` preset), with **no new rendering dependency** (`@testing-library/react-native` is explicitly not needed for this, and is not installed in this repository).

**Permitted test-only substitutions** (navigation plumbing only, never backend/service behavior):
- `expo-router`'s `useLocalSearchParams`/`useRouter` — stubbed to supply a fixed `invitationId` param and a recording `push`/`replace`, since the real Expo Router navigator is not mounted in this harness.
- `AuthContext`'s `useAuth()` — stubbed to return the already-real, Auth-emulator-created invitee `User` (obtained via the real `signIn`/`createUserWithEmailAndPassword` client call earlier in the same scenario), so the screen has a `user.uid` to decline with, without mounting the full `AuthProvider`/`onAuthStateChanged` subscription tree.
- Harmless native-primitive shims only if the existing Jest/RN test environment already requires them for any component test (none currently do, per the existing test suite).

**Explicitly NOT permitted to mock**: `getTripInvitationPreview`, `fetchCurrentTripTerms`, `acceptTripInvitation`, `declineTripInvitation`. These are instrumented, not replaced — a thin wrapper around each real export that records a timestamped event (`preview:start`/`preview:resolved`/`terms:start`/`terms:resolved`) and then **forwards the call, and its real result or real thrown error, to the original implementation unchanged**. This is the one place the test needs to intercept at the module boundary (via the same `jest.mock(...)` + "keep calling the real implementation" pattern — `jest.mock("<path>/tripInvitations", () => { const real = jest.requireActual("<path>/tripInvitations"); return {...real, getTripInvitationPreview: async (...args) => { log("preview:start"); const r = await real.getTripInvitationPreview(...args); log("preview:resolved"); return r; }}; })`), so the instrumentation never substitutes behavior, only observes it.

**Assertions, frozen**: `preview:start < preview:resolved < terms:start < terms:resolved` (strict event order, from calls initiated **by the rendered screen itself**, never by the test driving the functions directly); and — the concrete, falsifiable form of "never uses a client-carried tripId" — the `tripId` argument `fetchCurrentTripTerms` is actually invoked with must equal exactly the `tripId` field of the real response `getTripInvitationPreview` actually returned for this run, read off the recorded event log, not assumed.

**If implementation later finds the existing `react-test-renderer` environment cannot reasonably render this specific screen without large, unrelated new infrastructure**: the checkpoint's own instruction governs — **STOP and report the blocker explicitly; do not silently fall back to the harness-owned wrapper.** Any fallback architecture would itself need to be a shared orchestration helper actually imported and used by the production screen (so that instrumenting *that* helper would still prove something about the real screen), which would be a new, separately-reviewed design decision, not a quiet substitution.

## 11. Trusted/admin inspection strategy (revised — supersedes the original draft)

**Revised choice: `@firebase/rules-unit-testing`'s `initializeTestEnvironment` + `withSecurityRulesDisabled`, already a root `devDependency`** (confirmed: `@firebase/rules-unit-testing` `^5.0.1` is listed in root `package.json`; `firebase-admin` is **not**, and is a dependency of the separate `functions` package, not the root package where this Jest integration harness lives — adding it to root merely for this checkpoint was the original draft's mistake, now withdrawn).

```ts
const inspector = await initializeTestEnvironment({
  projectId: "demo-squadstash-5c3d",
  firestore: { rules: fs.readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
});
// ... await inspector.withSecurityRulesDisabled(async (ctx) => { /* read trips/tripInvitations/tripMembershipAcceptances/tripMemberOwnership directly */ });
```

mirroring `tests/firestore-rules/helpers/testEnv.js`'s own exact existing call shape, with the one required difference: the project id must be the **same** `demo-squadstash-5c3d` every other layer uses, never a separate `demo-squadstash-rules-test`-style id of its own — the Firestore Emulator keys its entire in-memory dataset by project id, so a mismatched inspector project id would not error loudly; it would silently inspect an empty or unrelated dataset, which is precisely the class of silent failure this whole hardening pass exists to prevent.

**Scope, unchanged from the original draft**: this trusted context verifies exact `Trip.memberIds`, invitation `status`/`respondedAt`, acceptance-record existence/shape, absence of an acceptance record after `terms_changed`, absence of partial membership after `terms_changed`, and the one trivial post-join absence check (no `tripMemberOwnership` row for the new member) — never anything beyond that, and never used for the client operations that are supposed to prove Rules (those continue through the real, demo-identity, emulator-connected Web SDK client from §7).

## 12. Harness location / source scope

**Recommended location, unchanged: `tests/integration/tripInvitationFlow.emulator.test.ts`**, run under a new `jest.integration.config.js` (sibling to `jest.rules.config.js`), via a new `package.json` script. Root `jest.config.js` must add `tests/integration/` to its existing `testPathIgnorePatterns` (which already excludes `tests/firestore-rules/` and `functions/` for the identical reason).

**Recommendation, unchanged: commit it as durable regression coverage** — it proves the single highest-value, hardest-to-accidentally-regress property in this milestone (the anti-TOCTOU `terms_changed` contract, cross-cutting Rules + Functions + the real client screen at once) using the real stack end to end.

## 13. `firebase.json` / package-script decision (revised — adds the missing build step)

**Frozen: add explicit emulator port blocks for `auth` and `functions`**:
```json
"emulators": {
  "auth": { "port": 9099 },
  "firestore": { "port": 8080 },
  "functions": { "port": 5001 }
}
```
**Explicitly NOT added**: `"singleProjectMode": false`. Single-project mode's default behavior is desirable here precisely because it fails loudly on any project-id mismatch (§2 Finding 6) — disabling it would remove a real, emulator-enforced layer of the protection this entire hardening pass is about.

**Hardening correction (new, §6 of the checkpoint): the Functions build step was missing from the original draft's proposed script.** `functions/package.json` declares `"main": "lib/index.js"`, and `functions/.gitignore` excludes `lib/**/*.js` — confirmed by direct read of both files. A clean clone has **no** `lib/` output at all, and a developer's existing `lib/` may be stale relative to current `functions/src/**`. The Functions Emulator loads whatever `lib/index.js` currently contains on disk — it does not compile TypeScript itself. **Frozen, corrected package script**:
```json
"test:trip-invitation-integration": "npm --prefix functions run build && firebase emulators:exec --project demo-squadstash-5c3d --only auth,firestore,functions \"jest --config jest.integration.config.js --runInBand\""
```
The one-command developer workflow is `npm run test:trip-invitation-integration` — this is the form that must always be used; it cannot accidentally skip the Functions build the way a bare `firebase emulators:exec ...` invocation could.

## 14. Exact proposed execution command

The **emulator command itself** (what the npm script's second half actually runs) is:
```
firebase emulators:exec --project demo-squadstash-5c3d --only auth,firestore,functions "jest --config jest.integration.config.js --runInBand"
```
but normal execution must always go through the npm script in §13 (`npm run test:trip-invitation-integration`), never this command run standalone, so the Functions build step can never be skipped.

**PowerShell quoting note**: the inner-quote nesting above is already proven to work in this exact repository's actual environment — `test:rules`'s own existing script uses the identical escaped-double-quote nesting inside a `package.json` string today.

**`FUNCTIONS_DISCOVERY_TIMEOUT` — corrected to Windows/PowerShell syntax.** Not required by default — this repository exports 14 functions (corrected count; see §16), well within the Functions Emulator's default discovery timeout. **Contingency only, and the original draft's POSIX-shell example (`FUNCTIONS_DISCOVERY_TIMEOUT=10 firebase ...`) is invalid on this Windows/PowerShell project and is withdrawn.** If discovery is ever observed to time out, the correct local form is:
```powershell
$env:FUNCTIONS_DISCOVERY_TIMEOUT="30"
npm run test:trip-invitation-integration
```
documented as contingency-only — never enabled by default, never set unless discovery actually times out in practice.

## 15. Fail-closed production guards (revised — strengthens project-identity verification)

One project identity, `demo-squadstash-5c3d`, is required at **every** layer:

| Layer | How it is verified |
|---|---|
| Firebase CLI / emulator process | The `--project demo-squadstash-5c3d` flag on the wrapping `emulators:exec` invocation (§14) |
| Integration Web SDK App (§7) | `demoApp.options.projectId === "demo-squadstash-5c3d"`, checked immediately after construction, inside the same mock factory, before any Auth user or Firestore document is created |
| Trusted inspector (§11) | The literal `projectId` argument passed to `initializeTestEnvironment`, hardcoded identical to every other layer's value — never a separate id of its own |
| Functions Emulator / Admin SDK environment | `functions/src/index.ts`'s own `initializeApp()` (no explicit project argument) relies on `GCLOUD_PROJECT`/`FIREBASE_CONFIG`, which `emulators:exec --project demo-squadstash-5c3d` is expected to set in the Functions process's environment — **this specific environment-variable name is the one fact in this entire document not yet empirically confirmed against this exact Firebase CLI version (15.25.1) and must be verified empirically at the start of 5C.3D's implementation, before any guard relies on it, per the checkpoint's own explicit instruction** (see §20, Blocking) |
| Auth-emulator-issued identities/tokens | Implicitly scoped to whichever project the Auth emulator itself was started under (via the same `--project` flag) — an ID token minted there is only ever meaningful to a Functions/Firestore emulator pair started under the identical project id, which single-project mode (§2 Finding 6, §13) additionally enforces |

Additional guards, unchanged from the original draft:
- `FIRESTORE_EMULATOR_HOST` must be present and resolve to a loopback address.
- `FIREBASE_AUTH_EMULATOR_HOST` must be present and resolve to a loopback address.
- The Functions-emulator target the harness's client `functions` instance connects to must be `127.0.0.1:5001` — never a real Cloud Functions URL.
- The production project id `squadstash-6d0f1` is explicitly rejected at every layer above, not merely absent by omission.
- No production credentials/ADC dependency — `demo-*` project ids structurally prevent the Admin SDK and Web SDK from attempting real GCP authentication.
- No fallback to production if an emulator is unavailable — a missing/unreachable emulator is a hard failure.
- **Fail before creating any data** — every guard above must be checked and pass before the harness's first Firestore write, Auth user creation, or callable invocation of any kind.

## 16. Corrected Functions export count

`functions/src/index.ts` currently exports **14** callables (re-read fresh for this hardening pass, confirmed by direct count): `createBucket`, `createTrip`, `lookupUserByEmail`, `createTripInvitation`, `acceptTripInvitation`, `getTripInvitationPreview`, `publishTripTerms`, `recordSavingsTransaction`, `recordTripExpense`, `reverseTripExpense`, `recordSharedStashExpense`, `reverseSharedStashExpense`, `recordTripSettlement`, `reverseTripSettlement`. The original draft's "13" was stale (it predated counting `acceptTripInvitation`/`getTripInvitationPreview` correctly). Not architecturally material — corrected for accuracy.

## 17. Cleanup / idempotency model (unchanged)

Always invoke via `firebase emulators:exec` (never a long-lived `emulators:start` session reused across runs) — this provides a fresh, in-memory emulator lifecycle per invocation with no explicit reset logic needed, exactly as `test:rules` and every `functions test` invocation already rely on in this repository today. Defense-in-depth: unique owner/invitee emails per run. No production cleanup logic exists or is needed, since the harness never touches production by construction (§15).

## 18. Expected assertions / output (unchanged)

```
PASS normal accept
PASS pre-join Trip privacy
PASS safe preview shape
PASS preview-before-terms ordering
PASS exact displayed terms id acceptance
PASS direct client accepted write denied
PASS terms_changed returned
PASS terms_changed caused zero partial membership
PASS explicit second acceptance with new terms succeeds
PASS decline path
PASS post-decline preview denied
PASS post-accept member Trip read allowed
PASS acceptance evidence exact
PASS zero production access
```
Final line, printed only if every assertion above passed: `5C.3D: PASS`.

## 19. Expected implementation file scope (revised)

```
firebase.json                                           (modified - add auth/functions emulator ports)
package.json                                             (modified - add test:trip-invitation-integration)
jest.config.js                                           (modified - add tests/integration/ to testPathIgnorePatterns)
jest.integration.config.js                               (new)

tests/integration/tripInvitationFlow.emulator.test.ts    (new)
tests/integration/helpers/firebaseIntegrationTestEnv.ts   (new, if needed - owns the demo Firebase Web SDK app/instances, the emulator connectors, and the project-identity guard)
tests/integration/helpers/trustedInspection.ts            (new, if useful - @firebase/rules-unit-testing / withSecurityRulesDisabled only)
tests/integration/helpers/* (screen-render helpers)       (new, only if needed for the react-test-renderer proof in §10)
```

**NO expected change to**: `firebase.ts`, `firestore.rules`, `functions/src/**`, `src/services/firebase/**`, `src/domain/**`, `app/**`. If actual implementation later reveals a production source change is needed anywhere in this list: **STOP for review before making it** — do not proceed on the assumption that this preflight already authorized it.

## 20. Blocking vs. deferred decisions

**BLOCKING** (resolved by this hardening pass; nothing here blocks starting 5C.3D's implementation):
- Project-identity contradiction: resolved, §6/§7 (revised Option C, one demo-identity app, no production-config redirection).
- Loading-order proof: resolved, §10 (real screen render via existing `react-test-renderer`, instrumented real services, explicit stop-and-report if rendering proves impractical — no silent fallback).
- Trusted inspection mechanism: resolved, §11 (`@firebase/rules-unit-testing`, already a root devDependency — no `firebase-admin` added to root).
- Functions build step: resolved, §13 (`npm --prefix functions run build &&` prepended to the durable script).
- Functions export count: corrected, §16 (14, not 13).
- PowerShell timeout syntax: corrected, §14 (`$env:FUNCTIONS_DISCOVERY_TIMEOUT="30"`, contingency-only).
- Auth/Firestore/Functions emulator requirement (§3), demo project id (§4), ports/region (§5), all five scenarios and no-financial-transaction scope and decline/direct-write/pre-join-privacy/post-accept/acceptance-evidence test coverage (§9), `emulators:exec` fresh-lifecycle model and unique-email defense-in-depth (§17), and the final `5C.3D: PASS` gating (§18) — all reconfirmed unchanged from the original draft.

**DEFERRED** (acceptable to remain open; do not block starting 5C.3D's implementation):
- **Named explicitly, not merely deferred-by-omission**: the exact environment-variable name (`GCLOUD_PROJECT` vs. `FIREBASE_CONFIG` vs. another) that `emulators:exec --project demo-squadstash-5c3d` actually sets for the wrapped Functions Emulator process on Firebase CLI 15.25.1 must be **empirically verified at the very start of 5C.3D's implementation**, before any guard is written to depend on it (§15). This is the one fact in this document not independently confirmed by direct repository inspection, since confirming it requires actually running the emulator suite, which this read-only preflight does not do.
- Exact Jest transform/preset configuration for `jest.integration.config.js`.
- Exact shape/contents of the `tests/integration/helpers/*` files.

## 21. Final recommendation

```
GO for proceeding to 5C.3D's actual implementation.

No BLOCKING decision remains open. The project-identity contradiction in
the original draft is fully corrected: the chosen client strategy is now
a dedicated, demo-project-identity Firebase Web SDK App
(demo-squadstash-5c3d, never squadstash-6d0f1), injected via Jest module
mocking so the real, unmodified 5C.3C service-wrapper code executes
against it. The loading-order regression proof now renders the actual
shipped InvitationReviewScreen with the already-available
react-test-renderer, instrumenting only the two real service calls for
event observation - never a harness-owned reimplementation of the
sequencing contract. Trusted inspection uses the already-installed
@firebase/rules-unit-testing, not a new root firebase-admin dependency.
The durable package script now builds Functions before starting the
emulator suite. The Functions export count (14) and the Windows/
PowerShell timeout contingency syntax are corrected. Exactly one
empirical fact - the precise environment-variable name the Functions
Emulator process receives its project identity through - remains to be
confirmed at the very start of implementation, before any guard depends
on it; this is a named, bounded first step, not an open design question.
```
