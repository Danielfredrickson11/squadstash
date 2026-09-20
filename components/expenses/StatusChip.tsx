// Text-based Expense status chip (Checkpoint 4D.2, per the frozen
// docs/audits/TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §10/§17/§29).
// Mirrors components/buckets/GoalReachedBadge.tsx's exact shape (pale
// tinted pill, text-only) - never color/icon-only, matching that
// component's own explicit accessibility requirement. Only two tones
// exist for 4D.2: "neutral" (Reversed) and "info" (Correction) - coral is
// never used here, reserved exclusively for genuine destructive/error
// states elsewhere in this app's frozen Light Mode palette.
import React from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { radii, spacing } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";

export type StatusChipTone = "neutral" | "info";

export function StatusChip({ label, tone }: { label: string; tone: StatusChipTone }) {
  const colors = useSemanticColors();
  const backgroundColor = tone === "info" ? colors.bluePale : colors.slatePale;
  const textColor = tone === "info" ? colors.blue : colors.textSecondary;

  return (
    <View style={[styles.chip, { backgroundColor }]} accessibilityLabel={label}>
      <Text style={[styles.text, { color: textColor }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  text: { fontSize: 11, fontWeight: "700" },
});
