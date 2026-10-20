#!/usr/bin/env node
/* global __dirname */
// This is a plain CommonJS Node script - the shared eslint.config.js
// does not grant Node globals to it, and per this checkpoint's own scope
// that shared file is not to be touched again for this. `__dirname` is a
// real, always-available Node global for a CommonJS module - this
// directive declares it for this file only, the narrowest fix
// available, without disabling any other check.
// Checkpoint 5C.3D-B "Integration Harness Hardening" follow-up - a small,
// dependency-free, cross-platform runner (no cross-env - this repo is
// used on Windows and must stay reproducible there without a shell-only
// `VAR=value cmd` form) that makes the Functions Emulator discovery
// timeout durable for every normal invocation of this suite, rather than
// relying on whoever runs it to remember a one-off manual env override.
//
// The cold-emulator probe empirically produced "Timeout after 10000"
// while discovering this repo's 14 Functions; retrying with
// FUNCTIONS_DISCOVERY_TIMEOUT=30 (seconds) loaded all 14 successfully.
// This is now a routine cost (first run after clearing the emulator
// cache, CI, a slow machine), not a hypothetical edge case, so the
// normal `npm run test:trip-invitation-integration` script must set it
// automatically every time.
//
// This file does nothing else: it does not change which emulators run,
// which project id is used, or which Jest config is loaded - it only
// wraps the exact same `firebase emulators:exec ...` invocation the
// package.json script used before, with one additional environment
// variable set on the child process only.
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

// Built and passed as ONE pre-quoted command string (exactly how the
// previous package.json script string invoked it, and how npm itself
// always runs script strings on Windows - via cmd.exe) rather than as an
// argument array. An argument array passed through spawnSync with
// shell:true on Windows does not reliably preserve the inner quoting
// around the jest command (empirically confirmed: it caused Firebase's
// own CLI argument parser to see `--runInBand` as one of ITS flags
// instead of part of the quoted jest command string). Every piece below
// is a fixed literal - no untrusted input is ever concatenated into this
// string.
const jestCommand = "jest --config jest.integration.config.js --runInBand";
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
