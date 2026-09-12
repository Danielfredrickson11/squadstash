// Dedicated Personal Savings Bucket detail screen (Milestone 3
// Checkpoint 3B, transaction history added in Checkpoint 3C).
// Consolidated money actions (3D) and the cohesive visual-polish pass
// (3F) remain deliberately out of scope here.
//
// Bucket live data strategy: reuses subscribeToUserBuckets - the exact
// same trusted, Rules-authorized live query the Bucket list already
// uses - rather than introducing a new single-Bucket read/subscription
// service. Filtering the live list client-side for this bucketId means
// balance/target updates, membership changes, and deletion are all
// reflected automatically (the bucket simply updates or disappears from
// the array), with no new Firestore query surface to reason about.
//
// Transaction history strategy: reuses
// subscribeToSavingsTransactionsForResource (src/services/firebase/
// savingsTransactions.ts) - the existing trusted, resource-scoped,
// createdAt-descending live query - as its own independent subscription
// keyed only on the route's bucketId (not the mutable Bucket object), so
// it neither depends on nor re-subscribes with every Bucket balance
// update. savingsTransactions remains the sole financial source of
// truth; nothing here derives history from Bucket.balance or
// ledgerOpeningBalanceMinor.
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Button, ProgressBar, Text, useTheme } from "react-native-paper";

import { GoalReachedBadge } from "../../../components/buckets/GoalReachedBadge";
import { TransactionRow } from "../../../components/buckets/TransactionRow";
import { useAuth } from "../../../src/contexts/AuthContext";
import { clampProgress, isGoalReached, remainingToGoal } from "../../../src/domain/savingsGoal";
import { useSavingsMoneyAction } from "../../../src/hooks/useSavingsMoneyAction";
import { subscribeToUserBuckets } from "../../../src/services/firebase/buckets";
import { subscribeToSavingsTransactionsForResource } from "../../../src/services/firebase/savingsTransactions";
import type { Bucket, SavingsTransaction } from "../../../src/types/domain";
import { formatCurrency } from "../../../utils/format";

const DEFAULT_ACCENT = "#2563EB";
const MAX_CONTENT_WIDTH = 640;

