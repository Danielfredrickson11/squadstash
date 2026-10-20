// Checkpoint 5C.3D-B, per the frozen docs/audits/
// TRIP_INVITATION_INTEGRATION_PREFLIGHT_2026-10-19.md §7/§9 - a test-only
// Firebase Web SDK environment, entirely separate from the production
// ../../../firebase.ts module. This file NEVER imports or constructs
// anything from that module - the production app/instances must never
// initialize during this integration run at all.
//
// The demo App's identity is `demo-squadstash-5c3d` from the moment it is
// constructed - never derived from, or related to, the production config
// in any way. Connecting a Firebase Web SDK instance to an emulator only
// redirects its TRANSPORT endpoint; it never changes the App's own
// `options.projectId`, which is why this file hardcodes a fully
// independent demo config rather than ever touching the production one
// (see the preflight's own Finding 4 for why the two must never mix).
import {deleteApp, initializeApp} from "firebase/app";
import type {FirebaseApp} from "firebase/app";
import {connectAuthEmulator, getAuth, signOut} from "firebase/auth";
import type {Auth} from "firebase/auth";
import {connectFirestoreEmulator, getFirestore, terminate} from "firebase/firestore";
import type {Firestore} from "firebase/firestore";
import {connectFunctionsEmulator, getFunctions} from "firebase/functions";
import type {Functions} from "firebase/functions";

export const DEMO_PROJECT_ID = "demo-squadstash-5c3d";
export const PRODUCTION_PROJECT_ID = "squadstash-6d0f1";

// Hardcoded, frozen loopback targets (preflight §5) - never read from any
// external config, env var, or anything that could be overridden to point
// at a non-local address. This hardcoding is itself part of guard items H
// ("Functions client is deliberately configured only to 127.0.0.1:5001")
// and I ("no production Firebase URL/project id appears in the
// integration configuration") - there is no code path by which these
// three literals could ever resolve to anything else.
const AUTH_EMULATOR_URL = "http://127.0.0.1:9099";
const FIRESTORE_EMULATOR_HOST = "127.0.0.1";
const FIRESTORE_EMULATOR_PORT = 8080;
const FUNCTIONS_EMULATOR_HOST = "127.0.0.1";
const FUNCTIONS_EMULATOR_PORT = 5001;
const FUNCTIONS_REGION = "us-central1";

// Minimal demo config - no value is ever copied from the production
// firebase.ts. A `demo-` project id is itself a Firebase-documented
// convention (confirmed by this repository's own
// tests/firestore-rules/helpers/testEnv.js comment) that guarantees no
// real GCP authentication, billing check, or network call is ever
// attempted for this App, regardless of what the rest of this config
// contains.
const DEMO_FIREBASE_CONFIG = {
  apiKey: "demo-api-key",
  authDomain: `${DEMO_PROJECT_ID}.firebaseapp.com`,
  projectId: DEMO_PROJECT_ID,
  appId: "demo-app-id",
};

export type DemoFirebaseInstances = {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
};

export type GuardCheckInput = {
  demoAppProjectId: string;
  gcloudProject: string | undefined;
  firebaseConfigRaw: string | undefined;
  firestoreEmulatorHost: string | undefined;
  authEmulatorHost: string | undefined;
};

export type GuardResult =
  | {ok: true}
  | {ok: false; reason: string};

const EXPECTED_FIRESTORE_EMULATOR_HOST = `${FIRESTORE_EMULATOR_HOST}:${FIRESTORE_EMULATOR_PORT}`;
const EXPECTED_AUTH_EMULATOR_HOSTS = ["127.0.0.1:9099", "localhost:9099"];

/**
 * Parses FIREBASE_CONFIG's projectId, never throwing - malformed/missing
 * input simply resolves to undefined, which every caller below treats as
 * a guard failure (there is no distinction between "missing" and
 * "unparsable" from the guard's point of view - both fail closed).
 * @param {string | undefined} firebaseConfigRaw The raw FIREBASE_CONFIG
 *   environment value.
 * @return {unknown} The parsed projectId, or undefined.
 */
function parseFirebaseConfigProjectId(firebaseConfigRaw: string | undefined): unknown {
  if (!firebaseConfigRaw) {
    return undefined;
  }
  try {
    return JSON.parse(firebaseConfigRaw).projectId;
  } catch {
    return undefined;
  }
}

