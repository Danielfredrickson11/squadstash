import {
  deriveMemberSavingsBalanceMinor,
  deriveSavingsBalanceMinor,
  getSignedSavingsAmountMinor,
} from "../savingsBalance";
import type { PersistedTimestamp } from "../../types/domain/common";
import type {
  Contribution,
  Withdrawal,
} from "../../types/domain/savingsTransaction";

// firebase/firestore's real Timestamp class doesn't transform cleanly as
// a value import under this project's jest-expo config, and none of the
// functions under test ever read `createdAt` - so this fixture
// implements PersistedTimestamp's actual public shape directly (every
// member of the real Timestamp class) instead of importing the class or
// reaching for a cast.
const FIXTURE_CREATED_AT: PersistedTimestamp = {
  seconds: 0,
  nanoseconds: 0,
  toDate: () => new Date(0),
  toMillis: () => 0,
  isEqual: (other) => other.seconds === 0 && other.nanoseconds === 0,
  toString: () => "Timestamp(seconds=0, nanoseconds=0)",
  toJSON: () => ({ seconds: 0, nanoseconds: 0, type: "firestore/timestamp/1.0" }),
  valueOf: () => "0",
};

let nextId = 0;

type FactoryOverrides = {
  amountMinor: number;
  memberUid?: string;
  resourceId?: string;
  recordedBy?: string;
  reversalOf?: string | null;
  id?: string;
};

function makeContribution(overrides: FactoryOverrides): Contribution {
  const {
    amountMinor,
    memberUid = "member-1",
    resourceId = "resource-1",
    recordedBy = memberUid,
    reversalOf = null,
    id,
  } = overrides;
  nextId += 1;

  return {
    id: id ?? `txn-${nextId}`,
    type: "contribution",
    resourceType: "bucket",
    resourceId,
    memberUid,
    recordedBy,
    amountMinor,
    currency: "USD",
    createdAt: FIXTURE_CREATED_AT,
    reversalOf,
  };
}

function makeWithdrawal(overrides: FactoryOverrides): Withdrawal {
  const {
    amountMinor,
    memberUid = "member-1",
    resourceId = "resource-1",
    recordedBy = memberUid,
    reversalOf = null,
    id,
  } = overrides;
  nextId += 1;

  return {
    id: id ?? `txn-${nextId}`,
    type: "withdrawal",
    resourceType: "bucket",
    resourceId,
    memberUid,
    recordedBy,
    amountMinor,
    currency: "USD",
    createdAt: FIXTURE_CREATED_AT,
    reversalOf,
  };
}

describe("getSignedSavingsAmountMinor", () => {
  it("returns a positive amount for a contribution", () => {
    expect(getSignedSavingsAmountMinor(makeContribution({ amountMinor: 1234 }))).toBe(
      1234
    );
  });

  it("returns a negative amount for a withdrawal", () => {
    expect(getSignedSavingsAmountMinor(makeWithdrawal({ amountMinor: 1234 }))).toBe(
      -1234
    );
  });

  it("does not let reversalOf affect the sign either way", () => {
    const reversalContribution = makeContribution({
      amountMinor: 500,
      reversalOf: "some-original-id",
    });
    const reversalWithdrawal = makeWithdrawal({
      amountMinor: 500,
      reversalOf: "some-original-id",
    });

    expect(getSignedSavingsAmountMinor(reversalContribution)).toBe(500);
    expect(getSignedSavingsAmountMinor(reversalWithdrawal)).toBe(-500);
  });
});

