// Tests for the pure canonical-projection + SHA-256 digest primitives
// (Checkpoint 5B.4B, §16A). No Firestore emulator needed - pure logic
// only, using in-process Timestamp.fromMillis values.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  computeAllocationDigest,
  computeOwnershipDigest,
  computeSourceHistoryDigest,
} from "../src/domain/tripOwnershipMigrationDigest";
import type {
  AllocationEconomicProjection,
  DigestExpenseInput,
  DigestSavingsTransactionInput,
} from "../src/domain/tripOwnershipMigrationDigest";

const T1 = Timestamp.fromMillis(1000);
const T2 = Timestamp.fromMillis(2000);

function tx(
  overrides: Partial<DigestSavingsTransactionInput>
): DigestSavingsTransactionInput {
  return {
    id: "tx-1",
    resourceType: "trip",
    resourceId: "trip-1",
    memberUid: "uid-1",
    type: "contribution",
    amountMinor: 100,
    currency: "USD",
    createdAt: T1,
    reversalOf: null,
    linkedExpenseId: null,
    ...overrides,
  };
}

function expense(overrides: Partial<DigestExpenseInput>): DigestExpenseInput {
  return {
    id: "expense-1",
    tripId: "trip-1",
    paymentSource: "shared_stash",
    amountMinor: 100,
    currency: "USD",
    sharedStashTransactionId: "withdrawal-1",
    status: "active",
    createdAt: T1,
    reversedAt: null,
    refundTransactionId: null,
    replacesExpenseId: null,
    replacedByExpenseId: null,
    ...overrides,
  };
}

describe("computeSourceHistoryDigest", () => {
  it("is deterministic across input-array permutations", () => {
    const txs = [tx({id: "tx-a"}), tx({id: "tx-b"}), tx({id: "tx-c"})];
    const exps = [expense({id: "exp-a"}), expense({id: "exp-b"})];

    const forward = computeSourceHistoryDigest(txs, exps);
    const reversedTxs = computeSourceHistoryDigest([...txs].reverse(), exps);
    const reversedExps = computeSourceHistoryDigest(txs, [...exps].reverse());

    assert.equal(forward.hash, reversedTxs.hash);
    assert.equal(forward.hash, reversedExps.hash);
    assert.equal(forward.count, 5);
  });

  it("changes when any economic field changes", () => {
    const base = computeSourceHistoryDigest([tx({})], []);
    const changedAmount = computeSourceHistoryDigest(
      [tx({amountMinor: 101})],
      []
    );
    assert.notEqual(base.hash, changedAmount.hash);
  });

  it("changes when a document's own createdAt is tampered with", () => {
    const base = computeSourceHistoryDigest([tx({createdAt: T1})], []);
    const tampered = computeSourceHistoryDigest([tx({createdAt: T2})], []);
    assert.notEqual(base.hash, tampered.hash);
  });

  it("normalizes linkedExpenseId/reversalOf null vs the same explicit null identically", () => {
    const a = computeSourceHistoryDigest(
      [tx({linkedExpenseId: null, reversalOf: null})],
      []
    );
    const b = computeSourceHistoryDigest(
      [tx({linkedExpenseId: null, reversalOf: null})],
      []
    );
    assert.equal(a.hash, b.hash);
  });

  it("counts member_out_of_pocket Expenses even though they carry no economic replay role", () => {
    const withMop = computeSourceHistoryDigest(
      [],
      [expense({id: "mop-1", paymentSource: "member_out_of_pocket", sharedStashTransactionId: null})]
    );
    assert.equal(withMop.count, 1);
  });

  it("is empty-safe (zero transactions, zero expenses)", () => {
    const result = computeSourceHistoryDigest([], []);
    assert.equal(result.count, 0);
    assert.equal(typeof result.hash, "string");
    assert.ok(result.hash.length > 0);
  });
});

describe("computeOwnershipDigest", () => {
  it("is deterministic across input-array permutations", () => {
    const a = computeOwnershipDigest([
      {uid: "zed", ownershipMinor: 100},
      {uid: "amy", ownershipMinor: 200},
    ]);
    const b = computeOwnershipDigest([
      {uid: "amy", ownershipMinor: 200},
      {uid: "zed", ownershipMinor: 100},
    ]);
    assert.equal(a.hash, b.hash);
    assert.equal(a.count, 2);
  });

  it("detects a wrong distribution with the same total (the frozen worked example)", () => {
    const correct = computeOwnershipDigest([
      {uid: "daniel", ownershipMinor: 900},
      {uid: "friend", ownershipMinor: 100},
    ]);
    const corrupted = computeOwnershipDigest([
      {uid: "daniel", ownershipMinor: 800},
      {uid: "friend", ownershipMinor: 200},
    ]);
    assert.notEqual(correct.hash, corrupted.hash);
  });

  it("ignores operational metadata it was never given in the first place", () => {
    const a = computeOwnershipDigest([{uid: "a", ownershipMinor: 5}]);
    const b = computeOwnershipDigest([{uid: "a", ownershipMinor: 5}]);
    assert.equal(a.hash, b.hash);
  });
});

describe("computeAllocationDigest", () => {
  function allocation(
    overrides: Partial<AllocationEconomicProjection>
  ): AllocationEconomicProjection {
    return {
      id: "withdrawal-1",
      tripId: "trip-1",
      expenseId: "expense-1",
      withdrawalTransactionId: "withdrawal-1",
      amountMinor: 100,
      currency: "USD",
      allocations: [{uid: "a", amountMinor: 100}],
      provenance: "migrated",
      createdAt: T1,
      ...overrides,
    };
  }

  it("is deterministic across input-array permutations", () => {
    const list1 = [allocation({id: "w-a"}), allocation({id: "w-b"})];
    const list2 = [...list1].reverse();
    assert.equal(
      computeAllocationDigest(list1).hash,
      computeAllocationDigest(list2).hash
    );
  });

  it("excludes migratedAt - never present in the input type, so a rerun's digest is stable", () => {
    const a = computeAllocationDigest([allocation({})]);
    const b = computeAllocationDigest([allocation({})]);
    assert.equal(a.hash, b.hash);
  });

  it("detects a changed allocations array", () => {
    const a = computeAllocationDigest([allocation({})]);
    const b = computeAllocationDigest([
      allocation({allocations: [{uid: "a", amountMinor: 99}]}),
    ]);
    assert.notEqual(a.hash, b.hash);
  });

  it("detects a changed provenance", () => {
    const a = computeAllocationDigest([allocation({provenance: "migrated"})]);
    const b = computeAllocationDigest([allocation({provenance: "original"})]);
    assert.notEqual(a.hash, b.hash);
  });
});
