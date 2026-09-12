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

  const heroTrip = filteredTrips[0] ?? null;
  const otherTrips = filteredTrips.slice(1);

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
          ) : (
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
