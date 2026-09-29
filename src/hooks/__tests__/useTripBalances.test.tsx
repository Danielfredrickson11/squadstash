// Controller-level tests for useTripBalances (Checkpoint 4E.4), per the
// frozen docs/audits/TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md
// §15/§16. Exercises the REAL hook (not a re-implementation) via
// react-test-renderer, mirroring src/hooks/__tests__/
// useSavingsMoneyAction.test.tsx's exact harness convention - no UI
// snapshotting, only controller-state/mock-call assertions.
//
// The Expense/Settlement SERVICE layer is mocked (already independently
// tested in 4E.3); the REAL computeTripBalances engine runs unmocked, so
// these tests prove the actual integration boundary, not a fake one.
import React from "react";
import { act, create } from "react-test-renderer";

import { useTripBalances } from "../useTripBalances";
import type { Expense, ExpenseSplit, Settlement } from "../../types/domain";
import {
  fetchExpenseSplitsForExpense as mockFetchExpenseSplitsForExpense,
  subscribeToExpensesForTrip as mockSubscribeToExpensesForTrip,
} from "../../services/firebase/expenses";
import { subscribeToSettlementsForTrip as mockSubscribeToSettlementsForTrip } from "../../services/firebase/settlements";

jest.mock("../../services/firebase/expenses", () => ({
  subscribeToExpensesForTrip: jest.fn(),
  fetchExpenseSplitsForExpense: jest.fn(),
}));

jest.mock("../../services/firebase/settlements", () => ({
  subscribeToSettlementsForTrip: jest.fn(),
}));

const mockSubscribeToExpensesForTripFn = mockSubscribeToExpensesForTrip as unknown as jest.Mock;
const mockFetchExpenseSplitsForExpenseFn = mockFetchExpenseSplitsForExpense as unknown as jest.Mock;
const mockSubscribeToSettlementsForTripFn = mockSubscribeToSettlementsForTrip as unknown as jest.Mock;

type ExpensesOnChange = (expenses: Expense[]) => void;
type ExpensesOnError = (error: unknown) => void;
type SettlementsOnChange = (settlements: Settlement[]) => void;
type SettlementsOnError = (error: unknown) => void;

type SplitDeferred = {
  resolve: (splits: ExpenseSplit[]) => void;
  reject: (error: unknown) => void;
};

let splitDeferreds: Map<string, SplitDeferred>;

beforeEach(() => {
  jest.clearAllMocks();
  splitDeferreds = new Map();

  mockSubscribeToExpensesForTripFn.mockImplementation(() => jest.fn());
  mockSubscribeToSettlementsForTripFn.mockImplementation(() => jest.fn());
  mockFetchExpenseSplitsForExpenseFn.mockImplementation(
    (_tripId: string, expenseId: string) =>
      new Promise<ExpenseSplit[]>((resolve, reject) => {
        splitDeferreds.set(expenseId, { resolve, reject });
      })
  );
});

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "expense-1",
    tripId: "trip-1",
    payerUid: "member-1",
    createdBy: "member-1",
    amountMinor: 1000,
    currency: "USD",
    description: "Test expense",
    splitStrategy: "equal",
    paymentSource: "member_out_of_pocket",
    createdAt: {} as Expense["createdAt"],
    status: "active",
    ...overrides,
  };
}

function makeSplit(overrides: Partial<ExpenseSplit> = {}): ExpenseSplit {
  return {
    expenseId: "expense-1",
    tripId: "trip-1",
    userId: "member-2",
    amountMinor: 500,
    createdAt: {} as ExpenseSplit["createdAt"],
    ...overrides,
  };
}

function makeSettlement(overrides: Partial<Settlement> = {}): Settlement {
  return {
    id: "settlement-1",
    tripId: "trip-1",
    fromUid: "member-2",
    toUid: "member-1",
    amountMinor: 200,
    currency: "USD",
    method: "venmo",
    createdAt: {} as Settlement["createdAt"],
    createdBy: "member-1",
    status: "active",
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type HookApi = ReturnType<typeof useTripBalances>;

async function renderHook(tripId: string) {
  let latest: HookApi | null = null;

  function Harness({ tripId }: { tripId: string }) {
    latest = useTripBalances(tripId);
    return null;
  }

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness tripId={tripId} />);
  });

  return {
    api: (): HookApi => {
      if (!latest) throw new Error("Hook not ready");
      return latest;
    },
    rerender: async (nextTripId: string) => {
      await act(async () => {
        renderer.update(<Harness tripId={nextTripId} />);
      });
    },
    unmount: async () => {
      await act(async () => {
        renderer.unmount();
      });
    },
  };
}

