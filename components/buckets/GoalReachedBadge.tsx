// Minimal "Goal Reached" indicator (Milestone 3 Checkpoint 3D), shared
// between the Bucket list card (BucketGridCard), Home's Top Buckets (if
// used), and Bucket Detail so every surface communicates completion
// identically. Text-based, not color/icon-only, per the checkpoint's
// accessibility requirement. Deliberately no celebration animation/
// confetti - see src/domain/savingsGoal.ts for the deterministic
// balance >= target derivation this badge is conditionally rendered
// from by its callers.
//
// Checkpoint 3F.2A transitional cleanup: a solid bright fill would now
// read as a bright mint "button" (theme.colors.primary is the signature
// mint accent) competing with real primary actions elsewhere on the
// same screen - this is a small, subdued status treatment instead (a
// pale mint-tinted surface behind mint text), matching the "muted
// success" direction for Bucket Detail without changing this shared
// component's size/shape/copy.
import React from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { radii } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";

export function GoalReachedBadge() {
  const colors = useSemanticColors();

  return (
    <View
      style={[styles.badge, { backgroundColor: colors.mintSurface }]}
      accessibilityLabel="Goal reached"
    >
      <Text style={[styles.text, { color: colors.mintText }]}>Goal Reached</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  text: {
    fontSize: 11,
    fontWeight: "700",
  },
});
