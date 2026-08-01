// app/(tabs)/trips/index.tsx
import { useFocusEffect, useRouter } from "expo-router";
import { getAuth } from "firebase/auth";
import {
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useTheme } from "react-native-paper";

import { db } from "../../../firebase";

type TripDoc = {
  id: string;
  title?: string;
  location?: string;
  target?: number;
  saved?: number;
  ownerId?: string;
  memberIds?: string[];
  imageUrl?: string;
  createdAt?: Timestamp | any;
};

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1200&q=60";

function money(n?: number) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export default function TripsIndex() {
  const router = useRouter();
  const theme = useTheme();
  const { width } = useWindowDimensions();

  const [loading, setLoading] = useState(true);
  const [trips, setTrips] = useState<TripDoc[]>([]);
  const [queryText, setQueryText] = useState("");

  // Responsive columns (mobile -> desktop)
  const numColumns = useMemo(() => {
    if (width >= 1200) return 4;
    if (width >= 900) return 3;
    if (width >= 600) return 2;
    return 1;
  }, [width]);

  const cardGap = 14;
  const contentPadding = 16;

  const cardWidth = useMemo(() => {
    const available = width - contentPadding * 2;
    const totalGaps = cardGap * (numColumns - 1);
    return Math.floor((available - totalGaps) / numColumns);
  }, [width, numColumns]);

  const fetchTrips = useCallback(async () => {
    const user = getAuth().currentUser;
    if (!user) {
      setTrips([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const tripsRef = collection(db, "trips");
      const q = query(
        tripsRef,
        where("memberIds", "array-contains", user.uid),
        orderBy("createdAt", "desc")
      );

      const snap = await getDocs(q);
      const rows: TripDoc[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));

      setTrips(rows);
    } catch (e) {
      console.log("fetchTrips error:", e);

      // Fallback if createdAt/orderBy isn't present for older docs
      try {
        const user = getAuth().currentUser;
        const tripsRef = collection(db, "trips");
        const q2 = query(
          tripsRef,
          where("memberIds", "array-contains", user?.uid ?? "")
        );
        const snap2 = await getDocs(q2);
        const rows2: TripDoc[] = snap2.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }));
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

  const filteredTrips = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q) return trips;
    return trips.filter((t) => {
      const title = (t.title ?? "").toLowerCase();
      const location = (t.location ?? "").toLowerCase();
      return title.includes(q) || location.includes(q);
    });
  }, [trips, queryText]);

  const emptyState = useMemo(() => {
    if (loading) return null;

    if (trips.length === 0) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={[styles.emptyTitle, { color: theme.colors.onBackground }]}>
            No trips yet
          </Text>
          <Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
            Create your first SquadStash trip and start saving together.
          </Text>

          <Pressable
            onPress={() => router.push("/(tabs)/trips/create")}
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: theme.colors.primary },
              pressed && { transform: [{ scale: 0.98 }] },
            ]}
          >
            <Text style={styles.primaryBtnText}>Create a Trip</Text>
          </Pressable>
        </View>
      );
    }

    if (filteredTrips.length === 0) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={[styles.emptyTitle, { color: theme.colors.onBackground }]}>
            No matches
          </Text>
          <Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
            Try searching by trip title or location.
          </Text>
        </View>
      );
    }

    return null;
  }, [loading, trips.length, filteredTrips.length, router, theme.colors]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.container, { paddingHorizontal: contentPadding }]}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={[styles.h1, { color: theme.colors.onBackground }]}>Trips</Text>
            <Text style={[styles.sub, { color: theme.colors.onSurfaceVariant }]}>
              Plan, save, and go — all in one place.
            </Text>
          </View>

          <Pressable
            onPress={() => router.push("/(tabs)/trips/create")}
            style={({ pressed }) => [
              styles.addBtn,
              { backgroundColor: theme.colors.primary },
              pressed && { transform: [{ scale: 0.98 }] },
            ]}
          >
            <Text style={styles.addBtnText}>+ New</Text>
          </Pressable>
        </View>

        {/* Search */}
        <View style={styles.searchRow}>
          <TextInput
            value={queryText}
            onChangeText={setQueryText}
            placeholder="Search trips (title or location)"
            placeholderTextColor={theme.colors.onSurfaceVariant}
            style={[
              styles.searchInput,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.outline,
                color: theme.colors.onBackground,
              },
            ]}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* List */}
        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator />
            <Text style={[styles.loadingText, { color: theme.colors.onSurfaceVariant }]}>
              Loading trips…
            </Text>
          </View>
        ) : (
          <FlatList
            data={filteredTrips}
            keyExtractor={(item) => item.id}
            key={numColumns} // force layout recalculation when columns change
            numColumns={numColumns}
            columnWrapperStyle={numColumns > 1 ? { gap: cardGap } : undefined}
            contentContainerStyle={{
              paddingVertical: 14,
              paddingBottom: 40,
              gap: cardGap,
            }}
            ListEmptyComponent={emptyState}
            renderItem={({ item }) => (
              <TripCard
                trip={item}
                width={cardWidth}
                onPress={() =>
                  router.push({
                    pathname: "/(tabs)/trips/[tripId]",
                    params: { tripId: item.id },
                  })
                }
              />
            )}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

function TripCard({
  trip,
  width,
  onPress,
}: {
  trip: TripDoc;
  width: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const [imgFailed, setImgFailed] = useState(false);

  const title = trip.title?.trim() || "Untitled trip";
  const location = trip.location?.trim() || "No location";
  const saved = Number(trip.saved ?? 0);
  const target = Number(trip.target ?? 0);
  const pct = target > 0 ? clamp01(saved / target) : 0;

  const uri = !imgFailed && trip.imageUrl ? trip.imageUrl : FALLBACK_IMAGE;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          width,
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.outline,
        },
        pressed && { transform: [{ scale: 0.99 }], opacity: 0.98 },
      ]}
    >
      <View style={styles.imageWrap}>
        <Image
          source={{ uri }}
          style={styles.image}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />

        {/* soft overlay for text readability */}
        <View style={styles.imageOverlay} />

        {/* Badge */}
        <View style={styles.badgeRow}>
          <View
            style={[
              styles.badge,
              {
                backgroundColor: theme.dark
                  ? "rgba(15, 21, 38, 0.85)"
                  : "rgba(255, 255, 255, 0.88)",
                borderColor: "rgba(0,0,0,0.10)",
              },
            ]}
          >
            <Text style={{ color: theme.colors.onBackground, fontWeight: "800", fontSize: 12 }}>
              Active
            </Text>
          </View>
        </View>

        {/* Title + location */}
        <View style={styles.imageTextWrap}>
          <Text numberOfLines={1} style={styles.cardTitle}>
            {title}
          </Text>
          <Text numberOfLines={1} style={styles.cardLocation}>
            {location}
          </Text>
        </View>
      </View>

      <View style={styles.cardBody}>
        <View style={styles.moneyRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.label, { color: theme.colors.onSurfaceVariant }]}>Saved</Text>
            <Text style={[styles.value, { color: theme.colors.onBackground }]}>
              {money(saved)}
            </Text>
          </View>

          <View style={{ flex: 1, alignItems: "flex-end" }}>
            <Text style={[styles.label, { color: theme.colors.onSurfaceVariant }]}>Target</Text>
            <Text style={[styles.value, { color: theme.colors.onBackground }]}>
              {money(target)}
            </Text>
          </View>
        </View>

        <View
          style={[
            styles.progressOuter,
            {
              backgroundColor: theme.colors.surfaceVariant,
              borderColor: theme.colors.outline,
            },
          ]}
        >
          <View
            style={[
              styles.progressInner,
              { width: `${pct * 100}%`, backgroundColor: theme.colors.primary },
            ]}
          />
        </View>

        <Text style={[styles.progressText, { color: theme.colors.onSurfaceVariant }]}>
          {Math.round(pct * 100)}% funded
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1 },

  header: {
    paddingTop: 10,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
  },
  h1: {
    fontSize: 28,
    fontWeight: "900",
    letterSpacing: 0.2,
  },
  sub: {
    marginTop: 4,
    fontSize: 13,
  },

  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  addBtnText: { color: "#fff", fontWeight: "900", fontSize: 14 },

  searchRow: {
    marginTop: 6,
    marginBottom: 2,
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
  },

  loadingWrap: { paddingTop: 40, alignItems: "center", gap: 10 },
  loadingText: { fontSize: 13, fontWeight: "700" },

  card: {
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
  },

  imageWrap: { height: 160, position: "relative" },
  image: { width: "100%", height: "100%" },

  imageOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.18)",
  },

  badgeRow: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  badge: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },

  imageTextWrap: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 12,
  },
  cardTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 0.2,
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  cardLocation: {
    marginTop: 2,
    color: "rgba(255,255,255,0.92)",
    fontSize: 13,
    fontWeight: "700",
  },

  cardBody: { padding: 14, gap: 10 },

  moneyRow: { flexDirection: "row", alignItems: "flex-end", gap: 12 },
  label: { fontSize: 12, fontWeight: "700" },
  value: { fontSize: 16, fontWeight: "900", marginTop: 2 },

  progressOuter: {
    height: 10,
    borderRadius: 999,
    borderWidth: 1,
    overflow: "hidden",
  },
  progressInner: {
    height: "100%",
    borderRadius: 999,
  },
  progressText: { fontSize: 12, fontWeight: "700" },

  emptyWrap: {
    marginTop: 34,
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 10,
  },
  emptyTitle: { fontSize: 18, fontWeight: "900" },
  emptyText: { fontSize: 13, textAlign: "center" },
  primaryBtn: {
    marginTop: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
  },
  primaryBtnText: { color: "#fff", fontWeight: "900" },
});
