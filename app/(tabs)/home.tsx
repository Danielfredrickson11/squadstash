import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { Button, Card, Divider, ProgressBar, Text } from "react-native-paper";
import { RecentActivityRow } from "../../components/home/RecentActivityRow";
import { useAuth } from "../../src/contexts/AuthContext";
import { mergeRecentSavingsTransactions } from "../../src/domain/recentSavingsActivity";
import { subscribeToUserBuckets } from "../../src/services/firebase/buckets";
import { subscribeToRecentSavingsTransactionsForResource } from "../../src/services/firebase/savingsTransactions";
import type { SavingsTransaction } from "../../src/types/domain";
import { formatCurrency } from "../../utils/format";

type MiniBucket = {
  id: string;
  name: string;
  balance: number;
  target: number;
};

// Home's Recent Activity shows only the newest few transactions across
// all of the user's Personal Savings buckets (Milestone 3 Checkpoint
// 3E) - never a bucket's full history, which remains Bucket Detail's
// job via the separate, unbounded subscribeToSavingsTransactionsForResource.
const RECENT_ACTIVITY_LIMIT = 5;

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
}) {
  return (
    <Card style={styles.statCard}>
      <Card.Content style={styles.statCardContent}>
        <View style={styles.statIconBubble}>
          <MaterialCommunityIcons name={icon} size={18} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.statLabel}>{label}</Text>
          <Text style={styles.statValue}>{value}</Text>
        </View>
      </Card.Content>
    </Card>
  );
}

