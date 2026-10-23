#!/usr/bin/env node
/* global __dirname */
// This is a plain CommonJS Node script - the shared eslint.config.js
// does not grant Node globals to it, and per this checkpoint's own scope
// that shared file is not to be touched for this. `__dirname` is a real,
// always-available Node global for a CommonJS module - this directive
// declares it for this file only, the narrowest fix available, without
// disabling any other check.
// Milestone 5C.7 - a small, dependency-free, cross-platform runner for
// the full multi-member end-to-end validation suite, mirroring the
// already-proven tests/integration/runMultiMemberReconciliationIntegration.cjs
// (and, before it, runMultiMemberFinancialIntegration.cjs) pattern
// exactly (same mechanism, own Jest config). Makes the Functions
// Emulator discovery timeout durable for every normal invocation, rather
// than relying on whoever runs it to remember a one-off manual env
// override - the same empirically-confirmed need as every sibling
// runner (a cold emulator cache can otherwise produce "Timeout after
// 10000" while discovering this repo's Functions).
//
// This file does nothing else: it does not change which emulators run,
// which project id is used, or which Jest config is loaded - it only
// invokes `firebase emulators:exec ...` with one additional environment
// variable set on the child process only, exactly as every sibling
// runner already does for its own suite. No production fallback exists
// anywhere in this file.
"use strict";

const {spawnSync} = require("child_process");
const path = require("path");

const firebaseCliPath = path.resolve(
  __dirname,
  "..",
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "firebase.cmd" : "firebase"
);

const env = {...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: "30"};

// Built and passed as ONE pre-quoted command string, exactly matching
// every sibling runner's own empirically-confirmed-necessary approach:
// an argument array passed through spawnSync with shell:true on Windows
// does not reliably preserve the inner quoting around the jest command.
// Every piece below is a fixed literal - no untrusted input is ever
// concatenated into this string, and no production fallback exists.
const jestCommand = "jest --config jest.multi-member-e2e.config.js --runInBand";
const fullCommand =
  `"${firebaseCliPath}" emulators:exec --project demo-squadstash-5c3d ` +
  `--only auth,firestore,functions "${jestCommand}"`;

const result = spawnSync(fullCommand, {
  cwd: path.resolve(__dirname, "..", ".."),
  env,
  stdio: "inherit",
  shell: true,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status === null ? 1 : result.status);