function nthExpensesCall(n: number): [string, ExpensesOnChange, ExpensesOnError] {
  const call = mockSubscribeToExpensesForTripFn.mock.calls[n];
  if (!call) throw new Error(`No subscribeToExpensesForTrip call #${n}`);
  return call as [string, ExpensesOnChange, ExpensesOnError];
}

function nthSettlementsCall(n: number): [string, SettlementsOnChange, SettlementsOnError] {
  const call = mockSubscribeToSettlementsForTripFn.mock.calls[n];
  if (!call) throw new Error(`No subscribeToSettlementsForTrip call #${n}`);
  return call as [string, SettlementsOnChange, SettlementsOnError];
}

function latestExpensesCallIndex(): number {
  return mockSubscribeToExpensesForTripFn.mock.calls.length - 1;
}

function latestSettlementsCallIndex(): number {
  return mockSubscribeToSettlementsForTripFn.mock.calls.length - 1;
}

async function emitExpenses(expenses: Expense[], sessionIndex = latestExpensesCallIndex()): Promise<void> {
  const [, onChange] = nthExpensesCall(sessionIndex);
  await act(async () => {
    onChange(expenses);
  });
}

async function emitExpensesError(error: unknown, sessionIndex = latestExpensesCallIndex()): Promise<void> {
  const [, , onError] = nthExpensesCall(sessionIndex);
  await act(async () => {
    onError(error);
  });
}

async function emitSettlements(
  settlements: Settlement[],
  sessionIndex = latestSettlementsCallIndex()
): Promise<void> {
  const [, onChange] = nthSettlementsCall(sessionIndex);
  await act(async () => {
    onChange(settlements);
  });
}

async function emitSettlementsError(error: unknown, sessionIndex = latestSettlementsCallIndex()): Promise<void> {
  const [, , onError] = nthSettlementsCall(sessionIndex);
  await act(async () => {
    onError(error);
  });
}

async function resolveSplit(expenseId: string, splits: ExpenseSplit[]): Promise<void> {
  const deferred = splitDeferreds.get(expenseId);
  if (!deferred) throw new Error(`No pending split fetch for "${expenseId}"`);
  await act(async () => {
    deferred.resolve(splits);
    await flush();
  });
}

async function rejectSplit(expenseId: string, error: unknown): Promise<void> {
  const deferred = splitDeferreds.get(expenseId);
  if (!deferred) throw new Error(`No pending split fetch for "${expenseId}"`);
  await act(async () => {
    deferred.reject(error);
    await flush().catch(() => {});
  });
}

// Checkpoint 4E.4A: captures a SPECIFIC in-flight Split fetch's deferred
// handle at the moment it exists, so a test can trigger a SECOND fetch
// for the same expenseId (which overwrites splitDeferreds' entry for
// that id) and still resolve/reject the FIRST (now-stale) promise
// afterward - proving the controller's behavior for late async work
// belonging to an Expense that is no longer current.
function captureSplitDeferred(expenseId: string): SplitDeferred {
  const deferred = splitDeferreds.get(expenseId);
  if (!deferred) throw new Error(`No pending split fetch for "${expenseId}"`);
  return deferred;
}

async function resolveDeferred(deferred: SplitDeferred, splits: ExpenseSplit[]): Promise<void> {
  await act(async () => {
    deferred.resolve(splits);
    await flush();
  });
}

async function rejectDeferred(deferred: SplitDeferred, error: unknown): Promise<void> {
  await act(async () => {
    deferred.reject(error);
    await flush().catch(() => {});
  });
}

// =======================================================================
// INITIAL GATING
// =======================================================================

describe("useTripBalances - initial gating", () => {
  it("starts loading with balances null", async () => {
    const { api } = await renderHook("trip-1");
    expect(api().state).toEqual({ status: "loading", balances: null, error: null });
  });

  it("Expenses ready alone does not calculate", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([]);
    expect(api().state.status).toBe("loading");
    expect(api().state.balances).toBeNull();
  });

  it("Settlements ready alone does not calculate", async () => {
    const { api } = await renderHook("trip-1");
    await emitSettlements([]);
    expect(api().state.status).toBe("loading");
    expect(api().state.balances).toBeNull();
  });

  it("both ready + zero Expenses => ready with []", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([]);
    await emitSettlements([]);
    expect(api().state).toEqual({ status: "ready", balances: [], error: null });
  });

  it("non-empty Expenses do not become ready until every current Expense's Splits resolve", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" })]);
    await emitSettlements([]);
    expect(api().state.status).toBe("loading");
    expect(api().state.balances).toBeNull();

    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);
    expect(api().state.status).toBe("ready");
  });
});

