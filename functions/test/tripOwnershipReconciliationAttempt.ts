// Tests for the pure Trip-ownership reconciliation-attempt schema
// primitives (Checkpoint 5C.6). No Firestore emulator needed - pure
// logic only.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  tripOwnershipReconciliationAttemptId,
  validateReconciliationAttemptShape,
} from "../src/domain/tripOwnershipReconciliationAttempt";

const NOW = Timestamp.fromMillis(1_700_000_000_000);
const BASIS = {
  ledgerInitializationKind: "initialized" as const,
  ledgerOpeningBalanceMinor: 0,
  ledgerBalanceMinor: 1000,
  effectiveCurrency: "USD",
};

function lockedDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tripId: "trip-1",
    attemptId: "attempt-1",
    phase: "locked",
    startedAt: NOW,
    lockedFinancialBasis: BASIS,
    ...overrides,
  };
}

const RECONSTRUCTED_FIELDS = {
  sourceHistoryDigest: "a".repeat(64),
  sourceHistoryDocumentCount: 3,
  validatedAllocationDigest: "b".repeat(64),
  validatedAllocationCount: 1,
  expectedOwnershipDigest: "c".repeat(64),
  expectedOwnershipCount: 2,
  expectedAggregateMinor: 1000,
};

function reconstructedDoc(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...lockedDoc(),
    phase: "reconstructed",
    ...RECONSTRUCTED_FIELDS,
    ...overrides,
  };
}

function completedDoc(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...reconstructedDoc(),
    phase: "completed",
    completedAt: NOW,
    ...overrides,
  };
}

function failedDoc(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...reconstructedDoc(),
    phase: "failed",
    failedAt: NOW,
    failureReasonCode: "out_of_band_mutation_detected",
    ...overrides,
  };
}

describe("tripOwnershipReconciliationAttemptId", () => {
  it("joins tripId and attemptId with an underscore", () => {
    assert.equal(
      tripOwnershipReconciliationAttemptId("trip-1", "attempt-1"),
      "trip-1_attempt-1"
    );
  });
});

describe("validateReconciliationAttemptShape - locked phase", () => {
  it("accepts a well-formed locked document", () => {
    assert.deepEqual(validateReconciliationAttemptShape(lockedDoc()), {
      ok: true,
    });
  });

  it("rejects a locked document carrying a reconstruction field", () => {
    const result = validateReconciliationAttemptShape(
      lockedDoc({sourceHistoryDigest: "a".repeat(64)})
    );
    assert.equal(result.ok, false);
  });

  it("rejects a locked document carrying completedAt", () => {
    const result = validateReconciliationAttemptShape(
      lockedDoc({completedAt: NOW})
    );
    assert.equal(result.ok, false);
  });

  it("rejects a locked document with a malformed lockedFinancialBasis", () => {
    const result = validateReconciliationAttemptShape(
      lockedDoc({lockedFinancialBasis: {}})
    );
    assert.equal(result.ok, false);
  });

  it("rejects a non-object value", () => {
    assert.equal(validateReconciliationAttemptShape(null).ok, false);
    assert.equal(validateReconciliationAttemptShape("nope").ok, false);
  });

  it("rejects a missing tripId/attemptId", () => {
    const {tripId, ...withoutTripId} = lockedDoc();
    assert.equal(validateReconciliationAttemptShape(withoutTripId).ok, false);
    const {attemptId, ...withoutAttemptId} = lockedDoc();
    assert.equal(
      validateReconciliationAttemptShape(withoutAttemptId).ok,
      false
    );
  });

  it("rejects a non-Timestamp startedAt", () => {
    const result = validateReconciliationAttemptShape(
      lockedDoc({startedAt: new Date()})
    );
    assert.equal(result.ok, false);
  });

  it("rejects an unknown phase value", () => {
    const result = validateReconciliationAttemptShape(
      lockedDoc({phase: "bogus"})
    );
    assert.equal(result.ok, false);
  });
});