export default function HomeScreen() {
  const { user } = useAuth();

  const displayName =
    user?.displayName || (user?.email ? user.email.split("@")[0] : "Guest");

  const [buckets, setBuckets] = useState<MiniBucket[]>([]);
  // Distinguishes "haven't received the first subscribeToUserBuckets
  // snapshot yet" from "received one, and it happens to be empty" - the
  // Recent Activity readiness below (and this state's own honest loading
  // treatment) depends on that distinction (Checkpoint 3E lifecycle fix).
  const [bucketsReady, setBucketsReady] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const firstLoad = useRef(true);

  useEffect(() => {
    // A user transition (sign-out/sign-in within the same session) must
    // never leave the previous user's buckets or derived Recent Activity
    // state visible while the new subscription spins up.
    setBuckets([]);
    setBucketsReady(false);

    if (!user) return;

    // ✅ shared buckets query (memberIds contains my uid)
    const unsub = subscribeToUserBuckets(user.uid, (next) => {
      const list: MiniBucket[] = next.map((b) => ({
        id: b.id,
        name: String(b.name ?? "Untitled"),
        balance: b.balance,
        target: b.target,
      }));

      setBuckets(list);
      setBucketsReady(true);

      // "Last updated" (skip first render)
      if (!firstLoad.current) setLastUpdated(new Date());
      firstLoad.current = false;
    });

    return () => unsub();
  }, [user]);

  // Stable bucket-id identity (Checkpoint 3E lifecycle fix): changes only
  // when the actual set of bucket ids changes, not on every balance/name
  // update subscribeToUserBuckets otherwise re-delivers. The Recent
  // Activity listener effect below depends on this, not on `buckets`
  // itself, so an Add Money/Withdraw balance change never tears down and
  // rebuilds every per-bucket Recent Activity listener.
  const bucketIdsKey = useMemo(
    () => JSON.stringify(buckets.map((b) => b.id).sort()),
    [buckets]
  );
  const bucketIds = useMemo<string[]>(() => JSON.parse(bucketIdsKey), [bucketIdsKey]);

  // Bounded fan-out (Milestone 3 Checkpoint 3E): one
  // subscribeToRecentSavingsTransactionsForResource(..., RECENT_ACTIVITY_LIMIT)
  // listener per current bucket id, never the full-history subscription
  // Bucket Detail uses.
  const [recentByBucket, setRecentByBucket] = useState<Record<string, SavingsTransaction[]>>({});
  const [recentReadyByBucket, setRecentReadyByBucket] = useState<Record<string, boolean>>({});
  const [recentErrorByBucket, setRecentErrorByBucket] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // Cleared unconditionally whenever bucketIds genuinely changes
    // (membership, not balance) - a removed bucket's entry in any of
    // these three maps can never survive past this point, even before
    // its own subscription cleanup below runs.
    setRecentByBucket({});
    setRecentReadyByBucket({});
    setRecentErrorByBucket({});

    if (bucketIds.length === 0) return;

    const unsubs = bucketIds.map((bucketId) =>
      subscribeToRecentSavingsTransactionsForResource(
        "bucket",
        bucketId,
        RECENT_ACTIVITY_LIMIT,
        (transactions) => {
          setRecentByBucket((prev) => ({ ...prev, [bucketId]: transactions }));
          setRecentReadyByBucket((prev) => ({ ...prev, [bucketId]: true }));
          setRecentErrorByBucket((prev) => ({ ...prev, [bucketId]: false }));
        },
        (err) => {
          console.error("Home recent activity snapshot error:", err);
          setRecentReadyByBucket((prev) => ({ ...prev, [bucketId]: true }));
          setRecentErrorByBucket((prev) => ({ ...prev, [bucketId]: true }));
        }
      )
    );

    return () => unsubs.forEach((unsub) => unsub());
  }, [bucketIds]);

  const bucketNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const b of buckets) map[b.id] = b.name;
    return map;
  }, [buckets]);

  // Both derived from bucketIds only (never Object.values/keys of the
  // per-bucket maps directly), so a stale key left behind by a future
  // lifecycle bug still can't reach the UI (Checkpoint 3E lifecycle fix).
  const recentActivityReady =
    bucketsReady &&
    (bucketIds.length === 0 || bucketIds.every((id) => recentReadyByBucket[id]));
  const recentActivityHasError = bucketIds.some((id) => recentErrorByBucket[id]);

  const recentActivity = useMemo(
    () =>
      mergeRecentSavingsTransactions(
        bucketIds.map((id) => recentByBucket[id] ?? []),
        RECENT_ACTIVITY_LIMIT
      ),
    [bucketIds, recentByBucket]
  );

  const totals = useMemo(() => {
    const totalSaved = buckets.reduce(
      (sum, b) => sum + (Number(b.balance) || 0),
      0
    );
    const totalGoals = buckets.reduce(
      (sum, b) => sum + (Number(b.target) || 0),
      0
    );
    const remaining = Math.max(totalGoals - totalSaved, 0);
    const progress = totalGoals > 0 ? Math.min(totalSaved / totalGoals, 1) : 0;

    const activeGoals = buckets.filter((b) => (b.target || 0) > 0).length;

    // Top buckets by progress %, then by balance
    const topBuckets = [...buckets]
      .sort((a, b) => {
        const ap = a.target > 0 ? a.balance / a.target : 0;
        const bp = b.target > 0 ? b.balance / b.target : 0;
        if (bp !== ap) return bp - ap;
        return (b.balance || 0) - (a.balance || 0);
      })
      .slice(0, 3);

    return {
      totalSaved,
      totalGoals,
      remaining,
      progress,
      activeGoals,
      topBuckets,
    };
  }, [buckets]);

  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdated) return "Last updated: —";
    return `Last updated: ${lastUpdated.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }, [lastUpdated]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text variant="titleLarge" style={styles.title}>
            Financial Overview
          </Text>
          <Text style={styles.subtitle}>Welcome back, {displayName}.</Text>
        </View>
        <Text style={styles.lastUpdated}>{lastUpdatedLabel}</Text>
      </View>

      {/* Stat cards */}
      <View style={styles.statsGrid}>
        <StatCard
          label="Personal Savings"
          value={formatCurrency(totals.totalSaved)}
          icon="bank-outline"
        />
        <StatCard
          label="Goal Total"
          value={formatCurrency(totals.totalGoals)}
          icon="target"
        />
        <StatCard
          label="Remaining"
          value={formatCurrency(totals.remaining)}
          icon="progress-clock"
        />
        <StatCard
          label="Active Goals"
          value={`${totals.activeGoals}`}
          icon="flag-outline"
        />
      </View>

      {/* Quick actions */}
      <Card style={styles.sectionCard}>
        <Card.Content>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.actionsRow}>
            <Button
              mode="contained"
              icon="plus"
              onPress={() => router.push("/(tabs)/buckets")}
              style={styles.actionBtn}
            >
              Buckets
            </Button>
            <Button
              mode="outlined"
              icon="airplane"
              onPress={() => router.push("/(tabs)/trips")}
              style={styles.actionBtn}
            >
              Trips
            </Button>
          </View>
        </Card.Content>
      </Card>

      {/* Overall progress */}
      <Card style={styles.sectionCard}>
        <Card.Content>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Overall Progress</Text>
            <Text style={styles.muted}>{Math.round(totals.progress * 100)}%</Text>
          </View>
          <Text style={styles.muted}>
            {formatCurrency(totals.totalSaved)} / {formatCurrency(totals.totalGoals)}
          </Text>
          <View style={{ height: 10 }} />
          <ProgressBar progress={totals.progress} style={styles.progressBar} />
        </Card.Content>
      </Card>

      {/* Top buckets */}
      <Card style={styles.sectionCard}>
        <Card.Content>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Top Buckets</Text>
            <Button compact onPress={() => router.push("/(tabs)/buckets")}>
              View all
            </Button>
          </View>

          {totals.topBuckets.length === 0 ? (
            <Text style={styles.muted}>
              No buckets yet. Create one to get started.
            </Text>
          ) : (
            totals.topBuckets.map((b, idx) => {
              const pct = b.target > 0 ? Math.min(b.balance / b.target, 1) : 0;
              const left = Math.max(b.target - b.balance, 0);

              return (
                <View key={`${b.name}-${idx}`} style={styles.bucketRow}>
                  <View style={styles.bucketTopLine}>
                    <Text style={styles.bucketName}>{b.name}</Text>
                    <Text style={styles.muted}>{Math.round(pct * 100)}%</Text>
                  </View>

                  <Text style={styles.bucketSub}>
                    {formatCurrency(b.balance)} / {formatCurrency(b.target)} •{" "}
                    {formatCurrency(left)} left
                  </Text>

                  <ProgressBar progress={pct} style={styles.bucketProgress} />
                  <Divider style={{ marginTop: 14 }} />
                </View>
              );
            })
          )}

          <View style={{ height: 8 }} />
          <Button mode="contained" onPress={() => router.push("/(tabs)/buckets")}>
            Add / Edit Buckets
          </Button>
        </Card.Content>
      </Card>

      {/* Recent activity (Milestone 3 Checkpoint 3E): real
          savingsTransactions data only, bounded to the newest 5 across
          all current buckets - see mergeRecentSavingsTransactions and
          subscribeToRecentSavingsTransactionsForResource. */}
      <Card style={styles.sectionCard}>
        <Card.Content>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Recent Activity</Text>
          </View>

          {!recentActivityReady ? (
            <View style={styles.activityLoading}>
              <ActivityIndicator />
            </View>
          ) : recentActivityHasError ? (
            <Text style={styles.muted}>
              We couldn’t load recent activity right now.
            </Text>
          ) : recentActivity.length === 0 ? (
            <Text style={styles.muted}>No savings activity yet.</Text>
          ) : (
            recentActivity.map((transaction) => (
              <RecentActivityRow
                key={transaction.id}
                transaction={transaction}
                bucketName={bucketNameById[transaction.resourceId] ?? "Untitled"}
              />
            ))
          )}
        </Card.Content>
      </Card>

      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F6F7FB" },
  content: { padding: 16 },

  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 14,
    gap: 12,
  },
  title: { fontWeight: "800" },
  subtitle: { marginTop: 4, opacity: 0.7 },
  lastUpdated: { opacity: 0.6, marginTop: 6 },

  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 12,
  },
  statCard: {
    width: "48%",
    borderRadius: 14,
  },
  statCardContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statIconBubble: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.06)",
  },
  statLabel: { opacity: 0.7, marginBottom: 4 },
  statValue: { fontWeight: "900", fontSize: 18 },

  sectionCard: {
    borderRadius: 14,
    marginBottom: 12,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  sectionTitle: { fontWeight: "800", fontSize: 16 },
  muted: { opacity: 0.7 },

  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 10,
  },
  actionBtn: { flexGrow: 1 },

  progressBar: { height: 10, borderRadius: 8 },

  bucketRow: { paddingVertical: 10 },
  bucketTopLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  bucketName: { fontWeight: "800", fontSize: 16 },
  bucketSub: { opacity: 0.7, marginTop: 4 },
  bucketProgress: { height: 8, borderRadius: 8, marginTop: 10 },

  activityLoading: {
    paddingVertical: 16,
    alignItems: "center",
  },
});
