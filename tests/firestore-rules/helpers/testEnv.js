// Shared setup for Firestore rules tests. Creates a RulesTestEnvironment
// bound to the local Firestore emulator only - this never touches the
// real Firebase project, regardless of what "projectId" is used here.
//
// A "demo-" projectId prefix is a Firebase convention that guarantees
// emulator-only behavior: no login, no real project, no billing checks.
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-squadstash-rules-test';
const RULES_PATH = path.resolve(__dirname, '..', '..', '..', 'firestore.rules');
const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = 8080;

async function createTestEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(RULES_PATH, 'utf8'),
      host: EMULATOR_HOST,
      port: EMULATOR_PORT,
    },
  });
}

module.exports = { createTestEnv, PROJECT_ID };
