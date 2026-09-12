// Small action menu opened by the global center create button
// (Milestone 3 Checkpoint 3F.2). Offers "New Bucket" / "New Trip" and
// reuses existing creation architecture entirely - it never creates a
// Bucket or Trip itself:
//   - New Bucket navigates to the Buckets tab with an `openCreate` param
//     that app/(tabs)/buckets/index.tsx reads to open its own existing
//     New Bucket dialog/state/handlers (createVisible/openCreate/
//     onAddBucket) - the exact same dialog reachable from that screen's
//     own "New Goal" button.
//   - New Trip navigates to the existing /(tabs)/trips/create route.
import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Text, useTheme } from "react-native-paper";

import { radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";

export function CreateActionSheet({
  visible,
  onDismiss,
  onNewBucket,
  onNewTrip,
}: {
  visible: boolean;
  onDismiss: () => void;
  onNewBucket: () => void;
  onNewTrip: () => void;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onDismiss} accessibilityLabel="Close">
        <View
          style={[styles.sheet, { backgroundColor: theme.colors.surface, borderColor: colors.border }]}
          onStartShouldSetResponder={() => true}
        >
          <Text style={[styles.title, { color: theme.colors.onSurface }]}>Create</Text>

          <Pressable
            onPress={onNewBucket}
            accessibilityRole="button"
            accessibilityLabel="New Bucket"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={[styles.iconBubble, { backgroundColor: colors.mintSurface }]}>
              <MaterialCommunityIcons name="bullseye-arrow" size={20} color={colors.mintText} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: theme.colors.onSurface }]}>New Bucket</Text>
              <Text style={[styles.rowSub, { color: theme.colors.onSurfaceVariant }]}>
                Start a new savings goal
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPress={onNewTrip}
            accessibilityRole="button"
            accessibilityLabel="New Trip"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={[styles.iconBubble, { backgroundColor: colors.bluePale }]}>
              <MaterialCommunityIcons name="airplane" size={20} color={colors.blue} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: theme.colors.onSurface }]}>New Trip</Text>
              <Text style={[styles.rowSub, { color: theme.colors.onSurfaceVariant }]}>
                Plan a trip and start stashing
              </Text>
            </View>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
  },
  title: { ...typography.sectionTitle, marginBottom: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
  },
  rowPressed: { opacity: 0.7 },
  iconBubble: {
    width: 42,
    height: 42,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { ...typography.cardTitle },
  rowSub: { ...typography.meta, marginTop: 2 },
});
