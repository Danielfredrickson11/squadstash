import { useRouter } from "expo-router";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Card, Text, TextInput } from "react-native-paper";

import { db } from "../../../firebase";
import { useAuth } from "../../../src/contexts/AuthContext";

export default function CreateTripScreen() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [target, setTarget] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = useMemo(() => {
    if (loading || !user) return false;
    if (!title.trim()) return false;
    const t = Number(target);
    if (!Number.isFinite(t) || t <= 0) return false;
    return !submitting;
  }, [loading, user, title, target, submitting]);

  const onSave = async () => {
    if (loading || !user) return;

    const t = Number(target);
    if (!title.trim()) {
      setError("Please enter a trip name.");
      return;
    }
    if (!Number.isFinite(t) || t <= 0) {
      setError("Target must be a number greater than 0.");
      return;
    }

    setSubmitting(true);
    setError(null);

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

      router.replace(`/(tabs)/trips/${ref.id}`);
    } catch (e) {
      console.error("Create trip failed:", e);
      setError("Failed to create trip (permissions).");
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = () => router.back();

  return (
    <View style={styles.container}>
      <Card style={styles.card} mode="elevated">
        <Card.Title title="Create Trip" />
        <Card.Content>
          <TextInput
            label="Trip name"
            value={title}
            onChangeText={(v) => {
              setTitle(v);
              if (error) setError(null);
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
              if (error) setError(null);
            }}
            keyboardType="numeric"
            style={{ marginBottom: 6 }}
          />

          {error ? (
            <Text style={{ marginTop: 10, color: "#B91C1C", fontWeight: "700" }}>
              {error}
            </Text>
          ) : null}
        </Card.Content>

        <Card.Actions>
          <Button onPress={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            mode="contained"
            onPress={onSave}
            disabled={!canSave}
            loading={submitting}
          >
            Save
          </Button>
        </Card.Actions>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: "#F6F7FB" },
  card: { borderRadius: 16, backgroundColor: "white" },
});