describe("deriveSavingsBalanceMinor", () => {
  it("1. is zero for zero transactions and zero opening balance", () => {
    expect(deriveSavingsBalanceMinor([], 0)).toBe(0);
  });

  it("2. returns the opening balance alone when there are no transactions", () => {
    expect(deriveSavingsBalanceMinor([], 75000)).toBe(75000);
  });

  it("3. reflects a single contribution", () => {
    const transactions = [makeContribution({ amountMinor: 10000 })];
    expect(deriveSavingsBalanceMinor(transactions, 0)).toBe(10000);
  });

  it("4. subtracts a single withdrawal from an opening balance", () => {
    const transactions = [makeWithdrawal({ amountMinor: 5000 })];
    expect(deriveSavingsBalanceMinor(transactions, 75000)).toBe(70000);
  });

  it("5. sums multiple contributions", () => {
    const transactions = [
      makeContribution({ amountMinor: 1000 }),
      makeContribution({ amountMinor: 2000 }),
      makeContribution({ amountMinor: 3000 }),
    ];
    expect(deriveSavingsBalanceMinor(transactions, 0)).toBe(6000);
  });

  it("6. nets mixed contributions and withdrawals", () => {
    const transactions = [
      makeContribution({ amountMinor: 10000 }),
      makeWithdrawal({ amountMinor: 3000 }),
      makeContribution({ amountMinor: 2000 }),
    ];
    expect(deriveSavingsBalanceMinor(transactions, 0)).toBe(9000);
  });

  it("7. combines an opening balance with mixed transactions", () => {
    const transactions = [
      makeContribution({ amountMinor: 10000 }),
      makeWithdrawal({ amountMinor: 5000 }),
    ];
    expect(deriveSavingsBalanceMinor(transactions, 75000)).toBe(80000);
  });

  it("8. nets a contribution reversed by an equal withdrawal to zero", () => {
    const original = makeContribution({ amountMinor: 10000, id: "orig-1" });
    const reversal = makeWithdrawal({
      amountMinor: 10000,
      reversalOf: original.id,
    });
    expect(deriveSavingsBalanceMinor([original, reversal], 0)).toBe(0);
  });

  it("9. nets a withdrawal reversed by an equal contribution back to the opening balance", () => {
    const original = makeWithdrawal({ amountMinor: 5000, id: "orig-2" });
    const reversal = makeContribution({
      amountMinor: 5000,
      reversalOf: original.id,
    });
    expect(deriveSavingsBalanceMinor([original, reversal], 20000)).toBe(20000);
  });

  it("14. returns a negative result rather than clamping to zero", () => {
    const transactions = [
      makeContribution({ amountMinor: 5000 }),
      makeWithdrawal({ amountMinor: 7500 }),
    ];
    expect(deriveSavingsBalanceMinor(transactions, 0)).toBe(-2500);
  });

  it("15. never produces a fractional (non-integer minor-unit) result", () => {
    const transactions = [
      makeContribution({ amountMinor: 333 }),
      makeContribution({ amountMinor: 667 }),
      makeWithdrawal({ amountMinor: 500 }),
    ];
    const result = deriveSavingsBalanceMinor(transactions, 1);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(501);
  });
});

describe("deriveMemberSavingsBalanceMinor", () => {
  it("10. returns only the requested member's own contributions", () => {
    const transactions = [
      makeContribution({ amountMinor: 100, memberUid: "daniel" }),
      makeContribution({ amountMinor: 50, memberUid: "jake" }),
    ];
    expect(deriveMemberSavingsBalanceMinor(transactions, "daniel")).toBe(100);
  });

  it("11. keeps multiple members' balances isolated from each other", () => {
    const transactions = [
      makeContribution({ amountMinor: 1000, memberUid: "daniel" }),
      makeContribution({ amountMinor: 500, memberUid: "jake" }),
      makeWithdrawal({ amountMinor: 200, memberUid: "jake" }),
      makeContribution({ amountMinor: 750, memberUid: "matt" }),
    ];

    expect(deriveMemberSavingsBalanceMinor(transactions, "daniel")).toBe(1000);
    expect(deriveMemberSavingsBalanceMinor(transactions, "jake")).toBe(300);
    expect(deriveMemberSavingsBalanceMinor(transactions, "matt")).toBe(750);
  });

  it("12. excludes the resource's legacy opening balance from a member's balance", () => {
    // Legacy resource opening balance: $750 (75000 minor units), not
    // attributable to any member. Daniel then contributes $100 (10000).
    const openingBalanceMinor = 75000;
    const transactions = [
      makeContribution({ amountMinor: 10000, memberUid: "daniel" }),
    ];

    const resourceBalance = deriveSavingsBalanceMinor(
      transactions,
      openingBalanceMinor
    );
    const danielsBalance = deriveMemberSavingsBalanceMinor(
      transactions,
      "daniel"
    );

    expect(danielsBalance).toBe(10000);
    expect(danielsBalance).not.toBe(resourceBalance);
  });

  it("13. lets summed member balances differ from the resource balance because of a legacy opening balance", () => {
    const openingBalanceMinor = 75000;
    const transactions = [
      makeContribution({ amountMinor: 10000, memberUid: "daniel" }),
      makeContribution({ amountMinor: 5000, memberUid: "jake" }),
    ];

    const resourceBalance = deriveSavingsBalanceMinor(
      transactions,
      openingBalanceMinor
    );
    const summedMemberBalances =
      deriveMemberSavingsBalanceMinor(transactions, "daniel") +
      deriveMemberSavingsBalanceMinor(transactions, "jake");

    // The gap is exactly the untracked opening balance - intentional,
    // not a bug (see ledgerOpeningBalanceMinor's doc comment).
    expect(resourceBalance - summedMemberBalances).toBe(openingBalanceMinor);
  });
});
