// app/(tabs)/trips/index.tsx
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Text, useTheme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { ActiveStashHero } from "../../../components/home/ActiveStashHero";
import { OtherTripCard } from "../../../components/trips/OtherTripCard";
import { EmptyAdventureHero } from "../../../components/shared/EmptyAdventureHero";
import { getCurrentUser } from "../../../src/services/firebase/auth";
import {
  fetchMemberTrips,
  fetchMemberTripsOrdered,
} from "../../../src/services/firebase/trips";
import { radii, spacing, typography } from "../../../src/theme/tokens";
import { useSemanticColors } from "../../../src/theme/useSemanticColors";
import type { Trip } from "../../../src/types/domain";

const DESKTOP_BREAKPOINT = 900;
const MAX_CONTENT_WIDTH = 1100;

export default function TripsIndex() {
  const router = useRouter();
  const theme = useTheme();
  const colors = useSemanticColors();
  const { width } = useWindowDimensions();
  const isDesktop = width >= DESKTOP_BREAKPOINT;

  const [loading, setLoading] = useState(true);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [queryText, setQueryText] = useState("");

  const fetchTrips = useCallback(async () => {
    const user = getCurrentUser();
    if (!user) {
      setTrips([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const rows = await fetchMemberTripsOrdered(user.uid);
      setTrips(rows);
    } catch (e) {
      console.log("fetchTrips error:", e);

      // Fallback if createdAt/orderBy isn't present for older docs
      try {
        const user = getCurrentUser();
        const rows2 = await fetchMemberTrips(user?.uid ?? "");
        setTrips(rows2);
      } catch (e2) {
        console.log("fetchTrips fallback error:", e2);
        setTrips([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchTrips();
    }, [fetchTrips])
  );

  // Client-side search only, over the already-fetched trips - no new
  // query/backend behavior (Milestone 3 Checkpoint 3F.2).
  const filteredTrips = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q) return trips;
    return trips.filter((t) => {
      const title = (t.title ?? "").toLowerCase();
      const location = (t.location ?? "").toLowerCase();
      return title.includes(q) || location.includes(q);
    });
  }, [trips, queryText]);

  // Checkpoint 4B.5B: client-side PARTITION (never a
  // `where("archivedAt", "==", null)` query - see the approved preflight
  // §9: that query would silently exclude every legacy Trip, since
  // Firestore's `== null` only matches a field explicitly present and
  // set to null, never a field that's entirely absent). `!t.archivedAt`
  // is true for both "field absent" (legacy) and "field null" (never
  // archived), so legacy Trips land in the active group automatically,
  // with no backfill needed. fetchMemberTripsOrdered/fetchMemberTrips
  // themselves are completely unchanged - this only partitions their
  // already-fetched, already-search-filtered result.
  const activeFilteredTrips = useMemo(
    () => filteredTrips.filter((t) => !t.archivedAt),
    [filteredTrips]
  );
  const archivedFilteredTrips = useMemo(
    () => filteredTrips.filter((t) => !!t.archivedAt),
    [filteredTrips]
  );

  const heroTrip = activeFilteredTrips[0] ?? null;
  const otherTrips = activeFilteredTrips.slice(1);

  const listSection = otherTrips.length === 0 ? null : (
    <View>
      <Text style={[styles.sectionTitle, { color: theme.colors.onBackground }]}>
        Other Stashes
      </Text>
      <View style={{ gap: spacing.sm }}>
        {otherTrips.map((trip) => (
          <OtherTripCard
            key={trip.id}
            trip={trip}
            onPress={() =>
              router.push({ pathname: "/(tabs)/trips/[tripId]", params: { tripId: trip.id } })
            }
          />
        ))}
      </View>
    </View>
  );

  // Checkpoint 4B.5B: the minimal, always-present Archived section
  // (approved preflight §9/§10) - the ONLY in-app path back to an
  // archived Trip, and therefore to that member's own My Stash (Trip
  // Detail is the sole screen that ever renders a My Stash card - see
  // the preflight's executive summary for why hiding archived Trips
  // with no path back would silently reintroduce the exact hazard this
  // whole feature exists to prevent). Deliberately compact/subdued
  // (title + chevron only, no photo/progress) rather than a second
  // OtherTripCard-style rich card - this is a status list, not a second
  // set of active trip cards. Tapping a row opens the EXACT same Trip
  // Detail route as any other trip - no separate route, no restore, no
  // management UI.
  const archivedSection = archivedFilteredTrips.length === 0 ? null : (
    <View style={{ marginTop: spacing.lg }}>
      <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>Archived</Text>
      <View style={{ gap: spacing.xs }}>
        {archivedFilteredTrips.map((trip) => (
          <Pressable
            key={trip.id}
            onPress={() =>
              router.push({ pathname: "/(tabs)/trips/[tripId]", params: { tripId: trip.id } })
            }
            accessibilityRole="button"
            accessibilityLabel={`Open ${trip.title?.trim() || "archived trip"} details`}
            style={({ pressed }) => [
              styles.archivedRow,
              { backgroundColor: theme.colors.surface, borderColor: colors.border },
              pressed && { opacity: 0.85 },
            ]}
          >
            <MaterialCommunityIcons name="archive-outline" size={16} color={colors.textMuted} />
            <Text
              style={[styles.archivedRowTitle, { color: colors.textSecondary }]}
              numberOfLines={1}
            >
              {trip.title?.trim() || "Untitled trip"}
            </Text>
            <MaterialCommunityIcons name="chevron-right" size={18} color={colors.textMuted} />
          </Pressable>
        ))}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.contentWrap}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.h1, { color: theme.colors.onBackground }]}>Trips</Text>
            <Text style={[styles.sub, { color: theme.colors.onSurfaceVariant }]}>
              Plan together. Stash together. Go somewhere unforgettable.
            </Text>
          </View>

          {/* Checkpoint 3F.3B: the search field is now persistent inline
              (matching the approved reference's header layout) rather
              than hidden behind a magnify-icon toggle - purely a
              visibility change, the underlying queryText/filteredTrips
              search logic below is untouched. Omitted entirely when
              there are no real trips at all (nothing to search), per
              the checkpoint's explicit allowance; the create button
              stays visible either way so there is never a dead/missing
              control. */}
          <View style={styles.actionRow}>
            {trips.length > 0 ? (
              <View
                style={[
                  styles.searchPill,
                  { backgroundColor: theme.colors.surface, borderColor: colors.border },
                ]}
              >
                <MaterialCommunityIcons name="magnify" size={18} color={colors.textSecondary} />
                <TextInput
                  value={queryText}
                  onChangeText={setQueryText}
                  placeholder="Search by trip or location"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.searchInput, { color: theme.colors.onSurface }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            ) : (
              <View style={{ flex: 1 }} />
            )}

            <Pressable
              onPress={() => router.push("/(tabs)/trips/create")}
              accessibilityRole="button"
              accessibilityLabel="Create a trip"
              style={[styles.addButton, { backgroundColor: theme.colors.primary }]}
            >
              <MaterialCommunityIcons name="plus" size={22} color={theme.colors.onPrimary} />
            </Pressable>
          </View>

          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text style={[styles.loadingText, { color: theme.colors.onSurfaceVariant }]}>
                Loading trips…
              </Text>
            </View>
          ) : trips.length === 0 ? (
            // Checkpoint 3F.2A: the same premium, truthful empty-state
            // hero used on Home for "no real trips yet" - not a fake
            // trip, just decorative presentation + a real navigation
            // target (existing Trip creation).
            <EmptyAdventureHero
              height={220}
              onPress={() => router.push("/(tabs)/trips/create")}
            />
          ) : filteredTrips.length === 0 ? (
            <View
              style={[
                styles.emptyWrap,
                { backgroundColor: theme.colors.surface, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.emptyTitle, { color: theme.colors.onBackground }]}>
                No trips found
              </Text>
              <Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
                Try a different trip or location.
              </Text>
            </View>
          ) : isDesktop ? (
            <>
              {activeFilteredTrips.length > 0 ? (
                <View style={styles.desktopRow}>
                  <View style={styles.desktopMainCol}>
                    {heroTrip ? (
                      <ActiveStashHero
                        trip={heroTrip}
                        variant="trips"
                        onPress={() =>
                          router.push({
                            pathname: "/(tabs)/trips/[tripId]",
                            params: { tripId: heroTrip.id },
                          })
                        }
                      />
                    ) : null}
                  </View>
                  <View style={styles.desktopSideCol}>{listSection}</View>
                </View>
              ) : null}
              {archivedSection}
            </>
          ) : (
            <>
              {activeFilteredTrips.length > 0 ? (
                <>
                  {heroTrip ? (
                    <ActiveStashHero
                      trip={heroTrip}
                      variant="trips"
                      onPress={() =>
                        router.push({
                          pathname: "/(tabs)/trips/[tripId]",
                          params: { tripId: heroTrip.id },
                        })
                      }
                    />
                  ) : null}
                  <View style={{ height: spacing.md }} />
                  {listSection}
                </>
              ) : null}
              {archivedSection}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollContent: { padding: spacing.lg, paddingBottom: 140, alignItems: "center" },
  contentWrap: { width: "100%", maxWidth: MAX_CONTENT_WIDTH },

  header: {},
  h1: { ...typography.pageTitle },
  sub: { ...typography.body, marginTop: spacing.xs },

  // Checkpoint 3F.3B: persistent search pill + create button, replacing
  // the previous magnify-toggle icon pair. Real search logic
  // (queryText/filteredTrips) is unchanged - only when/how it renders.
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  searchPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    height: 40,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    height: "100%",
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },

  sectionTitle: { ...typography.sectionTitle, marginBottom: spacing.sm },

  // Checkpoint 4B.5B: deliberately compact/subdued - title + chevron
  // only, no thumbnail/progress - this is a status list distinguishing
  // itself visually from the rich Active trip cards above, not a second
  // set of them.
  archivedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  archivedRowTitle: { ...typography.body, flex: 1, fontWeight: "700" },

  loadingWrap: { paddingTop: 40, alignItems: "center", gap: 10 },
  loadingText: { fontSize: 13, fontWeight: "600" },

  emptyWrap: {
    marginTop: spacing.lg,
    alignItems: "center",
    padding: spacing.xl,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
  },
  emptyTitle: { fontSize: 18, fontWeight: "800" },
  emptyText: { fontSize: 13, textAlign: "center" },
  primaryBtn: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
  },
  primaryBtnText: { fontWeight: "800" },

  desktopRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "flex-start",
    marginTop: spacing.md,
  },
  desktopMainCol: { flex: 3 },
  desktopSideCol: { flex: 2 },
});
