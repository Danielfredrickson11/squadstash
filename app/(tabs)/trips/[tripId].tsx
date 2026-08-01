import { useLocalSearchParams, useRouter } from "expo-router";
import { deleteDoc, doc, getDoc } from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Image,
    Platform,
    Pressable,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    useWindowDimensions,
    View,
} from "react-native";
import { useTheme } from "react-native-paper";

import { db } from "../../../firebase";
import { useAuth } from "../../../src/contexts/AuthContext";

type TripDoc = {
  title?: string;
  location?: string | null;
  target?: number;
  saved?: number;
  imageUrl?: string;
  ownerId?: string;
  memberIds?: string[];
};

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1600&q=60";

function money(n?: number) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export default function TripDetails() {
  const router = useRouter();
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { width } = useWindowDimensions();
  const { user } = useAuth();
  const theme = useTheme();

  const [loading, setLoading] = useState(true);
  const [trip, setTrip] = useState<TripDoc | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  const isWide = width >= 980;

  const headerHeight = useMemo(() => {
    if (width >= 1200) return 340;
    if (width >= 800) return 300;
    return 240;
  }, [width]);

  const notify = useCallback((title: string, message?: string) => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.alert(message ? `${title}\n\n${message}` : title);
      return;
    }
    Alert.alert(title, message);
  }, []);

  const confirmDelete = useCallback((onConfirm: () => void) => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const ok = window.confirm(
        "Delete trip?\n\nThis will permanently delete this trip. This cannot be undone."
      );
      if (ok) onConfirm();
      return;
    }

    Alert.alert(
      "Delete trip?",
      "This will permanently delete this trip. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: onConfirm },
      ]
    );
  }, []);

  const fetchTrip = useCallback(async () => {
    if (!tripId) return;
    setLoading(true);
    try {
      const ref = doc(db, "trips", tripId);
      const snap = await getDoc(ref);
      setTrip(snap.exists() ? (snap.data() as TripDoc) : null);
    } catch (e) {
      console.log("fetchTrip error:", e);
      setTrip(null);
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    fetchTrip();
  }, [fetchTrip]);

  const isOwner = !!user?.uid && !!trip?.ownerId && user.uid === trip.ownerId;

  const onDeleteTrip = useCallback(() => {
    if (!tripId || !trip) return;

    confirmDelete(async () => {
      try {
        setLoading(true);
        await deleteDoc(doc(db, "trips", tripId));
        router.replace("/(tabs)/trips");
      } catch (e: any) {
        console.log("delete trip error:", e);
        notify(
          "Couldn’t delete trip",
          e?.message ||
            "You may not have permission, or there was a network error."
        );
      } finally {
        setLoading(false);
      }
    });
  }, [tripId, trip, confirmDelete, router, notify]);

  const title = trip?.title?.trim() || "Trip Details";
  const location = (trip?.location ?? "").trim() || "No location";
  const saved = Number(trip?.saved ?? 0);
  const target = Number(trip?.target ?? 0);
  const pct = target > 0 ? clamp01(saved / target) : 0;

  const imageUri =
    !imgFailed && trip?.imageUrl ? trip.imageUrl : FALLBACK_IMAGE;

  // ✅ Quick Analysis
  const membersCount = Math.max(1, trip?.memberIds?.length ?? 1);
  const remaining = Math.max(0, target - saved);
  const perPersonTarget = target / membersCount;
  const perPersonRemaining = remaining / membersCount;

  const weeklyPlans = [
    { label: "4 wks", weeks: 4 },
    { label: "8 wks", weeks: 8 },
    { label: "12 wks", weeks: 12 },
  ].map((p) => ({
    ...p,
    perWeekTotal: remaining / p.weeks,
    perWeekPerPerson: perPersonRemaining / p.weeks,
  }));

  const dangerBg = theme.colors.errorContainer ?? "#FEE2E2";
  const dangerText = theme.colors.onErrorContainer ?? "#991B1B";

  if (loading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator />
          <Text style={[styles.loadingText, { color: theme.colors.onSurfaceVariant }]}>
            Loading…
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!trip) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        <View style={styles.loadingWrap}>
          <Text style={[styles.h1, { color: theme.colors.onBackground }]}>Trip not found</Text>
          <Text style={[styles.sub, { color: theme.colors.onSurfaceVariant }]}>
            This trip may have been deleted.
          </Text>

          <Pressable
            onPress={() => router.back()}
            style={[styles.primaryBtn, { backgroundColor: theme.colors.primary }]}
          >
            <Text style={styles.primaryBtnText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.topBtn,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.outline,
            },
            pressed && { opacity: 0.85 },
          ]}
          hitSlop={10}
        >
          <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>← Back</Text>
        </Pressable>

        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable
            onPress={() => console.log("Record Expense")}
            style={({ pressed }) => [
              styles.topBtn,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
              pressed && { opacity: 0.9 },
            ]}
            hitSlop={10}
          >
            <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>
              Record Expense
            </Text>
          </Pressable>

          {isOwner ? (
            <Pressable
              onPress={onDeleteTrip}
              style={({ pressed }) => [
                styles.topBtn,
                { backgroundColor: dangerBg, borderColor: theme.colors.outline },
                pressed && { opacity: 0.9 },
              ]}
              hitSlop={12}
            >
              <Text style={{ color: dangerText, fontWeight: "900" }}>Delete</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.page}>
        <View style={isWide ? styles.gridWide : undefined}>
          {/* Main */}
          <View style={isWide ? styles.mainCol : undefined}>
            <View
              style={[
                styles.heroWrap,
                {
                  height: headerHeight,
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.outline,
                },
              ]}
            >
              <Image
                source={{ uri: imageUri }}
                style={styles.heroImg}
                resizeMode="cover"
                onError={() => setImgFailed(true)}
              />
              <View style={styles.heroOverlay} />

              <View style={styles.heroText}>
                <Text style={styles.heroTitle} numberOfLines={1}>
                  {title}
                </Text>
                <Text style={styles.heroLocation} numberOfLines={1}>
                  {location}
                </Text>
              </View>

              <View
                style={[
                  styles.pill,
                  {
                    backgroundColor: theme.dark
                      ? "rgba(17,24,42,0.85)"
                      : "rgba(255,255,255,0.85)",
                    borderColor: "rgba(0,0,0,0.08)",
                  },
                ]}
              >
                <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>
                  {Math.round(pct * 100)}% funded
                </Text>
              </View>
            </View>

            <View
              style={[
                styles.card,
                { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
              ]}
            >
              <Text style={[styles.cardLabel, { color: theme.colors.onSurfaceVariant }]}>
                Progress
              </Text>

              <View style={styles.amountRow}>
                <Text style={[styles.amountBig, { color: theme.colors.onBackground }]}>
                  {money(saved)}
                </Text>
                <Text style={[styles.amountSmall, { color: theme.colors.onSurfaceVariant }]}>
                  {" "}
                  / {money(target)}
                </Text>
              </View>

              <View
                style={[
                  styles.progressOuter,
                  { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outline },
                ]}
              >
                <View
                  style={[
                    styles.progressInner,
                    { width: `${pct * 100}%`, backgroundColor: theme.colors.primary },
                  ]}
                />
              </View>

              <Text style={[styles.remaining, { color: theme.colors.onSurfaceVariant }]}>
                Remaining:{" "}
                <Text style={{ fontWeight: "900", color: theme.colors.onBackground }}>
                  {money(remaining)}
                </Text>
              </Text>
            </View>
          </View>

          {/* Side */}
          <View style={isWide ? styles.sideCol : undefined}>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
              ]}
            >
              <Text style={[styles.cardTitle, { color: theme.colors.onBackground }]}>
                Quick Analysis
              </Text>
              <Text style={[styles.sub, { color: theme.colors.onSurfaceVariant }]}>
                Based on your goal and members.
              </Text>

              <View style={{ height: 12 }} />

              <Row label="Members" value={`${membersCount}`} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />
              <Row label="Saved" value={money(saved)} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />
              <Row label="Remaining" value={money(remaining)} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />

              <View style={[styles.divider, { backgroundColor: theme.colors.outline }]} />

              <Row label="Target / person" value={money(perPersonTarget)} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />
              <Row label="Remaining / person" value={money(perPersonRemaining)} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />

              <View style={[styles.divider, { backgroundColor: theme.colors.outline }]} />

              <Text style={[styles.cardLabel, { color: theme.colors.onSurfaceVariant, marginBottom: 8 }]}>
                Suggested weekly savings (total / per person)
              </Text>

              {weeklyPlans.map((p) => (
                <Row
                  key={p.label}
                  label={p.label}
                  value={`${money(p.perWeekTotal)} / ${money(p.perWeekPerPerson)}`}
                  themeText={theme.colors.onBackground}
                  muted={theme.colors.onSurfaceVariant}
                />
              ))}
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  label,
  value,
  themeText,
  muted,
}: {
  label: string;
  value: string;
  themeText: string;
  muted: string;
}) {
  return (
    <View style={styles.qaRow}>
      <Text style={[styles.qaLabel, { color: muted }]}>{label}</Text>
      <Text style={[styles.qaValue, { color: themeText }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  topBar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  topBtn: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },

  page: { padding: 16, paddingBottom: 40 },

  gridWide: { flexDirection: "row", gap: 16, alignItems: "flex-start" },
  mainCol: { flex: 1, minWidth: 560 },
  sideCol: { width: 380 },

  heroWrap: {
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    position: "relative",
  },
  heroImg: { width: "100%", height: "100%" },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  heroText: { position: "absolute", left: 16, right: 16, bottom: 16 },
  heroTitle: { color: "#fff", fontSize: 32, fontWeight: "900" },
  heroLocation: { marginTop: 4, color: "rgba(255,255,255,0.9)", fontSize: 14, fontWeight: "700" },

  pill: {
    position: "absolute",
    right: 16,
    bottom: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },

  card: {
    marginTop: 14,
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
  },
  cardTitle: { fontSize: 16, fontWeight: "900" },
  cardLabel: { fontSize: 12, fontWeight: "800" },

  amountRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 6 },
  amountBig: { fontSize: 34, fontWeight: "900" },
  amountSmall: { fontSize: 14, fontWeight: "800", marginBottom: 6 },

  progressOuter: {
    marginTop: 10,
    height: 12,
    borderRadius: 999,
    borderWidth: 1,
    overflow: "hidden",
  },
  progressInner: { height: "100%", borderRadius: 999 },

  remaining: { marginTop: 10, fontSize: 13, fontWeight: "800" },

  divider: { height: 1, marginVertical: 12 },

  qaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 10,
  },
  qaLabel: { fontWeight: "800" },
  qaValue: { fontWeight: "900" },

  loadingWrap: { paddingTop: 60, alignItems: "center", gap: 10 },
  loadingText: { fontSize: 13 },
  h1: { fontSize: 20, fontWeight: "900" },
  sub: { fontSize: 13, marginTop: 6 },

  primaryBtn: {
    marginTop: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
  },
  primaryBtnText: { color: "#fff", fontWeight: "900" },
});