// =======================================================================
// CORRECT CALCULATION
// =======================================================================

describe("useTripBalances - correct calculation (real engine)", () => {
  it("one out-of-pocket Expense + Splits produces the expected pairwise balance", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);

    expect(api().state.status).toBe("ready");
    expect(api().state.balances).toEqual([
      { fromUid: "member-2", toUid: "member-1", amountMinor: 500 },
    ]);
  });

  it("an active Settlement reduces the expected debt", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([makeSettlement({ amountMinor: 200, status: "active" })]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);

    expect(api().state.balances).toEqual([
      { fromUid: "member-2", toUid: "member-1", amountMinor: 300 },
    ]);
  });

  it("a reversed Settlement contributes zero using the real engine", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([
      makeSettlement({
        amountMinor: 200,
        status: "reversed",
        reversedAt: {} as Settlement["reversedAt"],
        reversedBy: "member-1",
      }),
    ]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);

    expect(api().state.balances).toEqual([
      { fromUid: "member-2", toUid: "member-1", amountMinor: 500 },
    ]);
  });
});

// =======================================================================
// SPLIT CACHE
// =======================================================================

describe("useTripBalances - split cache", () => {
  it("the same Expense id across repeated live Expense snapshots fetches Splits only once", async () => {
    await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" })]);
    await emitExpenses([makeExpense({ id: "expense-1" })]); // repeated snapshot, still pending
    expect(mockFetchExpenseSplitsForExpenseFn).toHaveBeenCalledTimes(1);
  });

  it("two Expense ids each fetch exactly once", async () => {
    await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" }), makeExpense({ id: "expense-2" })]);
    expect(mockFetchExpenseSplitsForExpenseFn).toHaveBeenCalledTimes(2);
    const fetchedIds = mockFetchExpenseSplitsForExpenseFn.mock.calls.map((c) => c[1]);
    expect(fetchedIds.sort()).toEqual(["expense-1", "expense-2"]);
  });

  it("a newly-arriving Expense after ready fetches ONLY the new id", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);
    expect(api().state.status).toBe("ready");
    mockFetchExpenseSplitsForExpenseFn.mockClear();

    await emitExpenses([
      makeExpense({ id: "expense-1", amountMinor: 1000 }),
      makeExpense({ id: "expense-2", amountMinor: 400 }),
    ]);
    expect(mockFetchExpenseSplitsForExpenseFn).toHaveBeenCalledTimes(1);
    expect(mockFetchExpenseSplitsForExpenseFn).toHaveBeenCalledWith("trip-1", "expense-2");
  });

  it("a cached extra id no longer in the current Expense list is not flattened into current calculation", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);
    expect(api().state.balances).toEqual([
      { fromUid: "member-2", toUid: "member-1", amountMinor: 500 },
    ]);

    // expense-1 (cached) drops out of the snapshot; a different expense-2
    // (a different pair) takes its place.
    await emitExpenses([
      makeExpense({ id: "expense-2", amountMinor: 300, payerUid: "member-1" }),
    ]);
    await resolveSplit("expense-2", [
      makeSplit({ expenseId: "expense-2", userId: "member-1", amountMinor: 0 }),
      makeSplit({ expenseId: "expense-2", userId: "member-3", amountMinor: 300 }),
    ]);

    expect(api().state.balances).toEqual([
      { fromUid: "member-3", toUid: "member-1", amountMinor: 300 },
    ]);
  });
});

// =======================================================================
// UPDATING / LAST-KNOWN-GOOD
// =======================================================================

