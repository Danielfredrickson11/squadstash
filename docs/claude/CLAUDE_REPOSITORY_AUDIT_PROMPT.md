# SquadStash Repository Audit Instructions

You are acting as a senior mobile architect, fintech systems engineer, application-security reviewer, and technical program lead.

You have access to the existing SquadStash repository. Your assignment is to perform a comprehensive, evidence-based audit of the repository and compare the current implementation against the SquadStash Master Product, Financial and Technical Specification Version 2.0.

## Primary Objective

Determine exactly what currently exists, what works, what is incomplete, what is unsafe, and what must change before SquadStash can be developed into a production-quality embedded-finance application.

This is an **audit-only phase**.

Do not modify, create, delete, rename, format, install, upgrade, or refactor any project files during this audit.

Do not begin implementing the master specification.

Your final output must be a detailed repository audit and prioritized implementation plan that another development session can follow.

---

# 1. Source of Truth

Locate and read:

`docs/product/SQUADSTASH_MASTER_SPEC_V2.md`

Treat that document as the primary product and architectural source of truth.

If the file is missing:

1. Stop the comparison portion of the audit.
2. Continue documenting the repository’s current state.
3. Clearly state that the master specification was not found.
4. Do not invent its contents.
5. Do not modify the repository.

When existing code conflicts with the master specification, document the conflict. Do not resolve it during this audit.

---

# 2. Strict Audit-Only Rules

During this audit, you must not:

- Edit source files.
- Create new files.
- Delete files.
- Rename or move files.
- Run formatters that write changes.
- Run automated fix commands.
- Install packages.
- Upgrade packages.
- Modify package-lock files.
- Modify Firebase configuration.
- Deploy Firebase rules.
- Create or modify cloud resources.
- Change environment variables.
- Commit changes.
- Push changes.
- Create a branch.
- Open a pull request.
- Change database records.
- Connect to production financial systems.
- Call live banking APIs.
- Insert test data into production services.
- Replace the current architecture.
- Generate implementation code.

You may use read-only inspection commands and existing diagnostic scripts that do not write to tracked files.

Before running a script, inspect its definition to determine whether it changes files.

Do not run scripts containing actions such as:

- `--fix`
- formatting
- generation
- migration
- deployment
- seeding
- package installation
- dependency updates

If a useful diagnostic cannot be safely executed without modifying the repository, document that limitation instead.

---

# 3. Repository Protection

At the beginning of the audit:

1. Determine whether the folder is a Git repository.
2. Record the active branch.
3. Run `git status`.
4. Record any preexisting uncommitted or untracked changes.
5. Do not revert, stage, delete, or modify those changes.

At the end of the audit:

1. Run `git status` again.
2. Run an appropriate diff check.
3. Confirm whether the audit changed any tracked files.
4. Clearly disclose any unexpected repository changes.

The desired result is zero changes caused by the audit.

---

# 4. Known Historical Context

The repository is believed to be an existing React Native application that may include:

- Expo.
- Expo Router.
- TypeScript.
- Firebase Authentication.
- Cloud Firestore.
- Firebase security rules.
- Tab-based navigation.
- A Home screen.
- A Trips section.
- Trip creation.
- Trip listing.
- Trip details.
- Trip deletion.
- Trip search.
- Trip images.
- Progress bars.
- A shared application theme.
- Fields such as:
  - `title`
  - `location`
  - `target`
  - `saved`
  - `ownerId`
  - `memberIds`
  - `imageUrl`
  - `createdAt`

This context is not guaranteed to be accurate.

Verify every item from repository evidence. Do not treat this list as proof that a feature works.

---

# 5. Audit Method

Follow this sequence.

## Phase A: Repository Discovery

Inspect the complete repository structure.

Identify:

- Applications.
- Packages.
- Source directories.
- Routing directories.
- Components.
- Services.
- Hooks.
- Context providers.
- Utility files.
- Type definitions.
- Firebase files.
- Assets.
- Tests.
- Scripts.
- Configuration files.
- Documentation.
- Generated files.
- Archived or duplicate code.
- Platform-specific files.
- Build and deployment files.

Do not include every dependency or every asset in the final report unless relevant. Focus on architecture and risk.

Create a concise repository tree that shows important folders and files.

## Phase B: Project Configuration

Inspect:

- `package.json`
- package-lock or alternative lockfile
- Expo configuration
- TypeScript configuration
- Babel configuration
- Metro configuration
- EAS configuration
- ESLint configuration
- Prettier configuration
- Firebase configuration
- environment-variable handling
- Git ignore rules
- app identifiers
- Android package name
- iOS bundle identifier
- build profiles
- scripts

