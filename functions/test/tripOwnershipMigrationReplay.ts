// Tests for the pure logical-event construction/ordering/replay
// primitives (Checkpoint 5B.4B, §6-§11). No Firestore emulator needed -
// pure logic only, using in-process Timestamp.fromMillis values.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  buildLogicalEvents,
  orderLogicalEvents,
  replayAggregateLedgerTotal,
  replayLogicalEvents,
} from "../src/domain/tripOwnershipMigrationReplay";
import type {
  LogicalEvent,
  RawSavingsTransactionRecord,
  RawTripExpenseRecord,
} from "../src/domain/tripOwnershipMigrationReplay";

const T = (ms: number) => Timestamp.fromMillis(ms);

function tx(
  overrides: Partial<RawSavingsTransactionRecord>
): RawSavingsTransactionRecord {
  return {
    id: "tx-1",
    resourceType: "trip",
    resourceId: "trip-1",
    memberUid: "uid-1",
    type: "contribution",
    amountMinor: 100,
    currency: "USD",
    createdAt: T(1000),
    reversalOf: null,
    linkedExpenseId: null,
    ...overrides,
  };
}

function expense(
  overrides: Partial<RawTripExpenseRecord>
): RawTripExpenseRecord {
  return {
    id: "expense-1",
    tripId: "trip-1",
    paymentSource: "shared_stash",
    amountMinor: 100,
    currency: "USD",
    sharedStashTransactionId: "withdrawal-1",
    status: "active",
    createdAt: T(1000),
    reversedAt: null,
    refundTransactionId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// buildLogicalEvents
// ---------------------------------------------------------------------

describe("buildLogicalEvents", () => {
  it("builds one event for an ordinary contribution", () => {
    const result = buildLogicalEvents([tx({id: "tx-a"})], [], "USD");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].kind, "contribution");
    }
  });

  it("builds one event for an ordinary withdrawal", () => {
    const result = buildLogicalEvents(
      [tx({id: "tx-a", type: "withdrawal"})],
      [],
      "USD"
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.events[0].kind, "withdrawal");
    }
  });

  it("builds one shared_stash_expense event for an active Shared-Stash Expense", () => {
    const withdrawal = tx({
      id: "withdrawal-1",
      type: "withdrawal",
      linkedExpenseId: "expense-1",
      createdAt: T(1000),
    });
    const exp = expense({id: "expense-1", createdAt: T(1000)});
    const result = buildLogicalEvents([withdrawal], [exp], "USD");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].kind, "shared_stash_expense");
    }
  });

  it("builds both events for a reversed Shared-Stash Expense", () => {
    const withdrawal = tx({
      id: "withdrawal-1",
      type: "withdrawal",
      linkedExpenseId: "expense-1",
      createdAt: T(1000),
    });
    const refund = tx({
      id: "refund-1",
      type: "contribution",
      linkedExpenseId: "expense-1",
      reversalOf: "withdrawal-1",
      createdAt: T(2000),
    });
    const exp = expense({
      id: "expense-1",
      createdAt: T(1000),
      status: "reversed",
      reversedAt: T(2000),
      refundTransactionId: "refund-1",
    });
    const result = buildLogicalEvents([withdrawal, refund], [exp], "USD");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.events.length, 2);
      assert.equal(result.events[0].kind, "shared_stash_expense");
      assert.equal(result.events[1].kind, "shared_stash_reversal");
    }
  });

  it("skips member_out_of_pocket Expenses entirely", () => {
    const exp = expense({
      id: "mop-1",
      paymentSource: "member_out_of_pocket",
      sharedStashTransactionId: null,
    });
    const result = buildLogicalEvents([], [exp], "USD");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.events.length, 0);
    }
  });

  it("fails closed on an orphaned linkedExpenseId", () => {
    const withdrawal = tx({
      id: "withdrawal-1",
      type: "withdrawal",
      linkedExpenseId: "expense-missing",
    });
    const result = buildLogicalEvents([withdrawal], [], "USD");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /orphan_expense_linkage/);
    }
  });

  it("fails closed when a Shared-Stash Expense's withdrawal is missing", () => {
    const exp = expense({id: "expense-1", sharedStashTransactionId: "missing"});
    const result = buildLogicalEvents([], [exp], "USD");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /missing_original_withdrawal/);
    }
  });

  it("fails closed when the Expense/withdrawal createdAt disagree", () => {
    const withdrawal = tx({
      id: "withdrawal-1",
      type: "withdrawal",
      linkedExpenseId: "expense-1",
      createdAt: T(1000),
    });
    const exp = expense({id: "expense-1", createdAt: T(9999)});
    const result = buildLogicalEvents([withdrawal], [exp], "USD");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /unexpected_historical_record_type/);
    }
  });

  it("fails closed when the Expense/withdrawal amountMinor disagree", () => {
    const withdrawal = tx({
      id: "withdrawal-1",
      type: "withdrawal",
      linkedExpenseId: "expense-1",
      amountMinor: 50,
    });
    const exp = expense({id: "expense-1", amountMinor: 100});
    const result = buildLogicalEvents([withdrawal], [exp], "USD");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /orphan_expense_linkage/);
    }
  });

  it("fails closed when the refund's reversalOf disagrees with the withdrawal id", () => {
    const withdrawal = tx({
      id: "withdrawal-1",
      type: "withdrawal",
      linkedExpenseId: "expense-1",
      createdAt: T(1000),
    });
    const refund = tx({
      id: "refund-1",
      type: "contribution",
      linkedExpenseId: "expense-1",
      reversalOf: "some-other-withdrawal",
      createdAt: T(2000),
    });
    const exp = expense({
      id: "expense-1",
      createdAt: T(1000),
      status: "reversed",
      reversedAt: T(2000),
      refundTransactionId: "refund-1",
    });
    const result = buildLogicalEvents([withdrawal, refund], [exp], "USD");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /duplicate_or_conflicting_reversal/);
    }
  });

  it("fails closed when the refund's own createdAt disagrees with reversedAt (never Expense.createdAt)", () => {
    const withdrawal = tx({
      id: "withdrawal-1",
      type: "withdrawal",
      linkedExpenseId: "expense-1",
      createdAt: T(1000),
    });
    const refund = tx({
      id: "refund-1",
      type: "contribution",
      linkedExpenseId: "expense-1",
      reversalOf: "withdrawal-1",
      createdAt: T(3000), // disagrees with reversedAt below
    });
    const exp = expense({
      id: "expense-1",
      createdAt: T(1000),
      status: "reversed",
      reversedAt: T(2000),
      refundTransactionId: "refund-1",
    });
    const result = buildLogicalEvents([withdrawal, refund], [exp], "USD");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /reversal_timestamp_mismatch/);
    }
  });

  it("fails closed on a currency mismatch", () => {
    const result = buildLogicalEvents([tx({currency: "EUR"})], [], "USD");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /currency_mismatch/);
    }
  });

  it("fails closed on a reversalOf-without-linkedExpenseId transaction (structurally impossible shape)", () => {
    const result = buildLogicalEvents(
      [tx({reversalOf: "something", linkedExpenseId: null})],
      [],
      "USD"
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /unexpected_historical_record_type/);
    }
  });
});

