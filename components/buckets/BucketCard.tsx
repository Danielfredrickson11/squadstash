// Presentational Bucket list-card, extracted from
// app/(tabs)/buckets.tsx's renderItem (Milestone 3 Checkpoint 3A) with no
// behavior change. This component owns presentation and the directly-
// associated interaction affordances (menu open/close, tapping a quick-
// add/custom/withdraw control) only - it never calls Firebase directly.
// Every actual mutation (recordSavingsTransaction, updateBucket,
// deleteBucket, member management) stays owned by the screen and is
// invoked here only via the callback props below, matching the project's
// existing convention of keeping service calls out of presentational
// components.
import { MaterialCommunityIcons } from "@expo/vector-icons";
import React from "react";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  IconButton,
  Menu,
  ProgressBar,
  Text,
  useTheme,
} from "react-native-paper";

import { clampProgress, isGoalReached, remainingToGoal } from "../../src/domain/savingsGoal";
import type { Bucket, SavingsTransactionType } from "../../src/types/domain";
import { formatCurrency } from "../../utils/format";
import { AvatarCircle } from "./AvatarCircle";
import { GoalReachedBadge } from "./GoalReachedBadge";

export type BucketCardProps = {
  bucket: Bucket;
  isOwner: boolean;
  isMenuOpen: boolean;
  // Explicit pixel width for this card (Checkpoint 3D goal-layout fix) -
  // computed by the list screen from the current viewport and column
  // count, mirroring app/(tabs)/trips/index.tsx's proven cardWidth
  // pattern exactly. Replaces the previous flex:1 card sizing: flex:1 is
  // only meaningful for equal-width sharing inside a bounded
  // columnWrapperStyle row (numColumns > 1) - when numColumns is 1,
  // FlatList renders each card as a direct item of its own vertically
  // SCROLLING (effectively unbounded-height) column, where flex-grow has
  // no well-defined natural-content meaning and is a known React Native
  // anti-pattern for list items. An explicit width sidesteps the
  // ambiguity in both cases.
  cardWidth: number;
  avatarForUid: (uid: string) => { label: string; photoURL: string };
  onOpenBucket: (bucket: Bucket) => void;
  onOpenMembers: (bucket: Bucket) => void;
  onOpenMenu: (bucketId: string) => void;
  onCloseMenu: () => void;
  onEdit: (bucket: Bucket) => void;
  onDelete: (bucket: Bucket) => void;
  // Opens the shared Personal Savings money-action sheet (Milestone 3
  // Checkpoint 3D) pre-set to the given type - the trusted mutation
  // itself lives in useSavingsMoneyAction(), never in this presentational
  // component. Replaces the pre-3D onQuickAdd/onOpenMoneyDialog pair.
  onOpenMoneyAction: (bucket: Bucket, type: SavingsTransactionType) => void;
};

const DEFAULT_ACCENT = "#2563EB";

