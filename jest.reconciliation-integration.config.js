/* global __dirname */
// This is a plain CommonJS Node file (Jest config, not RN/web source) -
// the shared eslint.config.js does not grant Node globals to it, and per
// this checkpoint's own scope that shared file is not to be touched for
// this. `__dirname` is a real, always-available Node global for a
// CommonJS module - this directive declares it for this file only, the
// narrowest fix available, without disabling any other check.
// Dedicated Jest project for the Milestone 5C.6 Reversal/Reconciliation
// Hardening emulator integration suite, per the frozen docs/audits/
// MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md.
//
// Independently constructed from the same base preset and the same
// generic transform/setup logic jest.integration.config.js/
// jest.financial-integration.config.js already use - it does NOT
// `require` and spread either sibling config's own exported object, for
// the same reason those two configs are independent of each other
// (avoiding fragile coupling to a `testMatch`/sequencer that would
// immediately need overriding anyway). Neither sibling config is ever
// modified or required by this file.
const jestExpoPreset = require('jest-expo/jest-preset');

// Reproduces the two necessary deviations from jest-expo's default
// transform map that both sibling integration configs already establish
// as actually-required (not merely copied speculatively): the
// Firebase/@firebase transformIgnorePatterns exception, and the `.mjs`
// Babel transform entry.
const babelJestEntry = jestExpoPreset.transform['\\.[jt]sx?$'];

module.exports = {
  ...jestExpoPreset,
  rootDir: __dirname,
  // Exact file paths only, never a directory glob - this can never
  // accidentally pick up the invitation suite's or the 5C.4/5C.5
  // financial suite's own files, all of which also live under
  // tests/integration/.
  testMatch: [
    '<rootDir>/tests/integration/integrationGuard.test.ts',
    '<rootDir>/tests/integration/reconciliationHardening.emulator.test.ts',
    '<rootDir>/tests/integration/sharedStashReversalHardening.emulator.test.ts',
    '<rootDir>/tests/integration/nonOwnershipReversalRegression.emulator.test.ts',
    '<rootDir>/tests/integration/reconciliationRecovery.emulator.test.ts',
    '<rootDir>/tests/integration/zzz_5c6_summary.emulator.test.ts',
  ],
  transform: {
    ...jestExpoPreset.transform,
    '\\.mjs$': babelJestEntry,
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|firebase|@firebase))',
    '/node_modules/react-native-reanimated/plugin/',
  ],
  // Matches both sibling integration configs' own already-proven value -
  // real emulator/network calls (Functions cold invocations, real
  // Firestore round-trips, and this suite's own CLI subprocess
  // invocations of the reconciliation admin tool) are not bounded by the
  // jest-expo default (5s).
  testTimeout: 120000,
  setupFiles: [
    ...(jestExpoPreset.setupFiles || []),
    '<rootDir>/tests/integration/helpers/jestSetup.js',
  ],
  // Same rationale as both sibling configs: stop at the first failing
  // test FILE rather than continuing on to print a misleading later PASS
  // banner once something upstream has already failed - this is also
  // what guarantees "5C.6: PASS" can never print once any 5C.6 scenario
  // has failed. See reconciliationSequencer.js for the exact ordering
  // this depends on.
  bail: 1,
  testSequencer: '<rootDir>/tests/integration/helpers/reconciliationSequencer.js',
};
