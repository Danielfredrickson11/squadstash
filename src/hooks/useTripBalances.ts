// Trip balance aggregation controller (Checkpoint 4E.4), per the frozen
// docs/audits/TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md §15/§16.
//
// The ONLY new multi-source balance coordinator: combines live Expenses,
// one-shot-per-Expense immutable Splits, and live Settlements into
// computeTripBalances(...) - the sole money-math authority (never
// duplicated here). Performs NO financial writes: never imports
// recordTripSettlement/reverseTripSettlement, never touches Buckets/
// trip_personal/savingsTransactions/My Stash.
//
// Non-negotiable principle (preflight §15): a balance must never be
// marked "ready" if it was computed from fresh Expenses + missing
// Splits, a stale Expenses/Settlements reference, an errored source
// silently replaced with [], a partial split-fetch result, or stale
// async work from a previous Trip/session. All mutable coordination
// state below is scoped to ONE effect run (one "session"); a `cancelled`
// flag captured by every async callback/promise continuation is this
// session's cancellation guard - once set (tripId change, retry(), or
// unmount), every late callback/resolution is ignored entirely: it must
// never write into a new session's cache, set an error, compute
// balances, or change status.
import { useCallback, useEffect, useState } from "react";

import {
  fetchExpenseSplitsForExpense,
  subscribeToExpensesForTrip,
} from "../services/firebase/expenses";
import { subscribeToSettlementsForTrip } from "../services/firebase/settlements";
import { computeTripBalances } from "../domain/tripSettlement";
import type { TripBalance } from "../domain/tripSettlement";
import type { Expense, ExpenseSplit, Settlement } from "../types/domain";

export type TripBalancesLoadStatus = "loading" | "ready" | "updating" | "error";

export type TripBalancesErrorSource =
  | "expenses"
  | "splits"
  | "settlements"
  | "calculation";

export type TripBalancesError = {
  source: TripBalancesErrorSource;
  error: unknown;
};

export type TripBalancesState = {
  status: TripBalancesLoadStatus;
  // null means no successful complete calculation has happened yet. A
  // previously-good snapshot MAY remain here while status is "updating"
  // or "error", but must NEVER be represented as current by status.
  balances: TripBalance[] | null;
  error: TripBalancesError | null;
};

const INITIAL_STATE: TripBalancesState = {
  status: "loading",
  balances: null,
  error: null,
};