describe("useTripBalances - updating / last-known-good", () => {
  it("after first ready calculation, a new Expense id moves status to updating while retaining prior balances, then becomes ready with the latest full balance", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);
    const firstBalances = api().state.balances;
    expect(api().state.status).toBe("ready");
    expect(firstBalances).toEqual([{ fromUid: "member-2", toUid: "member-1", amountMinor: 500 }]);

    await emitExpenses([
      makeExpense({ id: "expense-1", amountMinor: 1000 }),
      makeExpense({ id: "expense-2", amountMinor: 100, payerUid: "member-1" }),
    ]);

    // Load-bearing: status is "updating", NOT "ready", and the prior
    // balances remain available as last-known-good - never null, never
    // silently labeled ready.
    expect(api().state.status).toBe("updating");
    expect(api().state.balances).toEqual(firstBalances);

    await resolveSplit("expense-2", [
      makeSplit({ expenseId: "expense-2", userId: "member-1", amountMinor: 0 }),
      makeSplit({ expenseId: "expense-2", userId: "member-4", amountMinor: 100 }),
    ]);

    expect(api().state.status).toBe("ready");
    expect(api().state.balances).toEqual(
      expect.arrayContaining([
        { fromUid: "member-2", toUid: "member-1", amountMinor: 500 },
        { fromUid: "member-4", toUid: "member-1", amountMinor: 100 },
      ])
    );
  });
});

// =======================================================================
// LATEST-SNAPSHOT RACE
// =======================================================================

describe("useTripBalances - latest-snapshot race", () => {
  it("uses the newest Settlement snapshot (not a stale closure) once a pending Split resolves", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([makeSettlement({ amountMinor: 100, status: "active" })]);
    expect(api().state.status).toBe("loading"); // split still pending

    // Settlements update WHILE the Split fetch is still in flight.
    await emitSettlements([makeSettlement({ amountMinor: 400, status: "active" })]);
    expect(api().state.status).toBe("loading");

    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);

    // 500 (debt) - 400 (NEWEST settlement, not the stale 100) = 100.
    expect(api().state.balances).toEqual([
      { fromUid: "member-2", toUid: "member-1", amountMinor: 100 },
    ]);
  });
});

// =======================================================================
// EXISTING EXPENSE UPDATE
// =======================================================================

describe("useTripBalances - existing Expense update", () => {
  it("a status update to an already-cached Expense does not refetch its immutable Splits, and recomputes from the updated data", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000, status: "active" })]);
    await emitSettlements([]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);
    expect(api().state.balances).toEqual([
      { fromUid: "member-2", toUid: "member-1", amountMinor: 500 },
    ]);
    mockFetchExpenseSplitsForExpenseFn.mockClear();

    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000, status: "reversed" })]);

    expect(mockFetchExpenseSplitsForExpenseFn).not.toHaveBeenCalled();
    expect(api().state.status).toBe("ready");
    expect(api().state.balances).toEqual([]); // reversed contributes zero
  });
});

// =======================================================================
// ERRORS
// =======================================================================

describe("useTripBalances - errors", () => {
  it("Expense listener error => status error, source expenses", async () => {
    const { api } = await renderHook("trip-1");
    const boom = new Error("expense listener failed");
    await emitExpensesError(boom);
    expect(api().state.status).toBe("error");
    expect(api().state.error).toEqual({ source: "expenses", error: boom });
    expect(api().state.balances).toBeNull();
  });

  it("Settlement listener error => status error, source settlements", async () => {
    const { api } = await renderHook("trip-1");
    const boom = new Error("settlement listener failed");
    await emitSettlementsError(boom);
    expect(api().state.status).toBe("error");
    expect(api().state.error).toEqual({ source: "settlements", error: boom });
  });

  it("Split fetch error => status error, source splits", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" })]);
    await emitSettlements([]);
    const boom = new Error("split fetch failed");
    await rejectSplit("expense-1", boom);
    expect(api().state.status).toBe("error");
    expect(api().state.error).toEqual({ source: "splits", error: boom });
  });

  it("malformed data causing computeTripBalances to throw => status error, source calculation", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([]);
    // Splits summing to 900, not the Expense's own 1000 - the real engine
    // throws on this, never silently accepting a mismatched split total.
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 400 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);
    expect(api().state.status).toBe("error");
    expect(api().state.error?.source).toBe("calculation");
  });

  it("no source error ever substitutes [] and produces a fake ready result", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpensesError(new Error("boom"));
    expect(api().state.status).toBe("error");
    expect(api().state.balances).not.toEqual([]);
  });

  it("after a terminal error, a late callback from another source does not silently restore ready", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" })]);
    const boom = new Error("split fetch failed");
    await rejectSplit("expense-1", boom);
    expect(api().state.status).toBe("error");

    // A late/ordinary Settlements callback arrives after the terminal
    // error was already established.
    await emitSettlements([]);
    expect(api().state.status).toBe("error");
    expect(api().state.error).toEqual({ source: "splits", error: boom });
  });
});

