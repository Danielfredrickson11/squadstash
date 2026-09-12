// Dark-UI Buckets-list card (Milestone 3 Checkpoint 3F.2), replacing the
// previous single BucketCard with two layouts driven by one component:
//   - variant="compact": the "Personal Essentials" 2-column grid card
//     (icon, name, saved amount, thin progress, percentage) - no member
//     avatars, matching the approved reference's compact cards.
//   - variant="shared": the full-width "Shared Buckets" row card, which
//     additionally shows real member avatars/count and the saved/target
//     pair (not just saved alone).
// Both variants keep the existing menu control (Members/Edit/Delete) and
// tap-to-open-Bucket-Detail behavior - money actions (Add Money/
// Withdraw) are NOT on these cards; the reference's compact/shared cards
// don't show them either, and they remain fully reachable from Bucket
// Detail, which already has them untouched.
import React from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { IconButton, Menu, ProgressBar, Text, useTheme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { bucketAccentPresentation, bucketIconForName } from "../../src/domain/bucketPresentation";
import { clampProgress, isGoalReached, remainingToGoal } from "../../src/domain/savingsGoal";
import { cardShadowFor, radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import type { Bucket } from "../../src/types/domain";
import { formatCurrency } from "../../utils/format";
import { AvatarCircle } from "./AvatarCircle";
import { GoalReachedBadge } from "./GoalReachedBadge";

// Checkpoint 3F.2C.2 permanent fix: numberOfLines={1} on web triggers
// react-native-web's single-line truncation path (Text -> "textOneLine"
// style, maxWidth:'100%' + overflow:hidden + white-space:nowrap), which
// a controlled runtime test proved clips the bucket-name Text to zero
// visible width in this card's layout - removing numberOfLines on web
// (bucket names simply wrap naturally there, no fixed height/ellipsis
// hack) fixed it immediately. Native iOS/Android doesn't go through that
// CSS-based path at all, so numberOfLines={1} stays correct/wanted there.
const NAME_NUMBER_OF_LINES = Platform.OS === "web" ? undefined : 1;

export function BucketGridCard({
  variant,
  bucket,
  // Checkpoint 3F.3A.1: the bucket's position within its own section
  // (Personal Essentials or Shared Buckets), used only to deterministically
  // rotate the restrained mint/blue/slate accent in Light Mode - see
  // bucketAccentPresentation. Defaults to 0 so existing callers/tests that
  // don't pass it still render deterministically.
  accentIndex = 0,
  isOwner,
  isMenuOpen,
  width,
  avatarForUid,
  onOpenBucket,
  onOpenMembers,
  onOpenMenu,
  onCloseMenu,
  onEdit,
  onDelete,
}: {
  variant: "compact" | "shared";
  bucket: Bucket;
  accentIndex?: number;
  isOwner: boolean;
  isMenuOpen: boolean;
  width?: number;
  avatarForUid: (uid: string) => { label: string; photoURL: string };
  onOpenBucket: (bucket: Bucket) => void;
  onOpenMembers: (bucket: Bucket) => void;
  onOpenMenu: (bucketId: string) => void;
  onCloseMenu: () => void;
  onEdit: (bucket: Bucket) => void;
  onDelete: (bucket: Bucket) => void;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();
  const accent = bucketAccentPresentation(accentIndex, bucket.color, theme.dark, colors);
  const pct = clampProgress(bucket.balance, bucket.target);
  const goalReached = isGoalReached(bucket.balance, bucket.target);
  const remaining = remainingToGoal(bucket.balance, bucket.target);
  const displayName = bucket.name?.trim() ? bucket.name.trim() : "Untitled";
  const memberIds = bucket.memberIds ?? [];
  const topMembers = memberIds.slice(0, 3);
  const extraCount = Math.max(0, memberIds.length - topMembers.length);

  const menu = (
    <Menu
      visible={isMenuOpen}
      onDismiss={onCloseMenu}
      anchor={
        <IconButton
          icon="dots-horizontal"
          size={18}
          onPress={() => onOpenMenu(bucket.id)}
          accessibilityLabel="Bucket options"
          style={styles.menuButton}
        />
      }
    >
      <Menu.Item title="Members" onPress={() => onOpenMembers(bucket)} />
      <Menu.Item title="Edit" onPress={() => onEdit(bucket)} />
      <Menu.Item title="Delete" onPress={() => onDelete(bucket)} disabled={!isOwner} />
    </Menu>
  );

  if (variant === "shared") {
    return (
      <View
        style={[
          styles.sharedCard,
          { backgroundColor: theme.colors.surface, borderColor: colors.border },
          theme.dark ? null : cardShadowFor(false),
        ]}
      >
        <View style={[styles.iconBubble, { backgroundColor: accent.pale }]}>
          <MaterialCommunityIcons name={bucketIconForName(bucket.name)} size={18} color={accent.icon} />
        </View>

        <View style={styles.sharedBody}>
          {/* Checkpoint 3F.2A containment fix: only the name/avatars,
              amount, and progress bar are inside the tappable Pressable -
              statusRow is a plain View sibling after it closes, not a
              child of it. Root cause: on React Native Web, a Pressable
              wrapping multiple stacked rows (as the previous single-
              Pressable structure did) does not reliably measure/contain
              all of its children's natural height, the same class of
              intrinsic-layout bug diagnosed for BucketCard/Bucket Detail
              in Checkpoint 3D - splitting trailing content out of the
              Pressable into an ordinary sibling View is the same proven
              fix applied there. */}
          {/* Checkpoint 3F.2C root cause: numberOfLines={1} on the name
              Text below applies react-native-web's "textOneLine" style
              (maxWidth:'100%', overflow:'hidden', whiteSpace:'nowrap') -
              that maxWidth:100% only resolves against a DEFINITE
              ancestor width. This Pressable had no explicit width of its
              own, only an implicit one inherited via flex-stretch, so
              the percentage could resolve against an indeterminate
              ancestor and clip the name to zero visible width - the
              exact reason every OTHER Text on this card (none of which
              use numberOfLines) rendered fine while only the name
              vanished. width:'100%' gives this Pressable a definite
              width to resolve against. */}
          <Pressable
            onPress={() => onOpenBucket(bucket)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${displayName} details`}
            style={styles.pressableFill}
          >
            <View style={styles.sharedTopLine}>
              <Text
                style={[styles.cardTitle, { color: theme.colors.onSurface }]}
                numberOfLines={NAME_NUMBER_OF_LINES}
              >
                {displayName}
              </Text>
              <View style={styles.avatarStack}>
                {topMembers.map((uid, idx) => {
                  const a = avatarForUid(uid);
                  return <AvatarCircle key={uid} index={idx} label={a.label} photoURL={a.photoURL} size={22} />;
                })}
                {extraCount > 0 ? (
                  <View style={[styles.morePill, { backgroundColor: colors.surfaceTertiary }]}>
                    <Text style={styles.morePillText}>+{extraCount}</Text>
                  </View>
                ) : null}
              </View>
            </View>

            <Text style={[styles.amountLine, { color: theme.colors.onSurfaceVariant }]}>
              <Text style={{ color: theme.colors.onSurface, fontWeight: "700" }}>
                {formatCurrency(bucket.balance)}
              </Text>{" "}
              / {formatCurrency(bucket.target)}
            </Text>

            <ProgressBar
              progress={pct}
              style={[styles.progress, { backgroundColor: colors.surfaceTertiary }]}
              color={accent.icon}
            />
          </Pressable>

          <View style={styles.statusRow}>
            {goalReached ? (
              <GoalReachedBadge />
            ) : (
              <Text style={[styles.pctText, { color: theme.colors.onSurfaceVariant }]}>
                {Math.round(pct * 100)}% complete
              </Text>
            )}
            <Text style={[styles.pctText, { color: theme.colors.onSurfaceVariant }]}>
              {memberIds.length} {memberIds.length === 1 ? "member" : "members"}
            </Text>
          </View>
        </View>

        <View style={styles.sharedMenuWrap}>{menu}</View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.compactCard,
        { width, backgroundColor: theme.colors.surface, borderColor: colors.border },
        // Checkpoint 3F.3A.1: an extremely restrained shadow in Light
        // Mode only, so the card reads as gently elevated (matching the
        // approved mockup) rather than leaning entirely on its border.
        // Dark Mode is unchanged - it never had a card shadow here.
        theme.dark ? null : cardShadowFor(false),
      ]}
    >
      <View style={styles.compactTopRow}>
        <View style={[styles.iconBubble, { backgroundColor: accent.pale }]}>
          <MaterialCommunityIcons name={bucketIconForName(bucket.name)} size={18} color={accent.icon} />
        </View>
        {menu}
      </View>

      {/* Checkpoint 3F.2A containment fix: see the identical note on the
          "shared" variant above - name/amount/progress stay inside the
          tappable Pressable, the trailing status/percentage line is a
          sibling View after it, not nested inside it.
          Checkpoint 3F.2C root cause fix: width:'100%' - see the
          identical note on the "shared" variant's Pressable above for
          why the name Text specifically (the only Text using
          numberOfLines here) needs this Pressable to have a definite
          width. */}
      <Pressable
        onPress={() => onOpenBucket(bucket)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${displayName} details`}
        style={styles.pressableFill}
      >
        <Text
          style={[styles.cardTitle, { color: theme.colors.onSurface }]}
          numberOfLines={NAME_NUMBER_OF_LINES}
        >
          {displayName}
        </Text>
        <Text style={[styles.savedAmount, { color: theme.colors.onSurface }]}>
          {formatCurrency(bucket.balance)}
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
          {Math.round(pct * 100)}% · {formatCurrency(remaining)} left
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Checkpoint 3F.2C root cause fix - see the usage sites above.
  pressableFill: { width: "100%" },

  iconBubble: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },

  // compact (Personal Essentials grid)
  compactCard: {
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing.md,
  },
  compactTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  cardTitle: { ...typography.cardTitle, fontSize: 14 },
  savedAmount: { fontSize: 18, fontWeight: "800", marginTop: 2, marginBottom: spacing.xs },
  progress: { height: 6, borderRadius: radii.pill },
  pctText: { ...typography.meta, fontSize: 11, marginTop: spacing.xs },
  menuButton: { margin: 0 },

  // shared (full-width row)
  sharedCard: {
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    padding: spacing.md,
    gap: spacing.sm,
  },
  sharedBody: { flex: 1 },
  sharedTopLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xs,
    gap: spacing.sm,
  },
  amountLine: { fontSize: 13, marginBottom: spacing.sm },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.xs,
  },
  sharedMenuWrap: { marginTop: -spacing.xs },

  avatarStack: { flexDirection: "row", alignItems: "center" },
  morePill: {
    height: 22,
    minWidth: 22,
    paddingHorizontal: 6,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -8,
  },
  morePillText: { fontSize: 10, fontWeight: "800", color: "#FFFFFF" },
});
