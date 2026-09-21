// Checkpoint 3F.3B.4: also mounts the SAME shared Personal Savings
// money-action controller (SavingsMoneyActionProvider) and its two
// overlay surfaces (MoneyActionSheet, MoneySuccessSnackbar) that
// app/(tabs)/buckets/_layout.tsx already mounts for the Buckets tab -
// this is "No new financial write system" (see the checkpoint report):
// a trip_personal fund ("My Stash") IS an ordinary Bucket, so Trip
// Detail's Add Money/Withdraw for it reuses this exact same trusted
// idempotency/serialization owner, not a duplicate one. The Buckets tab
// keeps its own separate provider instance - each route subtree owns
// one, matching the existing per-subtree pattern exactly.
import { Stack } from "expo-router";
import React from "react";

import { MoneyActionSheet } from "../../../components/buckets/MoneyActionSheet";
import { MoneySuccessSnackbar } from "../../../components/buckets/MoneySuccessSnackbar";
import { ExpenseSuccessSnackbar } from "../../../components/expenses/ExpenseSuccessSnackbar";
import { SavingsMoneyActionProvider } from "../../../src/hooks/useSavingsMoneyAction";
import { ExpenseSuccessProvider } from "../../../src/hooks/useExpenseSuccess";

export default function TripsLayout() {
  return (
    <SavingsMoneyActionProvider>
      {/* Checkpoint 4D.3: a second, Expense-scoped success-message owner
          (never folded into SavingsMoneyActionProvider, an unrelated
          Personal-Savings controller) - mounted here, at the Trips
          route-subtree level, so the success Snackbar it drives survives
          expenses/create.tsx's own unmount once router.replace()
          navigates to the Expense list. */}
      <ExpenseSuccessProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="create" />
          <Stack.Screen name="[tripId]" />
        </Stack>
        <MoneyActionSheet />
        <MoneySuccessSnackbar />
        <ExpenseSuccessSnackbar />
      </ExpenseSuccessProvider>
    </SavingsMoneyActionProvider>
  );
}