export function useTripBalances(tripId: string): {
  state: TripBalancesState;
  retry: () => void;
} {
  const [state, setState] = useState<TripBalancesState>(INITIAL_STATE);
  // Incrementing this forces the effect below to tear down and restart a
  // brand-new session - the same mechanism a tripId change already uses,
  // reused here so retry() gets the identical "restart the whole data
  // session cleanly" behavior for free (preflight §16/§23), with no
  // separate partial-repair code path.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // --- Session-scoped mutable coordination state ---------------------
    // Fresh for every tripId change AND every retry() - never reused
    // across sessions.
    let latestExpenses: Expense[] | null = null;
    let expensesReady = false;
    let latestSettlements: Settlement[] | null = null;
    let settlementsReady = false;
    // Additive-only for the life of this session (Splits are immutable
    // once fetched) - a cached entry is never re-fetched or invalidated
    // merely because another Expense snapshot arrived.
    const splitCache = new Map<string, ExpenseSplit[]>();
    // Prevents a repeated Expense snapshot from triggering a second fetch
    // for an id whose Split fetch is already in flight.
    const inFlightSplitIds = new Set<string>();
    let lastKnownGoodBalances: TripBalance[] | null = null;
    // Once true, only a fresh session (new tripId or retry()) can clear
    // it - an ordinary later callback from any source must never
    // silently restore "ready" over a terminal error.
    let inTerminalError = false;

    setState(INITIAL_STATE);

    function currentSplitsComplete(): boolean {
      if (!latestExpenses) return false;
      // Trivially complete when Expenses is successfully empty.
      return latestExpenses.every((expense) => splitCache.has(expense.id));
    }

    // Split-fetching is intentionally independent of Settlements
    // readiness - Splits only depend on the current Expense snapshot, so
    // there is no reason to delay starting a Split fetch merely because
    // the Settlements listener hasn't delivered its own first snapshot
    // yet. Compute-readiness (maybeCompute below) still requires ALL
    // three sources.
    function ensureSplitsFetched(): void {
      if (!latestExpenses) return;
      const missingIds = latestExpenses
        .map((expense) => expense.id)
        .filter((id) => !splitCache.has(id) && !inFlightSplitIds.has(id));
      if (missingIds.length === 0) return;

      // Load-bearing (preflight §15, checkpoint §17/§20): never recompute
      // with the new Expense but missing Splits, and never pretend a
      // retained last-known-good snapshot is current. If we've never
      // completed a calculation this session, this correctly stays
      // "loading"; otherwise it becomes "updating" while retaining the
      // prior result for display.
      setState({
        status: lastKnownGoodBalances !== null ? "updating" : "loading",
        balances: lastKnownGoodBalances,
        error: null,
      });

      missingIds.forEach((expenseId) => {
        inFlightSplitIds.add(expenseId);
        fetchExpenseSplitsForExpense(tripId, expenseId)
          .then((splits) => {
            if (cancelled) return;
            inFlightSplitIds.delete(expenseId);
            // Checkpoint 4E.4A: a Split fetch that outlives the Expense
            // it was fetched for (X disappeared from the latest Expense
            // snapshot before this settled) is stale, SAME-session async
            // work - distinct from cross-session cancellation, which
            // `cancelled` already covers above. Never cache it, never
            // compute from it, and never permanently blacklist the id -
            // if X reappears in a later snapshot, ensureSplitsFetched
            // sees it missing from both splitCache and inFlightSplitIds
            // (already deleted, right above) and fetches it again
            // normally.
            if (!isExpenseCurrent(expenseId)) return;
            splitCache.set(expenseId, splits);
            if (inTerminalError) return;
            maybeCompute();
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            inFlightSplitIds.delete(expenseId);
            // Same staleness guard as the success branch above: a late
            // failure for an Expense no longer required by the CURRENT
            // Expense snapshot must not poison the current session with
            // a terminal error - only a rejection for a STILL-current
            // Expense id may ever do that (checkpoint §8/§10).
            if (!isExpenseCurrent(expenseId)) return;
            inTerminalError = true;
            setState({
              status: "error",
              balances: lastKnownGoodBalances,
              error: { source: "splits", error },
            });
          });
      });
    }

    // Reads the LATEST session-scoped latestExpenses reference (never a
    // captured/stale array from when the fetch began) - the exact check
    // that distinguishes "this Expense is still part of the current
    // snapshot" from "it was removed while its Split fetch was in
    // flight."
    function isExpenseCurrent(expenseId: string): boolean {
      return latestExpenses?.some((expense) => expense.id === expenseId) ?? false;
    }

    function maybeCompute(): void {
      if (cancelled) return;
      if (inTerminalError) return; // only a fresh session may clear this
      if (!expensesReady || !settlementsReady) return;
      if (!currentSplitsComplete()) return;

      // All three sources are ready and the Splits cache is complete for
      // the CURRENT Expense set - compute using the LATEST snapshot of
      // every source (never a stale closure capture), flattening ONLY
      // cache entries whose id is in the current Expense snapshot (an
      // old cached id no longer present must never affect computation).
      const currentExpenses = latestExpenses ?? [];
      const currentExpenseIds = new Set(currentExpenses.map((e) => e.id));
      const flatSplits: ExpenseSplit[] = [];
      currentExpenseIds.forEach((id) => {
        const splits = splitCache.get(id);
        if (splits) flatSplits.push(...splits);
      });

      try {
        const balances = computeTripBalances(
          currentExpenses,
          flatSplits,
          latestSettlements ?? [],
          tripId
        );
        lastKnownGoodBalances = balances;
        setState({ status: "ready", balances, error: null });
      } catch (error) {
        inTerminalError = true;
        setState({
          status: "error",
          balances: lastKnownGoodBalances,
          error: { source: "calculation", error },
        });
      }
    }

    const unsubscribeExpenses = subscribeToExpensesForTrip(
      tripId,
      (expenses) => {
        if (cancelled) return;
        latestExpenses = expenses;
        expensesReady = true;
        if (inTerminalError) return;
        ensureSplitsFetched();
        maybeCompute();
      },
      (error) => {
        if (cancelled) return;
        inTerminalError = true;
        setState({
          status: "error",
          balances: lastKnownGoodBalances,
          error: { source: "expenses", error },
        });
      }
    );

    const unsubscribeSettlements = subscribeToSettlementsForTrip(
      tripId,
      (settlements) => {
        if (cancelled) return;
        latestSettlements = settlements;
        settlementsReady = true;
        if (inTerminalError) return;
        maybeCompute();
      },
      (error) => {
        if (cancelled) return;
        inTerminalError = true;
        setState({
          status: "error",
          balances: lastKnownGoodBalances,
          error: { source: "settlements", error },
        });
      }
    );

    return () => {
      cancelled = true;
      unsubscribeExpenses();
      unsubscribeSettlements();
    };
  }, [tripId, retryToken]);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  return { state, retry };
}