// ---------------------------------------------------------------------
// orderLogicalEvents
// ---------------------------------------------------------------------

function contribution(
  uid: string,
  amountMinor: number,
  timestamp: Timestamp,
  sourceId: string
): LogicalEvent {
  return {kind: "contribution", uid, amountMinor, timestamp, sourceId};
}

function withdrawal(
  uid: string,
  amountMinor: number,
  timestamp: Timestamp,
  sourceId: string
): LogicalEvent {
  return {kind: "withdrawal", uid, amountMinor, timestamp, sourceId};
}

describe("orderLogicalEvents", () => {
  it("orders strictly-increasing-timestamp events chronologically", () => {
    const events = [
      contribution("a", 100, T(2000), "tx-2"),
      contribution("a", 50, T(1000), "tx-1"),
    ];
    const result = orderLogicalEvents(events);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.ordered.map((e) => e.sourceId),
        ["tx-1", "tx-2"]
      );
    }
  });

  it("allows a same-uid, same-kind tie (two contributions) and breaks it by sourceId", () => {
    const events = [
      contribution("a", 100, T(1000), "tx-b"),
      contribution("a", 50, T(1000), "tx-a"),
    ];
    const result = orderLogicalEvents(events);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.ordered.map((e) => e.sourceId),
        ["tx-a", "tx-b"]
      );
    }
  });

  it("allows a different-uid tie with no Shared-Stash event involved", () => {
    const events = [
      contribution("a", 100, T(1000), "tx-a"),
      withdrawal("b", 50, T(1000), "tx-b"),
    ];
    const result = orderLogicalEvents(events);
    assert.equal(result.ok, true);
  });

  it("fails closed on a same-uid contribution+withdrawal tie", () => {
    const events = [
      contribution("a", 100, T(1000), "tx-a"),
      withdrawal("a", 50, T(1000), "tx-b"),
    ];
    const result = orderLogicalEvents(events);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /ambiguous_event_ordering/);
    }
  });

  it("fails closed when a Shared-Stash event ties with any other event", () => {
    const events: LogicalEvent[] = [
      contribution("a", 100, T(1000), "tx-a"),
      {
        kind: "shared_stash_expense",
        expenseId: "expense-1",
        withdrawalId: "withdrawal-1",
        amountMinor: 50,
        currency: "USD",
        timestamp: T(1000),
        sourceId: "withdrawal-1",
      },
    ];
    const result = orderLogicalEvents(events);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /ambiguous_event_ordering/);
    }
  });
});