export function BucketCard({
  bucket,
  isOwner,
  isMenuOpen,
  cardWidth,
  avatarForUid,
  onOpenBucket,
  onOpenMembers,
  onOpenMenu,
  onCloseMenu,
  onEdit,
  onDelete,
  onOpenMoneyAction,
}: BucketCardProps) {
  const theme = useTheme();

  // Bucket.color is product data, not theme chrome - a user's chosen
  // accent must keep identifying their Bucket regardless of the app
  // theme, so it is deliberately never replaced by a theme token here.
  const accent = bucket.color ?? DEFAULT_ACCENT;
  const pct = clampProgress(bucket.balance, bucket.target);
  const goalReached = isGoalReached(bucket.balance, bucket.target);
  const remaining = remainingToGoal(bucket.balance, bucket.target);
  const displayName = bucket.name?.trim() ? bucket.name.trim() : "Untitled";

  const memberIds = bucket.memberIds ?? [];
  const topMembers = memberIds.slice(0, 3);
  const extraCount = Math.max(0, memberIds.length - topMembers.length);

  return (
    <Card
      style={[styles.card, { width: cardWidth, backgroundColor: theme.colors.surface }]}
      mode="elevated"
    >
      <Card.Content style={styles.cardContentFix}>
        <View style={styles.cardTopRow}>
          <View style={[styles.iconBubble, { backgroundColor: `${accent}22` }]}>
            <MaterialCommunityIcons name="bullseye-arrow" size={20} color={accent} />
          </View>

          <View style={styles.memberCluster}>
            <Button
              compact
              mode="text"
              onPress={() => onOpenMembers(bucket)}
              style={{ paddingHorizontal: 0 }}
              contentStyle={{ flexDirection: "row" }}
              accessibilityLabel="View bucket members"
            >
              <View style={styles.avatarStack}>
                {topMembers.map((uid, idx) => {
                  const a = avatarForUid(uid);
                  return (
                    <AvatarCircle
                      key={uid}
                      index={idx}
                      label={a.label}
                      photoURL={a.photoURL}
                    />
                  );
                })}

                {extraCount > 0 ? (
                  <View
                    style={[
                      styles.morePill,
                      {
                        marginLeft: -10,
                        backgroundColor: theme.colors.primaryContainer,
                      },
                    ]}
                  >
                    <RNText
                      style={{
                        fontSize: 11,
                        fontWeight: "800",
                        color: theme.colors.onPrimaryContainer,
                      }}
                    >
                      +{extraCount}
                    </RNText>
                  </View>
                ) : null}
              </View>
            </Button>

            <Menu
              visible={isMenuOpen}
              onDismiss={onCloseMenu}
              anchor={
                <IconButton
                  icon="dots-horizontal"
                  size={20}
                  onPress={() => onOpenMenu(bucket.id)}
                  accessibilityLabel="Bucket options"
                />
              }
            >
              <Menu.Item title="Members" onPress={() => onOpenMembers(bucket)} />
              <Menu.Item title="Edit" onPress={() => onEdit(bucket)} />
              <Menu.Item
                title="Delete"
                onPress={() => onDelete(bucket)}
                disabled={!isOwner}
              />
            </Menu>
          </View>
        </View>

        {/* Only the name/amount/progress identity block is tappable to
            open the Bucket detail screen (Milestone 3 Checkpoint 3B).
            completedRow, memberMetaRow, and moneyActionsRow are
            deliberately Card.Content siblings, not children, of this
            Pressable (Checkpoint 3D runtime containment fix) - their
            content must never be measured as part of the navigation
            target's own layout box, and tapping them can never also
            trigger navigation (no event-bubbling ambiguity to manage, on
            any platform). */}
        <Pressable
          onPress={() => onOpenBucket(bucket)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${displayName} details`}
        >
          <View style={styles.nameWrap}>
            <RNText
              style={[styles.bucketNameText, { color: theme.colors.onSurface }]}
              numberOfLines={1}
            >
              {displayName}
            </RNText>
          </View>

          <View style={styles.amountRow}>
            <Text style={styles.bigAmount}>{formatCurrency(bucket.balance)}</Text>
            <Text style={[styles.ofAmount, { color: theme.colors.onSurfaceVariant }]}>
              {" "}
              / {formatCurrency(bucket.target)}
            </Text>
          </View>

          <ProgressBar
            progress={pct}
            style={[styles.progress, { backgroundColor: theme.colors.surfaceVariant }]}
            color={accent}
          />
        </Pressable>

        <View style={styles.completedRow}>
          {goalReached ? (
            <GoalReachedBadge />
          ) : (
            <Text
              style={[styles.muted, { color: theme.colors.onSurfaceVariant }]}
              numberOfLines={1}
            >
              {Math.round(pct * 100)}% Completed
            </Text>
          )}
          <Text
            style={[styles.muted, styles.remainingText, { color: theme.colors.onSurfaceVariant }]}
            numberOfLines={1}
          >
            {formatCurrency(remaining)} remaining
          </Text>
        </View>

        <View style={styles.memberMetaRow}>
          <Text style={[styles.muted, { color: theme.colors.onSurfaceVariant }]}>
            Members: {bucket.memberIds?.length ?? 0}
            {isOwner ? " • You’re owner" : ""}
          </Text>
        </View>

        {/* Every current member of this bucket may record their own
            contribution/withdrawal - the list this card renders from is
            already scoped to buckets the signed-in user is a member of
            (subscribeToUserBuckets queries memberIds array-contains
            uid), so no additional owner check is needed here. The
            trusted recordSavingsTransaction callable is the
            authoritative permission check regardless.

            Both buttons open the single shared money-action sheet
            (Milestone 3 Checkpoint 3D) pre-set to the corresponding type
            - see onOpenMoneyAction/useSavingsMoneyAction. Because the
            sheet is a modal, there is no need to disable other Buckets'
            buttons while one submission is in flight the way the pre-3D
            quick-add row needed to - the modal itself blocks interaction
            with the rest of the list while open. */}
        <View style={styles.moneyActionsRow}>
          <Button
            mode="contained-tonal"
            compact
            onPress={() => onOpenMoneyAction(bucket, "contribution")}
            style={styles.moneyBtn}
            accessibilityLabel={`Add money to ${displayName}`}
          >
            Add Money
          </Button>
          <Button
            mode="outlined"
            compact
            onPress={() => onOpenMoneyAction(bucket, "withdrawal")}
            style={styles.moneyBtn}
            accessibilityLabel={`Withdraw from ${displayName}`}
          >
            Withdraw
          </Button>
        </View>
      </Card.Content>
    </Card>
  );
}

const GAP = 12;

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    marginBottom: GAP,
    // Checkpoint 3D runtime containment fix: runtime evidence showed this
    // Card's own measured height ending short of its mounted content
    // (completedRow/memberMetaRow/moneyActionsRow painting past the
    // card's boundary and overlapping the next FlatList row). flexShrink
    // defaults to 1 on any flex item; in the numColumns>1 columnWrapperStyle
    // row, this Card is a row-flex item, so without an explicit override
    // it is eligible to be shrunk below its own content's natural size.
    // Pinning flexShrink:0 here (and on Card.Content below) ensures this
    // Card's measured height always includes every mounted child.
    flexShrink: 0,
  },

  cardTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  iconBubble: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },

  nameWrap: {
    minHeight: 26,
    justifyContent: "center",
    marginBottom: 8,
  },
  bucketNameText: {
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 22,
    flexShrink: 1,
  },

  amountRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginBottom: 10,
  },
  bigAmount: { fontWeight: "900", fontSize: 22 },
  ofAmount: {},

  progress: {
    height: 10,
    borderRadius: 10,
  },

  // Checkpoint 3D runtime containment fix: Card.Content is the direct
  // parent whose measured height must include the Pressable identity
  // block plus completedRow/memberMetaRow/moneyActionsRow. See the note
  // on `card` above for why an explicit flexShrink override is needed
  // rather than relying on the flexbox default.
  cardContentFix: { flexShrink: 0 },

  completedRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 10,
    marginBottom: 12,
    gap: 8,
  },
  muted: {},
  // Allows the remaining-amount text to shrink and truncate rather than
  // force the row (and therefore the card) to grow wider than cardWidth
  // for a long currency string - a defensive safeguard independent of
  // the cardWidth fix above (Checkpoint 3D goal-layout review).
  remainingText: {
    flexShrink: 1,
    textAlign: "right",
  },

  memberMetaRow: { marginBottom: 10 },

  memberCluster: { flexDirection: "row", alignItems: "center", gap: 6 },
  avatarStack: { flexDirection: "row", alignItems: "center" },
  morePill: {
    height: 26,
    paddingHorizontal: 8,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },

  moneyActionsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  moneyBtn: { flex: 1, borderRadius: 12 },
});
