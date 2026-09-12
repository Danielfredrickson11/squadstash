// Restrained accent-color selector for the Bucket create/edit dialogs
// (Milestone 3 Checkpoint 3F.2A) - small circular swatches with a
// checkmark on the selected color, replacing the previous full-size
// colorful Chips ("prototype-like color chips" per visual review).
// Presentational only; the same COLORS palette and onSelect(color)
// contract as before - no change to what gets stored on the bucket.
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { radii, spacing } from "../../src/theme/tokens";

export function AccentColorPicker({
  colors,
  selected,
  onSelect,
}: {
  colors: string[];
  selected: string | null;
  onSelect: (color: string) => void;
}) {
  return (
    <View style={styles.row}>
      {colors.map((c) => {
        const isSelected = selected === c;
        return (
          <Pressable
            key={c}
            onPress={() => onSelect(c)}
            accessibilityRole="button"
            accessibilityLabel={`Select accent color`}
            accessibilityState={{ selected: isSelected }}
            style={[styles.swatch, { backgroundColor: c }, isSelected && styles.swatchSelected]}
          >
            {isSelected ? <MaterialCommunityIcons name="check" size={14} color="#FFFFFF" /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  swatchSelected: {
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
});
