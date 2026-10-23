/* global __dirname */
// This is a plain CommonJS Node file (Jest config, not RN/web source) -
// the shared eslint.config.js does not grant Node globals to it, and per
// this checkpoint's own scope that shared file is not to be touched for
// this. `__dirname` is a real, always-available Node global for a
// CommonJS module - this directive declares it for this file only, the
// narrowest fix available, without disabling any other check.
// Dedicated Jest project for the Milestone 5C.7 Full Multi-Member
// End-to-End Validation emulator integration suite, per the frozen
// docs/audits/MULTI_MEMBER_END_TO_END_VALIDATION_PREFLIGHT_2026-10-21.md.
//
// Independently constructed from the same base preset and the same
// generic transform/setup logic jest.integration.config.js/
// jest.financial-integration.config.js/jest.reconciliation-integration.config.js
// already use - it does NOT `require` and spread any sibling config's
// own exported object, for the same reason those configs are
// independent of each other (avoiding fragile coupling to a
// `testMatch`/sequencer that would immediately need overriding anyway).
// No sibling config is ever modified or required by this file.
const jestExpoPreset = require('jest-expo/jest-preset');

// Reproduces the two necessary deviations from jest-expo's default
// transform map that every sibling integration config already
// establishes as actually-required (not merely copied speculatively):
// the Firebase/@firebase transformIgnorePatterns exception, and the
// `.mjs` Babel transform entry.
const babelJestEntry = jestExpoPreset.transform['\\.[jt]sx?$'];

module.exports = {
  ...jestExpoPreset,
  rootDir: __dirname,
  // Exact file paths only, never a directory glob - this can never
  // accidentally pick up the invitation suite's, the 5C.4/5C.5
  // financial suite's, or the 5C.6 reconciliation suite's own files,
  // all of which also live under tests/integration/. The 5C.4/5C.5/5C.6
  // test files are deliberately NOT included here - they remain their
  // own independently-rerunnable suites, per the frozen preflight's own
  // §18/§22.
  testMatch: [
    '<rootDir>/tests/integration/integrationGuard.test.ts',
    '<rootDir>/tests/integration/multiMemberLifecycle.emulator.test.ts',
    '<rootDir>/tests/integration/zzz_5c7_summary.emulator.test.ts',
  ],
  transform: {
    ...jestExpoPreset.transform,
    '\\.mjs$': babelJestEntry,
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|firebase|@firebase))',
    '/node_modules/react-native-reanimated/plugin/',
  ],
  // Matches every sibling integration config's own already-proven value -
  // real emulator/network calls (Functions cold invocations, real
  // Firestore round-trips) are not bounded by the jest-expo default (5s).
  testTimeout: 120000,
  setupFiles: [
    ...(jestExpoPreset.setupFiles || []),
    '<rootDir>/tests/integration/helpers/jestSetup.js',
  ],
  // Same rationale as every sibling config: stop at the first failing
  // test FILE rather than continuing on to print a misleading later PASS
  // banner once something upstream has already failed - this is also
  // what guarantees "5C.7: PASS" can never print once the lifecycle test
  // has failed. See multiMemberE2ESequencer.js for the exact ordering
  // this depends on.
  bail: 1,
  testSequencer: '<rootDir>/tests/integration/helpers/multiMemberE2ESequencer.js',
};