export default function BucketDetailScreen() {
  const router = useRouter();
  const { bucketId } = useLocalSearchParams<{ bucketId: string }>();
  const { user, loading } = useAuth();
  const theme = useTheme();
  // The same shared Personal Savings money-action controller the Bucket
  // list uses (Milestone 3 Checkpoint 3D) - see
  // src/hooks/useSavingsMoneyAction.tsx. Opening it here launches the
  // identical sheet/mutation, with the same idempotency/serialization
  // state, as opening it from the list.
  const { open: openMoneyAction } = useSavingsMoneyAction();

  const [buckets, setBuckets] = useState<Bucket[]>([]);
  // Distinguishes "still loading the first snapshot" from "loaded, and
  // this bucket genuinely isn't in it" (deleted, or removed as a
  // member) - both render very differently below.
  const [bucketsReady, setBucketsReady] = useState(false);
  // Set only by a genuine subscription/read failure (permissions,
  // network, etc.) - kept distinct from "no matching bucket" so a
  // transient read error is never mistaken for deletion/lost membership
  // (see the render branches below). Cleared on every successful
  // snapshot so a recovered listener doesn't keep showing a stale error.
  const [readError, setReadError] = useState(false);

  // A scalar dependency, not the whole `user` object, so this effect
  // only re-subscribes when the signed-in uid actually changes - not on
  // every AuthContext token refresh (matches the identical pattern in
  // app/(tabs)/buckets/index.tsx's buckets listener).
  const userUid = user?.uid;

  useEffect(() => {
    if (loading) return;
    if (!userUid) return;

    const unsub = subscribeToUserBuckets(
      userUid,
      (next) => {
        setBuckets(next);
        setBucketsReady(true);
        setReadError(false);
      },
      (err) => {
        console.error("Bucket detail snapshot error:", err);
        setBucketsReady(true);
        setReadError(true);
      }
    );

    return () => unsub();
  }, [loading, userUid]);

  const [transactions, setTransactions] = useState<SavingsTransaction[]>([]);
  // Same ready/error distinction as the Bucket subscription above,
  // scoped to the history section only - a transient history read
  // failure must never be presented as "no activity yet" (see the
  // render branches below).
  const [transactionsReady, setTransactionsReady] = useState(false);
  const [transactionsError, setTransactionsError] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!userUid) return;
    if (!bucketId) return;

    setTransactionsReady(false);
    setTransactionsError(false);

    const unsub = subscribeToSavingsTransactionsForResource(
      "bucket",
      bucketId,
      (next) => {
        setTransactions(next);
        setTransactionsReady(true);
        setTransactionsError(false);
      },
      (err) => {
        console.error("Bucket transaction history snapshot error:", err);
        setTransactionsReady(true);
        setTransactionsError(true);
      }
    );

    return () => unsub();
  }, [loading, userUid, bucketId]);

  const bucket = useMemo(
    () => buckets.find((b) => b.id === bucketId) ?? null,
    [buckets, bucketId]
  );

  const isOwner = !!user?.uid && !!bucket?.ownerId && user.uid === bucket.ownerId;

  // Deterministic by design (Checkpoint 3C navigation review fix): the
  // visible Back/Go to Buckets control must always land on the Bucket
  // list, never on whatever happens to be previously in history (e.g.
  // another Bucket's detail screen, or an unrelated prior route) - see
  // the audit note in this file's header. This only affects this
  // explicit control; hardware/browser back and swipe-back gestures are
  // untouched and keep their normal history-based behavior.
  const goBackToBuckets = () => {
    router.replace("/(tabs)/buckets");
  };

  if (loading || !user || (!bucketsReady && !bucket)) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      </SafeAreaView>
    );
  }

  if (!bucket && readError) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        <View style={styles.topBar}>
          <Button
            mode="text"
            icon="arrow-left"
            onPress={goBackToBuckets}
            accessibilityLabel="Back to Buckets"
          >
            Back
          </Button>
        </View>
        <View style={styles.centered}>
          <Text variant="titleMedium" style={{ color: theme.colors.onBackground }}>
            We couldn’t load this bucket right now.
          </Text>
          <Text
            style={[styles.unavailableSub, { color: theme.colors.onSurfaceVariant }]}
          >
            Please try again or return to Buckets.
          </Text>
          <View style={{ height: 16 }} />
          <Button mode="contained" onPress={goBackToBuckets}>
            Go to Buckets
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  if (!bucket) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        <View style={styles.topBar}>
          <Button
            mode="text"
            icon="arrow-left"
            onPress={goBackToBuckets}
            accessibilityLabel="Back to Buckets"
          >
            Back
          </Button>
        </View>
        <View style={styles.centered}>
          <Text variant="titleMedium" style={{ color: theme.colors.onBackground }}>
            This bucket is no longer available.
          </Text>
          <Text
            style={[styles.unavailableSub, { color: theme.colors.onSurfaceVariant }]}
          >
            It may have been deleted, or you may no longer be a member.
          </Text>
          <View style={{ height: 16 }} />
          <Button mode="contained" onPress={goBackToBuckets}>
            Go to Buckets
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  const accent = bucket.color ?? DEFAULT_ACCENT;
  const displayName = bucket.name?.trim() ? bucket.name.trim() : "Untitled";
  const pct = clampProgress(bucket.balance, bucket.target);
  const remaining = remainingToGoal(bucket.balance, bucket.target);
  const goalReached = isGoalReached(bucket.balance, bucket.target);
  const memberCount = bucket.memberIds?.length ?? 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <View style={styles.topBar}>
        <Button
          mode="text"
          icon="arrow-left"
          onPress={goBackToBuckets}
          accessibilityLabel="Back to Buckets"
        >
          Back
        </Button>
      </View>

      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.contentWrap}>
          {/* A. Bucket identity */}
          <View style={styles.identityRow}>
            <View style={[styles.iconBubble, { backgroundColor: `${accent}22` }]}>
              <MaterialCommunityIcons name="bullseye-arrow" size={28} color={accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text
                style={[styles.eyebrow, { color: theme.colors.onSurfaceVariant }]}
              >
                Personal Savings Goal
              </Text>
              <Text
                style={[styles.nameText, { color: theme.colors.onSurface }]}
                numberOfLines={2}
              >
                {displayName}
              </Text>
            </View>
          </View>

          {/* B. Financial summary */}
          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant },
            ]}
          >
            <Text style={[styles.cardLabel, { color: theme.colors.onSurfaceVariant }]}>
              Saved
            </Text>
            <View style={styles.amountRow}>
              <Text style={[styles.bigAmount, { color: theme.colors.onSurface }]}>
                {formatCurrency(bucket.balance)}
              </Text>
              <Text style={[styles.ofAmount, { color: theme.colors.onSurfaceVariant }]}>
                {" "}
                / {formatCurrency(bucket.target)} target
              </Text>
            </View>

            {/* Wrapped in a plain View so Paper's third-party ProgressBar
                participates in this card's layout through a normal RN
                View boundary before the sibling rows that follow it
                (Checkpoint 3D progress containment fix). */}
            <View style={styles.progressContainer}>
              <ProgressBar
                progress={pct}
                style={[styles.progress, { backgroundColor: theme.colors.surfaceVariant }]}
                color={accent}
              />
            </View>

            {/* Checkpoint 3D detail footer fix: one concrete normal-flow
                child holding the status/remaining and action rows, so
                the financial card's own natural height is derived from
                a single, direct child rather than several loose
                siblings after the progress bar. */}
            <View style={styles.financialFooter}>
              <View style={styles.summaryRow}>
                {goalReached ? (
                  <GoalReachedBadge />
                ) : (
                  <Text
                    style={[styles.summaryText, { color: theme.colors.onSurfaceVariant }]}
                    numberOfLines={1}
                  >
                    {Math.round(pct * 100)}% complete
                  </Text>
                )}
                <Text
                  style={[styles.summaryText, styles.remainingText, { color: theme.colors.onSurfaceVariant }]}
                  numberOfLines={1}
                >
                  {formatCurrency(remaining)} remaining
                </Text>
              </View>

              {/* Both buttons open the single shared money-action sheet
                  (Milestone 3 Checkpoint 3D) pre-set to the corresponding
                  type - the trusted mutation itself lives entirely in
                  useSavingsMoneyAction(), identical to the Bucket list's
                  entry points. */}
              <View style={styles.actionsRow}>
                {/* Checkpoint 3F.2A transitional cleanup: mode=
                    "contained-tonal" previously read as lavender because
                    MD3's secondaryContainer is auto-derived from this
                    app's `secondary` seed color (violet, see
                    src/theme/appTheme.ts), which was never remapped;
                    buttonColor bypasses that derivation for a clean
                    mint primary action instead. */}
                <Button
                  mode="contained"
                  buttonColor={theme.colors.primary}
                  textColor={theme.colors.onPrimary}
                  onPress={() => openMoneyAction(bucket, "contribution")}
                  style={styles.actionBtn}
                >
                  Add Money
                </Button>
                {/* mode="outlined" defaults its TEXT color to
                    theme.colors.primary (mint) even though its border
                    already defaults to the neutral theme.colors.outline
                    - overriding textColor makes this read as a genuinely
                    neutral secondary action next to the mint primary
                    one. */}
                <Button
                  mode="outlined"
                  textColor={theme.colors.onSurfaceVariant}
                  onPress={() => openMoneyAction(bucket, "withdrawal")}
                  style={styles.actionBtn}
                >
                  Withdraw
                </Button>
              </View>
            </View>
          </View>

          {/* Activity / Savings History - reads savingsTransactions
              only; never fabricates a row from Bucket.balance or
              ledgerOpeningBalanceMinor (see the file header comment). */}
          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant },
            ]}
          >
            <Text style={[styles.cardLabel, { color: theme.colors.onSurfaceVariant }]}>
              Activity
            </Text>

            {!transactionsReady ? (
              <View style={styles.historyLoading}>
                <ActivityIndicator />
              </View>
            ) : transactionsError ? (
              <View style={styles.historyMessage}>
                <Text style={{ color: theme.colors.onSurface }}>
                  We couldn’t load this bucket’s activity right now.
                </Text>
                <Text
                  style={[styles.historyMessageSub, { color: theme.colors.onSurfaceVariant }]}
                >
                  Please try again later.
                </Text>
              </View>
            ) : transactions.length === 0 ? (
              <View style={styles.historyMessage}>
                <Text style={{ color: theme.colors.onSurface }}>No savings activity yet.</Text>
                <Text
                  style={[styles.historyMessageSub, { color: theme.colors.onSurfaceVariant }]}
                >
                  Contributions and withdrawals will appear here.
                </Text>
              </View>
            ) : (
              transactions.map((transaction) => (
                <TransactionRow key={transaction.id} transaction={transaction} />
              ))
            )}
          </View>

          {/* C. Supporting context */}
          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant },
            ]}
          >
            <Text style={[styles.cardLabel, { color: theme.colors.onSurfaceVariant }]}>
              Members
            </Text>
            <Text style={[styles.contextValue, { color: theme.colors.onSurface }]}>
              {memberCount} {memberCount === 1 ? "member" : "members"}
            </Text>
            <Text style={[styles.contextSub, { color: theme.colors.onSurfaceVariant }]}>
              {isOwner
                ? "You own this bucket."
                : "You're a member of this bucket."}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  topBar: {
    paddingHorizontal: 8,
    paddingTop: 4,
    flexDirection: "row",
    alignItems: "center",
  },

  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  unavailableSub: {
    marginTop: 8,
    textAlign: "center",
  },

  page: {
    padding: 16,
    paddingBottom: 40,
    alignItems: "center",
  },
  // Caps goal content at a sensible reading width on wide/desktop
  // screens rather than stretching a single-column summary across the
  // entire viewport - a small, centered composition, not a new layout
  // system.
  contentWrap: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },

  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 20,
  },
  iconBubble: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  nameText: {
    fontSize: 24,
    fontWeight: "900",
  },

  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    marginBottom: 16,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 8,
  },

  amountRow: {
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    marginBottom: 14,
  },
  bigAmount: { fontSize: 32, fontWeight: "900" },
  ofAmount: { fontSize: 14, fontWeight: "700" },

  progress: { height: 10, borderRadius: 10 },

  // Checkpoint 3D progress containment fix: wraps Paper's ProgressBar in
  // a plain RN View boundary. Content-driven only - no fixed height.
  progressContainer: {
    width: "100%",
  },

  // Checkpoint 3D detail footer fix: single normal-flow wrapper for the
  // status/remaining and action rows, owning the vertical spacing below
  // the progress bar so the two rows inside it don't each need their own
  // marginTop.
  financialFooter: {
    width: "100%",
    marginTop: 12,
    gap: 16,
  },

  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  summaryText: { fontSize: 13, fontWeight: "700" },
  // Allows the remaining-amount text to shrink and truncate rather than
  // force the row wider than the card (Checkpoint 3D goal-layout review)
  // - a defensive safeguard for long currency strings.
  remainingText: {
    flexShrink: 1,
    textAlign: "right",
  },

  actionsRow: {
    flexDirection: "row",
    gap: 10,
  },
  actionBtn: { flex: 1, borderRadius: 12 },

  historyLoading: {
    paddingVertical: 20,
    alignItems: "center",
  },
  historyMessage: {
    paddingVertical: 12,
  },
  historyMessageSub: {
    fontSize: 13,
    marginTop: 4,
  },

  contextValue: { fontSize: 18, fontWeight: "800", marginBottom: 4 },
  contextSub: { fontSize: 13 },
});
