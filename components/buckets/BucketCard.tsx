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
import { Text as RNText, StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  IconButton,
  Menu,
  ProgressBar,
  Text,
  useTheme,
} from "react-native-paper";

import type { Bucket, SavingsTransactionType } from "../../src/types/domain";
import { formatCurrency } from "../../utils/format";
import { AvatarCircle } from "./AvatarCircle";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(n, max));
}

export type BucketCardProps = {
  bucket: Bucket;
  isOwner: boolean;
  isMenuOpen: boolean;
  quickAddSubmittingId: string | null;
  avatarForUid: (uid: string) => { label: string; photoURL: string };
  onOpenMembers: (bucket: Bucket) => void;
  onOpenMenu: (bucketId: string) => void;
  onCloseMenu: () => void;
  onEdit: (bucket: Bucket) => void;
  onDelete: (bucket: Bucket) => void;
  onQuickAdd: (bucket: Bucket, amountMinor: number) => void;
  onOpenMoneyDialog: (bucket: Bucket, type: SavingsTransactionType) => void;
};

const DEFAULT_ACCENT = "#2563EB";

export function BucketCard({
  bucket,
  isOwner,
  isMenuOpen,
  quickAddSubmittingId,
  avatarForUid,
  onOpenMembers,
  onOpenMenu,
  onCloseMenu,
  onEdit,
  onDelete,
  onQuickAdd,
  onOpenMoneyDialog,
}: BucketCardProps) {
  const theme = useTheme();

  // Bucket.color is product data, not theme chrome - a user's chosen
  // accent must keep identifying their Bucket regardless of the app
  // theme, so it is deliberately never replaced by a theme token here.
  const accent = bucket.color ?? DEFAULT_ACCENT;
  const pct = bucket.target > 0 ? clamp(bucket.balance / bucket.target, 0, 1) : 0;
  const displayName = bucket.name?.trim() ? bucket.name.trim() : "Untitled";

  const memberIds = bucket.memberIds ?? [];
  const topMembers = memberIds.slice(0, 3);
  const extraCount = Math.max(0, memberIds.length - topMembers.length);

  const quickAddLoading = quickAddSubmittingId === bucket.id;
  const quickAddDisabled = quickAddSubmittingId !== null;

  return (
    <Card
      style={[styles.card, { backgroundColor: theme.colors.surface }]}
      mode="elevated"
    >
      <Card.Content>
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

        <View style={styles.completedRow}>
          <Text style={[styles.muted, { color: theme.colors.onSurfaceVariant }]}>
            {Math.round(pct * 100)}% Completed
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

            Quick-add is serialized across ALL buckets (not just this
            one) by the parent screen: disabled is keyed off
            quickAddSubmittingId !== null so a second bucket's quick-add
            cannot start - and race - while another bucket's request is
            still in flight. loading stays scoped to the bucket actually
            submitting. */}
        <View style={styles.quickRow}>
          <Button
            mode="outlined"
            onPress={() => onQuickAdd(bucket, 5000)}
            style={styles.quickBtn}
            compact
            loading={quickAddLoading}
            disabled={quickAddDisabled}
          >
            + {formatCurrency(50)}
          </Button>
          <Button
            mode="outlined"
            onPress={() => onQuickAdd(bucket, 10000)}
            style={styles.quickBtn}
            compact
            loading={quickAddLoading}
            disabled={quickAddDisabled}
          >
            + {formatCurrency(100)}
          </Button>
        </View>

        <View style={styles.moneyActionsRow}>
          <Button
            mode="text"
            compact
            onPress={() => onOpenMoneyDialog(bucket, "contribution")}
            disabled={quickAddDisabled}
          >
            Custom Amount
          </Button>
          <Button
            mode="text"
            compact
            onPress={() => onOpenMoneyDialog(bucket, "withdrawal")}
            disabled={quickAddDisabled}
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
    flex: 1,
    borderRadius: 16,
    marginBottom: GAP,
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

  completedRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 10,
    marginBottom: 12,
  },
  muted: {},

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

  quickRow: { flexDirection: "row", gap: 10 },
  quickBtn: { flex: 1, borderRadius: 12 },
  moneyActionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
});