Determine:

- Expo SDK version.
- React Native version.
- TypeScript version.
- Node version expectations.
- package manager.
- application entry point.
- development commands.
- testing commands.
- build commands.
- linting commands.
- whether strict TypeScript is enabled.
- whether environment separation exists.
- whether production identifiers are configured.
- whether secrets could be committed.

Do not display secret values.

You may state that a variable or key exists, but redact its value.

## Phase C: Dependency Review

Review dependencies for:

- Unused packages.
- Duplicate packages.
- Deprecated packages.
- Conflicting versions.
- Packages incompatible with the current Expo SDK.
- Security-sensitive packages.
- Firebase packages.
- Navigation packages.
- Image-handling packages.
- Notification packages.
- Authentication packages.
- State-management packages.
- Testing packages.

Do not update dependencies.

Identify packages that would be inappropriate for a production financial application or that require additional review.

## Phase D: Route and Navigation Audit

Map all Expo Router routes.

For each route, identify:

- Route path.
- File.
- Authentication requirement.
- Expected user.
- Navigation entry point.
- Dynamic parameters.
- Whether the screen appears complete.
- Whether the route can be reached.
- Whether it contains broken or duplicate navigation logic.

Review:

- Root layout.
- Authentication routing.
- Tab layout.
- Protected routes.
- Redirect logic.
- Deep-link handling.
- Dynamic trip routes.
- Modal routes.
- Missing routes.
- Orphaned routes.
- Duplicate screens.
- Invalid links.
- Fallback behavior.

Produce a route map.

## Phase E: Authentication Audit

Inspect the authentication implementation.

Determine whether the app currently supports:

- Registration.
- Login.
- Logout.
- Persistent sessions.
- Password reset.
- Email verification.
- Protected routes.
- Loading state during authentication restoration.
- User profile creation.
- Error handling.
- Reauthentication.
- Multi-factor authentication.
- Device-session management.

Identify:

- Client-side-only permission assumptions.
- Hardcoded user IDs.
- Auth state race conditions.
- Missing unsubscribe behavior.
- Unsafe redirects.
- Sensitive data logged to the console.
- Duplicate Firebase Auth listeners.
- Missing error handling.

Do not change authentication code.

## Phase F: Firebase and Data Access Audit

Inspect:

- Firebase initialization.
- Firestore usage.
- Firebase Storage usage.
- Authentication integration.
- Firestore indexes.
- Security rules.
- Query patterns.
- Listener cleanup.
- Service organization.
- Direct Firebase calls from screen components.
- Environment-specific projects.
- Emulator configuration.

Map all observed collections and subcollections.

For every collection, identify:

- Collection name.
- Known fields.
- Where records are created.
- Where records are read.
- Where records are updated.
- Where records are deleted.
- Expected ownership field.
- Membership field.
- Query pattern.
- Security-rule coverage.
- Potential scaling concerns.

Clearly distinguish:

- Confirmed fields found in code.
- Inferred fields.
- Fields mentioned in the specification but not implemented.

## Phase G: Firestore Security Rules Audit

Perform a detailed review of Firestore and Storage security rules.

Check for:

- Unauthenticated reads.
- Unauthenticated writes.
- Broad authenticated-user access.
- Missing ownership checks.
- Missing membership checks.
- Client-controlled role escalation.
- Client-controlled `ownerId`.
- Client-controlled `memberIds`.
- Users editing other users’ records.
- Unsafe list queries.
- Create-versus-update validation.
- Schema validation.
- Immutable-field protection.
- Delete permissions.
- Privilege escalation.
- Rules that do not match actual query patterns.
- Storage paths that are publicly writable.
- Missing file-type validation.
- Missing file-size validation.

Classify every issue:

- Critical
- High
- Medium
- Low
- Informational

Do not deploy or edit rules.

## Phase H: Trip Feature Audit

Inspect all trip-related functionality.

Determine the state of:

- Trip list.
- Trip search.
- Trip creation.
- Trip details.
- Trip updates.
- Trip deletion.
- Trip images.
- Fallback images.
- Progress calculations.
- Member IDs.
- Owner permissions.
- Trip statuses.
- Loading states.
- Empty states.
- Error states.
- Firestore queries.
- Navigation.
- Responsive layouts.

For every feature, classify it as:

- Working and reasonably complete.
- Working but fragile.
- Partially implemented.
- Presentational only.
- Broken.
- Missing.
- Unable to verify.

Do not assume a visible screen means the underlying feature works.

