// Mirrors app/(tabs)/trips/_layout.tsx's exact pattern: a nested Stack so
// /buckets (list) and /buckets/[bucketId] (detail) both live under the
// Buckets tab, with each screen owning its own header/back affordance
// (headerShown: false here, same as Trips).
import { Stack } from "expo-router";
import React from "react";

export default function BucketsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[bucketId]" />
    </Stack>
  );
}
