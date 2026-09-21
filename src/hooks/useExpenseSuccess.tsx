// Expense-specific success-feedback owner (Checkpoint 4D.3), mirroring
// SavingsMoneyActionProvider's own successMessage/announceSuccess/
// dismissSuccess half exactly (src/hooks/useSavingsMoneyAction.tsx) -
// deliberately NOT the full money-action controller (no submitting
// state, no idempotency refs, no recordSavingsTransaction call): Add
// Expense's own submission state lives in the create screen itself
// (per the checkpoint's own "the route/controller owns the trusted call"
// instruction), this provider owns only the one thing that must SURVIVE
// that screen's own unmount - the success message shown after
// router.replace() has already navigated away from create.tsx.
//
// Mounted once at the Trips route-subtree level (app/(tabs)/trips/
// _layout.tsx), alongside the existing SavingsMoneyActionProvider - kept
// as its own small, Expense-scoped context rather than folding into that
// unrelated Personal-Savings controller or inventing a new app-wide
// notification framework.
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

type ExpenseSuccessContextValue = {
  successMessage: string | null;
  announceExpenseSuccess: (message: string) => void;
  dismissExpenseSuccess: () => void;
};

const ExpenseSuccessContext = createContext<ExpenseSuccessContextValue | undefined>(undefined);

export function ExpenseSuccessProvider({ children }: { children: React.ReactNode }) {
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const announceExpenseSuccess = useCallback((message: string) => setSuccessMessage(message), []);
  const dismissExpenseSuccess = useCallback(() => setSuccessMessage(null), []);

  const value = useMemo<ExpenseSuccessContextValue>(
    () => ({ successMessage, announceExpenseSuccess, dismissExpenseSuccess }),
    [successMessage, announceExpenseSuccess, dismissExpenseSuccess]
  );

  return <ExpenseSuccessContext.Provider value={value}>{children}</ExpenseSuccessContext.Provider>;
}

export function useExpenseSuccess(): ExpenseSuccessContextValue {
  const ctx = useContext(ExpenseSuccessContext);
  if (!ctx) {
    throw new Error("useExpenseSuccess must be used inside <ExpenseSuccessProvider />");
  }
  return ctx;
}
