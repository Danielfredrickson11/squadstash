# SquadStash Repository Audit Report

**Audit date:** 2026-08-01
**Audit type:** Audit-only (no code, configuration, dependency, or Firebase changes made)
**Source of truth:** `docs/product/SQUADSTASH_MASTER_SPEC_V2.md`
**Audit instructions followed:** `docs/claude/CLAUDE_REPOSITORY_AUDIT_PROMPT.md`

---

## 1. Executive Summary

**Overall repository condition:** A small, clean, functioning Expo/React Native prototype (~30 source files). It is an early-stage UI/data prototype, not a financial system. It runs, type-checks cleanly, and has a coherent (if minimal) feature set: auth, personal "buckets," and "trips." It is nowhere near the architecture described in Master Spec V2.

**Current development stage:** Pre-Milestone-1 (per the spec's own milestone ladder in §37). The spec's Milestone 1 ("Repository Audit and Stabilization") is what this document is, in fact, performing.

**Most complete part of the application:** Personal Buckets (`app/(tabs)/buckets.tsx`) — full CRUD, shared membership via email invite (Cloud Function `lookupUserByEmail`), real-time Firestore listeners, avatars, responsive grid.

**Most serious technical concern:** There is no backend, no ledger, and no server-authoritative anything. Every "financial" value (`bucket.balance`, `trip.saved`, `trip.target`) is a plain client-writable Firestore number, mutated directly from the mobile app (e.g., `quickAdd` in [buckets.tsx:385-398](app/(tabs)/buckets.tsx#L385-L398) increments `balance` with a raw `updateDoc`). This is architecturally incompatible with Master Spec V2 §16 ("No Balance Without a Ledger Entry") and §9 (Financial Safety Requirements).

**Most serious security concern:** Firestore rules ([firestore.rules:33-42](firestore.rules#L33-L42), [:74-83](firestore.rules#L74-L83)) allow **any member** of a bucket or trip to overwrite `balance`/`saved`/`target` to an arbitrary value, with no field-level validation, no monotonicity check, and no distinction between "my contribution" and "the group total." Any co-member can set another member's shared bucket balance to $999,999 or $0 directly from the client. This is a critical finding given the product's financial trajectory.

**Most significant conflict with Master Specification 2.0:** The entire data model conflates a Firestore document field with real money. Spec §16.4 explicitly forbids this ("No developer, administrator, screen or Firebase document may directly overwrite a financial balance"), and §9 states "Firebase is not the authoritative custody ledger." The current app does exactly what the spec prohibits, everywhere money is displayed.

**Recommended immediate next milestone:** Complete Master Spec Milestone 1 as scoped: lock down Firestore rules to close the client-write financial-field gap, add environment separation (no hardcoded prod Firebase config with zero emulator/env split), add a minimal test/lint/CI harness, and relabel all "balance"/"saved" UI language as **prototype/planning data**, not money — before any backend or ledger work begins.

---

## 2. Audit Scope and Limitations

**Inspected:** All 30 tracked source files (`app/`, `components/`, `src/`, `constants/`, `utils/`, `functions/src/`), all config files (`package.json` ×2, `tsconfig.json` ×2, `app.json`, `firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`, `.gitignore` ×2), `README.md`, and the full repository file tree (excluding `node_modules`, `.git`, `.expo`).

**Diagnostics run:**
- `git status` / `git log` / `git diff --stat` (before and after) — clean, no changes caused by this audit.
- `tsc --noEmit` on root `tsconfig.json` — **0 errors**.
- `tsc --noEmit` on `functions/tsconfig.json` — **0 errors**.
- Grep sweeps for `console.*`, `any` usage, TODO/FIXME, env-var usage, emulator usage, invite/contribute logic.

**Could not verify:**
- Runtime behavior (app was not launched/built — no simulator or device available in this environment).
- `expo-doctor` — the binary is **not installed** (`node_modules/expo` bin field does not include `doctor`; running it would require `npx` to fetch an uninstalled package, which the audit rules prohibit as an install action). **This diagnostic was skipped by policy, not by choice.**
- ESLint — no ESLint config exists at the repo root and no lint script is defined in root `package.json`, so no lint diagnostic could be run for the mobile app. (`functions/` has its own ESLint config and `lint` script, but it was not executed because running it would trigger `npm --prefix` behavior tied to Cloud Functions predeploy tooling that this audit did not attempt to invoke standalone; documenting as a limitation rather than running it blind.)
- Jest/tests — `react-test-renderer` is a devDependency and one snapshot test exists (`components/__tests__/StyledText-test.js`), but there is no `jest` config, no `jest` devDependency, and no `test` script in `package.json`. The test **cannot currently be run** without installing `jest`/`jest-expo`, which this audit did not do.
- Dependency vulnerability/duplicate analysis (`npm audit`, `npm ls`) — not run, to avoid any risk of lockfile mutation or network side effects; flagged as a follow-up diagnostic only.
- External systems (live Firebase project `squadstash-6d0f1`, Cloud Functions deployment state, Firestore actual document contents) — not accessible/not queried. All Firebase Console-side configuration (actual deployed rules, Auth providers enabled, Storage bucket usage) is **inferred from repo files only** and may not match what is actually deployed.

**Master specification:** Found at `docs/product/SQUADSTASH_MASTER_SPEC_V2.md` (3,137 lines) — read in full and used as source of truth throughout.

**Preexisting uncommitted changes:** None. `git status` showed a clean working tree on branch `main` at both the start and end of this audit, with 0 tracked-file diffs.

---

## 3. Current Technology Stack

| Layer | Technology | Version | Source |
|---|---|---|---|
| Framework | Expo | ~54.0.31 | [package.json:15](package.json#L15) (confirmed) |
| Framework | React Native | 0.81.5 | [package.json:26](package.json#L26) (confirmed) |
| UI runtime | React | 19.1.0 | [package.json:24](package.json#L24) (confirmed) |
| Routing | Expo Router | ~6.0.21 | [package.json:19](package.json#L19) (confirmed); typed routes enabled ([app.json:37-39](app.json#L37-L39)) |
| Language | TypeScript | ~5.9.2 | [package.json:37](package.json#L37) (confirmed); `strict: true` ([tsconfig.json:4](tsconfig.json#L4)) |
| UI kit | react-native-paper | ^5.14.5 (MD3) | [package.json:27](package.json#L27) (confirmed) |
| Backend/data | Firebase JS SDK | ^12.4.0 | [package.json:23](package.json#L23) (confirmed) — Auth, Firestore, Functions client only; no Storage import found |
| Serverless | Cloud Functions (Node 20, `firebase-functions` v7, `firebase-admin` v13.6) | [functions/package.json](functions/package.json) (confirmed) |
| Node target | 20 | [functions/package.json:14](functions/package.json#L14) (confirmed for functions only; no root `engines` field — **inference**: mobile app has no enforced Node version) |
| Package manager | npm (package-lock.json present, two separate lockfiles: root and `functions/`) | (confirmed) |
| Native project files | None generated (`/ios`, `/android` gitignored, not present) — pure managed Expo workflow | [.gitignore:40-41](.gitignore#L40-L41) (confirmed) |
| Build/EAS | **Not configured** — no `eas.json` found anywhere in repo | (confirmed absence) |
| CI | **None** — no `.github/` directory found | (confirmed absence) |
| Testing | `react-test-renderer` present as devDependency; **no jest, no jest config, no test script** | (confirmed) |
| Linting | No root ESLint config; `functions/` has its own (`eslint-config-google`) | (confirmed) |

---

## 4. Repository Architecture Map

```
squadstash/
├── app/                          # Expo Router file-based routes
│   ├── (auth)/                   # Unauthenticated route group
│   │   ├── login.tsx
│   │   └── register.tsx
│   ├── (tabs)/                   # Authenticated tab group
│   │   ├── _layout.tsx           # Auth-gated tab layout (redirects if !user)
│   │   ├── home.tsx              # Dashboard (buckets-derived totals only)
│   │   ├── buckets.tsx           # Personal/shared savings buckets (most complete feature)
│   │   ├── transactions.tsx      # Static placeholder screen
│   │   ├── profile.tsx           # Minimal profile + logout
│   │   └── trips/
│   │       ├── _layout.tsx
│   │       ├── index.tsx         # Trip list + client-side search
│   │       ├── create.tsx        # Trip creation (with Wikipedia/loremflickr image lookup)
│   │       └── [tripId].tsx      # Trip detail (read-only analysis; delete; no join/contribute UI)
│   ├── _layout.tsx                # Root layout: fonts, PaperProvider, AuthProvider, Stack
│   ├── index.tsx                  # Entry redirect (auth-based)
│   ├── modal.tsx, +not-found.tsx, +html.tsx   # Untouched Expo template boilerplate
├── src/
│   ├── contexts/AuthContext.tsx   # Firebase Auth listener + user/publicUser doc upsert
│   └── theme/appTheme.ts          # MD3 Paper theme (light/dark)
├── components/                    # Mostly untouched Expo template boilerplate (Themed, ExternalLink, StyledText, useColorScheme)
├── constants/Colors.ts            # Legacy template color tokens (not used by Paper theme)
├── utils/format.ts                # `formatCurrency` — dollars-as-float formatter
├── functions/src/index.ts         # One Cloud Function: `lookupUserByEmail`
├── firebase.ts                    # Hardcoded Firebase client config, no env vars, no emulator wiring
├── firestore.rules                # Rules for buckets/trips/users/publicUsers only
├── firestore.indexes.json         # Two composite indexes (buckets, trips by memberIds+createdAt)
└── docs/                          # This audit prompt + the Master Spec (both newly added, uncommitted-to-code)
```

**Current data-flow description:** Screens call the Firebase JS SDK **directly** — there is no service layer, no repository/data-access abstraction, and no backend API. `onSnapshot`/`getDocs`/`updateDoc`/`addDoc` calls are inlined in screen components (e.g., [buckets.tsx:169-218](app/(tabs)/buckets.tsx#L169-L218), [home.tsx:58-88](app/(tabs)/home.tsx#L58-L88), [trips/create.tsx:132-147](app/(tabs)/trips/create.tsx#L132-L147)). This directly conflicts with Master Spec §17.3 ("All sensitive actions must pass through a server-side backend") — though at this prototype stage nothing is real money yet, so the *severity* is architectural debt, not an active financial-safety breach.

**Current authentication flow:** `AuthProvider` ([AuthContext.tsx:46-85](src/contexts/AuthContext.tsx#L46-L85)) subscribes to `onAuthStateChanged`, forces an ID-token fetch, then upserts a `publicUsers/{uid}` doc. `app/index.tsx` redirects to `/(tabs)/home` or `/(auth)/login` based on `user`. `app/(tabs)/_layout.tsx` independently re-checks `user`/`loading` and redirects to login if unauthenticated — this is a **second, duplicate authorization gate** (see BUG-003).

**Current Firestore interaction flow:** Every collection (`buckets`, `trips`, `users`, `publicUsers`) is read/written directly from screen components with real-time `onSnapshot` listeners for buckets/home, and one-shot `getDocs`/`getDoc` for trips list/detail. No caching layer, no read models, no reconciliation of any kind.

---

## 5. Route Map

| Route | File | Auth Required | Status | Main Issues |
|---|---|---|---|---|
| `/` | `app/index.tsx` | N/A (dispatcher) | Working | Simple redirect; correct |
| `/(auth)/login` | `app/(auth)/login.tsx` | No (unauthenticated only, but not enforced against already-logged-in users navigating here directly) | Working | Self-heals `users`/`publicUsers` docs on every login (reasonable), but generic error message fallback exposes raw Firebase error text to the user ([login.tsx:67-74](app/(auth)/login.tsx#L67-L74)) |
| `/(auth)/register` | `app/(auth)/register.tsx` | No | Working | Same raw-error-message issue ([register.tsx:75-81](app/(auth)/register.tsx#L75-L81)) |
| `/(tabs)/home` | `app/(tabs)/home.tsx` | Yes (via `(tabs)/_layout.tsx` redirect) | Working, fragile | Only reflects bucket totals; ignores trips entirely, so "Personal Savings" is incomplete vs. spec's Home Dashboard (§25) |
| `/(tabs)/buckets` | `app/(tabs)/buckets.tsx` | Yes | Working, fragile | Full CRUD + invite; but writes raw numeric `balance` (see SEC-001) |
| `/(tabs)/trips` (index) | `app/(tabs)/trips/index.tsx` | Yes | Working, fragile | Client-side search only (no server query); fallback query on error swallows the `orderBy` index requirement silently |
| `/(tabs)/trips/create` | `app/(tabs)/trips/create.tsx` | Yes | Working, fragile | Calls external Wikipedia/loremflickr APIs unauthenticated from the client for cover images ([create.tsx:37-76](app/(tabs)/trips/create.tsx#L37-L76)) — functional but an odd, uncontrolled third-party dependency for a financial app |
| `/(tabs)/trips/[tripId]` | `app/(tabs)/trips/[tripId].tsx` | Yes | Partially implemented | "Record Expense" button is presentational only (`console.log`, [tripId].tsx:214](app/(tabs)/trips/[tripId].tsx#L214)); **no contribute/join/invite UI exists at all**, despite `trip.saved` implying contributions happen somewhere |
| `/(tabs)/transactions` | `app/(tabs)/transactions.tsx` | Yes | Presentational only | Fully static placeholder; "Add Transaction" button just `console.log`s ([transactions.tsx:19](app/(tabs)/transactions.tsx#L19)) |
| `/(tabs)/profile` | `app/(tabs)/profile.tsx` | Yes | Working | Minimal but functional (display name, email, logout) |
| `/modal` | `app/modal.tsx` | Inherits stack | Unmodified template | Never linked to from anywhere in the app — orphaned route |
| `+not-found` | `app/+not-found.tsx` | N/A | Unmodified template | Fine as a 404 fallback |
| `+html` | `app/+html.tsx` | N/A (web only) | Unmodified template | Fine |

**Duplicate/overlapping auth gating:** Both `app/index.tsx` and `app/(tabs)/_layout.tsx` independently branch on `useAuth()` — functionally harmless today (see BUG-003) but a maintainability smell.

**Deep-link handling:** `app.json` declares `"scheme": "squadstash"` ([app.json:8](app.json#L8)) but no deep-link routes or handlers exist anywhere in `app/`. **Unable to verify** deep-link behavior without running the app.

**Orphaned/dead routes:** `app/modal.tsx` is unreferenced. `components/EditScreenInfo.tsx`, `ExternalLink.tsx`, `StyledText.tsx`, `constants/Colors.ts` are all unmodified Expo template boilerplate, only reachable via the orphaned `modal.tsx`.

---

## 6. Current Feature Inventory

| Feature | Status | Evidence | Completeness | Limitations | Recommendation |
|---|---|---|---|---|---|
| Authentication (email/password) | Working but fragile | [AuthContext.tsx](src/contexts/AuthContext.tsx), [login.tsx](app/(auth)/login.tsx), [register.tsx](app/(auth)/register.tsx) | Register/login/logout/session-persistence work; no verification, MFA, password reset, or reauth | No email verification, no MFA, no password-reset flow, raw Firebase error strings shown to users | Refactor + extend |
| Home dashboard | Partially implemented | [home.tsx](app/(tabs)/home.tsx) | Shows bucket totals/progress only | Ignores trips entirely; "Recent Activity" is a static placeholder string ([home.tsx:271-273](app/(tabs)/home.tsx#L271-L273)) | Refactor |
| Trips — list | Working, fragile | [trips/index.tsx](app/(tabs)/trips/index.tsx) | Real Firestore query + client search | Search is client-side substring match only, not a real search index; error fallback silently drops ordering | Refactor |
| Trips — create | Working, fragile | [trips/create.tsx](app/(tabs)/trips/create.tsx) | Functional; sets `saved: 0`, `target`, `memberIds: [owner]` | No contribution terms, no currency field, no governance/spending-rule fields (spec §11.1 requires these) | Replace (data model) |
| Trips — detail | Partially implemented | [trips/[tripId].tsx](app/(tabs)/trips/[tripId].tsx) | Read-only progress + "Quick Analysis" math | No members list UI, no wallet, no budget, no expenses, no settlements tab (spec §11.3 requires 6 sections; only "Overview" exists) | Replace |
| Trips — deletion | Working | [trips/[tripId].tsx:111-130](app/(tabs)/trips/[tripId].tsx#L111-L130) | Owner-only, confirmed via native/web dialog, rule-enforced ([firestore.rules:83](firestore.rules#L83)) | Hard delete of financial-adjacent data with no reversal/audit trail — conflicts with spec §3.8 | Replace (must become archive, not delete, once real money involved) |
| Trips — search | Working but fragile | [trips/index.tsx:135-143](app/(tabs)/trips/index.tsx#L135-L143) | Title/location substring filter over already-fetched list | Not scalable; no backend search | Refactor |
| Trips — images | Working but fragile | [trips/create.tsx:22-76](app/(tabs)/trips/create.tsx#L22-L76) | Wikipedia + loremflickr fallback chain, client-side | Unauthenticated third-party network calls from a financial app's client at trip-creation time; no caching/CDN; loremflickr is a placeholder-image service unsuited for production | Replace |
| Trips — contribute/join/invite | **Missing** | No matches for "contribute"/"joinTrip"/"invite" anywhere in `app/(tabs)/trips/**` | 0% — `memberIds` is set once at creation to `[owner]` and never modified anywhere in the app | This is a materially incomplete core feature relative to both the historical context and the spec | Investigate/Build fresh against spec §12–13 |
| Buckets — CRUD | Working, reasonably complete | [buckets.tsx](app/(tabs)/buckets.tsx) | Create/edit/delete, owner-restricted delete, quick-add | Delete permanently removes financial history (see BUG/DEBT below) | Refactor |
| Buckets — shared membership + email invite | Working, reasonably complete | [buckets.tsx:433-483](app/(tabs)/buckets.tsx#L433-L483), [functions/src/index.ts](functions/src/index.ts) | Cloud Function-backed email→UID lookup, owner-gated invite/remove | No invitation expiry/revocation (spec §12.4 requires both); Cloud Function has no rate limiting | Preserve pattern, extend |
| Buckets — balances | Working but fragile / financially unsafe | [buckets.tsx:281-309](app/(tabs)/buckets.tsx#L281-L309), [:385-398](app/(tabs)/buckets.tsx#L385-L398) | `balance` is a raw client-writable float, no floor/ceiling, no ledger | **Any bucket member can set any other member's shared balance directly** — see SEC-001 | Replace |
| Activity/Transactions | Missing (presentational only) | [transactions.tsx](app/(tabs)/transactions.tsx) | Static text, no data binding at all | 0% implemented | Investigate/Build fresh |
| Profile | Working | [profile.tsx](app/(tabs)/profile.tsx) | Display name/email/logout | No settings, no security controls, no notification prefs | Refactor/extend |
| Notifications | Missing | No push/notification code anywhere in repo | 0% | — | Build fresh |
| Onboarding | Missing | No onboarding flow found; register→home is immediate | 0% | No terms acceptance, no financial-eligibility step | Build fresh |
| Settings | Missing | No settings screen exists | 0% | — | Build fresh |

---

## 7. Firebase Data Model

All fields below are **confirmed from code** (writers/readers cited); nothing here is invented beyond what's cited.

### `buckets/{bucketId}`
- **Confirmed fields:** `name` (string), `target` (number), `balance` (number), `color` (string|null), `createdAt`/`lastUpdatedAt` (serverTimestamp), `ownerId` (string uid), `memberIds` (string[]), `lastUpdatedBy` (uid).
- **Writers:** create/update/delete/quickAdd all in [buckets.tsx](app/(tabs)/buckets.tsx) (client-direct `addDoc`/`updateDoc`/`deleteDoc`); membership add/remove also client-direct via `arrayUnion`/`arrayRemove`.
- **Readers:** [buckets.tsx](app/(tabs)/buckets.tsx) (real-time), [home.tsx](app/(tabs)/home.tsx) (real-time, totals only).
- **Query pattern:** `where("memberIds", "array-contains", uid) + orderBy("createdAt", "desc")` — matches the composite index at [firestore.indexes.json:3-21](firestore.indexes.json#L3-L21).
- **Rules coverage:** [firestore.rules:22-42](firestore.rules#L22-L42). List/get gated on membership/ownership (good). **Update rule does not restrict which fields can change** beyond `ownerId` immutability and a memberIds-consistency check — `balance`, `target`, `name`, `color` are all freely writable by any member.
- **Concerns:** No non-negative constraint on `balance`; no server-side validation that `balance` changes are additive/traceable; no per-user contribution ledger — `balance` is a single shared pooled number with no attribution of who contributed what (conflicts with spec §10.6, which defines `allocatedBalance = credits − debits`, i.e., derived, not directly settable).
- **Scaling concern:** `publicUsers` batch-fetch chunks UIDs into groups of 30 for Firestore's `in` query limit ([buckets.tsx:234-235](app/(tabs)/buckets.tsx#L234-L235)) — correctly handled, but re-subscribes on every `buckets` state change ([buckets.tsx:221-269](app/(tabs)/buckets.tsx#L221-L269)), which will create/destroy listeners repeatedly as buckets update — minor performance concern at scale.

### `trips/{tripId}`
- **Confirmed fields:** `title` (string), `location` (string|null), `target` (number), `saved` (number), `imageUrl` (string), `createdAt`/`lastUpdatedAt`, `ownerId`, `memberIds` (string[], set to `[owner]` at creation and never mutated elsewhere in the app).
- **Writers:** create in [trips/create.tsx:132-147](app/(tabs)/trips/create.tsx#L132-L147); delete in [tripId].tsx:117](app/(tabs)/trips/[tripId].tsx#L117). **No code path updates `saved`, `target`, or `memberIds` after creation** — meaning the "contribute" concept referenced in repo history/commit messages (`9288db9 "Trips UI: list + create + contribute + realtime progress"`) does not exist in the current tree.
- **Readers:** [trips/index.tsx](app/(tabs)/trips/index.tsx) (one-shot), [trips/[tripId].tsx](app/(tabs)/trips/[tripId].tsx) (one-shot, not real-time).
- **Query pattern:** `where("memberIds", "array-contains", uid) + orderBy("createdAt", "desc")`, with a **silent fallback** to an unordered query on error ([trips/index.tsx:103-123](app/(tabs)/trips/index.tsx#L103-L123)) — matches the composite index at [firestore.indexes.json:22-40](firestore.indexes.json#L22-L40).
- **Rules coverage:** [firestore.rules:55-84](firestore.rules#L55-L84). Same shape/weakness as buckets: any member can rewrite `saved`/`target` since only `ownerId` and `memberIds` consistency are checked on update.
- **Concerns:** `target` and `saved` are plain numbers (dollars, floating point) — direct conflict with spec §14.4 ("Currency must be stored in cents") and §35 ("must not use floating-point arithmetic for currency"). No trip status field, no wallet state machine (spec §6.4), no governance/contribution-terms fields at all.
- **Migration implication:** This entire collection's shape must be replaced, not migrated in place, once real trip wallets are introduced — `saved`/`target` cannot become authoritative financial fields under any circumstance.

### `users/{uid}`
- **Confirmed fields:** `uid`, `displayName`, `email`, `photoURL`, `createdAt`/`updatedAt`.
- **Writers/Readers:** [login.tsx:42-64](app/(auth)/login.tsx#L42-L64), [register.tsx:47-72](app/(auth)/register.tsx#L47-L72).
- **Rules coverage:** [firestore.rules:89-91](firestore.rules#L89-L91) — self-only read/write. Correct and minimal.

### `publicUsers/{uid}`
- **Confirmed fields:** `uid`, `displayName`, `photoURL`, `emailLower`, `createdAt`/`updatedAt`.
- **Writers:** self, on login/register/auth-state-change ([AuthContext.tsx:28-44](src/contexts/AuthContext.tsx#L28-L44)); **also read by the `lookupUserByEmail` Cloud Function indirectly** (actually that function queries Firebase Auth directly, not `publicUsers` — see Phase F note below).
- **Readers:** any signed-in user ([firestore.rules:94](firestore.rules#L94)) — used by buckets member-avatar rendering.
- **Rules coverage:** [firestore.rules:93-96](firestore.rules#L93-L96) — read: any signed-in user; write: self-only. This means `emailLower` for every user in the system is readable by every other signed-in user — low-severity PII exposure, worth noting for privacy review (spec §29.1 data minimization).

**Not found / not implemented (no evidence in code):** `partner_customers`, `external_accounts`, `financial_accounts`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `trip_members`, `transfers`, `cards`, `card_transactions`, `expenses`, `expense_allocations`, `disputes`, `reconciliation_runs`, `audit_events` — **none of §18's core financial data model exists**. This is expected at this stage but is the single largest gap vs. the spec.

**Firebase Storage:** No `storage.rules` file exists, no Storage bucket reference beyond the auto-provisioned `storageBucket` string in [firebase.ts:11](firebase.ts#L11), and no `firebase/storage` import anywhere in the client. All images are external URLs (Unsplash/loremflickr/Wikipedia). **Storage is effectively unused** — Phase G's Storage-rule checklist (public write paths, file-type/size validation) is not applicable because there is no Storage usage to audit.

---

## 8. Security Findings

| ID | Severity | Finding | Evidence | Potential Impact | Recommended Remediation | Relevant Milestone |
|---|---|---|---|---|---|---|
| SEC-001 | **Critical** | Firestore `update` rules for `buckets` and `trips` do not restrict which fields a member can change beyond `ownerId` and `memberIds` consistency. Any member can rewrite `balance`, `target`, `saved`, `name`, `color` to any value. | [firestore.rules:33-39](firestore.rules#L33-L39), [:74-80](firestore.rules#L74-L80); client write path e.g. [buckets.tsx:337-345](app/(tabs)/buckets.tsx#L337-L345) | Any co-member of a shared bucket/trip can silently zero-out, inflate, or falsify another member's savings data. If this schema is ever wired to real money without a rewrite, this becomes theft/fraud-enabling. | Add explicit field allow-lists on `update` (e.g., `request.resource.data.diff(resource.data).affectedKeys()` checks); ultimately, remove client write access to financial fields entirely once a backend ledger exists (spec §16.4, §21.4) | Milestone 1–2 |
| SEC-002 | High | No environment separation: `firebase.ts` hardcodes a single Firebase project config with no `.env`/`EXPO_PUBLIC_*` variables and no emulator wiring anywhere in the codebase (confirmed via repo-wide grep). | [firebase.ts:7-14](firebase.ts#L7-L14); grep for `emulator|process.env|EXPO_PUBLIC` returned zero matches in app code | Local development, testing, and CI (if added) all talk to the same live/production-named Firebase project (`squadstash-6d0f1`), risking dev data pollution of what will become the production project and making it impossible to safely test destructive rule/data changes. | Introduce `EXPO_PUBLIC_FIREBASE_*` env vars + separate dev/staging Firebase projects + emulator suite for local dev, per spec §21.4 "Environment separation" | Milestone 1 |
| SEC-003 | Medium | `publicUsers/{uid}` documents (including `emailLower`) are readable by **any** signed-in user, with no field-level restriction. | [firestore.rules:93-95](firestore.rules#L93-L95) | Any authenticated user (not just co-members) can enumerate all registered users' emails and display names by guessing/iterating UIDs or via a broad query. Low severity today (small user base, no query currently does this), but a privacy exposure that should be closed before wider release. | Restrict `publicUsers` read to users who share a bucket/trip, or strip `emailLower` from the publicly readable shape and keep email lookup server-side only (the existing `lookupUserByEmail` Cloud Function pattern is the right model — extend it, don't expose raw email in Firestore) | Milestone 1 |
| SEC-004 | Medium | Login/registration error handling surfaces raw Firebase SDK error messages to the UI in the fallback `else` branch. | [login.tsx:67-74](app/(auth)/login.tsx#L67-L74), [register.tsx:75-81](app/(auth)/register.tsx#L75-L81) | Verbose internal error strings shown to end users; minor information-disclosure and poor UX, not itself exploitable but a bad pattern to carry into a financial app where error messages must be curated (spec §27.5 accessible errors). | Map all Firebase auth error codes to a fixed, reviewed set of user-facing messages; never fall through to raw `e.message` | Milestone 3 |
| SEC-005 | Informational | Firebase Web API key is committed in plaintext in `firebase.ts`. | [firebase.ts:8](firebase.ts#L8) (value not reproduced here per redaction policy) | Low intrinsic risk — Firebase web API keys are not secret by design and are protected by Firestore/Storage security rules and Firebase Auth, not by key secrecy. Flagged only because it reinforces SEC-002 (no env separation) and should still move to env-driven config as a matter of hygiene and multi-environment readiness. | Move to `EXPO_PUBLIC_FIREBASE_*` env vars even though not itself a secret | Milestone 1 |
| SEC-006 | Low | `lookupUserByEmail` Cloud Function requires authentication but has no rate limiting or App Check, and returns UID for any queried email (email enumeration). | [functions/src/index.ts:15-34](functions/src/index.ts#L15-L34) | An authenticated attacker could enumerate whether arbitrary emails have SquadStash accounts. | Add App Check, rate limiting, and consider returning a generic "not found" without distinguishing "no such email" vs. "not a user" if abuse becomes a concern | Milestone 3 |

No evidence of: unauthenticated reads/writes on any collection, hardcoded user IDs in production code paths, client-controlled `ownerId` at create time (`ownerId` is correctly pinned to `request.auth.uid` in both `buckets` and `trips` create rules — [firestore.rules:26](firestore.rules#L26), [:61](firestore.rules#L61)), or committed `.env`/service-account files (none found; `.gitignore` correctly excludes `.env*.local`, and no `.env` file of any kind is present in the tree).

**Note on `.gitignore` gap:** [.gitignore:33-34](.gitignore#L33-L34) only ignores `.env*.local`, not a plain `.env`. No `.env` file currently exists, so this is not an active leak, but it is a latent gap — if a developer later adds a plain `.env` (e.g., for the recommended SEC-002/SEC-005 fix), it would **not** be gitignored by the current pattern and could be committed accidentally. Recommend broadening to `.env*` (with explicit `.env.example` un-ignored if needed) before introducing any env-based secrets.

---

## 9. Bugs and Reliability Findings

| ID | Severity | Area | Finding | Evidence | User Impact | Recommended Remediation |
|---|---|---|---|---|---|---|
| BUG-001 | High | Currency handling | All money values (`formatCurrency`, `money()`, bucket/trip `balance`/`target`/`saved`) are plain JavaScript floating-point numbers, not integer cents. | [utils/format.ts:1-2](utils/format.ts#L1-L2), [trips/index.tsx:44-48](app/(tabs)/trips/index.tsx#L44-L48), [buckets.tsx](app/(tabs)/buckets.tsx) throughout | Floating-point arithmetic on money (`quickAdd`, per-person split math in trip details) will accumulate rounding errors over time and directly violates spec §14.4/§35. Not yet consumer-visible at small scale but is a landmine. | Standardize on integer cents everywhere before any real financial logic is added; this is foundational, not cosmetic |
| BUG-002 | Medium | Trip list resilience | `fetchTrips` catches a query error (likely a missing-index error) and silently retries **without** `orderBy`, hiding the root cause and producing unordered results with no user-facing indication. | [trips/index.tsx:103-123](app/(tabs)/trips/index.tsx#L103-L123) | Users may see trips in unpredictable order with no error shown, and real query/index problems go unnoticed in production. | Surface the error, fix root cause, remove silent fallback |
| BUG-003 | Low | Navigation | Two independent auth gates: `app/index.tsx` (redirect based on `user`) and `app/(tabs)/_layout.tsx` (separate redirect based on `user`). | [index.tsx:5-17](app/index.tsx#L5-L17), [(tabs)/_layout.tsx:17-40](app/(tabs)/_layout.tsx#L17-L40) | No current user-visible bug, but duplicated logic risks drifting out of sync (e.g., one gets updated with MFA checks and the other doesn't). | Centralize auth-gating logic in one place (e.g., a single `<Protected>` wrapper or route guard hook) |
| BUG-004 | Low | Trip detail actions | "Record Expense" button is non-functional (`console.log` only) but presented with full visual affordance identical to working buttons. | [tripId].tsx:213-225](app/(tabs)/trips/[tripId].tsx#L213-L225) | Users can tap a seemingly-functional button that does nothing, with no feedback — confusing UX for a financial action. | Either implement or visually mark as "coming soon" / disable |
| BUG-005 | Low | Transactions tab | Entire screen is static placeholder text; "Add Transaction" button does `console.log`. | [transactions.tsx:1-26](app/(tabs)/transactions.tsx#L1-L26) | Users navigating to "Transactions" from Home's Quick Actions find nothing functional. | Build the feature or remove from primary navigation until ready |
| BUG-006 | Low | Bucket real-time re-subscription | The `publicUsers` listener effect depends on the full `buckets` array reference, so it tears down and rebuilds Firestore listeners on every bucket balance change. | [buckets.tsx:221-269](app/(tabs)/buckets.tsx#L221-L269) | Unnecessary Firestore listener churn; potential minor performance/cost impact at scale, not currently user-visible. | Depend on a stable derived UID set (e.g., memoized/sorted-joined string) instead of the raw array |

---

## 10. Technical Debt Findings

| ID | Area | Description | Why It Matters | Recommended Action | Priority |
|---|---|---|---|---|---|
| DEBT-001 | Data access layer | Every screen calls the Firebase SDK directly; there is no service/repository abstraction anywhere. | Blocks the spec's required provider abstraction (§17.6) and backend-boundary work (§17.3); makes it hard to later swap Firestore reads for backend-API reads. | Introduce a thin data-access layer (`src/services/buckets.ts`, `src/services/trips.ts`) even before the real backend exists, so screens depend on an interface, not the SDK directly | High |
| DEBT-002 | Testing | No test runner is wired up (`jest` not installed, no config, no `test` script); only one snapshot test exists and cannot currently run. | Spec §33 requires extensive unit/integration/financial-scenario tests before any money work begins; there is currently zero test infrastructure to build on. | Install `jest-expo`, add a `test` script, get the existing snapshot test running, then build outward | High |
| DEBT-003 | Linting | No ESLint config or script exists for the mobile app (only `functions/` has one). | Strict TypeScript alone won't catch React hook-dependency bugs, unused vars, etc.; spec §35 requires "run type checks, linting and tests." | Add `eslint-config-expo` (or equivalent) + root lint script | Medium |
| DEBT-004 | CI/CD | No GitHub Actions or any CI configuration exists. | No automated gate for type-check/lint/test on PRs; conflicts with spec's implicit expectation of a testing foundation (Milestone 1). | Add a basic CI workflow running `tsc --noEmit` (already passes) + lint + tests once those exist | Medium |
| DEBT-005 | Template debris | `components/Themed.tsx`, `ExternalLink.tsx`, `StyledText.tsx`, `EditScreenInfo.tsx`, `constants/Colors.ts`, `app/modal.tsx` are unmodified Expo starter-template files, only reachable through the orphaned `/modal` route, and use a color system (`constants/Colors.ts`) entirely separate from the actual app theme (`src/theme/appTheme.ts`). | Dead code and a second, unused design-token system create confusion about which theme is authoritative. | Remove or consciously repurpose; consolidate on `src/theme/appTheme.ts` | Low |
| DEBT-006 | Duplicate money-formatting logic | `utils/format.ts` (`formatCurrency`) and inline `money()` helpers in `trips/index.tsx` and `trips/[tripId].tsx` do the same thing slightly differently (one uses `Intl.NumberFormat`, the other `toLocaleString`). | Inconsistent currency display and a preview of the "Money Status Language" consistency problem spec §27.3 warns about. | Consolidate into one currency-formatting utility, used everywhere | Low |
| DEBT-007 | Bucket delete is a hard delete | `onConfirmDelete` in buckets.tsx performs a real `deleteDoc`, permanently destroying bucket history with no archive step. | Spec §10.8: "Buckets with financial history must be archived rather than deleted." Even as a prototype, this pattern will need to change before any real usage, and the UI/UX pattern (a simple destructive delete) will need to become an archive flow. | Add `status: archived` instead of delete once any real balances exist | Medium |
| DEBT-008 | Trip `memberIds` never grows | Trip creation sets `memberIds: [owner]` and no code anywhere adds to it — the "join/contribute" feature implied by commit history and the tab bar (Trips) does not exist. | This is the single largest functional gap between what the UI implies (a group trip product) and what the code does (a single-owner trip tracker with no group mechanics). | Treat as a fresh build against spec §12–13, reusing the bucket invite-by-email pattern as a proven template | High |

---

## 11. Diagnostic Results

| Command | Status | Result | Important Errors | Files Changed? |
|---|---|---|---|---|
| `git status` / `git log` / `git diff --stat` | Ran | Clean tree, branch `main`, up to date with `origin/main`, 0 diffs before and after audit | None | No |
| `node_modules/.bin/tsc --noEmit -p tsconfig.json` (root) | Ran | **Passed — 0 errors** | None | No |
| `node_modules/.bin/tsc --noEmit -p tsconfig.json` (functions) | Ran | **Passed — 0 errors** | None | No |
| ESLint (root) | Not run | No config/script exists | N/A | N/A |
| ESLint (functions) | Not run (limitation, see §2) | Config exists (`eslint-config-google`) but not executed | N/A | N/A |
| `jest` / test suite | Not run | Not installed, no config, no script | N/A | N/A |
| `expo-doctor` | Not run (policy) | Binary not installed; running via `npx` would require an uninstalled-package fetch, prohibited under audit rules | N/A | N/A |
| `npm audit` / `npm ls` | Not run | Deferred to avoid any lockfile-adjacent side effects during an audit-only pass | N/A | N/A |

**Confidence note:** The clean `tsc` result across both projects is a genuinely positive signal — strict mode is on and the codebase respects it. This is one of the few areas where the repository already meets a Master Spec expectation (§35: "Use strict TypeScript").

---

## 12. Test Coverage Assessment

**Existing tests:** One Jest/react-test-renderer snapshot test (`components/__tests__/StyledText-test.js`) for an unused template component. **It cannot currently execute** — no `jest` dependency, no config, no script.

**Missing tests:** Effectively everything. No tests exist for: authentication flows, bucket CRUD, bucket invite/membership, trip CRUD, currency formatting, Firestore security rules (no `@firebase/rules-unit-testing` setup found), or any UI component beyond the one dead snapshot.

**Highest-risk untested workflows:**
1. Firestore security-rule behavior for `buckets`/`trips` updates (directly relevant to SEC-001 — a rules-unit-test suite would have caught the missing field-allow-list).
2. Bucket invite/remove/leave member-management logic (`buckets.tsx:433-540`) — multiple interacting permission branches (owner vs. member) with no coverage.
3. Currency/progress-percentage math (`quickAdd`, per-person trip splits) — exactly the kind of logic spec §33.1 requires unit tests for, and currently 0% covered.

**Minimum testing foundation required before implementation continues** (per spec Milestone 1 intent):
1. Install `jest-expo`, get the existing snapshot passing.
2. Add `firebase-tools` emulator + `@firebase/rules-unit-testing` and write rules tests for the SEC-001 gap before fixing it (test-first).
3. Add unit tests for `formatCurrency` and any bucket/trip math before touching cents-conversion (BUG-001) — a regression net for a currency-representation change is essential.
4. Wire a root `test` script and a CI workflow that runs it.

---

## 13. Master Specification Gap Analysis

| Area | Classification | Notes |
|---|---|---|
| Authentication | Partially existing | Email/password only; no MFA, verification, password reset, device management (spec §21.1) |
| User profiles | Partially existing | `users`/`publicUsers` docs exist; no eligibility status, preferred currency, time zone fields (spec §18.1) |
| Identity verification | Missing | No verification-status field or flow anywhere |
| Bank linking | Missing | No `external_accounts` concept, no provider integration |
| Backend API | Missing | No server-side application exists at all; 100% client-direct-to-Firebase |
| PostgreSQL ledger | Missing | No relational database anywhere in the stack |
| Personal buckets | Prototype only | UI/data model exists but as a directly-writable Firestore number, not a ledger-derived balance |
| Trip wallets | Prototype only (severely partial) | `trips` collection exists but has none of the wallet-state, member-ledger, or fund-stage concepts of spec §6 |
| Contributions | Missing | No contribution records, no per-member ledger, `saved` is never actually updated by any code path |
| Trip cards | Missing | No card concept anywhere |
| Spending controls | Missing | No concept exists |
| Expenses | Missing (presentational stub only) | "Record Expense" button is a no-op |
| Disputes | Missing | No concept exists |
| Refunds | Missing | No concept exists |
| Settlement | Missing | No concept exists |
| Reconciliation | Missing | No concept exists |
| Risk | Missing | No concept exists |
| Admin console | Missing | No admin surface anywhere |
| Security | Partially existing | Firestore Auth + rules exist but have the field-validation gap (SEC-001); no MFA, no step-up auth, no rate limiting beyond Firebase defaults |
| Customer support | Missing | No support flow, case system, or in-app reporting |
| App Store readiness | Prototype only | Bundle identifiers not set (§Q below), no EAS config, no privacy/terms links, no account-deletion flow |
| **Architecturally incompatible items:** | | `buckets.balance` and `trips.saved` as directly client-writable numbers are **architecturally incompatible** with spec §16 (double-entry ledger) and must be replaced, not evolved, once real money is introduced |
| **Requires external partner/legal decision:** | | Everything in spec §4 (legal entity, financial partner selection, licensing analysis) — none of this is a code-repository concern and none of it currently exists in any form in this repo (expected and correct for this stage) |

---

## 14. Preserve, Refactor, Replace and Remove

### Preserve
- Expo Router file-based routing structure and route grouping (`(auth)`, `(tabs)`) — sound, idiomatic, and typed-routes-enabled ([app.json:37-39](app.json#L37-L39)).
- `AuthContext.tsx` overall pattern (single provider, `onAuthStateChanged`, forced token refresh before marking loaded) — reasonable base to extend with MFA/step-up later.
- `firestore.rules` `ownerId`-immutability and creator-must-be-in-`memberIds` patterns ([firestore.rules:25-28](firestore.rules#L25-L28), [:60-63](firestore.rules#L60-L63)) — correct primitives, just need to be extended with field-level restrictions (SEC-001), not thrown away.
- The bucket email-invite pattern (`lookupUserByEmail` Cloud Function + client `httpsCallable`) — a legitimate "identify a user without exposing their record" pattern worth reusing for trip invites (once rebuilt with the missing expiry/revocation, spec §12.4).
- Strict TypeScript configuration (both `tsconfig.json` files) — currently 0 errors, keep enforcing.

### Refactor
- All direct Firebase SDK calls in screen components ([buckets.tsx](app/(tabs)/buckets.tsx), [home.tsx](app/(tabs)/home.tsx), [trips/*.tsx](app/(tabs)/trips/)) — extract into a service layer (DEBT-001) before adding more screens that repeat the pattern.
- Currency formatting (`utils/format.ts` + duplicated `money()` helpers) — consolidate (DEBT-006) as a precursor to the cents conversion (BUG-001).
- Auth-gating duplication between `app/index.tsx` and `app/(tabs)/_layout.tsx` (BUG-003).
- `trips/index.tsx` error-fallback query logic (BUG-002) — needs real error surfacing, not silent degradation.

### Replace
- `buckets.balance` / `trips.saved` / `trips.target` as directly-writable Firestore numbers — must become read-model projections derived from a real ledger once any money is involved (spec §16, §17.7). This is the single most consequential replace item in the repository.
- Firestore security rules for `buckets`/`trips` `update` — must add field-level allow-lists immediately (SEC-001), and ultimately most financial-field writes must move server-side entirely.
- Trip data model (`trips/create.tsx`'s document shape) — missing currency, contribution terms, governance, and status fields required by spec §11.1; the whole shape should be redesigned alongside the trip-wallet build rather than incrementally patched.

### Remove or Archive
- `app/modal.tsx` and its exclusively-reachable dependents (`components/EditScreenInfo.tsx`, `ExternalLink.tsx`, `StyledText.tsx`, `components/__tests__/StyledText-test.js`, `constants/Colors.ts`) — unmodified Expo template boilerplate, orphaned from real navigation (DEBT-005). Safe to remove once the team confirms nothing else references them (this audit did not remove anything, per audit-only constraints).
- `app/(tabs)/transactions.tsx` static placeholder — either build for real or remove from tab navigation so it doesn't present as a functional feature to users (BUG-005).

---

## 15. Recommended Target Architecture

Given the repository's current size (~30 files) and stage (pre-Milestone-1), **a full immediate rewrite is not justified.** The recommendation is incremental migration toward the spec's `apps/ / services/ / packages/` layout, starting only with the pieces that unblock safety and testability.

**What stays in the current mobile repo (near-term):**
- Everything under `app/`, `components/`, `src/` as-is, becoming the eventual `apps/mobile/` — no need to physically move files yet.
- `functions/` stays as the seed of `services/webhooks/` or a thin `services/api/` shim later, but should **not** grow into housing real financial logic (Cloud Functions are a poor fit for the transactional-consistency requirements of §17.4/§17.5 — a real backend service with PostgreSQL is what the spec calls for, and that belongs in a new `services/api/` codebase, likely a separate deployable, not deeper Cloud Functions).
- `firestore.rules` / `firestore.indexes.json` become the seed of `firebase/rules/` and `firebase/indexes/` once the repo is restructured — Firebase's role narrows to auth, non-authoritative projections, and realtime UI convenience per spec §17.2.

**What should eventually become separate services:**
- A new `services/api/` (TypeScript, containerized, per spec §17.3) owning all financial writes — nothing in the current `app/` should ever call Firestore directly for a financial field once this exists.
- A new `services/ledger/` implementing the double-entry model (spec §16) against PostgreSQL (spec §17.4) — this does not exist in any form today and is the largest net-new build.
- A `packages/shared-types/` extracted early (even before the backend exists) so the mobile app's `Bucket`/`TripDoc` types and the eventual backend's types are the same source — currently these types are defined inline per-screen ([buckets.tsx:44-53](app/(tabs)/buckets.tsx#L44-L53), [trips/index.tsx:29-39](app/(tabs)/trips/index.tsx#L29-L39)) with no sharing, which will drift.

**Sequencing recommendation:** Do not create the full `apps/services/packages/` skeleton yet — it would be premature structure for a ~30-file repo with no backend. Instead, treat Milestone 1 (this audit + stabilization) as the trigger for extracting `packages/shared-types/` and a `src/services/` data-access layer *within the current repo*, and only split into separate deployables (`apps/`, `services/`) at the start of Milestone 2 when a real backend and ledger are actually being built.

---

## 16. Data Migration Considerations

- **Fields that conflict with the new model:** `buckets.balance`, `trips.saved`, `trips.target` — all currently raw client-writable floats representing money with no ledger backing. None of these can become authoritative once real money exists.
- **Records that may need migration:** Any existing `buckets`/`trips` documents created during prototyping (in the live `squadstash-6d0f1` project) will need either (a) a one-time migration into ledger-backed equivalents with a `$0`/reset starting balance and clear user communication that prior "balances" were prototype data, or (b) explicit archival/deletion before real-money launch. **This audit did not inspect actual Firestore document contents** (no live-data access performed), so the volume/shape of real existing data is unknown and should be assessed separately.
- **Fields that may remain as display-only projections:** `name`, `color`, `target date`/`title`, `location`, `imageUrl` — cosmetic/planning metadata that can safely continue to live in Firestore as read-model/UI data even after a ledger exists, per spec §17.7.
- **Data that should not become authoritative financial data:** `balance`, `saved`, `target` in their current directly-writable form — explicitly called out in spec §Financial Safety Requirements and confirmed as a live pattern in this codebase (SEC-001).
- **Backward-compatibility issues:** Trip documents have no `status`/wallet-state field today; introducing spec §6.4's state machine (`draft`, `funding_open`, …) will require a default-state backfill for any existing trip documents.
- **Need for migration scripts:** Yes — not written during this audit (per constraints), but will be required to (a) backfill a `status` field on existing trips, (b) convert any float dollar amounts to integer cents, (c) seed initial ledger accounts/balances from current `balance`/`saved` values as a one-time "opening balance" adjustment entry (never a silent overwrite, per spec §22.4).
- **Need for development-data cleanup:** Given there is no environment separation (SEC-002), it is likely that development/test bucket and trip documents exist in the same Firestore project intended for eventual production use. This should be inventoried and cleaned up (or the project split into dev/prod) before Milestone 2 begins.

---

## 17. Prioritized Implementation Plan

### Phase 0 — Repository Safety and Stabilization
- **Objective:** Make the repo safe to iterate on without silent financial-field escalation.
- **Scope:** Firestore rules field-allow-listing (SEC-001), `.gitignore` broadening for future `.env` files.
- **Files/systems affected:** `firestore.rules`.
- **Dependencies:** None.
- **Risks:** Tightening rules could break the existing `quickAdd`/edit flows if not carefully scoped to still allow legitimate owner/member field changes — must be paired with rules-unit tests.
- **Tests required:** `@firebase/rules-unit-testing` suite covering allowed vs. disallowed field writes for both `buckets` and `trips`.
- **Exit criteria:** Rules tests pass; manual verification that legitimate bucket/trip edits still work; no member can write to another member's balance-adjacent field without an explicit, intended path.

### Phase 1 — Authentication Reliability
- **Objective:** Close the gaps in spec §21.1 (verification, password reset, MFA groundwork).
- **Scope:** Email verification on register, password-reset flow, curated error messages (SEC-004).
- **Files/systems affected:** `app/(auth)/*.tsx`, `src/contexts/AuthContext.tsx`.
- **Dependencies:** Phase 0.
- **Risks:** Low — additive changes to an already-working flow.
- **Tests required:** Unit tests for error-message mapping; manual QA of verification/reset emails.
- **Exit criteria:** New users receive verification email; password reset works end-to-end; no raw SDK error text reaches the UI.

### Phase 2 — Code-Quality and Testing Foundation
- **Objective:** Stand up the testing/linting infra required by spec §33 and this audit's Test Coverage Assessment (§12).
- **Scope:** Install `jest-expo`, root ESLint config, CI workflow.
- **Files/systems affected:** `package.json`, new `jest.config.js`, new `.eslintrc`, new `.github/workflows/ci.yml`.
- **Dependencies:** None (can run parallel to Phase 1).
- **Risks:** Low.
- **Tests required:** The existing snapshot test passes; a handful of new unit tests for `formatCurrency` and bucket math.
- **Exit criteria:** `npm test`, `npm run lint`, `npm run typecheck` all exist and pass in CI on every PR.

### Phase 3 — Firebase Security Hardening
- **Objective:** Close SEC-003 (publicUsers exposure), SEC-005/SEC-002 (env separation), SEC-006 (function hardening).
- **Scope:** `firestore.rules`, `firebase.ts`, `functions/src/index.ts`.
- **Dependencies:** Phase 0, Phase 2 (need rules tests in place first).
- **Risks:** Env-separation change touches every screen indirectly (via `firebase.ts` import) — needs full regression pass.
- **Tests required:** Rules tests; manual verification against a Firebase emulator.
- **Exit criteria:** No PII over-exposure; dev/staging Firebase project(s) exist and are used locally by default.

### Phase 4 — Backend Boundary (groundwork)
- **Objective:** Introduce the first server-side service and a client data-access layer, without yet moving real logic.
- **Scope:** New minimal `services/api/` skeleton (health check + one proxied read), `src/services/` client abstraction replacing direct Firestore calls in screens (DEBT-001).
- **Dependencies:** Phases 0–3.
- **Risks:** Largest refactor so far; must be done incrementally, screen by screen, with tests before/after each.
- **Tests required:** Integration test hitting the new API skeleton; regression tests for each migrated screen.
- **Exit criteria:** At least one read path (e.g., bucket list) flows through the new service layer end-to-end, proving the pattern before wider rollout.

### Phase 5 — Financial-Domain Model
- **Objective:** Define `packages/financial-domain/` types (integer cents, statuses) shared between mobile and future backend.
- **Scope:** New shared types package; convert existing dollar-float fields to cents in the UI layer first (display-only conversion) without yet touching Firestore schema.
- **Dependencies:** Phase 4.
- **Risks:** Cents conversion touches every money-displaying screen; regression-prone.
- **Tests required:** Unit tests for cents↔display conversion, covering rounding edge cases (spec §14.4).
- **Exit criteria:** Zero floating-point currency math remains in the client codebase.

### Phase 6 — Double-Entry Ledger Foundation
- **Objective:** Stand up PostgreSQL + `services/ledger/` implementing spec §16.
- **Scope:** New service, new database, new ledger-entry API.
- **Dependencies:** Phase 5 (shared cents-based types).
- **Risks:** Largest net-new infrastructure piece; requires DevOps/hosting decisions out of scope for this repo audit.
- **Tests required:** Full spec §33.1 unit-test list (balancing, idempotency, reversal).
- **Exit criteria:** A ledger transaction can be created, is provably balanced, and is queryable — with no UI wiring yet.

### Phase 7 — Provider-Neutral Sandbox Interfaces
- **Objective:** Define `packages/provider-interfaces/` (spec §17.6) so no business logic couples to a specific financial partner.
- **Dependencies:** Phase 6.
- **Risks:** Requires a financial-partner decision (Decision Register, §18 below) before real sandbox wiring — interfaces can be defined without a partner, but cannot be tested end-to-end until one is chosen.
- **Exit criteria:** Interfaces compile and have a mock/no-op implementation usable in tests.

### Phase 8 — Personal Bucket Flow (ledger-backed)
- **Objective:** Rebuild buckets on top of the ledger, replacing directly-writable `balance`.
- **Dependencies:** Phases 6–7.
- **Risks:** User-facing data-shape change; needs the migration plan from §16 above.
- **Exit criteria:** Bucket balances are 100% ledger-derived; direct Firestore writes to `balance` are impossible (rules deny it).

### Phase 9 — Trip-Wallet Flow (ledger-backed)
- **Objective:** Rebuild trips with real membership/invite (closing DEBT-008), contribution tracking, and wallet states (spec §6).
- **Dependencies:** Phase 8 (reuse the same ledger patterns).
- **Exit criteria:** A trip can be created, joined, contributed to, and shows accurate per-member ownership — all ledger-derived.

No phase in this plan reaches live financial-provider integration, card issuance, or real money movement — consistent with spec §4.3 and the audit instructions, that work is explicitly gated behind the Decision Register items below and cannot begin from code changes alone.

---

## 18. Decision Register

| Decision | Why It Matters | Options | Recommendation | Deadline/Milestone |
|---|---|---|---|---|
| Trip-wallet legal structure | Determines whether trip funds are custodial-pooled, per-member subaccounts, or manager-associated (spec §6.2) | Partner subaccount / pooled custodial with subledger / manager-associated with controlled terms | Defer to financial-services counsel + chosen partner; pooled-custodial-with-subledger is the most common pattern for this use case but must be partner-confirmed | Before Milestone 5 |
| User-funds ownership model | Legal basis for "whose money is it" underlies every UI label and dispute process | FBO/custodial account / individual accounts per user / hybrid | Requires legal analysis (spec §4) | Before Milestone 4 |
| Financial partner selection | Everything in Phases 6–9 of the implementation plan is contingent on API shape from a real partner | Multiple embedded-finance providers exist; selection criteria per spec §4.3 | Not a code decision — product/legal-owned | Before Milestone 2 completion |
| Geographic launch scope | Affects compliance scope and risk-control complexity | US-only pilot (spec-recommended) vs. broader | Spec explicitly recommends US-only, adults 18+, ACH-only initial pilot (§4.2) — recommend following as written | Before Milestone 0 exit |
| Manager spending authority model | Directly shapes the trip-card and approval-rule data model (spec §7.3, §8) | Single-manager unrestricted-within-limits / dual-approval for high-value / group vote | Recommend starting with single-manager + configurable per-transaction/daily limits (simplest to build and reason about first) | Before Milestone 6 |
| Member voting/approval model | Determines whether expense-split approval requires unanimous, majority, or manager-only sign-off | Manager-only / majority vote / unanimous for disputes only | Recommend manager-proposes + affected-member-must-approve-if-disputed (matches spec §14.5/§14.6 baseline) as the simplest compliant default | Before Milestone 6 |
| Contribution commitment rules | When does a contribution become "locked" — immediately, on a date, or on threshold (spec §13.4)? | Immediate / scheduled lock date / member-confirmation / threshold-based | Recommend scheduled lock date (clearest UX, easiest to test) as the initial default, configurable per trip | Before Milestone 5 |
| Refund/unused-funds distribution rule | Determines settlement math (spec §15.3) | Proportional to remaining ownership / net-contribution-based / custom | Recommend proportional-to-remaining-ownership as the fairest simple default | Before Milestone 7 |
| Transaction/spending limits | Risk-control baseline (spec §9.7, §20) | Must be partner- and risk-team-defined; cannot be hardcoded in the app | Start conservative (spec §3.10 "Gradual Risk Expansion"); make limits server-configurable from day one, not hardcoded | Before Milestone 9 |
| Card program structure | Physical vs. virtual-only, single vs. multi-card per trip (spec §8.2) | Virtual-only, single manager card (spec-recommended initial model) | Follow spec's explicit recommendation — virtual, single-manager, capped — for the pilot | Before Milestone 6 |
| Subscription/monetization model | Free-tier limits and Pro feature set (spec §30) | Various tier splits | Product-owner decision; not urgent until near Milestone 11 | Before Milestone 11 |

---

## 19. Immediate Next Actions

1. Write a Firestore rules-unit-test suite (using the emulator) reproducing the SEC-001 exploit (a non-owner member overwriting `balance`) as a **failing test first**, before changing any rule.
2. Fix `firestore.rules` to allow-list which fields non-owner members may change on `buckets`/`trips` `update`, and confirm the new test passes without breaking existing edit/quickAdd flows.
3. Add a root `test` script and install `jest-expo`; get the existing `StyledText-test.js` snapshot running again.
4. Add a root ESLint config and `lint` script; run it once and record (but do not yet fix) the baseline findings.
5. Broaden `.gitignore` to cover any future plain `.env` file (not just `.env*.local`), before anyone adds environment-variable-based Firebase config.
6. Move the Firebase client config in `firebase.ts` to `EXPO_PUBLIC_FIREBASE_*` environment variables (config move only — no new secrets, no behavior change).
7. Restrict `publicUsers` reads to shared-membership context rather than "any signed-in user" (SEC-003), verified against the existing bucket-member-avatar use case so it doesn't regress.
8. Set up a second (dev/staging) Firebase project and wire local development to it by default, reserving `squadstash-6d0f1` as the eventual production target.
9. Add a minimal GitHub Actions workflow running `tsc --noEmit` (already green) + lint + test on every PR, so future changes can't silently regress the one clean diagnostic this audit found.
10. Decide and document (even informally, pending legal review) whether existing prototype `buckets`/`trips` Firestore documents in the live project should be treated as disposable test data or need a formal migration path — this blocks how aggressively Phase 0–3 rule changes can be made.

---

## 20. Final Audit Integrity Statement

- **Tracked files modified by this audit:** None. `git diff --stat` was empty at the end of the audit, matching the clean state at the start.
- **Untracked files created:** None.
- **Dependencies installed:** None. `expo-doctor` and ESLint (functions) were explicitly *not* run because doing so would have required installing an uninstalled package or was judged out of caution for this audit-only pass; both are documented as limitations in §2 and §11, not silently skipped.
- **External systems changed:** None. No Firebase deploy, no Firestore writes, no Cloud Functions deploy, no network calls that mutate any remote state were performed. (Read-only `tsc` type-checking was executed locally against already-installed `node_modules`.)
- **Final Git status:** Branch `main`, up to date with `origin/main`, working tree clean, 0 uncommitted or untracked changes — identical to the state recorded at the start of the audit.
- **Limitations preventing higher-confidence conclusions:**
  - The app was never run/built; all UI behavior claims are based on static code reading, not observed runtime behavior.
  - Actual deployed Firestore rules, Firebase Auth provider configuration, and live document contents in the `squadstash-6d0f1` project were not inspected — this report reflects **repository state only**, which may or may not match what is currently live.
  - `expo-doctor`, ESLint (mobile app — no config exists), and the full Jest suite could not be run, leaving those specific diagnostic categories unverified rather than confirmed-clean.
  - Dependency vulnerability scanning (`npm audit`) was not performed.