// ---------------------------------------------------------------------
// replayLogicalEvents
// ---------------------------------------------------------------------

describe("replayLogicalEvents", () => {
  it("replays a single contribution", () => {
    const result = replayLogicalEvents(
      [contribution("a", 100, T(1000), "tx-a")],
      "trip-1"
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.ownership, [{uid: "a", ownershipMinor: 100}]);
    }
  });

  it("replays the frozen 900/100 -> 200/180/20 worked example", () => {
    const events: LogicalEvent[] = [
      contribution("daniel", 900, T(1000), "tx-1"),
      contribution("friend", 100, T(2000), "tx-2"),
      {
        kind: "shared_stash_expense",
        expenseId: "expense-1",
        withdrawalId: "withdrawal-1",
        amountMinor: 200,
        currency: "USD",
        timestamp: T(3000),
        sourceId: "withdrawal-1",
      },
    ];
    const result = replayLogicalEvents(events, "trip-1");
    assert.equal(result.ok, true);
    if (result.ok) {
      const byUid = new Map(result.ownership.map((b) => [b.uid, b.ownershipMinor]));
      assert.equal(byUid.get("daniel"), 720);
      assert.equal(byUid.get("friend"), 80);
      assert.equal(result.allocations.length, 1);
      assert.equal(result.allocations[0].amountMinor, 200);
    }
  });

  it("fails closed on ordinary withdrawal underflow", () => {
    const result = replayLogicalEvents(
      [withdrawal("a", 100, T(1000), "tx-a")],
      "trip-1"
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /ownership_underflow_during_replay/);
    }
  });

  it("fails closed on a Shared-Stash expense exceeding total ownership", () => {
    const events: LogicalEvent[] = [
      contribution("a", 50, T(1000), "tx-a"),
      {
        kind: "shared_stash_expense",
        expenseId: "expense-1",
        withdrawalId: "withdrawal-1",
        amountMinor: 100,
        currency: "USD",
        timestamp: T(2000),
        sourceId: "withdrawal-1",
      },
    ];
    const result = replayLogicalEvents(events, "trip-1");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /ownership_underflow_during_replay/);
    }
  });

  it("fails closed on a Shared-Stash expense before any ownership exists", () => {
    const events: LogicalEvent[] = [
      {
        kind: "shared_stash_expense",
        expenseId: "expense-1",
        withdrawalId: "withdrawal-1",
        amountMinor: 100,
        currency: "USD",
        timestamp: T(1000),
        sourceId: "withdrawal-1",
      },
    ];
    const result = replayLogicalEvents(events, "trip-1");
    assert.equal(result.ok, false);
  });

  it("replays an exact Shared-Stash reversal back to the original ownership", () => {
    const events: LogicalEvent[] = [
      contribution("daniel", 900, T(1000), "tx-1"),
      contribution("friend", 100, T(2000), "tx-2"),
      {
        kind: "shared_stash_expense",
        expenseId: "expense-1",
        withdrawalId: "withdrawal-1",
        amountMinor: 200,
        currency: "USD",
        timestamp: T(3000),
        sourceId: "withdrawal-1",
      },
      {
        kind: "shared_stash_reversal",
        expenseId: "expense-1",
        withdrawalId: "withdrawal-1",
        refundId: "refund-1",
        amountMinor: 200,
        timestamp: T(4000),
        sourceId: "refund-1",
      },
    ];
    const result = replayLogicalEvents(events, "trip-1");
    assert.equal(result.ok, true);
    if (result.ok) {
      const byUid = new Map(result.ownership.map((b) => [b.uid, b.ownershipMinor]));
      assert.equal(byUid.get("daniel"), 900);
      assert.equal(byUid.get("friend"), 100);
      // The original allocation record is retained, never deleted.
      assert.equal(result.allocations.length, 1);
    }
  });

  it("preserves a former member's positive ownership (never redistributed)", () => {
    const result = replayLogicalEvents(
      [contribution("former-member", 500, T(1000), "tx-a")],
      "trip-1"
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.ownership, [
        {uid: "former-member", ownershipMinor: 500},
      ]);
    }
  });

  it("fails closed when a reversal references an unknown original withdrawal", () => {
    const events: LogicalEvent[] = [
      contribution("a", 100, T(1000), "tx-a"),
      {
        kind: "shared_stash_reversal",
        expenseId: "expense-1",
        withdrawalId: "withdrawal-missing",
        refundId: "refund-1",
        amountMinor: 50,
        timestamp: T(2000),
        sourceId: "refund-1",
      },
    ];
    const result = replayLogicalEvents(events, "trip-1");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /missing_original_withdrawal/);
    }
  });
});