## Phase I: Home, Buckets, Activity and Profile Audit

Inspect the current implementation of:

- Home.
- Personal buckets.
- Activity.
- Profile.
- Settings.
- Notifications.
- Onboarding.

Determine whether each section is:

- Implemented.
- Stubbed.
- Hardcoded.
- Partially connected.
- Missing.

Identify any displayed financial totals that are:

- Hardcoded.
- Calculated inconsistently.
- Based on unverified client-side data.
- Misleadingly labeled.
- Not traceable to source records.

## Phase J: UI and Design-System Audit

Inspect:

- Theme files.
- Color tokens.
- Typography.
- Spacing.
- Radii.
- Shadows.
- Common components.
- Repeated styles.
- Hardcoded colors.
- Responsive behavior.
- Dark-mode behavior.
- Accessibility.
- Error messages.
- Money formatting.
- Date formatting.
- Loading states.
- Empty states.
- Confirmation dialogs.

Identify:

- Reusable components that should be preserved.
- Components that duplicate one another.
- Accessibility problems.
- Inconsistent visual patterns.
- Unreadable contrast.
- Inconsistent touch targets.
- Unsafe financial confirmation patterns.

Do not redesign the app during the audit.

## Phase K: Code Quality Audit

Review:

- TypeScript usage.
- Use of `any`.
- Null handling.
- Error handling.
- Async behavior.
- Cleanup functions.
- Dependency arrays.
- Duplicated logic.
- Component size.
- Service boundaries.
- Naming.
- Folder organization.
- Hardcoded values.
- Commented-out code.
- Console logging.
- Unused code.
- Dead routes.
- Circular dependencies.
- Stale experimental files.

Identify technical debt that materially affects:

- Reliability.
- Maintainability.
- Security.
- Financial correctness.
- Ability to build the master specification.

## Phase L: Diagnostic Checks

When safe and available, run read-only diagnostics such as:

- TypeScript type checking.
- Existing lint script without automatic fixes.
- Existing test suite.
- Expo Doctor.
- Package-manager dependency diagnostics.
- Git status and diff checks.

Before running any command:

1. Inspect its script definition.
2. Confirm it should not write tracked files.
3. Avoid commands that install or upgrade dependencies.

For each diagnostic report:

- Command.
- Whether it ran.
- Result.
- Important errors.
- Whether the result may be affected by missing local dependencies or configuration.

Do not fix errors during this audit.

## Phase M: Testing Audit

Identify:

- Existing test framework.
- Unit tests.
- Integration tests.
- Component tests.
- End-to-end tests.
- Firebase rules tests.
- Financial-calculation tests.
- CI workflows.
- Test scripts.

Determine:

- What is actually tested.
- What important behavior is untested.
- Whether the tests appear runnable.
- Whether tests are placeholders.
- Whether coverage reporting exists.

## Phase N: GitHub and CI Audit

Inspect repository-local GitHub configuration if present.

Review:

- GitHub Actions.
- Branch expectations.
- Dependency scanning.
- Secret scanning.
- Lint and type-check workflows.
- Test workflows.
- Build workflows.
- Deployment workflows.
- Pull-request templates.
- Issue templates.

Do not access, create, or modify remote GitHub resources unless explicitly requested in a later phase.

## Phase O: Secret and Security Audit

Search for evidence of:

- Committed API keys.
- Firebase configuration.
- Service-account files.
- Private keys.
- Access tokens.
- Passwords.
- Production endpoints.
- `.env` files.
- Sensitive test credentials.
- Raw personal information.
- Logging of tokens or user data.

Do not print secret values.

Report only:

- File location.
- Type of secret or sensitive data.
- Whether it appears committed or ignored.
- Required remediation priority.

If you encounter a live credential, redact it completely.

## Phase P: Embedded-Finance Readiness Audit

Compare the current repository against Master Specification 2.0.

Determine whether the existing architecture is prepared for:

- Secure backend APIs.
- PostgreSQL.
- Double-entry ledger.
- Financial-provider abstraction.
- Server-side partner API calls.
- Identity verification.
- External bank linking.
- ACH deposits and withdrawals.
- Transfer states.
- Personal bucket allocations.
- Trip wallets.
- Member ownership positions.
- Manager spending permissions.
- Virtual cards.
- Card authorization events.
- Expense allocations.
- Disputes.
- Refunds.
- Reimbursements.
- Reconciliation.
- Audit history.
- Risk controls.
- Admin operations.

Explicitly identify any implementation that incorrectly treats Firestore values such as `saved`, `balance`, or `target` as authoritative real-money balances.

