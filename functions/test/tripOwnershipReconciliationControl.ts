// Tests for the pure Trip-ownership reconciliation-control schema
// primitives (Checkpoint 5C.6). No Firestore emulator needed - pure
// logic only.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  tripOwnershipReconciliationControlId,
  validateReconciliationControlShape,
} from "../src/domain/tripOwnershipReconciliationControl";

const NOW = Timestamp.fromMillis(1_700_000_000_000);

function controlDoc(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: "trip-1",
    activeAttemptId: null,
    lastCompletedAttemptId: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("tripOwnershipReconciliationControlId", () => {
  it("returns the tripId unchanged - one document per Trip", () => {
    assert.equal(tripOwnershipReconciliationControlId("trip-1"), "trip-1");
  });
});

describe("validateReconciliationControlShape", () => {
  it("accepts a well-formed fresh (both-null) control document", () => {
    assert.deepEqual(validateReconciliationControlShape(controlDoc()), {
      ok: true,
    });
  });

  it("accepts activeAttemptId set, lastCompletedAttemptId null", () => {
    assert.deepEqual(
      validateReconciliationControlShape(
        controlDoc({activeAttemptId: "attempt-1"})
      ),
      {ok: true}
    );
  });

  it("accepts activeAttemptId null, lastCompletedAttemptId set", () => {
    assert.deepEqual(
      validateReconciliationControlShape(
        controlDoc({lastCompletedAttemptId: "attempt-1"})
      ),
      {ok: true}
    );
  });

  it("accepts BOTH set, to two DIFFERENT attempt ids", () => {
    assert.deepEqual(
      validateReconciliationControlShape(
        controlDoc({
          activeAttemptId: "attempt-2",
          lastCompletedAttemptId: "attempt-1",
        })
      ),
      {ok: true}
    );
  });

  it("rejects activeAttemptId equal to lastCompletedAttemptId", () => {
    const result = validateReconciliationControlShape(
      controlDoc({
        activeAttemptId: "attempt-1",
        lastCompletedAttemptId: "attempt-1",
      })
    );
    assert.equal(result.ok, false);
  });

  it("rejects a non-object value", () => {
    assert.equal(validateReconciliationControlShape(null).ok, false);
    assert.equal(validateReconciliationControlShape("nope").ok, false);
    assert.equal(validateReconciliationControlShape(42).ok, false);
  });

  it("rejects a missing/empty tripId", () => {
    const {tripId, ...withoutTripId} = controlDoc();
    assert.equal(validateReconciliationControlShape(withoutTripId).ok, false);
    assert.equal(
      validateReconciliationControlShape(controlDoc({tripId: ""})).ok,
      false
    );
  });

  it("rejects a non-nullable/non-string activeAttemptId", () => {
    assert.equal(
      validateReconciliationControlShape(controlDoc({activeAttemptId: ""})).ok,
      false
    );
    assert.equal(
      validateReconciliationControlShape(controlDoc({activeAttemptId: 1})).ok,
      false
    );
  });

  it("rejects a non-nullable/non-string lastCompletedAttemptId", () => {
    assert.equal(
      validateReconciliationControlShape(
        controlDoc({lastCompletedAttemptId: ""})
      ).ok,
      false
    );
    assert.equal(
      validateReconciliationControlShape(
        controlDoc({lastCompletedAttemptId: 1})
      ).ok,
      false
    );
  });

  it("rejects a missing/non-Timestamp updatedAt", () => {
    const {updatedAt, ...withoutUpdatedAt} = controlDoc();
    assert.equal(
      validateReconciliationControlShape(withoutUpdatedAt).ok,
      false
    );
    assert.equal(
      validateReconciliationControlShape(controlDoc({updatedAt: new Date()}))
        .ok,
      false
    );
  });

  it("rejects an unexpected extra field", () => {
    const result = validateReconciliationControlShape(
      controlDoc({unexpectedField: "x"})
    );
    assert.equal(result.ok, false);
  });
});
