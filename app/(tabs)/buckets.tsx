import {
  addDoc,
  collection,
  DocumentData,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
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
import { db } from "../../firebase";
import { useAuth } from "../contexts/AuthContext";

type Bucket = {
  id: string;
  name: string;
  target: number;   // goal amount
  balance: number;  // current saved
  color?: string | null;
  createdAt?: any;
};

const COLORS = [
  "#4F46E5", // indigo
  "#06B6D4", // cyan
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EF4444", // red
  "#8B5CF6", // violet
  "#EC4899", // pink
  "#0EA5E9", // sky
];

export default function BucketsScreen() {
  const { user } = useAuth();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [visible, setVisible] = useState(false);

  // form state
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [balance, setBalance] = useState("");
  const [color, setColor] = useState<string | null>(COLORS[0]);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = useMemo(
    () => name.trim().length > 0 && Number(target) > 0 && !submitting,
    [name, target, submitting]
  );

  useEffect(() => {
    if (!user) return;
    const col = collection(db, "users", user.uid, "buckets");
    const q = query(col, orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const next: Bucket[] = [];
      snap.forEach((doc) => {
        const d = doc.data() as DocumentData;
        next.push({
          id: doc.id,
          name: d.name,
          target: Number(d.target) || 0,
          balance: Number(d.balance) || 0,
          color: d.color ?? null,
          createdAt: d.createdAt,
        });
      });
      setBuckets(next);
    });
    return () => unsub();
  }, [user]);

  const openDialog = () => setVisible(true);
  const closeDialog = () => {
    setVisible(false);
    setName("");
    setTarget("");
    setBalance("");
    setColor(COLORS[0]);
  };

  const onAddBucket = async () => {
    if (!user) return;
    setSubmitting(true);
    try {
      const col = collection(db, "users", user.uid, "buckets");
      await addDoc(col, {
        name: name.trim(),
        target: Number(target),
        balance: balance ? Number(balance) : 0,
        color: color ?? null,
        createdAt: serverTimestamp(),
      });
      closeDialog();
    } catch (e) {
      console.error("Failed to add bucket:", e);
    } finally {
      setSubmitting(false);
    }
  };

  const renderItem = ({ item }: { item: Bucket }) => {
    const pct = item.target > 0 ? Math.min(item.balance / item.target, 1) : 0;
    return (
      <Card style={[styles.card, { backgroundColor: item.color ?? "#1F2937" }]} elevation={3}>
        <Card.Content>
          <Text variant="titleMedium" style={styles.cardTitle}>
            {item.name}
          </Text>
          <Text style={styles.sub}>
            ${item.balance.toFixed(2)} / ${item.target.toFixed(2)}
          </Text>
          <ProgressBar progress={pct} style={styles.progress} />
          <Text style={styles.percent}>{Math.round(pct * 100)}%</Text>
        </Card.Content>
      </Card>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text variant="titleLarge">Buckets</Text>
        <Button mode="contained" onPress={openDialog}>
          New
        </Button>
      </View>

      <FlatList
        data={buckets}
        keyExtractor={(b) => b.id}
        renderItem={renderItem}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={buckets.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <Card style={{ borderRadius: 12 }}>
            <Card.Content>
              <Text>You don’t have any buckets yet.</Text>
              <Text>Create your first one to start tracking savings goals.</Text>
            </Card.Content>
          </Card>
        }
      />

      <Portal>
        <Dialog visible={visible} onDismiss={closeDialog}>
          <Dialog.Title>New Bucket</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Name (e.g., Rent, Food, Vacation)"
              value={name}
              onChangeText={setName}
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Target Amount (e.g., 5000)"
              value={target}
              onChangeText={setTarget}
              keyboardType="numeric"
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Starting Balance (optional)"
              value={balance}
              onChangeText={setBalance}
              keyboardType="numeric"
              style={{ marginBottom: 16 }}
            />

            <Text style={{ marginBottom: 8 }}>Color</Text>
            <View style={styles.colorRow}>
              {COLORS.map((c) => (
                <Chip
                  key={c}
                  selected={color === c}
                  onPress={() => setColor(c)}
                  style={[styles.colorChip, { backgroundColor: c }]}
                  textStyle={{ color: "white", fontWeight: "600" }}
                >
                  {color === c ? "Selected" : " "}
                </Chip>
              ))}
            </View>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeDialog}>Cancel</Button>
            <Button mode="contained" onPress={onAddBucket} disabled={!canSubmit} loading={submitting}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const GAP = 12;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: GAP,
  },
  row: {
    justifyContent: "space-between",
    marginBottom: GAP,
  },
  card: {
    flex: 1,
    marginRight: GAP / 2,
    marginLeft: GAP / 2,
    borderRadius: 16,
    minHeight: 140,
  },
  cardTitle: { color: "white", fontWeight: "700", marginBottom: 4 },
  sub: { color: "white", opacity: 0.9, marginBottom: 8 },
  progress: { height: 10, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.3)" },
  percent: { color: "white", textAlign: "right", marginTop: 6, opacity: 0.95 },
  emptyContainer: { flex: 1, justifyContent: "center" },
  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  colorChip: { marginRight: 8, marginBottom: 8, borderRadius: 999 },
});
