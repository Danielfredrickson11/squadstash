// app/(tabs)/trips.tsx
import {
  addDoc,
  collection,
  DocumentData,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import { FlatList, Image, StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  Chip,
  Dialog,
  Portal,
  ProgressBar,
  Text,
  TextInput,
} from "react-native-paper";

import { db } from "../../firebase";
import { useAuth } from "../../src/contexts/AuthContext";
import { formatCurrency } from "../../utils/format";

type Trip = {
  id: string;

  title: string;
  location?: string | null;
  startDate?: string | null; // keep string for now (YYYY-MM-DD)
  endDate?: string | null;

  goal?: number | null;
  saved?: number | null;
  coverPhotoURL?: string | null;

  ownerId: string;
  memberIds: string[];

  createdAt?: any;
  lastUpdatedAt?: any;
  lastUpdatedBy?: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(n, max));
}

function initialsFromName(label: string) {
  const s = (label ?? "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map((p) => (p?.[0] ?? "").toUpperCase()).join("");
}

function shortUid(uid: string) {
  return `${uid.slice(0, 2).toUpperCase()}${uid.slice(-2).toUpperCase()}`;
}

function isValidNumberString(v: string) {
  if (!v) return false;
  const n = Number(v);
  return Number.isFinite(n);
}

function AvatarCircle({
  index,
  label,
}: {
  index: number;
  label: string;
}) {
  return (
    <View
      style={[
        styles.avatar,
        {
          marginLeft: index === 0 ? 0 : -10,
        },
      ]}
    >
      <Text style={styles.avatarText}>{label}</Text>
    </View>
  );
}

export default function TripsScreen() {
  const { user, loading } = useAuth();

  const [trips, setTrips] = useState<Trip[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Create dialog
  const [createVisible, setCreateVisible] = useState(false);
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [goal, setGoal] = useState("");
  const [saved, setSaved] = useState("");
  const [coverPhotoURL, setCoverPhotoURL] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canCreate = useMemo(() => {
    if (!title.trim()) return false;
    // goal optional but if set must be valid
    if (goal.trim() && !isValidNumberString(goal.trim())) return false;
    if (saved.trim() && !isValidNumberString(saved.trim())) return false;
    return !submitting;
  }, [title, goal, saved, submitting]);

  // ✅ listener
  useEffect(() => {
    if (loading || !user) return;

    setError(null);

    const colRef = collection(db, "trips");
    const qRef = query(
      colRef,
      where("memberIds", "array-contains", user.uid),
      orderBy("createdAt", "desc")
    );

    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const next: Trip[] = [];
        snap.forEach((docSnap) => {
          const d = docSnap.data() as DocumentData;
          next.push({
            id: docSnap.id,
            title: String(d.title ?? ""),
            location: d.location ?? null,
            startDate: d.startDate ?? null,
            endDate: d.endDate ?? null,
            goal: typeof d.goal === "number" ? d.goal : null,
            saved: typeof d.saved === "number" ? d.saved : null,
            coverPhotoURL: d.coverPhotoURL ?? null,
            ownerId: String(d.ownerId ?? ""),
            memberIds: Array.isArray(d.memberIds) ? d.memberIds : [],
            createdAt: d.createdAt,
            lastUpdatedAt: d.lastUpdatedAt,
            lastUpdatedBy: d.lastUpdatedBy,
          });
        });
        setTrips(next);
      },
      (err) => {
        console.error("Trips snapshot error:", err);
        setError("Can’t load trips. Check Firestore rules/index.");
      }
    );

    return () => unsub();
  }, [loading, user]);

  const openCreate = () => {
    setError(null);
    setTitle("");
    setLocation("");
    setGoal("");
    setSaved("");
    setCoverPhotoURL("");
    setStartDate("");
    setEndDate("");
    setCreateVisible(true);
  };

  const closeCreate = () => {
    setCreateVisible(false);
  };

  const onCreateTrip = async () => {
    if (!user) return;

    setSubmitting(true);
    setError(null);

    try {
      const goalNum = goal.trim() ? Number(goal.trim()) : null;
      const savedNum = saved.trim() ? Number(saved.trim()) : 0;

      await addDoc(collection(db, "trips"), {
        title: title.trim(),
        location: location.trim() || null,
        startDate: startDate.trim() || null,
        endDate: endDate.trim() || null,

        goal: goalNum,
        saved: savedNum,

        coverPhotoURL: coverPhotoURL.trim() || null,

        ownerId: user.uid,
        memberIds: [user.uid],

        createdAt: serverTimestamp(),
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
      });

      closeCreate();
    } catch (e) {
      console.error("Failed to create trip:", e);
      setError("Failed to create trip (permissions).");
    } finally {
      setSubmitting(false);
    }
  };

  const renderTrip = ({ item }: { item: Trip }) => {
    const goalVal = item.goal ?? 0;
    const savedVal = item.saved ?? 0;
    const pct =
      goalVal > 0 ? clamp(savedVal / goalVal, 0, 1) : 0;

    const pctLabel =
      goalVal > 0 ? `${Math.round(pct * 100)}% Funded` : "No goal set";

    const dates =
      item.startDate && item.endDate
        ? `${item.startDate} – ${item.endDate}`
        : item.startDate
        ? `${item.startDate}`
        : item.endDate
        ? `${item.endDate}`
        : null;

    const memberIds = item.memberIds ?? [];
    const topMembers = memberIds.slice(0, 4);
    const extra = Math.max(0, memberIds.length - topMembers.length);

    return (
      <Card style={styles.tripCard} mode="elevated">
        {/* Hero */}
        {item.coverPhotoURL ? (
          <View style={styles.heroWrap}>
            <Image
              source={{ uri: item.coverPhotoURL }}
              style={styles.heroImg}
              resizeMode="cover"
            />
            <View style={styles.heroOverlay} />
            <View style={styles.heroTopRight}>
              <Chip style={styles.pill} textStyle={styles.pillText}>
                {pctLabel}
              </Chip>
            </View>

            <View style={styles.heroBottom}>
              <Text style={styles.heroTitle} numberOfLines={1}>
                {item.title || "Untitled Trip"}
              </Text>
              <View style={{ height: 6 }} />
              <View style={styles.heroMetaRow}>
                {item.location ? (
                  <Text style={styles.heroMeta} numberOfLines={1}>
                    {item.location}
                  </Text>
                ) : null}
                {dates ? (
                  <Text style={styles.heroMeta} numberOfLines={1}>
                    {item.location ? " • " : ""}
                    {dates}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.heroFallback}>
            <View style={styles.heroTopRight}>
              <Chip style={styles.pill} textStyle={styles.pillText}>
                {pctLabel}
              </Chip>
            </View>
            <View style={styles.heroBottomFallback}>
              <Text style={styles.heroTitle} numberOfLines={1}>
                {item.title || "Untitled Trip"}
              </Text>
              <View style={{ height: 6 }} />
              <Text style={styles.heroMeta} numberOfLines={1}>
                {item.location || "Add a location"}
                {dates ? ` • ${dates}` : ""}
              </Text>
            </View>
          </View>
        )}

        <Card.Content style={{ paddingTop: 14 }}>
          <View style={styles.moneyRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Total Saved</Text>
              <Text style={styles.bigMoney}>
                {formatCurrency(savedVal)}
              </Text>
              <Text style={styles.muted}>
                {goalVal > 0 ? `of ${formatCurrency(goalVal)}` : "Set a goal to track funding"}
              </Text>
            </View>

            <View style={styles.memberStackWrap}>
              <View style={styles.avatarStack}>
                {topMembers.map((uid, idx) => (
                  <AvatarCircle
                    key={uid}
                    index={idx}
                    label={shortUid(uid)}
                  />
                ))}
                {extra > 0 ? (
                  <View style={[styles.morePill, { marginLeft: -10 }]}>
                    <Text style={styles.morePillText}>+{extra}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.membersLabel}>
                Members: {memberIds.length}
              </Text>
            </View>
          </View>

          <View style={{ height: 14 }} />

          <ProgressBar
            progress={pct}
            style={styles.progress}
          />

          <View style={styles.progressMeta}>
            <Text style={styles.muted}>
              {goalVal > 0 ? `${Math.round(pct * 100)}% funded` : ""}
            </Text>
          </View>

          <View style={{ height: 14 }} />

          <View style={styles.ctaRow}>
            <Button mode="contained" style={styles.ctaPrimary} onPress={() => {}}>
              Contribute
            </Button>
            <Button mode="outlined" style={styles.ctaSecondary} onPress={() => {}}>
              Record Expense
            </Button>
          </View>
        </Card.Content>
      </Card>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text variant="headlineSmall" style={styles.title}>
            Group Trips
          </Text>
          <Text style={styles.subtitle}>
            Plan, save, and travel together.
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>

        <Button mode="contained" icon="plus" onPress={openCreate}>
          New Trip
        </Button>
      </View>

      <FlatList
        data={trips}
        keyExtractor={(t) => t.id}
        renderItem={renderTrip}
        contentContainerStyle={trips.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <Card style={{ borderRadius: 16 }}>
            <Card.Content>
              <Text style={{ fontWeight: "900", marginBottom: 6 }}>
                You don’t have any trips yet.
              </Text>
              <Text style={styles.muted}>
                Create your first trip to start tracking shared savings and expenses.
              </Text>
              <View style={{ height: 12 }} />
              <Button mode="contained" icon="plus" onPress={openCreate}>
                New Trip
              </Button>
            </Card.Content>
          </Card>
        }
      />

      <Portal>
        <Dialog visible={createVisible} onDismiss={closeCreate}>
          <Dialog.Title>New Trip</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Trip title (required)"
              value={title}
              onChangeText={setTitle}
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Location (optional)"
              value={location}
              onChangeText={setLocation}
              style={{ marginBottom: 12 }}
            />

            <View style={styles.formRow}>
              <TextInput
                label="Goal (optional)"
                value={goal}
                onChangeText={setGoal}
                keyboardType="numeric"
                style={[styles.formHalf, { marginRight: 8 }]}
              />
              <TextInput
                label="Starting saved"
                value={saved}
                onChangeText={setSaved}
                keyboardType="numeric"
                style={styles.formHalf}
              />
            </View>

            <TextInput
              label="Cover image URL (optional)"
              value={coverPhotoURL}
              onChangeText={setCoverPhotoURL}
              autoCapitalize="none"
              style={{ marginBottom: 12 }}
            />

            <View style={styles.formRow}>
              <TextInput
                label="Start date (YYYY-MM-DD)"
                value={startDate}
                onChangeText={setStartDate}
                style={[styles.formHalf, { marginRight: 8 }]}
              />
              <TextInput
                label="End date (YYYY-MM-DD)"
                value={endDate}
                onChangeText={setEndDate}
                style={styles.formHalf}
              />
            </View>

            <Text style={[styles.muted, { marginTop: 8 }]}>
              Tip: You can leave goal empty for now and set it later.
            </Text>
          </Dialog.Content>

          <Dialog.Actions>
            <Button onPress={closeCreate}>Cancel</Button>
            <Button
              mode="contained"
              onPress={onCreateTrip}
              disabled={!canCreate}
              loading={submitting}
            >
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: "#F6F7FB" },

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  title: { fontWeight: "900" },
  subtitle: { opacity: 0.7, marginTop: 2 },
  error: { marginTop: 8, color: "#B91C1C", fontWeight: "700" },
  muted: { opacity: 0.7 },

  emptyContainer: { flexGrow: 1, justifyContent: "center" },

  tripCard: {
    borderRadius: 18,
    marginBottom: 14,
    overflow: "hidden",
    backgroundColor: "white",
  },

  heroWrap: {
    height: 170,
    position: "relative",
    backgroundColor: "#111827",
  },
  heroImg: { width: "100%", height: "100%" },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  heroTopRight: {
    position: "absolute",
    top: 12,
    right: 12,
  },
  heroBottom: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 12,
  },
  heroTitle: {
    color: "white",
    fontWeight: "900",
    fontSize: 24,
    letterSpacing: 0.2,
  },
  heroMetaRow: { flexDirection: "row", flexWrap: "wrap" },
  heroMeta: { color: "rgba(255,255,255,0.85)", fontWeight: "700" },

  heroFallback: {
    height: 170,
    backgroundColor: "#0F172A",
    position: "relative",
    justifyContent: "flex-end",
  },
  heroBottomFallback: {
    paddingHorizontal: 14,
    paddingBottom: 12,
  },

  pill: { borderRadius: 999, backgroundColor: "rgba(255,255,255,0.92)" },
  pillText: { fontWeight: "900" },

  label: { opacity: 0.65, fontWeight: "800" },
  bigMoney: { fontSize: 30, fontWeight: "900", marginTop: 2 },

  moneyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  progress: {
    height: 10,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.08)",
  },
  progressMeta: {
    marginTop: 10,
    flexDirection: "row",
    justifyContent: "flex-end",
  },

  ctaRow: { flexDirection: "row", gap: 10 },
  ctaPrimary: { flex: 1, borderRadius: 14 },
  ctaSecondary: { flex: 1, borderRadius: 14 },

  memberStackWrap: { alignItems: "flex-end" },
  membersLabel: { marginTop: 8, opacity: 0.7, fontWeight: "700" },

  avatarStack: { flexDirection: "row", alignItems: "center" },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: "#E5E7EB",
    borderWidth: 2,
    borderColor: "white",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 11, fontWeight: "900", color: "#111827" },
  morePill: {
    height: 28,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: "#EEF2FF",
    alignItems: "center",
    justifyContent: "center",
  },
  morePillText: { fontSize: 11, fontWeight: "900", color: "#3730A3" },

  formRow: { flexDirection: "row" },
  formHalf: { flex: 1 },
});