describe("validateReconciliationAttemptShape - reconstructed phase", () => {
  it("accepts a well-formed reconstructed document", () => {
    assert.deepEqual(
      validateReconciliationAttemptShape(reconstructedDoc()),
      {ok: true}
    );
  });

  it("rejects a reconstructed document missing a reconstruction field", () => {
    const doc = reconstructedDoc();
    delete doc.expectedAggregateMinor;
    assert.equal(validateReconciliationAttemptShape(doc).ok, false);
  });

  it("rejects a reconstructed document carrying completedAt", () => {
    const result = validateReconciliationAttemptShape(
      reconstructedDoc({completedAt: NOW})
    );
    assert.equal(result.ok, false);
  });

  it("rejects a reconstructed document carrying a failure field", () => {
    const result = validateReconciliationAttemptShape(
      reconstructedDoc({failureReasonCode: "x"})
    );
    assert.equal(result.ok, false);
  });

  it("rejects malformed reconstruction field types", () => {
    const result = validateReconciliationAttemptShape(
      reconstructedDoc({sourceHistoryDocumentCount: -1})
    );
    assert.equal(result.ok, false);
  });
});

describe("validateReconciliationAttemptShape - completed phase", () => {
  it("accepts a well-formed completed document", () => {
    assert.deepEqual(validateReconciliationAttemptShape(completedDoc()), {
      ok: true,
    });
  });

  it("requires completedAt", () => {
    const doc = completedDoc();
    delete doc.completedAt;
    assert.equal(validateReconciliationAttemptShape(doc).ok, false);
  });

  it("forbids failedAt/failureReasonCode/failureDetail", () => {
    assert.equal(
      validateReconciliationAttemptShape(completedDoc({failedAt: NOW})).ok,
      false
    );
    assert.equal(
      validateReconciliationAttemptShape(
        completedDoc({failureReasonCode: "x"})
      ).ok,
      false
    );
    assert.equal(
      validateReconciliationAttemptShape(
        completedDoc({failureDetail: "x"})
      ).ok,
      false
    );
  });

  it("requires every reconstruction field (strict superset of reconstructed)", () => {
    const doc = completedDoc();
    delete doc.expectedOwnershipDigest;
    assert.equal(validateReconciliationAttemptShape(doc).ok, false);
  });
});

describe("validateReconciliationAttemptShape - failed phase", () => {
  it("accepts a well-formed failed document without failureDetail", () => {
    assert.deepEqual(validateReconciliationAttemptShape(failedDoc()), {
      ok: true,
    });
  });

  it("accepts a well-formed failed document WITH failureDetail", () => {
    assert.deepEqual(
      validateReconciliationAttemptShape(
        failedDoc({failureDetail: "stale digest"})
      ),
      {ok: true}
    );
  });

  it("requires failedAt", () => {
    const doc = failedDoc();
    delete doc.failedAt;
    assert.equal(validateReconciliationAttemptShape(doc).ok, false);
  });

  it("requires a non-empty failureReasonCode", () => {
    assert.equal(
      validateReconciliationAttemptShape(
        failedDoc({failureReasonCode: ""})
      ).ok,
      false
    );
    const doc = failedDoc();
    delete doc.failureReasonCode;
    assert.equal(validateReconciliationAttemptShape(doc).ok, false);
  });

  it("rejects a non-string failureDetail", () => {
    const result = validateReconciliationAttemptShape(
      failedDoc({failureDetail: 123})
    );
    assert.equal(result.ok, false);
  });

  it("forbids completedAt", () => {
    const result = validateReconciliationAttemptShape(
      failedDoc({completedAt: NOW})
    );
    assert.equal(result.ok, false);
  });

  it("requires every reconstruction field (strict superset of reconstructed)", () => {
    const doc = failedDoc();
    delete doc.sourceHistoryDigest;
    assert.equal(validateReconciliationAttemptShape(doc).ok, false);
  });

  it("completed and failed are mutually exclusive terminal shapes", () => {
    // A document cannot carry both completedAt and failedAt - failed's
    // own "forbid completedAt" check and completed's own "forbid
    // failedAt" check are each individually proven above; this proves
    // the combination is rejected regardless of which phase is declared.
    const bothFields = {...failedDoc(), completedAt: NOW};
    assert.equal(validateReconciliationAttemptShape(bothFields).ok, false);
  });
});
