// Tests for the pure Trip-ownership migration-state schema primitives
// (Checkpoint 5B.4B). No Firestore emulator needed - pure logic only.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  buildLockedFinancialBasis,
  classifyLedgerBootstrapForMigration,
  evaluateMigrationEligibility,
  lockedFinancialBasesEqual,
  tripOwnershipMigrationStateId,
  validateMigrationStateShape,
} from "../src/domain/tripOwnershipMigrationState";

// ---------------------------------------------------------------------
// classifyLedgerBootstrapForMigration (§5's full decision table)
// ---------------------------------------------------------------------

describe("classifyLedgerBootstrapForMigration", () => {
  it("classifies an initialized Trip with a zero opening balance as case_a", () => {
    const result = classifyLedgerBootstrapForMigration(
      {ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 500},
      false
    );
    assert.deepEqual(result, {
      kind: "case_a",
      currentBalanceMinor: 500,
      openingBalanceMinor: 0,
    });
  });

  it("classifies an initialized Trip with a positive opening balance as ambiguous (Case C)", () => {
    const result = classifyLedgerBootstrapForMigration(
      {ledgerOpeningBalanceMinor: 100, ledgerBalanceMinor: 500},
      false
    );
    assert.deepEqual(result, {
      kind: "ambiguous_opening_balance",
      openingBalanceMinor: 100,
    });
  });

  it("classifies an invalid initialized ledger state as invalid_ledger_state", () => {
    const result = classifyLedgerBootstrapForMigration(
      {ledgerOpeningBalanceMinor: -5, ledgerBalanceMinor: 500},
      false
    );
    assert.deepEqual(result, {
      kind: "invalid_ledger_state",
      reason: "invalid_initialized_state",
    });
  });

  it("classifies a partial ledger state as invalid_ledger_state", () => {
    const result = classifyLedgerBootstrapForMigration(
      {ledgerOpeningBalanceMinor: 0},
      false
    );
    assert.deepEqual(result, {
      kind: "invalid_ledger_state",
      reason: "partial_corrupt_state",
    });
  });

  it("classifies uninitialized + existing history as uninitialized_with_history", () => {
    const result = classifyLedgerBootstrapForMigration({}, true);
    assert.deepEqual(result, {kind: "uninitialized_with_history"});
  });

  it("classifies uninitialized + no history + zero legacy saved as case_a_equivalent", () => {
    const result = classifyLedgerBootstrapForMigration({saved: 0}, false);
    assert.deepEqual(result, {kind: "case_a_equivalent"});
  });

  it("classifies uninitialized + no history + absent saved as case_a_equivalent", () => {
    const result = classifyLedgerBootstrapForMigration({}, false);
    assert.deepEqual(result, {kind: "case_a_equivalent"});
  });

  it("classifies uninitialized + no history + positive legacy saved as ambiguous (Case C-equivalent)", () => {
    const result = classifyLedgerBootstrapForMigration({saved: 7.5}, false);
    assert.deepEqual(result, {
      kind: "ambiguous_opening_balance",
      openingBalanceMinor: 750,
    });
  });

  it("classifies an invalid legacy saved value as invalid_ledger_state", () => {
    const result = classifyLedgerBootstrapForMigration({saved: -1}, false);
    assert.deepEqual(result, {
      kind: "invalid_ledger_state",
      reason: "invalid_legacy_value",
    });
  });
});

// ---------------------------------------------------------------------
// buildLockedFinancialBasis / lockedFinancialBasesEqual
// ---------------------------------------------------------------------

