/* global __dirname */
// This is a plain CommonJS Node file (Jest config, not RN/web source) -
// the shared eslint.config.js does not grant Node globals to it, and
// per this checkpoint's own scope that shared file is not to be touched
// again for this. `__dirname` is a real, always-available Node global
// for a CommonJS module - this directive declares it for this file only,
// the narrowest fix available, without disabling any other check.
// Separate Jest project for the Trip-invitation emulator integration suite
// (Checkpoint 5C.3D-B, per the frozen docs/audits/
// TRIP_INVITATION_INTEGRATION_PREFLIGHT_2026-10-19.md). These tests run
// against real local Auth/Firestore/Functions emulators (see firebase.json
// "emulators" and package.json's test:trip-invitation-integration script)
// and must not share root jest.config.js's test matching (see that file's
// own testPathIgnorePatterns, which excludes tests/integration/ for this
// exact reason) or jest.rules.config.js (Rules-only, no transform, no
// Firebase SDK, no React rendering - a different shape entirely).
//
// Reuses the existing jest-expo preset (not a new one) because this suite
// must render the REAL app/(tabs)/trips/invitations/[invitationId].tsx
// screen with react-test-renderer (already used throughout this
// repository's own component tests) - the exact same transform/module
// mapping/testEnvironment the rest of the app's component tests already
// rely on. The ONE necessary deviation: jest-expo's own default
// transformIgnorePatterns does not transform the `firebase`/`@firebase`
// packages (confirmed directly - see
// src/services/firebase/__tests__/trips.test.ts's own comment: "Jest
// attempts to parse the real 'firebase' package's ESM build, which
// jest-expo's default preset does not transform"). Every OTHER test file
// in this repo works around that by mocking firebase/firestore and
// firebase/functions with an explicit factory, which never requires Jest
// to load the real package's source at all. This suite is the first to
// need the REAL Firebase Web SDK (so it can talk to real emulators), so it
// is the first to need this one minimal addition - firebase/@firebase are
// appended to jest-expo's own existing "do transform" exception list,
// nothing else about that list is touched.
const jestExpoPreset = require('jest-expo/jest-preset');

// jest-expo's own transform has three entries: two asset-file
// transformers (images, and a broader binary/doc-asset list) plus one
// regex matching .js/.jsx/.ts/.tsx, mapped to babel-jest with
// Metro-equivalent Babel options. The real Firebase Web SDK's
// "react-native" package-export condition (which this same preset's own
// moduleNameMapper/resolver picks, matching how the production app
// itself consumes these exact packages under Metro) pulls in at least
// one plain ESM `.mjs` file (@firebase/util/dist/postinstall.mjs) that
// none of those three regexes match, causing a raw "Unexpected token
// export" failure - confirmed by actually running this config against
// the real SDK. The minimum fix: keep all three of jest-expo's own
// entries exactly as-is, and add exactly one more entry applying the
// SAME babel-jest transform value (the js/jsx/ts/tsx one) to `.mjs`
// too - never replacing or narrowing jest-expo's own transform map.
const babelJestEntry = jestExpoPreset.transform['\\.[jt]sx?$'];

module.exports = {
  ...jestExpoPreset,
  rootDir: __dirname,
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts', '<rootDir>/tests/integration/**/*.test.tsx'],
  transform: {
    ...jestExpoPreset.transform,
    '\\.mjs$': babelJestEntry,
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|firebase|@firebase))',
    '/node_modules/react-native-reanimated/plugin/',
  ],
  // Integration runs are deliberately long (real network calls to real
  // local emulators, real Functions cold invocations) - the jest-expo
  // default (5s) is tuned for synchronous unit tests, not this. 60000 was
  // empirically still too tight for Scenario A's cold first run (its own
  // first createTrip call alone took ~4.3s, compounding with its larger
  // number of sequential real round-trips); 120000 gives real headroom
  // without resorting to an unbounded timeout - a test that still hangs
  // past this is a genuine defect to diagnose, not something to paper
  // over with a longer number.
  testTimeout: 120000,
  setupFiles: [
    ...(jestExpoPreset.setupFiles || []),
    '<rootDir>/tests/integration/helpers/jestSetup.js',
  ],
  // Checkpoint 5C.3D-B §23/§24: "if any assertion fails, the overall
  // integration suite must fail" - stop at the first failing test FILE
  // rather than continuing to run (and possibly printing misleading
  // later PASS lines) once something upstream has already failed.
  bail: 1,
  testSequencer: '<rootDir>/tests/integration/helpers/sequencer.js',
};
