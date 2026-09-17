module.exports = {
  preset: 'jest-expo',
  // Firestore rules tests run under a separate config (jest.rules.config.js)
  // against the local emulator and must not be picked up here.
  //
  // Checkpoint 4C.2C: functions/ is a wholly separate Node package with
  // its own test runner (node:test, via `npm --prefix functions test`),
  // never Jest - excluded here for the same reason tests/firestore-rules/
  // already is. Without this, a functions/test/*.ts file whose name
  // happens to match Jest's own default testMatch (e.g. ending in
  // ".test.ts") gets picked up by ROOT Jest too, which then fails it
  // ("Your test suite must contain at least one test") since that file
  // uses node:test's own describe/it, not Jest's - this was observed
  // directly when functions/test/tripExpenseSplits.test.ts was added,
  // and its compiled functions/lib-test/**/*.test.js output was
  // independently picked up as a second, identically-failing suite.
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/tests/firestore-rules/',
    '<rootDir>/functions/',
  ],
};