// ---------------------------------------------------------------------
// replayAggregateLedgerTotal (§15, condition 2 - the INDEPENDENT replay)
// ---------------------------------------------------------------------

describe("replayAggregateLedgerTotal", () => {
  it("replays opening balance + signed contributions/withdrawals", () => {
    const result = replayAggregateLedgerTotal(1000, [
      contribution("a", 500, T(1000), "tx-a"),
      withdrawal("a", 200, T(2000), "tx-b"),
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.totalMinor, 1300);
    }
  });

  it("replays a Shared-Stash expense as a pool depletion and its reversal as a restoration", () => {
    const events: LogicalEvent[] = [
      {
        kind: "shared_stash_expense",
        expenseId: "expense-1",
        withdrawalId: "withdrawal-1",
        amountMinor: 200,
        currency: "USD",
        timestamp: T(1000),
        sourceId: "withdrawal-1",
      },
      {
        kind: "shared_stash_reversal",
        expenseId: "expense-1",
        withdrawalId: "withdrawal-1",
        refundId: "refund-1",
        amountMinor: 200,
        timestamp: T(2000),
        sourceId: "refund-1",
      },
    ];
    const result = replayAggregateLedgerTotal(1000, events);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.totalMinor, 1000);
    }
  });

  it("fails closed on an out-of-range running total", () => {
    const result = replayAggregateLedgerTotal(0, [
      withdrawal("a", 100, T(1000), "tx-a"),
    ]);
    assert.equal(result.ok, false);
  });

  it("is empty-safe (opening balance alone, zero events)", () => {
    const result = replayAggregateLedgerTotal(500, []);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.totalMinor, 500);
    }
  });
});
