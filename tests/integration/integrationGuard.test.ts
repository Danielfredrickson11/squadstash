// Checkpoint 5C.3D-B "Integration Harness Hardening" follow-up - focused,
// pure unit tests for resolveIntegrationGuard. These require no emulator
// at all (the function under test takes every fact as an explicit
// argument rather than reading process.env or a live Firebase App), so
// they run fast and are placed FIRST in this suite's own testSequencer
// order - a guard regression must be caught before any real Auth/
// Firestore/Functions emulator work ever starts.
import {
  DEMO_PROJECT_ID,
  PRODUCTION_PROJECT_ID,
  resolveIntegrationGuard,
} from "./helpers/firebaseIntegrationTestEnv";
import type {GuardCheckInput} from "./helpers/firebaseIntegrationTestEnv";

const VALID_INPUT: GuardCheckInput = {
  demoAppProjectId: DEMO_PROJECT_ID,
  gcloudProject: DEMO_PROJECT_ID,
  firebaseConfigRaw: JSON.stringify({projectId: DEMO_PROJECT_ID}),
  firestoreEmulatorHost: "127.0.0.1:8080",
  authEmulatorHost: "127.0.0.1:9099",
};

describe("resolveIntegrationGuard", () => {
  it("accepts when every identity and emulator-host signal is exactly the demo project", () => {
    expect(resolveIntegrationGuard(VALID_INPUT)).toEqual({ok: true});
  });

  it("rejects when the demo App's own projectId is the production project id", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      demoAppProjectId: PRODUCTION_PROJECT_ID,
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/production project id/i);
  });

  it("rejects when GCLOUD_PROJECT is the production project id, even if FIREBASE_CONFIG is the demo project", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      gcloudProject: PRODUCTION_PROJECT_ID,
      firebaseConfigRaw: JSON.stringify({projectId: DEMO_PROJECT_ID}),
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/GCLOUD_PROJECT equals the production/i);
  });

  it("rejects when FIREBASE_CONFIG.projectId is the production project id, even if GCLOUD_PROJECT is the demo project", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      gcloudProject: DEMO_PROJECT_ID,
      firebaseConfigRaw: JSON.stringify({projectId: PRODUCTION_PROJECT_ID}),
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/FIREBASE_CONFIG\.projectId equals the production/i);
  });

  it("rejects when GCLOUD_PROJECT is missing, with no fallback to a correct FIREBASE_CONFIG", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      gcloudProject: undefined,
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/GCLOUD_PROJECT is/);
  });

  it("rejects when FIREBASE_CONFIG is missing, with no fallback to a correct GCLOUD_PROJECT", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      firebaseConfigRaw: undefined,
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/FIREBASE_CONFIG is not set/);
  });

  it("rejects when FIREBASE_CONFIG does not parse as JSON", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      firebaseConfigRaw: "{not valid json",
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/did not parse as JSON/);
  });

  it("rejects when GCLOUD_PROJECT is some other, non-production, non-demo value", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      gcloudProject: "some-other-project",
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/GCLOUD_PROJECT is/);
  });

  it("rejects when FIREBASE_CONFIG.projectId is some other, non-production, non-demo value", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      firebaseConfigRaw: JSON.stringify({projectId: "some-other-project"}),
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/FIREBASE_CONFIG\.projectId is/);
  });

  it("rejects when the Firestore emulator host is missing", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      firestoreEmulatorHost: undefined,
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/FIRESTORE_EMULATOR_HOST is not set/);
  });

  it("rejects when the Firestore emulator host is wrong", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      firestoreEmulatorHost: "127.0.0.1:9999",
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/FIRESTORE_EMULATOR_HOST is/);
  });

  it("rejects when the Auth emulator host is missing", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      authEmulatorHost: undefined,
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/FIREBASE_AUTH_EMULATOR_HOST is not set/);
  });

  it("rejects when the Auth emulator host is wrong", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      authEmulatorHost: "127.0.0.1:9999",
    });
    expect(result.ok).toBe(false);
    expect((result as {reason: string}).reason).toMatch(/FIREBASE_AUTH_EMULATOR_HOST is/);
  });

  it("accepts the documented localhost equivalent for the Auth emulator host", () => {
    const result = resolveIntegrationGuard({
      ...VALID_INPUT,
      authEmulatorHost: "localhost:9099",
    });
    expect(result).toEqual({ok: true});
  });
});
