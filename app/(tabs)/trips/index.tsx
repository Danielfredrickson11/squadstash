import {
  addDoc,
  collection,
  doc,
  DocumentData,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
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

import { db } from "../../../firebase";
import { useAuth } from "../../../src/contexts/AuthContext";

type Trip = {
  id: string;
  title: string;
  location?: string | null;

  target: number;
  saved: number;

  createdAt?: any;

  ownerId: string;
  memberIds: string[];

  lastUpdatedAt?: any;
  lastUpdatedBy?: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(n, max));
}

function formatCurrency(n: number) {
  const v = Number(n) || 0;
  try {
    return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

export default function TripsScreen() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [trips, setTrips] = useState<Trip[]>([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create Trip dialog
  const [createVisible, setCreateVisible] = useState(false);
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [target, setTarget] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Contribute dialog
  const [contributeVisible, setContributeVisible] = useState(false);
  const [contributeTrip, setContributeTrip] = useState<Trip | null>(null);
  const [contributeAmount, setContributeAmount] = useState("");
  const [contributeSubmitting, setContributeSubmitting] = useState(false);
  const [contributeError, setContributeError] = useState<string | null>(null);

  const goCreate = () => router.push("/(tabs)/trips/create");
  const openTrip = (tripId: string) => router.push(`/(tabs)/trips/${tripId}`);

  const canCreate = useMemo(() => {
    if (!user) return false;
    if (!title.trim()) return false;
    const t = Number(target);
    if (!Number.isFinite(t) || t <= 0) return false;
    return !creating;
  }, [user, title, target, creating]);

  // ✅ Trips listener
  useEffect(() => {
    if (loading) return;

    if (!user) {
      setTrips([]);
      setFetching(false);
      setError(null);
      return;
    }

    setFetching(true);
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
            target: Number(d.target) || 0,
            saved: Number(d.saved) || 0,
            createdAt: d.createdAt,
            ownerId: String(d.ownerId ?? ""),
            memberIds: Array.isArray(d.memberIds) ? d.memberIds : [],
            lastUpdatedAt: d.lastUpdatedAt,
            lastUpdatedBy: d.lastUpdatedBy,
          });
        });
        setTrips(next);
        setFetching(false);
      },
      (err) => {
        console.error("Trips snapshot error:", err);
        setError("Missing or insufficient permissions.");
        setTrips([]);
        setFetching(false);
      }
    );

    return () => unsub();
  }, [loading, user]);

  // --- Create Trip helpers ---
  const openCreateDialog = () => {
    setCreateVisible(true);
    setCreateError(null);
  };

  const closeCreate = () => {
    setCreateVisible(false);
    setTitle("");
    setLocation("");
    setTarget("");
    setCreateError(null);
  };

  const onCreateTrip = async () => {
    if (loading || !user) return;

    const t = Number(target);
    if (!title.trim()) {
      setCreateError("Please enter a trip name.");
      return;
    }
    if (!Number.isFinite(t) || t <= 0) {
      setCreateError("Target must be a number greater than 0.");
      return;
    }

    setCreating(true);
    setCreateError(null);

    try {
      const ref = await addDoc(collection(db, "trips"), {
        title: title.trim(),
        location: location.trim() ? location.trim() : null,
        target: t,
        saved: 0,

        createdAt: serverTimestamp(),
        ownerId: user.uid,
        memberIds: [user.uid],

        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
      });

      closeCreate();
      // Optional: open the new trip
      openTrip(ref.id);
    } catch (e: any) {
      console.error("Failed to create trip:", e);
      setCreateError("Failed to create trip (permissions).");
    } finally {
      setCreating(false);
    }
  };

  // --- Contribute helpers ---
  const openContribute = (trip: Trip) => {
    setContributeTrip(trip);
    setContributeAmount("");
    setContributeError(null);
    setContributeVisible(true);
  };

  const closeContribute = () => {
    setContributeVisible(false);
    setContributeTrip(null);
    setContributeAmount("");
    setContributeError(null);
  };

  const quickContribute = async (trip: Trip, amt: number) => {
    if (!user) return;
    try {
      const ref = doc(db, "trips", trip.id);
      await updateDoc(ref, {
        saved: increment(amt),
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
      });
    } catch (e) {
      console.error("Quick contribute failed:", e);
      setError("Failed to contribute (permissions).");
    }
  };

  const onConfirmContribute = async () => {
    if (!user || !contributeTrip) return;

    const amt = Number(contributeAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setContributeError("Enter a valid amount greater than 0.");
      return;
    }

    setContributeSubmitting(true);
    setContributeError(null);

    try {
      const ref = doc(db, "trips", contributeTrip.id);
      await updateDoc(ref, {
        saved: increment(amt),
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
      });
      closeContribute();
    } catch (e) {
      console.error("Contribute failed:", e);
      setContributeError("Failed to contribute (permissions).");
    } finally {
      setContributeSubmitting(false);
    }
  };

  const renderTrip = ({ item }: { item: Trip }) => {
    const pct = item.target > 0 ? clamp(item.saved / item.target, 0, 1) : 0;
    const remaining = Math.max(
      0,
      (Number(item.target) || 0) - (Number(item.saved) || 0)
    );

    return (
      <Card style={styles.card} mode="elevated">
        <Card.Content>
          <View style={styles.topRow}>
            <View style={{ flex: 1 }}>
              <Text
                variant="titleMedium"
                style={styles.tripTitle}
                numberOfLines={1}
              >
                {item.title?.trim() ? item.title.trim() : "Untitled Trip"}
              </Text>

              {!!item.location?.trim() ? (
                <Text style={styles.muted} numberOfLines={1}>
                  {item.location}
                </Text>
              ) : (
                <Text style={styles.muted}> </Text>
              )}
            </View>

            <Chip style={styles.membersPill} compact>
              {item.memberIds?.length ?? 1} member
              {(item.memberIds?.length ?? 1) === 1 ? "" : "s"}
            </Chip>
          </View>

          <View style={styles.amountRow}>
            <Text style={styles.bigAmount}>{formatCurrency(item.saved)}</Text>
            <Text style={styles.ofAmount}> / {formatCurrency(item.target)}</Text>
          </View>

          <ProgressBar progress={pct} style={styles.progress} />

          <View style={styles.metaRow}>
            <Text style={styles.muted}>{Math.round(pct * 100)}% funded</Text>
            <Text style={styles.muted}>
              {formatCurrency(remaining)} remaining
            </Text>
          </View>

          <View style={styles.ctaRow}>
            <Button
              mode="contained"
              style={styles.ctaPrimary}
              onPress={() => openTrip(item.id)}
            >
              Open
            </Button>

            <Button
              mode="outlined"
              style={styles.ctaSecondary}
              onPress={() => openContribute(item)}
            >
              Contribute
            </Button>
          </View>

          <View style={{ height: 10 }} />

          <View style={styles.quickRow}>
            <Chip
              onPress={() => quickContribute(item, 25)}
              style={styles.quickChip}
            >
              + $25
            </Chip>
            <Chip
              onPress={() => quickContribute(item, 50)}
              style={styles.quickChip}
            >
              + $50
            </Chip>
            <Chip
              onPress={() => quickContribute(item, 200)}
              style={styles.quickChip}
            >
              + $200
            </Chip>
          </View>
        </Card.Content>
      </Card>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text variant="headlineSmall" style={styles.headerTitle}>
            Trips
          </Text>
          <Text style={styles.headerSubtitle}>
            Plan together, save together, and stay on track.
          </Text>
        </View>

        <Button
          mode="contained"
          icon="plus"
          onPress={goCreate}
          disabled={!user || loading}
        >
          New Trip
        </Button>
      </View>

      {error ? (
        <Card style={styles.noticeCard}>
          <Card.Content>
            <Text style={{ fontWeight: "900", marginBottom: 6 }}>
              Can’t load trips
            </Text>
            <Text style={styles.muted}>{error}</Text>
          </Card.Content>
        </Card>
      ) : null}

      {fetching ? (
        <Card style={styles.noticeCard}>
          <Card.Content>
            <Text style={{ fontWeight: "900", marginBottom: 6 }}>Loading…</Text>
            <Text style={styles.muted}>Getting your trips.</Text>
          </Card.Content>
        </Card>
      ) : (
        <FlatList
          data={trips}
          keyExtractor={(t) => t.id}
          renderItem={renderTrip}
          contentContainerStyle={
            trips.length === 0 ? styles.emptyContainer : undefined
          }
          ListEmptyComponent={
            <Card style={styles.noticeCard}>
              <Card.Content>
                <Text style={{ fontWeight: "900", marginBottom: 6 }}>
                  You don’t have any trips yet.
                </Text>
                <Text style={styles.muted}>
                  Create your first trip and start saving with friends.
                </Text>
                <View style={{ height: 12 }} />
                <Button
                  mode="contained"
                  icon="plus"
                  onPress={goCreate}
                  disabled={!user || loading}
                >
                  New Trip
                </Button>
              </Card.Content>
            </Card>
          }
        />
      )}

      {/* Optional inline Create Dialog (you can remove if you only use /create) */}
      <Portal>
        <Dialog visible={createVisible} onDismiss={closeCreate}>
          <Dialog.Title>New Trip</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Trip name"
              value={title}
              onChangeText={(v) => {
                setTitle(v);
                if (createError) setCreateError(null);
              }}
              style={{ marginBottom: 12 }}
            />

            <TextInput
              label="Location (optional)"
              value={location}
              onChangeText={setLocation}
              style={{ marginBottom: 12 }}
            />

            <TextInput
              label="Target amount"
              value={target}
              onChangeText={(v) => {
                setTarget(v);
                if (createError) setCreateError(null);
              }}
              keyboardType="numeric"
              style={{ marginBottom: 6 }}
            />

            {createError ? (
              <Text
                style={{ color: "#B91C1C", fontWeight: "700", marginTop: 8 }}
              >
                {createError}
              </Text>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeCreate}>Cancel</Button>
            <Button
              mode="contained"
              onPress={onCreateTrip}
              disabled={!canCreate}
              loading={creating}
            >
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Contribute Dialog */}
      <Portal>
        <Dialog visible={contributeVisible} onDismiss={closeContribute}>
          <Dialog.Title>Contribute</Dialog.Title>
          <Dialog.Content>
            <Text style={{ marginBottom: 10, opacity: 0.7 }}>
              Trip:{" "}
              <Text style={{ fontWeight: "900" }}>
                {contributeTrip?.title ?? ""}
              </Text>
            </Text>

            <TextInput
              label="Amount"
              value={contributeAmount}
              onChangeText={(v) => {
                setContributeAmount(v);
                if (contributeError) setContributeError(null);
              }}
              keyboardType="numeric"
            />

            {contributeError ? (
              <Text
                style={{ marginTop: 10, color: "#B91C1C", fontWeight: "700" }}
              >
                {contributeError}
              </Text>
            ) : null}

            <View style={{ height: 10 }} />

            <View style={styles.quickRow}>
              <Chip
                onPress={() => setContributeAmount("25")}
                style={styles.quickChip}
              >
                $25
              </Chip>
              <Chip
                onPress={() => setContributeAmount("100")}
                style={styles.quickChip}
              >
                $100
              </Chip>
              <Chip
                onPress={() => setContributeAmount("500")}
                style={styles.quickChip}
              >
                $500
              </Chip>
            </View>
          </Dialog.Content>

          <Dialog.Actions>
            <Button onPress={closeContribute}>Cancel</Button>
            <Button
              mode="contained"
              onPress={onConfirmContribute}
              loading={contributeSubmitting}
              disabled={contributeSubmitting}
            >
              Add
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const GAP = 12;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: "#F6F7FB" },

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  headerTitle: { fontWeight: "900" },
  headerSubtitle: { opacity: 0.7, marginTop: 2 },

  card: {
    borderRadius: 16,
    marginBottom: GAP,
    backgroundColor: "white",
  },

  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 6,
  },
  tripTitle: { fontWeight: "900" },
  membersPill: { borderRadius: 999 },

  amountRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginTop: 10,
    marginBottom: 10,
  },
  bigAmount: { fontWeight: "900", fontSize: 22 },
  ofAmount: { opacity: 0.6 },

  progress: {
    height: 10,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.06)",
  },

  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
    marginBottom: 12,
  },
  muted: { opacity: 0.7 },

  ctaRow: { flexDirection: "row", gap: 10 },
  ctaPrimary: { flex: 1, borderRadius: 12 },
  ctaSecondary: { borderRadius: 12 },

  quickRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  quickChip: { borderRadius: 999 },

  noticeCard: { borderRadius: 16, backgroundColor: "white" },
  emptyContainer: { flexGrow: 1, justifyContent: "center" },
});
