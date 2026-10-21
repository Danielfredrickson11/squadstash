/* global __dirname */
// This is a plain CommonJS Node file (Jest config, not RN/web source) -
// the shared eslint.config.js does not grant Node globals to it, and per
// this checkpoint's own scope that shared file is not to be touched for
// this. `__dirname` is a real, always-available Node global for a
// CommonJS module - this directive declares it for this file only, the
// narrowest fix available, without disabling any other check.
// Dedicated Jest project for the Multi-Member Shared Stash Spending
// (5C.4) and Ownership-Based Withdrawal (5C.5) emulator integration
// suite, per the frozen docs/audits/
// MULTI_MEMBER_SPENDING_WITHDRAWAL_PREFLIGHT_2026-10-20.md §19
// ("Chosen emulator harness architecture", corrected to resolve a
// harness-scope contradiction in an earlier revision of that document).
//
// This file is INDEPENDENTLY constructed from the same base preset and
// the same generic transform/setup logic jest.integration.config.js
// already uses - it does NOT `require` and spread that sibling config's
// own exported object. Spreading that config's exports would also
// inherit its hardcoded `testMatch` (the invitation-only file list) and
// its reference to the invitation-specific sequencer, both of which
// would have to be immediately overridden - fragile coupling for no
// real benefit over independently declaring the same few generic lines
// here. jest.integration.config.js itself is NEVER modified or required
// by this file.
const jestExpoPreset = require('jest-expo/jest-preset');

// Reproduces jest.integration.config.js's own two necessary deviations
// from jest-expo's default transform map (confirmed by that config's own
// comments as actually-required, not merely copied speculatively): the
// Firebase/@firebase transformIgnorePatterns exception (the real
// Firebase Web SDK's ESM build is otherwise left unparsed by jest-expo's
// default preset) and the `.mjs` Babel transform entry (one of Firebase's
// own "react-native" package-export-condition files is plain ESM that
// none of jest-expo's three built-in transform regexes match).
const babelJestEntry = jestExpoPreset.transform['\\.[jt]sx?$'];

module.exports = {
  ...jestExpoPreset,
  rootDir: __dirname,
  // Matches ONLY the pure guard unit test (reused, unmodified, from the
  // invitation suite - it has no emulator/financial content of its own)
  // plus the five financial-checkpoint files this config owns. Each
  // entry is an exact file path, not a directory glob, so this can never
  // accidentally pick up tripInvitationFlow.emulator.test.ts,
  // tripInvitationScreen.emulator.test.tsx, or
  // zzz_summary.emulator.test.ts - the invitation suite remains
  // independently invocable and wholly unaffected by this config.
  testMatch: [
    '<rootDir>/tests/integration/integrationGuard.test.ts',
    '<rootDir>/tests/integration/sharedStashSpending.emulator.test.ts',
    '<rootDir>/tests/integration/ownershipWithdrawal.emulator.test.ts',
    '<rootDir>/tests/integration/zzz_5c4_summary.emulator.test.ts',
    '<rootDir>/tests/integration/zzz_5c5_summary.emulator.test.ts',
  ],
  transform: {
    ...jestExpoPreset.transform,
    '\\.mjs$': babelJestEntry,
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|firebase|@firebase))',
    '/node_modules/react-native-reanimated/plugin/',
  ],
  // Matches jest.integration.config.js's own already-proven value -
  // real emulator/network calls (Functions cold invocations, real
  // Firestore round-trips) are not bounded by the jest-expo default (5s).
  testTimeout: 120000,
  setupFiles: [
    ...(jestExpoPreset.setupFiles || []),
    // Reused unchanged from the invitation suite - the real Firestore
    // Web SDK's WebChannel transport needs a working XMLHttpRequest
    // global under jest-expo's RN test environment, exactly as already
    // proven there. This file has no financial- or invitation-specific
    // content of its own.
    '<rootDir>/tests/integration/helpers/jestSetup.js',
  ],
  // Same rationale as jest.integration.config.js: stop at the first
  // failing test FILE rather than continuing on to print a misleading
  // later PASS banner once something upstream has already failed. This
  // is also what guarantees "5C.4: PASS" can never print once 5C.4's own
  // scenarios have failed, and "5C.5: PASS" can never print once 5C.5's
  // own scenarios have failed - see financialSequencer.js for the exact
  // ordering this depends on.
  bail: 1,
  testSequencer: '<rootDir>/tests/integration/helpers/financialSequencer.js',
};
