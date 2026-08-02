// Separate Jest project for Firestore security-rules tests. These run
// against the local Firestore emulator (see firebase.json "emulators")
// and must not share the app's jest-expo/React Native configuration.
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/firestore-rules/**/*.test.js'],
  // Plain CommonJS test files, no JSX/TypeScript to transform.
  transform: {},
};