State which existing concepts can remain as:

- UI prototypes.
- Read models.
- Planning-only records.
- Non-authoritative metadata.

State which concepts must be replaced or restructured before real money can be introduced.

## Phase Q: App Store and Production Readiness

Audit only what can be determined from the repository.

Check for:

- App name.
- App icon.
- Splash screen.
- iOS bundle identifier.
- Android package identifier.
- Versioning.
- Privacy-policy links.
- Terms links.
- Support contact.
- Account deletion.
- Permission descriptions.
- Notification permissions.
- Image permissions.
- Deep-link setup.
- Store metadata files.
- EAS profiles.
- Production build configuration.
- Platform-specific configuration.

Do not claim the app satisfies current store rules merely from repository evidence.

---

# 6. Required Final Report

Return one structured report using the following sections.

## 1. Executive Summary

Include:

- Overall repository condition.
- Current development stage.
- Most complete part of the application.
- Most serious technical concern.
- Most serious security concern.
- Most significant conflict with Master Specification 2.0.
- Recommended immediate next milestone.

## 2. Audit Scope and Limitations

State:

- What you inspected.
- What diagnostics you ran.
- What you could not verify.
- Whether dependencies were available.
- Whether external systems were accessible.
- Whether the master specification was found.
- Whether preexisting uncommitted changes existed.

## 3. Current Technology Stack

List confirmed technologies and versions where available.

Clearly distinguish confirmed information from inference.

## 4. Repository Architecture Map

Provide:

- Important directory tree.
- Purpose of each major area.
- Current data-flow description.
- Current authentication flow.
- Current Firestore interaction flow.

## 5. Route Map

Provide a table with:

- Route.
- File.
- Authentication requirement.
- Status.
- Main issues.

## 6. Current Feature Inventory

Provide a table with:

- Feature.
- Status.
- Evidence.
- Quality or completeness.
- Important limitations.
- Recommendation: preserve, refactor, replace, remove, or investigate.

Cover at least:

- Authentication.
- Home.
- Trips.
- Trip creation.
- Trip details.
- Trip deletion.
- Trip search.
- Trip images.
- Buckets.
- Activity.
- Profile.
- Notifications.
- Onboarding.
- Settings.

## 7. Firebase Data Model

Document each confirmed collection and field.

Include:

- Writers.
- Readers.
- Query patterns.
- Rules coverage.
- Concerns.
- Migration implications.

## 8. Security Findings

Provide a prioritized table:

- ID.
- Severity.
- Finding.
- Evidence.
- Potential impact.
- Recommended remediation.
- Relevant milestone.

Use IDs such as:

- `SEC-001`
- `SEC-002`

Do not include secret values.

## 9. Bugs and Reliability Findings

Provide a prioritized table:

- ID.
- Severity.
- Area.
- Finding.
- Evidence.
- User impact.
- Recommended remediation.

Use IDs such as:

- `BUG-001`
- `BUG-002`

## 10. Technical Debt Findings

Provide:

- ID.
- Area.
- Description.
- Why it matters.
- Recommended action.
- Priority.

Use IDs such as:

- `DEBT-001`

## 11. Diagnostic Results

For each diagnostic command, report:

- Command.
- Status.
- Result.
- Important errors.
- Whether repository files changed.

Include summarized TypeScript, lint, test, and Expo Doctor findings where available.

## 12. Test Coverage Assessment

State:

- Existing tests.
- Missing tests.
- Highest-risk untested workflows.
- Minimum testing foundation required before implementation continues.

## 13. Master Specification Gap Analysis

For each major Master Specification 2.0 area, classify it as:

- Existing.
- Partially existing.
- Prototype only.
- Missing.
- Architecturally incompatible.
- Requires external partner or legal decision.

Cover:

- Authentication.
- User profiles.
- Identity verification.
- Bank linking.
- Backend API.
- PostgreSQL ledger.
- Personal buckets.
- Trip wallets.
- Contributions.
- Trip cards.
- Spending controls.
- Expenses.
- Disputes.
- Refunds.
- Settlement.
- Reconciliation.
- Risk.
- Admin console.
- Security.
- Customer support.
- App Store readiness.

## 14. Preserve, Refactor, Replace and Remove

Create four sections.

### Preserve

Code or patterns that are sound enough to retain.

### Refactor

Working code that needs structural improvements.

### Replace

Code or data models incompatible with security, financial integrity, or the master specification.

### Remove or Archive

Dead, duplicate, obsolete, or dangerous code.

Reference exact files.