describe("buildLockedFinancialBasis / lockedFinancialBasesEqual", () => {
  it("builds an initialized basis from case_a", () => {
    const basis = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 500, openingBalanceMinor: 0},
      "USD"
    );
    assert.deepEqual(basis, {
      ledgerInitializationKind: "initialized",
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 500,
      effectiveCurrency: "USD",
    });
  });

  it("builds an uninitialized basis (derived 0) from case_a_equivalent", () => {
    const basis = buildLockedFinancialBasis({kind: "case_a_equivalent"}, "USD");
    assert.deepEqual(basis, {
      ledgerInitializationKind: "uninitialized",
      derivedLegacyOpeningBalanceMinor: 0,
      effectiveCurrency: "USD",
    });
  });

  it("treats two field-for-field identical bases as equal", () => {
    const a = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 500, openingBalanceMinor: 0},
      "USD"
    );
    const b = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 500, openingBalanceMinor: 0},
      "USD"
    );
    assert.equal(lockedFinancialBasesEqual(a, b), true);
  });

  it("detects a changed ledgerBalanceMinor", () => {
    const a = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 500, openingBalanceMinor: 0},
      "USD"
    );
    const b = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 600, openingBalanceMinor: 0},
      "USD"
    );
    assert.equal(lockedFinancialBasesEqual(a, b), false);
  });

  it("detects a changed effectiveCurrency", () => {
    const a = buildLockedFinancialBasis({kind: "case_a_equivalent"}, "USD");
    const b = buildLockedFinancialBasis({kind: "case_a_equivalent"}, "EUR");
    assert.equal(lockedFinancialBasesEqual(a, b), false);
  });

  it("detects a changed ledgerInitializationKind", () => {
    const a = buildLockedFinancialBasis({kind: "case_a_equivalent"}, "USD");
    const b = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 0, openingBalanceMinor: 0},
      "USD"
    );
    assert.equal(lockedFinancialBasesEqual(a, b), false);
  });
});

// ---------------------------------------------------------------------
// evaluateMigrationEligibility (§4's full five-item rule)
// ---------------------------------------------------------------------