/**
 * Pure, testable fail-closed guard (preflight §9/§15, hardened per
 * Milestone 5C.3D-B's "Integration Harness Hardening" follow-up) - takes
 * every fact it depends on as an explicit argument rather than reading
 * `process.env`/the live App itself, so it can be exercised with every
 * branch under plain unit tests with no emulator running at all.
 *
 * Every project-identity signal (the demo App's own options.projectId,
 * GCLOUD_PROJECT, and FIREBASE_CONFIG.projectId) is required to
 * independently equal DEMO_PROJECT_ID. There is deliberately NO fallback
 * between these three signals - agreement between any two of them never
 * excuses a mismatch on the third, since each one is set by a different
 * layer (the hardcoded demo config, the Firebase CLI's own child-process
 * environment injection, and that same CLI's JSON project descriptor) and
 * a bug in any single layer must still be caught.
 * @param {GuardCheckInput} input The resolved facts this guard depends on.
 * @return {GuardResult} ok, or a specific reason it is not safe to proceed.
 */
export function resolveIntegrationGuard(input: GuardCheckInput): GuardResult {
  const firebaseConfigProjectId = parseFirebaseConfigProjectId(input.firebaseConfigRaw);

  // D: explicit, immediate rejection if ANY identity signal equals the
  // production project id - checked before anything else, so a
  // production id can never be masked by some other signal's mismatch
  // being reported first.
  if (input.demoAppProjectId === PRODUCTION_PROJECT_ID) {
    return {
      ok: false,
      reason: "The demo Firebase App's projectId equals the production " +
        `project id ("${PRODUCTION_PROJECT_ID}") - refusing to run.`,
    };
  }
  if (input.gcloudProject === PRODUCTION_PROJECT_ID) {
    return {
      ok: false,
      reason: "GCLOUD_PROJECT equals the production project id " +
        `("${PRODUCTION_PROJECT_ID}") - refusing to run.`,
    };
  }
  if (firebaseConfigProjectId === PRODUCTION_PROJECT_ID) {
    return {
      ok: false,
      reason: "FIREBASE_CONFIG.projectId equals the production project id " +
        `("${PRODUCTION_PROJECT_ID}") - refusing to run.`,
    };
  }

  // A: the demo App's own identity.
  if (input.demoAppProjectId !== DEMO_PROJECT_ID) {
    return {
      ok: false,
      reason: `The demo Firebase App's projectId is "${input.demoAppProjectId}", ` +
        `expected exactly "${DEMO_PROJECT_ID}".`,
    };
  }

  // B: GCLOUD_PROJECT, independently required - no fallback to
  // FIREBASE_CONFIG if this is missing or wrong.
  if (input.gcloudProject !== DEMO_PROJECT_ID) {
    return {
      ok: false,
      reason: `GCLOUD_PROJECT is ${JSON.stringify(input.gcloudProject)}, ` +
        `expected exactly "${DEMO_PROJECT_ID}".`,
    };
  }

  // C: FIREBASE_CONFIG, independently required - must exist, parse as
  // JSON, and contain projectId exactly DEMO_PROJECT_ID. No fallback to
  // GCLOUD_PROJECT if this is missing, malformed, or wrong.
  if (!input.firebaseConfigRaw) {
    return {ok: false, reason: "FIREBASE_CONFIG is not set."};
  }
  if (firebaseConfigProjectId === undefined) {
    return {
      ok: false,
      reason: `FIREBASE_CONFIG did not parse as JSON with a projectId field: ${input.firebaseConfigRaw}`,
    };
  }
  if (firebaseConfigProjectId !== DEMO_PROJECT_ID) {
    return {
      ok: false,
      reason: `FIREBASE_CONFIG.projectId is ${JSON.stringify(firebaseConfigProjectId)}, ` +
        `expected exactly "${DEMO_PROJECT_ID}".`,
    };
  }

  if (!input.firestoreEmulatorHost) {
    return {ok: false, reason: "FIRESTORE_EMULATOR_HOST is not set."};
  }
  if (input.firestoreEmulatorHost !== EXPECTED_FIRESTORE_EMULATOR_HOST) {
    return {
      ok: false,
      reason: `FIRESTORE_EMULATOR_HOST is "${input.firestoreEmulatorHost}", ` +
        `expected exactly "${EXPECTED_FIRESTORE_EMULATOR_HOST}".`,
    };
  }

  if (!input.authEmulatorHost) {
    return {ok: false, reason: "FIREBASE_AUTH_EMULATOR_HOST is not set."};
  }
  if (!EXPECTED_AUTH_EMULATOR_HOSTS.includes(input.authEmulatorHost)) {
    return {
      ok: false,
      reason: `FIREBASE_AUTH_EMULATOR_HOST is "${input.authEmulatorHost}", ` +
        `expected one of ${EXPECTED_AUTH_EMULATOR_HOSTS.join(", ")}.`,
    };
  }

  return {ok: true};
}

