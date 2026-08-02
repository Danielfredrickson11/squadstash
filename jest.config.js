module.exports = {
  preset: 'jest-expo',
  // Firestore rules tests run under a separate config (jest.rules.config.js)
  // against the local emulator and must not be picked up here.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/firestore-rules/'],
};
