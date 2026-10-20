// Checkpoint 5C.3D-B, per the frozen docs/audits/
// TRIP_INVITATION_INTEGRATION_PREFLIGHT_2026-10-19.md §11 - trusted,
// Rules-bypassing post-condition inspection ONLY. Reuses
// @firebase/rules-unit-testing, already a root devDependency (NOT
// firebase-admin, which is a dependency of the separate functions
// package, not this root package) - mirroring
// tests/firestore-rules/helpers/testEnv.js's own exact call shape, with
// the one required difference: the project id here must be the SAME
// demo-squadstash-5c3d every other layer of this integration run uses,
// never a separate id of its own (a mismatched id would not error
// loudly - it would silently inspect an empty/unrelated dataset, since
// the Firestore Emulator keys its entire in-memory dataset by project
// id).
//
// FROZEN SCOPE: this context is for trusted READ inspection only - never
// for performing an operation whose purpose is to prove the client is
// Rules-permitted or Rules-denied. Those operations continue through the
// real, authenticated, emulator-connected demo Web SDK client.
import fs from "fs";
import path from "path";
import {initializeTestEnvironment} from "@firebase/rules-unit-testing";
import type {RulesTestEnvironment} from "@firebase/rules-unit-testing";
import {DEMO_PROJECT_ID} from "./firebaseIntegrationTestEnv";

const FIRESTORE_EMULATOR_HOST = "127.0.0.1";
const FIRESTORE_EMULATOR_PORT = 8080;

let cached: RulesTestEnvironment | null = null;

/**
 * Builds (once) the trusted rules-unit-testing environment, pinned to
 * the exact same demo project id as every other layer of this
 * integration run.
 * @return {Promise<RulesTestEnvironment>} The trusted test environment.
 */
export async function getTrustedInspectionEnv(): Promise<RulesTestEnvironment> {
  if (cached) {
    return cached;
  }
  const rulesPath = path.resolve(__dirname, "..", "..", "..", "firestore.rules");
  cached = await initializeTestEnvironment({
    projectId: DEMO_PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(rulesPath, "utf8"),
      host: FIRESTORE_EMULATOR_HOST,
      port: FIRESTORE_EMULATOR_PORT,
    },
  });
  return cached;
}

/**
 * Trusted, Rules-bypassing read of a single Trip document.
 * @param {string} tripId The Trip's document id.
 * @return {Promise<Record<string, unknown> | undefined>} The raw data,
 *   or undefined if the document does not exist.
 */
export async function inspectTrip(
  tripId: string
): Promise<Record<string, unknown> | undefined> {
  const env = await getTrustedInspectionEnv();
  let data: Record<string, unknown> | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().collection("trips").doc(tripId).get();
    data = snap.data();
  });
  return data;
}

/**
 * Trusted, Rules-bypassing read of a single tripInvitations document.
 * @param {string} invitationId The invitation's document id.
 * @return {Promise<Record<string, unknown> | undefined>} The raw data,
 *   or undefined if the document does not exist.
 */
export async function inspectInvitation(
  invitationId: string
): Promise<Record<string, unknown> | undefined> {
  const env = await getTrustedInspectionEnv();
  let data: Record<string, unknown> | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().collection("tripInvitations").doc(invitationId).get();
    data = snap.data();
  });
  return data;
}

/**
 * Trusted, Rules-bypassing read of a single tripMembershipAcceptances
 * document by its deterministic id.
 * @param {string} acceptanceId The acceptance record's document id.
 * @return {Promise<Record<string, unknown> | undefined>} The raw data,
 *   or undefined if the document does not exist.
 */
export async function inspectAcceptance(
  acceptanceId: string
): Promise<Record<string, unknown> | undefined> {
  const env = await getTrustedInspectionEnv();
  let data: Record<string, unknown> | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("tripMembershipAcceptances")
      .doc(acceptanceId)
      .get();
    data = snap.data();
  });
  return data;
}

/**
 * Trusted, Rules-bypassing count of every tripMembershipAcceptances
 * document for a given (tripId, uid) pair - used to prove "zero
 * acceptance records exist" after a rejected/stale-terms attempt,
 * independent of knowing the exact termsDocId in advance.
 * @param {string} tripId The Trip id.
 * @param {string} uid The member uid.
 * @return {Promise<number>} The number of matching documents.
 */
export async function countAcceptancesFor(
  tripId: string,
  uid: string
): Promise<number> {
  const env = await getTrustedInspectionEnv();
  let count = 0;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("tripMembershipAcceptances")
      .where("tripId", "==", tripId)
      .where("uid", "==", uid)
      .get();
    count = snap.size;
  });
  return count;
}

/**
 * Trusted, Rules-bypassing existence check for a tripMemberOwnership row
 * - used only for the one trivial post-join absence check (preflight
 * §11's scope note); never expanded into any financial assertion.
 * @param {string} tripId The Trip id.
 * @param {string} uid The member uid.
 * @return {Promise<boolean>} True if a row exists.
 */
export async function ownershipRowExists(
  tripId: string,
  uid: string
): Promise<boolean> {
  const env = await getTrustedInspectionEnv();
  let exists = false;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("tripMemberOwnership")
      .doc(`${tripId}_${uid}`)
      .get();
    exists = snap.exists;
  });
  return exists;
}

/** Tears down the trusted inspection environment, if one was built. */
export async function cleanupTrustedInspectionEnv(): Promise<void> {
  if (cached) {
    await cached.cleanup();
    cached = null;
  }
}