/**
 * Reads the exact facts resolveIntegrationGuard needs from the live
 * process/App - the only place this file touches `process.env` directly,
 * so every other call site can stay pure and testable.
 * @param {FirebaseApp} demoApp The already-constructed demo App.
 * @return {GuardCheckInput} The resolved guard input.
 */
function readGuardInputFromEnvironment(demoApp: FirebaseApp): GuardCheckInput {
  return {
    demoAppProjectId: demoApp.options.projectId ?? "",
    gcloudProject: process.env.GCLOUD_PROJECT,
    firebaseConfigRaw: process.env.FIREBASE_CONFIG,
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  };
}

// Module-scoped - constructed at most once per test process, the instant
// this module is first required (see tripInvitationFlow.emulator.test.ts's
// own jest.mock factory, which requires this module specifically so this
// construction happens before any other import touches firebase.ts).
let cached: DemoFirebaseInstances | null = null;

/**
 * Builds (once) the demo Firebase Web SDK App and its Auth/Firestore/
 * Functions instances, connects all three to the frozen loopback
 * emulator ports, runs the fail-closed guard, and throws immediately -
 * before any Auth user or Firestore document could ever be created - if
 * any guard check fails. This is the ONLY function this module exports
 * that has side effects; everything else above is pure.
 * @return {DemoFirebaseInstances} The demo app/auth/db/functions.
 */
export function buildDemoFirebaseInstances(): DemoFirebaseInstances {
  if (cached) {
    return cached;
  }

  const app = initializeApp(DEMO_FIREBASE_CONFIG, "integration-demo-app");
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, FUNCTIONS_REGION);

  // Connect BEFORE any other operation touches these instances - Auth's
  // own client connector is URL-based (corrected in this checkpoint's
  // own §0), Firestore/Functions are host+port-based.
  connectAuthEmulator(auth, AUTH_EMULATOR_URL);
  connectFirestoreEmulator(db, FIRESTORE_EMULATOR_HOST, FIRESTORE_EMULATOR_PORT);
  connectFunctionsEmulator(functions, FUNCTIONS_EMULATOR_HOST, FUNCTIONS_EMULATOR_PORT);

  const guard = resolveIntegrationGuard(readGuardInputFromEnvironment(app));
  if (!guard.ok) {
    throw new Error(
      `5C.3D-B integration guard refused to proceed: ${guard.reason} ` +
        "There is no warning-only mode and no fallback - refusing to " +
        "create any Auth user or Firestore document."
    );
  }

  cached = {app, auth, db, functions};
  return cached;
}

/**
 * Tears down whatever buildDemoFirebaseInstances() created for this test
 * file's module registry, and resets the module-scoped cache. Order
 * matters: sign out first (stops any further token-refresh activity),
 * terminate Firestore's own network layer second, then delete the App
 * itself last, which unregisters every service still attached to it. A
 * no-op (not an error) if nothing was ever built in this module registry.
 *
 * This is every public teardown call the installed Firebase Web SDK
 * exposes for this purpose - empirically confirmed (via
 * `process._getActiveHandles()` against the real Firestore Emulator,
 * in isolation, outside Jest) to still leave ONE open socket immediately
 * after all three calls resolve, the first time any real Firestore read
 * happens in a process: present whether signOut/terminate/deleteApp are
 * called together or deleteApp() alone is called, and present regardless
 * of transport (`experimentalForceLongPolling` made no difference); not
 * present in Node's own `http.globalAgent` pool, so it is not ordinary
 * keep-alive reuse - it is a socket @firebase/firestore's own internal
 * Node stream implementation still holds at that exact instant. In every
 * observed run (this diagnostic and every official integration run) that
 * socket finishes closing within a couple of seconds on its own and the
 * process/suite always exits successfully (code 0) - it is a bounded,
 * self-resolving async close tail inside the SDK itself, not a resource
 * this file fails to release, and there is no further public SDK API to
 * close it synchronously faster. This is why `npm run
 * test:trip-invitation-integration` may still print Jest's "did not
 * exit one second after the test run has completed" advisory even
 * though every test passes and the process always terminates on its own
 * immediately after - that single line is this known, diagnosed
 * characteristic, not an indication of an actual hang.
 * @return {Promise<void>}
 */
export async function cleanupDemoFirebaseInstances(): Promise<void> {
  if (!cached) {
    return;
  }
  const {app, auth, db} = cached;
  await signOut(auth).catch(() => undefined);
  await terminate(db).catch(() => undefined);
  await deleteApp(app).catch(() => undefined);
  cached = null;
}
