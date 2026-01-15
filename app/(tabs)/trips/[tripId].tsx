import {
  DocumentData,
  doc,
  increment,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Card, ProgressBar, Text } from "react-native-paper";

import { db } from "../../../firebase";
import { useAuth } from "../../../src/contexts/AuthContext";

type Trip = {
  id: string;
  title: string;
  location?: string | null;
  target: number;
  saved: number;
  ownerId: string;
  memberIds: string[];
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

export default function TripDetailScreen() {
  const router = useRouter();
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { user, loading } = useAuth();

  const [trip, setTrip] = useState<Trip | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (loading) return;

    if (!user) {
      setTrip(null);
      setFetching(false);
      setError("You must be logged in.");
      return;
    }

    if (!tripId) {
      setTrip(null);
      setFetching(false);
      setError("Missing tripId.");
      return;
    }

    setFetching(true);
    setError(null);

    const ref = doc(db, "trips", String(tripId));
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setTrip(null);
          setFetching(false);
          setError("Trip not found.");
          return;
        }

        const d = snap.data() as DocumentData;
        setTrip({
          id: snap.id,
          title: String(d.title ?? ""),
          location: d.location ?? null,
          target: Number(d.target) || 0,
          saved: Number(d.saved) || 0,
          ownerId: String(d.ownerId ?? ""),
          memberIds: Array.isArray(d.memberIds) ? d.memberIds : [],
        });

        setFetching(false);
      },
      (err) => {
        console.error("Trip detail snapshot error:", err);
        setTrip(null);
        setFetching(false);
        setError("Missing or insufficient permissions.");
      }
    );

    return () => unsub();
  }, [loading, user, tripId]);

  const pct = useMemo(() => {
    if (!trip?.target) return 0;
    return clamp((trip.saved || 0) / trip.target, 0, 1);
  }, [trip]);

  const remaining = useMemo(() => {
    if (!trip) return 0;
    return Math.max(0, (trip.target || 0) - (trip.saved || 0));
  }, [trip]);

  const contribute = async (amt: number) => {
    if (!user || !trip) return;

    setSubmitting(true);
    setError(null);

    try {
      const ref = doc(db, "trips", trip.id);
      await updateDoc(ref, {
        saved: increment(amt),
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
      });
    } catch (e) {
      console.error("Contribute failed:", e);
      setError("Failed to contribute (permissions).");
    } finally {
      setSubmitting(false);
    }
  };

  if (fetching) {
    return (
      <View style={styles.container}>
        <Card style={styles.card}>
          <Card.Content>
            <Text style={{ fontWeight: "900", marginBottom: 6 }}>Loading…</Text>
            <Text style={styles.muted}>Getting trip details.</Text>
          </Card.Content>
        </Card>
      </View>
    );
  }

  if (!trip) {
    return (
      <View style={styles.container}>
        <Card style={styles.card}>
          <Card.Content>
            <Text style={{ fontWeight: "900", marginBottom: 6 }}>Trip</Text>
            <Text style={styles.muted}>{error ?? "No trip data."}</Text>
            <View style={{ height: 12 }} />
            <Button mode="outlined" onPress={() => router.back()}>
              Go back
            </Button>
          </Card.Content>
        </Card>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Card style={styles.card} mode="elevated">
        <Card.Content>
          <Text variant="titleLarge" style={{ fontWeight: "900" }}>
            {trip.title?.trim() ? trip.title.trim() : "Untitled Trip"}
          </Text>

          {!!trip.location?.trim() ? (
            <Text style={styles.muted}>{trip.location}</Text>
          ) : (
            <Text style={styles.muted}> </Text>
          )}

          <View style={{ height: 12 }} />

          <View style={styles.amountRow}>
            <Text style={styles.bigAmount}>{formatCurrency(trip.saved)}</Text>
            <Text style={styles.ofAmount}> / {formatCurrency(trip.target)}</Text>
          </View>

          <ProgressBar progress={pct} style={styles.progress} />

          <View style={styles.metaRow}>
            <Text style={styles.muted}>{Math.round(pct * 100)}% funded</Text>
            <Text style={styles.muted}>
              {formatCurrency(remaining)} remaining
            </Text>
          </View>

          {error ? (
            <Text style={{ color: "#B91C1C", fontWeight: "700", marginTop: 8 }}>
              {error}
            </Text>
          ) : null}

          <View style={{ height: 14 }} />

          <View style={styles.ctaRow}>
            <Button
              mode="contained"
              style={styles.ctaPrimary}
              onPress={() => contribute(50)}
              loading={submitting}
              disabled={submitting}
            >
              + $50
            </Button>
            <Button
              mode="outlined"
              style={styles.ctaSecondary}
              onPress={() => contribute(200)}
              disabled={submitting}
            >
              + $200
            </Button>
          </View>

          <View style={{ height: 10 }} />

          <Button mode="text" onPress={() => router.back()} disabled={submitting}>
            Back to Trips
          </Button>
        </Card.Content>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: "#F6F7FB" },
  card: { borderRadius: 16, backgroundColor: "white" },
  muted: { opacity: 0.7 },

  amountRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginTop: 6,
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
  },

  ctaRow: { flexDirection: "row", gap: 10 },
  ctaPrimary: { flex: 1, borderRadius: 12 },
  ctaSecondary: { borderRadius: 12 },
});
