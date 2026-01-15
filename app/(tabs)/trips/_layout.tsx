import { Stack } from "expo-router";
import React from "react";

export default function TripsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="create" />
      <Stack.Screen name="[tripId]" />
    </Stack>
  );
}
