// Minimal "Goal Reached" indicator (Milestone 3 Checkpoint 3D), shared
// between the Bucket list card and the Bucket detail screen so both
// surfaces communicate completion identically. Text-based, not
// color/icon-only, per the checkpoint's accessibility requirement.
// Deliberately no celebration animation/confetti - see
// src/domain/savingsGoal.ts for the deterministic balance >= target
// derivation this badge is conditionally rendered from by its callers.
//
// Uses theme.colors.primary/onPrimary (the app's actual overridden brand
// blue - see src/theme/appTheme.ts) rather than primaryContainer/
// onPrimaryContainer, which were never re-derived from that brand color
// override and stay the unmodified default MD3 purple-based container
// tokens - a pale, off-brand, low-emphasis pairing that a manual smoke
// test found easy to overlook (Checkpoint 3D goal-presentation review).
// A solid, high-contrast, on-brand pill makes the completed state
// unmistakable without changing its size/shape/copy - not a redesign.
import React from "react";
import { StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

export function GoalReachedBadge() {
  const theme = useTheme();

  return (
    <View
      style={[styles.badge, { backgroundColor: theme.colors.primary }]}
      accessibilityLabel="Goal reached"
    >
      <Text style={[styles.text, { color: theme.colors.onPrimary }]}>
        Goal Reached
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  text: {
    fontSize: 12,
    fontWeight: "800",
  },
});