describe("evaluateMigrationEligibility", () => {
  const baseInput = {
    ownershipModelState: undefined,
    ownershipModelVersion: undefined,
    memberIds: ["a", "b"],
    tripData: {ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 500},
    savingsTransactionCount: 3,
    combinedHistoryCount: 3,
    historyLimit: 2000,
  };

  it("accepts an eligible legacy Trip (Case A)", () => {
    const result = evaluateMigrationEligibility(baseInput);
    assert.equal(result.ok, true);
  });

  it("rejects a non-legacy state", () => {
    const result = evaluateMigrationEligibility({
      ...baseInput,
      ownershipModelState: "migrating",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_legacy_state_migrating");
    }
  });

  it("rejects a corrupt state", () => {
    const result = evaluateMigrationEligibility({
      ...baseInput,
      ownershipModelState: "bogus",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "corrupt_ownership_state");
    }
  });

  it("rejects history exceeding the automatic-migration bound", () => {
    const result = evaluateMigrationEligibility({
      ...baseInput,
      combinedHistoryCount: 3000,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.reason,
        "history_exceeds_automatic_migration_limit"
      );
    }
  });

  it("rejects malformed memberIds", () => {
    const result = evaluateMigrationEligibility({
      ...baseInput,
      memberIds: "not-an-array",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "malformed_memberIds");
    }
  });

  it("rejects an ambiguous positive opening balance", () => {
    const result = evaluateMigrationEligibility({
      ...baseInput,
      tripData: {ledgerOpeningBalanceMinor: 100, ledgerBalanceMinor: 500},
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "positive_ambiguous_opening_balance");
    }
  });

  it("rejects uninitialized ledger with existing history", () => {
    const result = evaluateMigrationEligibility({
      ...baseInput,
      tripData: {},
      savingsTransactionCount: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "uninitialized_ledger_with_history");
    }
  });

  it("accepts case_a_equivalent (uninitialized, no history, zero legacy)", () => {
    const result = evaluateMigrationEligibility({
      ...baseInput,
      tripData: {},
      savingsTransactionCount: 0,
      combinedHistoryCount: 0,
    });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------
// tripOwnershipMigrationStateId
// ---------------------------------------------------------------------

describe("tripOwnershipMigrationStateId", () => {
  it("returns the tripId unchanged", () => {
    assert.equal(tripOwnershipMigrationStateId("trip-123"), "trip-123");
  });
});

// ---------------------------------------------------------------------
// validateMigrationStateShape (§16B's discriminated phase rules)
// ---------------------------------------------------------------------

describe("validateMigrationStateShape", () => {
  const now = Timestamp.now();
  const basisInitialized = {
    ledgerInitializationKind: "initialized",
    ledgerOpeningBalanceMinor: 0,
    ledgerBalanceMinor: 500,
    effectiveCurrency: "USD",
  };
  const lockedDoc = {
    tripId: "trip-1",
    attemptId: "attempt-1",
    phase: "locked",
    lockedAt: now,
    startedAt: now,
    lockedFinancialBasis: basisInitialized,
  };
  const reconstructedFields = {
    sourceHistoryDigest: "abc",
    sourceHistoryDocumentCount: 3,
    expectedOwnershipDigest: "def",
    expectedOwnershipCount: 2,
    expectedAllocationDigest: "ghi",
    expectedAllocationCount: 1,
  };

  it("accepts a well-formed locked document", () => {
    assert.equal(validateMigrationStateShape(lockedDoc).ok, true);
  });

  it("rejects a locked document carrying reconstruction fields", () => {
    const result = validateMigrationStateShape({
      ...lockedDoc,
      ...reconstructedFields,
    });
    assert.equal(result.ok, false);
  });

  it("rejects a locked document carrying completedAt", () => {
    const result = validateMigrationStateShape({
      ...lockedDoc,
      completedAt: now,
    });
    assert.equal(result.ok, false);
  });

  it("accepts a well-formed reconstructed document", () => {
    const doc = {...lockedDoc, phase: "reconstructed", ...reconstructedFields};
    assert.equal(validateMigrationStateShape(doc).ok, true);
  });

  it("rejects a reconstructed document missing a reconstruction field", () => {
    const {expectedAllocationDigest, ...rest} = reconstructedFields;
    const doc = {...lockedDoc, phase: "reconstructed", ...rest};
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("rejects a reconstructed document carrying completedAt", () => {
    const doc = {
      ...lockedDoc,
      phase: "reconstructed",
      ...reconstructedFields,
      completedAt: now,
    };
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("accepts a well-formed completed document", () => {
    const doc = {
      ...lockedDoc,
      phase: "completed",
      ...reconstructedFields,
      completedAt: now,
    };
    assert.equal(validateMigrationStateShape(doc).ok, true);
  });

  it("rejects a completed document missing completedAt", () => {
    const doc = {...lockedDoc, phase: "completed", ...reconstructedFields};
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("rejects an unknown phase", () => {
    const doc = {...lockedDoc, phase: "bogus"};
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("rejects a missing tripId", () => {
    const {tripId, ...rest} = lockedDoc;
    assert.equal(validateMigrationStateShape(rest).ok, false);
  });

  it("rejects a malformed lockedFinancialBasis", () => {
    const doc = {...lockedDoc, lockedFinancialBasis: {}};
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("rejects a non-object value", () => {
    assert.equal(validateMigrationStateShape(null).ok, false);
    assert.equal(validateMigrationStateShape("x").ok, false);
  });

  // Checkpoint 5B.4B.1, Section D: real Timestamp instances only -
  // never a Date/string/number/plain-object placeholder.
  it("rejects a Date object in place of lockedAt", () => {
    const doc = {...lockedDoc, lockedAt: new Date()};
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("rejects a numeric epoch in place of startedAt", () => {
    const doc = {...lockedDoc, startedAt: Date.now()};
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("rejects a string in place of completedAt", () => {
    const doc = {
      ...lockedDoc,
      phase: "completed",
      ...reconstructedFields,
      completedAt: new Date().toISOString(),
    };
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("rejects an undefined pseudo-timestamp (field present as undefined is still absent)", () => {
    const doc = {...lockedDoc, lockedAt: undefined};
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  // Checkpoint 5B.4B.1, Section D: branch-incompatible extra fields
  // fail closed, never silently ignored.
  it("rejects a locked document carrying an unexpected extra field", () => {
    const doc = {...lockedDoc, someRogueField: "oops"};
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("rejects a reconstructed document carrying an unexpected extra field", () => {
    const doc = {
      ...lockedDoc,
      phase: "reconstructed",
      ...reconstructedFields,
      someRogueField: "oops",
    };
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });

  it("rejects a completed document carrying an unexpected extra field", () => {
    const doc = {
      ...lockedDoc,
      phase: "completed",
      ...reconstructedFields,
      completedAt: now,
      someRogueField: "oops",
    };
    assert.equal(validateMigrationStateShape(doc).ok, false);
  });
});