// =======================================================================
// RETRY
// =======================================================================

describe("useTripBalances - retry", () => {
  it("retry begins a fresh loading session, clears the previous error, and can reach ready", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpensesError(new Error("boom"));
    expect(api().state.status).toBe("error");

    const firstUnsubscribe = mockSubscribeToExpensesForTripFn.mock.results[0].value as jest.Mock;

    await act(async () => {
      api().retry();
    });

    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(api().state).toEqual({ status: "loading", balances: null, error: null });
    expect(mockSubscribeToExpensesForTripFn).toHaveBeenCalledTimes(2);
    expect(mockSubscribeToSettlementsForTripFn).toHaveBeenCalledTimes(2);

    await emitExpenses([]);
    await emitSettlements([]);
    expect(api().state).toEqual({ status: "ready", balances: [], error: null });
  });

  it("required Splits are fetched again in the fresh session after retry", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);
    expect(api().state.status).toBe("ready");

    mockFetchExpenseSplitsForExpenseFn.mockClear();
    await act(async () => {
      api().retry();
    });
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([]);

    expect(mockFetchExpenseSplitsForExpenseFn).toHaveBeenCalledTimes(1);
    expect(mockFetchExpenseSplitsForExpenseFn).toHaveBeenCalledWith("trip-1", "expense-1");
  });
});

// =======================================================================
// RACE / SESSION SAFETY
// =======================================================================

describe("useTripBalances - race / session safety", () => {
  it("an old Split promise resolving after tripId changes does not modify the new Trip's state", async () => {
    const { api, rerender } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", tripId: "trip-1" })], 0);

    await rerender("trip-2");
    // The rerender started a fresh session for "trip-2" - nothing has
    // been emitted on it yet, so it should still read as loading.
    expect(api().state).toEqual({ status: "loading", balances: null, error: null });

    // The OLD (trip-1) Split promise resolves late.
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);

    // Must still reflect the new (trip-2) session, untouched.
    expect(api().state).toEqual({ status: "loading", balances: null, error: null });
  });

  it("an old Split promise rejecting after tripId changes does not poison the new Trip's state", async () => {
    const { api, rerender } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", tripId: "trip-1" })], 0);

    await rerender("trip-2");
    await rejectSplit("expense-1", new Error("stale rejection"));

    expect(api().state).toEqual({ status: "loading", balances: null, error: null });
  });

  it("retry while an old Split promise is pending invalidates the old result", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" })]);

    await act(async () => {
      api().retry();
    });
    expect(api().state).toEqual({ status: "loading", balances: null, error: null });

    // The stale (pre-retry) Split promise resolves late.
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);

    expect(api().state).toEqual({ status: "loading", balances: null, error: null });
  });

  it("unmounting while a Split promise is pending causes no late controller update", async () => {
    const { unmount } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" })]);

    await unmount();

    // Resolving the still-pending promise after unmount must not throw
    // and must not attempt any further state update.
    await expect(
      resolveSplit("expense-1", [
        makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
        makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
      ])
    ).resolves.not.toThrow();
  });
});

// =======================================================================
// SUBSCRIPTIONS
// =======================================================================

describe("useTripBalances - subscription cleanup", () => {
  it("both unsubscribe functions are invoked on cleanup/restart", async () => {
    const { unmount } = await renderHook("trip-1");
    const unsubscribeExpenses = mockSubscribeToExpensesForTripFn.mock.results[0].value as jest.Mock;
    const unsubscribeSettlements = mockSubscribeToSettlementsForTripFn.mock.results[0].value as jest.Mock;

    await unmount();

    expect(unsubscribeExpenses).toHaveBeenCalledTimes(1);
    expect(unsubscribeSettlements).toHaveBeenCalledTimes(1);
  });
});

// =======================================================================
// STALE ASYNC SPLIT WORK FOR A NO-LONGER-CURRENT EXPENSE (Checkpoint
// 4E.4A) - a Split fetch may still be in flight for an Expense id that
// has since disappeared from the latest Expense snapshot (SAME session,
// not a tripId/retry/unmount cancellation - those are covered above).
// Its eventual settlement must be ignored entirely: never cached, never
// used to compute, and - critically - a late REJECTION for a no-longer-
// current Expense must NOT put the current session into terminal error.
// =======================================================================

