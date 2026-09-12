// Compact Home "Your Buckets" preview card (Milestone 3 Checkpoint
// 3F.2B) - informational/navigational only: icon, name, saved/target,
// thin progress, percentage or Goal Reached status. No menu, no Add
// Money/Withdraw - those stay on the Buckets list (BucketGridCard) and
// Bucket Detail respectively. Real Bucket data only; balance is never
// capped, only the progress bar's visual fill is.
//
// Containment note: only name/amount/progress are inside the tappable
// Pressable - the trailing status line is a sibling View after it
// closes, not nested inside it. This proactively applies the exact fix
// Checkpoint 3F.2A root-caused for BucketGridCard/OtherTripCard (a
// Pressable wrapping several stacked rows can fail to contain all of
// its children's natural height on React Native Web).
import React from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { ProgressBar, Text, useTheme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { bucketAccentPresentation, bucketIconForName } from "../../src/domain/bucketPresentation";
import { isGoalReached } from "../../src/domain/savingsGoal";
import { cardShadowFor, radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { formatCurrency } from "../../utils/format";
import { GoalReachedBadge } from "../buckets/GoalReachedBadge";

export const BUCKET_PREVIEW_CARD_WIDTH = 172;

// Checkpoint 3F.2C.2 permanent fix: see the identical constant/comment
// in components/buckets/BucketGridCard.tsx - a controlled runtime test
// proved numberOfLines={1} triggers react-native-web's single-line
// truncation path, which clipped this card's name Text to zero visible
// width. Removed on web (names wrap naturally there); kept on native,
// where that CSS-based path doesn't apply.
const NAME_NUMBER_OF_LINES = Platform.OS === "web" ? undefined : 1;

export function BucketPreviewCard({
  name,
  balance,
  target,
  color,
  // Checkpoint 3F.3A.1: this card's position within Home's "Your
  // Buckets" preview row, used only to deterministically rotate the
  // restrained mint/blue/slate accent in Light Mode - see
  // bucketAccentPresentation.
  accentIndex = 0,
  onPress,
}: {
  name: string;
  balance: number;
  target: number;
  color?: string | null;
  accentIndex?: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();
  const accent = bucketAccentPresentation(accentIndex, color, theme.dark, colors);
  const pct = target > 0 ? Math.min(balance / target, 1) : 0;
  const goalReached = isGoalReached(balance, target);

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: colors.border },
        theme.dark ? null : cardShadowFor(false),
      ]}
    >
      {/* Checkpoint 3F.2C root cause fix (proactively applied - same
          structural pattern proven to cause invisible bucket names in
          components/buckets/BucketGridCard.tsx): numberOfLines={1} on
          the name Text below applies react-native-web's "textOneLine"
          style (maxWidth:'100%', overflow:'hidden', whiteSpace:
          'nowrap'), which only resolves correctly against a DEFINITE
          ancestor width. This Pressable had no explicit width of its
          own, only an implicit one inherited via flex-stretch from
          `card` above - width:'100%' gives it a definite width to
          resolve against. */}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Open ${name} details`}
        style={styles.pressableFill}
      >
        <View style={[styles.iconBubble, { backgroundColor: accent.pale }]}>
          <MaterialCommunityIcons name={bucketIconForName(name)} size={16} color={accent.icon} />
        </View>

        <Text
          style={[styles.name, { color: theme.colors.onSurface }]}
          numberOfLines={NAME_NUMBER_OF_LINES}
        >
          {name}
        </Text>

        <Text style={[styles.amountRow, { color: theme.colors.onSurfaceVariant }]}>
          <Text style={{ color: theme.colors.onSurface, fontWeight: "700" }}>
            {formatCurrency(balance)}
          </Text>{" "}
          / {formatCurrency(target)}
        </Text>

        <ProgressBar
          progress={pct}
          style={[styles.progress, { backgroundColor: colors.surfaceTertiary }]}
          color={accent.icon}
        />
      </Pressable>

      {goalReached ? (
        <View style={{ marginTop: spacing.xs, alignSelf: "flex-start" }}>
          <GoalReachedBadge />
        </View>
      ) : (
        <Text style={[styles.pctText, { color: theme.colors.onSurfaceVariant }]}>
          {Math.round(pct * 100)}% complete
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: BUCKET_PREVIEW_CARD_WIDTH,
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing.sm,
    flexShrink: 0,
  },
  // Checkpoint 3F.2C root cause fix - see the usage site above.
  pressableFill: { width: "100%" },
  iconBubble: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xs,
  },
  name: { ...typography.cardTitle, fontSize: 13, marginBottom: 2 },
  amountRow: { fontSize: 12, marginBottom: spacing.xs },
  progress: { height: 5, borderRadius: radii.pill },
  pctText: { ...typography.meta, fontSize: 11, marginTop: spacing.xs },
});
