import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import {
  collection,
  DocumentData,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Card, Divider, ProgressBar, Text } from "react-native-paper";
import { db } from "../../firebase";
import { useAuth } from "../../src/contexts/AuthContext";
import { formatCurrency } from "../../utils/format";

type MiniBucket = {
  name: string;
  balance: number;
  target: number;
};

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
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const firstLoad = useRef(true);

  useEffect(() => {
    if (!user) return;

    // ✅ NEW: shared buckets query (memberIds contains my uid)
    const qRef = query(
      collection(db, "buckets"),
      where("memberIds", "array-contains", user.uid),
      orderBy("createdAt", "desc")
    );

    const unsub = onSnapshot(qRef, (snap) => {
      const list: MiniBucket[] = [];

      snap.forEach((d) => {
        const data = d.data() as DocumentData;
        list.push({
          name: String(data.name ?? "Untitled"),
          balance: Number(data.balance) || 0,
          target: Number(data.target) || 0,
        });
      });

      setBuckets(list);

      // "Last updated" (skip first render)
      if (!firstLoad.current) setLastUpdated(new Date());
      firstLoad.current = false;
    });

    return () => unsub();
  }, [user]);

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
            <Button
              mode="outlined"
              icon="format-list-bulleted"
              onPress={() => router.push("/(tabs)/transactions")}
              style={styles.actionBtn}
            >
              Activity
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

      {/* Recent activity placeholder */}
      <Card style={styles.sectionCard}>
        <Card.Content>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Recent Activity</Text>
            <Button compact onPress={() => router.push("/(tabs)/transactions")}>
              View
            </Button>
          </View>
          <Text style={styles.muted}>
            Once we wire up transactions, you’ll see recent deposits + spending here.
          </Text>
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
});