## 15. Recommended Target Architecture

Provide a repository-specific recommendation for transitioning toward:

```text
apps/
  mobile/
  admin/

services/
  api/
  webhooks/
  ledger/
  reconciliation/
  notifications/
  risk/

packages/
  financial-domain/
  validation/
  provider-interfaces/
  shared-types/
  design-system/

infrastructure/
firebase/
docs/
tests/
```

Do not recommend a full immediate rewrite unless the evidence strongly justifies it.

Explain what should remain in the current mobile repository and what should eventually become separate services.

## 16. Data Migration Considerations

Identify:

- Current fields that conflict with the new model.
- Records that may need migration.
- Fields that may remain as display-only projections.
- Data that should not become authoritative financial data.
- Potential backward-compatibility issues.
- Need for migration scripts.
- Need for development-data cleanup.

Do not write migrations during the audit.

## 17. Prioritized Implementation Plan

Provide a sequenced plan beginning with repository stabilization.

For every proposed phase include:

- Objective.
- Scope.
- Files or systems affected.
- Dependencies.
- Risks.
- Tests required.
- Exit criteria.

The initial implementation plan should prioritize:

1. Repository safety and stabilization.
2. Authentication reliability.
3. Code-quality and testing foundation.
4. Firebase security.
5. Backend boundary.
6. Financial-domain model.
7. Double-entry ledger foundation.
8. Provider-neutral sandbox interfaces.
9. Personal bucket flow.
10. Trip-wallet flow.

Do not recommend live financial-provider integration before the required legal and partner decisions.

## 18. Decision Register

List decisions that require input from:

- Product owner.
- Financial-services attorney.
- Banking or embedded-finance partner.
- Security lead.
- Compliance lead.
- Design lead.

For every decision include:

- Decision.
- Why it matters.
- Options.
- Recommendation when technically appropriate.
- Deadline or milestone before which it must be resolved.

Examples include:

- Trip-wallet legal structure.
- User-funds ownership model.
- Financial partner.
- Geographic launch scope.
- Manager spending authority.
- Member voting model.
- Contribution commitment rules.
- Refund rules.
- Transaction limits.
- Card program.
- Subscription model.

## 19. Immediate Next Actions

Provide no more than ten immediate actions.

They must be:

- Concrete.
- Ordered.
- Safe.
- Appropriate before major implementation.

## 20. Final Audit Integrity Statement

End the report by stating:

- Whether you modified any tracked files.
- Whether untracked files were created.
- Whether dependencies were installed.
- Whether external systems were changed.
- Final Git status summary.
- Any limitations that prevent high-confidence conclusions.

---

# 7. Severity Definitions

## Critical

Could expose user data, allow unauthorized access, corrupt financial records, leak credentials, or make the app fundamentally unsafe.

## High

Could cause major feature failure, privilege escalation, significant data inconsistency, or block production readiness.

## Medium

Could create incorrect behavior, maintenance risk, confusing user experience, or scaling problems.

## Low

Minor quality, consistency, readability, or usability concern.

## Informational

Observation or future recommendation without a current defect.

---

# 8. Evidence Requirements

Every important conclusion must reference evidence such as:

- File path.
- Function.
- Component.
- Route.
- Configuration entry.
- Security-rule section.
- Script output.
- Dependency.
- Data-model field.

Do not make generic claims without evidence.

When a finding is inferred rather than confirmed, label it as an inference.

When behavior cannot be verified without running the app or accessing an external system, state that limitation.

---

# 9. Financial Safety Requirements

While auditing, continuously apply these rules:

- Firebase is not the authoritative custody ledger.
- Client-controlled balances are not safe for real money.
- A trip manager must not own all member funds merely because they administer the trip.
- Real financial actions must occur through authenticated backend services.
- Financial-provider webhooks must be verified and idempotent.
- All financial transactions require double-entry accounting.
- Currency must use integer cents.
- Confirmed transactions must be reversed, not deleted.
- Displayed balances must distinguish pending, available, committed, reserved, spent, refundable, frozen, returned, and settled states.
- No live-money implementation should begin without a financial partner, approved program structure, and legal review.

Flag any current code that conflicts with these principles.

---

# 10. Final Instruction

Perform the audit thoroughly, but do not implement fixes.

The purpose of this phase is to create an accurate map and a safe implementation sequence.

Do not optimize for making the repository appear healthy.

Optimize for:

1. Truth.
2. User-fund safety.
3. Security.
4. Financial correctness.
5. Maintainability.
6. A realistic path from the current prototype to the SquadStash Master Specification Version 2.0.
