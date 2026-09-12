import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

import { RecentActivityRow } from "../../components/home/RecentActivityRow";
import { TotalStashedCard } from "../../components/home/TotalStashedCard";
import { ActiveStashHero } from "../../components/home/ActiveStashHero";
import { BucketPreviewCard } from "../../components/home/BucketPreviewCard";
import { EmptyAdventureHero } from "../../components/shared/EmptyAdventureHero";
import { useAuth } from "../../src/contexts/AuthContext";
import {
  computeMonthlyStashChange,
  getCurrentLocalMonthStart,
  reconstructPreviousMonthEndTotalMinor,
  type MonthlyStashChange,
} from "../../src/domain/monthlyStashChange";
import { mergeRecentSavingsTransactions } from "../../src/domain/recentSavingsActivity";
import { subscribeToUserBuckets } from "../../src/services/firebase/buckets";
import {
  fetchSavingsTransactionsSinceForResources,
  subscribeToRecentSavingsTransactionsForResource,
} from "../../src/services/firebase/savingsTransactions";
import { fetchMemberTrips, fetchMemberTripsOrdered } from "../../src/services/firebase/trips";
import type { BucketType, PersistedTimestamp, SavingsTransaction, Trip } from "../../src/types/domain";
import { radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";

type MiniBucket = {
  id: string;
  name: string;
  balance: number;
  target: number;
  color: string | null;
  createdAt: PersistedTimestamp | undefined;
  // Checkpoint 3F.3B.4A: kept ONLY to let the "Your Buckets" preview
  // list exclude a trip_personal fund ("My Stash" belongs to the Trip
  // experience, not this preview) - explicitly NOT used to filter
  // `totals`/`monthlyChange` below. A trip_personal Bucket IS real
  // personally-owned savings (the product decision this checkpoint
  // records), so it must stay included in Home's actual Total Stashed
  // figure and its monthly-change history exactly like any other
  // personal Bucket - only the small visual preview cards hide it.
  bucketType: BucketType | undefined;
};

// Home's "Your Buckets" preview shows at most 3 real buckets (Milestone
// 3 Checkpoint 3F.2B) - informational/navigational only.
const BUCKET_PREVIEW_LIMIT = 3;

// Home's Recent Activity shows only the newest few transactions across
// all of the user's Personal Savings buckets (Milestone 3 Checkpoint
// 3E) - never a bucket's full history, which remains Bucket Detail's
// job via the separate, unbounded subscribeToSavingsTransactionsForResource.
const RECENT_ACTIVITY_LIMIT = 5;

const DESKTOP_BREAKPOINT = 900;
const MAX_CONTENT_WIDTH = 1100;

export default function HomeScreen() {
  const { user } = useAuth();
  const theme = useTheme();
  const colors = useSemanticColors();
  const { width } = useWindowDimensions();
  const isDesktop = width >= DESKTOP_BREAKPOINT;

  const fullName = user?.displayName?.trim();
  const firstName = fullName ? fullName.split(/\s+/)[0] : undefined;
  const displayName = firstName || (user?.email ? user.email.split("@")[0] : "there");
  const avatarInitial = (firstName ?? displayName).charAt(0).toUpperCase() || "?";

  const [buckets, setBuckets] = useState<MiniBucket[]>([]);
  // Distinguishes "haven't received the first subscribeToUserBuckets
  // snapshot yet" from "received one, and it happens to be empty" - the
  // Recent Activity readiness below (and this state's own honest loading
  // treatment) depends on that distinction (Checkpoint 3E lifecycle fix).
  const [bucketsReady, setBucketsReady] = useState(false);
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
        color: b.color ?? null,
        // Already delivered by the existing subscribeToUserBuckets
        // subscription (buckets.ts already reads this field off every
        // document) - Home just wasn't keeping it before. Needed for the
        // "created this month" special case in the monthly-change
        // reconstruction below; no new Firestore read.
        createdAt: b.createdAt,
        bucketType: b.bucketType,
      }));

      setBuckets(list);
      setBucketsReady(true);
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
    return { totalSaved };
  }, [buckets]);

  // "Total Stashed vs. last month" (Milestone 3 Checkpoint 3F.3A.2): a
  // bounded, one-shot read of only each current bucket's transactions
  // since the start of the current local calendar month - never the
  // user's full lifetime ledger, and never a new per-bucket live
  // listener (see src/domain/monthlyStashChange.ts for the reconstruction
  // math/edge cases and fetchSavingsTransactionsSinceForResources for the
  // bounded query itself). Refetches when bucketIds changes (membership)
  // and, deliberately, whenever recentByBucket changes too - that map is
  // already updated live by the existing bounded Recent Activity
  // listeners above, so a same-session Add Money/Withdraw refreshes this
  // metric without standing up any new listener of its own.
  const [monthlyTxnsSinceStart, setMonthlyTxnsSinceStart] = useState<
    Record<string, SavingsTransaction[]>
  >({});
  const [monthlyHistoryReady, setMonthlyHistoryReady] = useState(false);
  const [monthlyHistoryError, setMonthlyHistoryError] = useState(false);

  useEffect(() => {
    setMonthlyHistoryReady(false);
    setMonthlyHistoryError(false);

    if (bucketIds.length === 0) {
      setMonthlyTxnsSinceStart({});
      setMonthlyHistoryReady(true);
      return;
    }

    let cancelled = false;
    const monthStart = getCurrentLocalMonthStart();

    (async () => {
      try {
        const txnsByBucket = await fetchSavingsTransactionsSinceForResources(
          "bucket",
          bucketIds,
          monthStart
        );
        if (!cancelled) {
          setMonthlyTxnsSinceStart(txnsByBucket);
          setMonthlyHistoryReady(true);
        }
      } catch (e) {
        console.log("Home monthly-change history fetch error:", e);
        if (!cancelled) {
          setMonthlyTxnsSinceStart({});
          setMonthlyHistoryReady(true);
          setMonthlyHistoryError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bucketIds, recentByBucket]);

  const monthlyChange: MonthlyStashChange | null = useMemo(() => {
    if (!bucketsReady || !monthlyHistoryReady) return null;

    const monthStart = getCurrentLocalMonthStart();
    const bucketsForCalc = buckets.map((b) => ({
      id: b.id,
      currentBalanceMinor: Math.round((Number(b.balance) || 0) * 100),
      createdAt: b.createdAt ? b.createdAt.toDate() : null,
    }));
    const currentTotalMinor = bucketsForCalc.reduce(
      (sum, b) => sum + b.currentBalanceMinor,
      0
    );
    const previousMonthEndTotalMinor = reconstructPreviousMonthEndTotalMinor(
      bucketsForCalc,
      monthlyTxnsSinceStart,
      monthStart
    );

    return computeMonthlyStashChange({
      currentTotalMinor,
      previousMonthEndTotalMinor,
      historyAvailable: !monthlyHistoryError,
    });
  }, [buckets, bucketsReady, monthlyTxnsSinceStart, monthlyHistoryReady, monthlyHistoryError]);

  // Home's real-trip hero (Milestone 3 Checkpoint 3F.2): a read-only,
  // one-shot fetch reusing the exact same fetchMemberTripsOrdered/
  // fetchMemberTrips fallback pair app/(tabs)/trips/index.tsx already
  // uses - no new query shape, no Rules/index change, no live
  // subscription (none exists for Trips today). This never mutates
  // Trips state and is not itself the Trips feature.
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripsReady, setTripsReady] = useState(false);

  useEffect(() => {
    setTrips([]);
    setTripsReady(false);

    if (!user) return;

    let cancelled = false;

    (async () => {
      try {
        const rows = await fetchMemberTripsOrdered(user.uid);
        if (!cancelled) {
          setTrips(rows);
          setTripsReady(true);
        }
      } catch (e) {
        console.log("Home trips preview fetch error:", e);
        try {
          const rows = await fetchMemberTrips(user.uid);
          if (!cancelled) {
            setTrips(rows);
            setTripsReady(true);
          }
        } catch (e2) {
          console.log("Home trips preview fallback error:", e2);
          if (!cancelled) {
            setTrips([]);
            setTripsReady(true);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  // "First/most relevant" trip: fetchMemberTripsOrdered already returns
  // createdAt-descending, so the first entry is the user's most recently
  // created real trip.
  const heroTrip = trips[0] ?? null;

  // Reuses the same real, already-subscribed `buckets` array Home
  // already computed `totals` from - no new Firestore query. Order is
  // whatever subscribeToUserBuckets already delivers (createdAt desc,
  // see src/services/firebase/buckets.ts) - not an invented ranking, so
  // this section is deliberately labeled "Your Buckets", not "Top
  // Buckets".
  //
  // Checkpoint 3F.3B.4A: a trip_personal fund ("My Stash") is
  // deliberately excluded from this VISUAL preview only - it belongs in
  // the Trip experience, not here - while remaining fully included in
  // `totals`/`monthlyChange` above (computed from the unfiltered
  // `buckets` array), since it is real personally-owned savings. The
  // ordinary Buckets tab applies the identical filter for the identical
  // reason (see app/(tabs)/buckets/index.tsx's `visibleBuckets`).
  const bucketPreview = buckets
    .filter((b) => b.bucketType !== "trip_personal")
    .slice(0, BUCKET_PREVIEW_LIMIT);

  const bucketsSection = (
    <View
      style={[
        styles.sectionCard,
        { backgroundColor: theme.colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={styles.sectionHeaderRow}>
        <Text style={[styles.sectionTitle, { color: theme.colors.onSurface, marginBottom: 0 }]}>
          Your Buckets
        </Text>
        <Pressable
          onPress={() => router.push("/(tabs)/buckets")}
          accessibilityRole="button"
          accessibilityLabel="See all buckets"
        >
          <Text style={[styles.seeAll, { color: colors.mintText }]}>See all</Text>
        </Pressable>
      </View>

      {!bucketsReady ? (
        <View style={styles.activityLoading}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : bucketPreview.length === 0 ? (
        <View style={styles.bucketsEmpty}>
          <Text style={[styles.muted, { color: theme.colors.onSurfaceVariant }]}>
            No savings goals yet
          </Text>
          <Pressable
            onPress={() =>
              router.push({ pathname: "/(tabs)/buckets", params: { openCreate: "1" } })
            }
            accessibilityRole="button"
            accessibilityLabel="Create a new bucket"
            style={[styles.newBucketBtn, { backgroundColor: theme.colors.primary }]}
          >
            <Text style={[styles.newBucketBtnText, { color: theme.colors.onPrimary }]}>
              New Goal
            </Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.bucketRow}
        >
          {bucketPreview.map((b, index) => (
            <BucketPreviewCard
              key={b.id}
              name={b.name}
              balance={b.balance}
              target={b.target}
              color={b.color}
              accentIndex={index}
              onPress={() =>
                router.push({
                  pathname: "/(tabs)/buckets/[bucketId]",
                  params: { bucketId: b.id },
                })
              }
            />
          ))}
        </ScrollView>
      )}
    </View>
  );

  const recentActivitySection = (
    <View
      style={[
        styles.sectionCard,
        { backgroundColor: theme.colors.surface, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Recent Activity
      </Text>

      {!recentActivityReady ? (
        <View style={styles.activityLoading}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : recentActivityHasError ? (
        <Text style={[styles.muted, { color: theme.colors.onSurfaceVariant }]}>
          We couldn’t load recent activity right now.
        </Text>
      ) : recentActivity.length === 0 ? (
        <Text style={[styles.muted, { color: theme.colors.onSurfaceVariant }]}>
          No savings activity yet.
        </Text>
      ) : (
        recentActivity.map((transaction) => (
          <RecentActivityRow
            key={transaction.id}
            transaction={transaction}
            bucketName={bucketNameById[transaction.resourceId] ?? "Untitled"}
          />
        ))
      )}
    </View>
  );

  const heroSection = !tripsReady ? (
    <View
      style={[
        styles.heroLoading,
        { backgroundColor: theme.colors.surface, borderColor: colors.border },
      ]}
    >
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  ) : heroTrip ? (
    <ActiveStashHero
      trip={heroTrip}
      onPress={() =>
        router.push({ pathname: "/(tabs)/trips/[tripId]", params: { tripId: heroTrip.id } })
      }
    />
  ) : (
    <EmptyAdventureHero
      height={200}
      onPress={() => router.push("/(tabs)/trips/create")}
    />
  );

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={styles.contentOuter}
    >
      <View style={styles.contentWrap}>
        {/* Header */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.greeting, { color: theme.colors.onSurfaceVariant }]}>
              Hey {displayName}
            </Text>
            <Text style={[styles.headline, { color: theme.colors.onSurface }]}>
              Your next adventure{"\n"}is getting{" "}
              <Text style={{ color: colors.mintText }}>closer.</Text>
            </Text>
          </View>

          <View style={[styles.avatar, { backgroundColor: colors.surfaceTertiary }]}>
            {user?.photoURL ? (
              <Image source={{ uri: user.photoURL }} style={styles.avatarImage} />
            ) : (
              <Text style={[styles.avatarInitial, { color: theme.colors.onSurface }]}>
                {avatarInitial}
              </Text>
            )}
          </View>
        </View>

        {/* Checkpoint 3F.3A.1: tightened from spacing.md/spacing.sm - the
            approved mockup's density lets more of Recent Activity enter
            the viewport on a ~390-430px phone without feeling cramped. */}
        <View style={{ height: spacing.sm }} />

        {isDesktop ? (
          <View style={styles.desktopRow}>
            <View style={styles.desktopMainCol}>
              <TotalStashedCard totalSaved={totals.totalSaved} monthlyChange={monthlyChange} />
              <View style={{ height: spacing.xs }} />
              {bucketsSection}
              <View style={{ height: spacing.xs }} />
              {heroSection}
            </View>
            <View style={styles.desktopSideCol}>{recentActivitySection}</View>
          </View>
        ) : (
          <>
            <TotalStashedCard totalSaved={totals.totalSaved} monthlyChange={monthlyChange} />
            <View style={{ height: spacing.xs }} />
            {bucketsSection}
            <View style={{ height: spacing.xs }} />
            {heroSection}
            <View style={{ height: spacing.xs }} />
            {recentActivitySection}
          </>
        )}

        <View style={{ height: spacing.sm }} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  contentOuter: { padding: spacing.md, paddingBottom: 110, alignItems: "center" },
  contentWrap: { width: "100%", maxWidth: MAX_CONTENT_WIDTH },

  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  greeting: { ...typography.body, fontSize: 13 },
  // Checkpoint 3F.2A density pass: 26 -> 22 and tighter line height - the
  // approved reference's headline is compact, not a full display-size
  // heading.
  headline: {
    ...typography.headline,
    fontSize: 22,
    lineHeight: 27,
    marginTop: 2,
  },

  avatar: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: { width: 42, height: 42 },
  avatarInitial: { fontSize: 16, fontWeight: "800" },

  sectionCard: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.sm,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  sectionTitle: { ...typography.sectionTitle, marginBottom: spacing.xs },
  seeAll: { fontSize: 12, fontWeight: "700" },
  muted: { ...typography.body },

  bucketRow: { gap: spacing.sm, paddingRight: spacing.xs },
  bucketsEmpty: {
    alignItems: "flex-start",
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  newBucketBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
  },
  newBucketBtnText: { fontSize: 12, fontWeight: "700" },

  activityLoading: { paddingVertical: spacing.sm, alignItems: "center" },

  heroLoading: {
    height: 200,
    borderRadius: radii.xl,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  desktopRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "flex-start",
  },
  desktopMainCol: { flex: 3 },
  desktopSideCol: { flex: 2 },
});
