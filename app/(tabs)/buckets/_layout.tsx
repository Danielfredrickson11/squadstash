// Mirrors app/(tabs)/trips/_layout.tsx's exact pattern: a nested Stack so
// /buckets (list) and /buckets/[bucketId] (detail) both live under the
// Buckets tab, with each screen owning its own header/back affordance
// (headerShown: false here, same as Trips).
//
// Milestone 3 Checkpoint 3D: also mounts the single shared Personal
// Savings money-action controller (SavingsMoneyActionProvider) and its
// two overlay surfaces (MoneyActionSheet, MoneySuccessSnackbar) exactly
// once per Buckets route subtree, so both nested screens share one
// idempotency/serialization owner instead of each holding competing
// state - see src/hooks/useSavingsMoneyAction.tsx for the full rationale.
import { Stack } from "expo-router";
import React from "react";

import { MoneyActionSheet } from "../../../components/buckets/MoneyActionSheet";
import { MoneySuccessSnackbar } from "../../../components/buckets/MoneySuccessSnackbar";
import { SavingsMoneyActionProvider } from "../../../src/hooks/useSavingsMoneyAction";

export default function BucketsLayout() {
  return (
    <SavingsMoneyActionProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="[bucketId]" />
      </Stack>
      <MoneyActionSheet />
      <MoneySuccessSnackbar />
    </SavingsMoneyActionProvider>
  );
}