describe("useTripBalances - stale Split work for a removed Expense", () => {
  it("a late REJECTION for an Expense removed from the current snapshot is ignored, not a terminal error", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);
    const readyBalances = api().state.balances;
    expect(api().state.status).toBe("ready");

    // A new Expense arrives - its Split fetch begins but does not settle.
    await emitExpenses([
      makeExpense({ id: "expense-1", amountMinor: 1000 }),
      makeExpense({ id: "expense-2", amountMinor: 200, payerUid: "member-1" }),
    ]);
    expect(api().state.status).toBe("updating");
    const staleDeferred = captureSplitDeferred("expense-2");

    // expense-2 is removed again before its fetch resolves - the
    // remaining Expense set (expense-1 only, already cached) is complete
    // again and the session returns to ready on its own.
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    expect(api().state.status).toBe("ready");
    expect(api().state.balances).toEqual(readyBalances);

    // The removed Expense's stale fetch now REJECTS.
    await rejectDeferred(staleDeferred, new Error("stale split fetch failed"));

    expect(api().state.status).toBe("ready");
    expect(api().state.balances).toEqual(readyBalances);
    expect(api().state.error).toBeNull();
  });

  it("a late SUCCESS for a removed Expense is not cached, and a later reappearance re-fetches its Splits", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    await emitSettlements([]);
    await resolveSplit("expense-1", [
      makeSplit({ expenseId: "expense-1", userId: "member-1", amountMinor: 500 }),
      makeSplit({ expenseId: "expense-1", userId: "member-2", amountMinor: 500 }),
    ]);
    const readyBalances = api().state.balances;

    await emitExpenses([
      makeExpense({ id: "expense-1", amountMinor: 1000 }),
      makeExpense({ id: "expense-2", amountMinor: 200, payerUid: "member-1" }),
    ]);
    const staleDeferred = captureSplitDeferred("expense-2");

    await emitExpenses([makeExpense({ id: "expense-1", amountMinor: 1000 })]);
    expect(api().state.status).toBe("ready");

    // The removed Expense's stale fetch now resolves SUCCESSFULLY.
    await resolveDeferred(staleDeferred, [
      makeSplit({ expenseId: "expense-2", userId: "member-1", amountMinor: 0 }),
      makeSplit({ expenseId: "expense-2", userId: "member-3", amountMinor: 200 }),
    ]);

    // The stale success must not have affected current balances.
    expect(api().state.status).toBe("ready");
    expect(api().state.balances).toEqual(readyBalances);

    mockFetchExpenseSplitsForExpenseFn.mockClear();

    // expense-2 reappears - since the stale result was never cached (and
    // never permanently blacklisted), its Splits must be fetched again.
    await emitExpenses([
      makeExpense({ id: "expense-1", amountMinor: 1000 }),
      makeExpense({ id: "expense-2", amountMinor: 200, payerUid: "member-1" }),
    ]);

    expect(mockFetchExpenseSplitsForExpenseFn).toHaveBeenCalledTimes(1);
    expect(mockFetchExpenseSplitsForExpenseFn).toHaveBeenCalledWith("trip-1", "expense-2");
  });

  it("a REJECTION for a STILL-current Expense continues to produce a terminal error (regression guard)", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" })]);
    await emitSettlements([]);
    const boom = new Error("split fetch failed for a still-current Expense");
    await rejectSplit("expense-1", boom);

    expect(api().state.status).toBe("error");
    expect(api().state.error).toEqual({ source: "splits", error: boom });
  });

  it("an old pre-retry Split promise REJECTING after retry() does not poison the new session", async () => {
    const { api } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" })]);
    const staleDeferred = captureSplitDeferred("expense-1");

    await act(async () => {
      api().retry();
    });
    expect(api().state).toEqual({ status: "loading", balances: null, error: null });

    await rejectDeferred(staleDeferred, new Error("stale pre-retry rejection"));

    expect(api().state).toEqual({ status: "loading", balances: null, error: null });
  });

  it("unmounting while a Split promise is pending, then having it REJECT, causes no late controller update", async () => {
    const { unmount } = await renderHook("trip-1");
    await emitExpenses([makeExpense({ id: "expense-1" })]);
    const staleDeferred = captureSplitDeferred("expense-1");

    await unmount();

    await expect(
      rejectDeferred(staleDeferred, new Error("late rejection after unmount"))
    ).resolves.not.toThrow();
  });
});
