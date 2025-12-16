import {
  DocumentData,
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  Chip,
  Dialog,
  IconButton,
  Menu,
  Portal,
  ProgressBar,
  Text,
  TextInput,
} from "react-native-paper";
import { db } from "../../firebase";
import { useAuth } from "../../src/contexts/AuthContext";
import { formatCurrency } from "../../utils/format";

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

  // Create dialog state
  const [createVisible, setCreateVisible] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [balance, setBalance] = useState("");
  const [color, setColor] = useState<string | null>(COLORS[0]);
  const [submitting, setSubmitting] = useState(false);

  // Edit/Delete state
  const [menuAnchor, setMenuAnchor] = useState<string | null>(null); // bucketId whose menu is open
  const [editVisible, setEditVisible] = useState(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [editing, setEditing] = useState<Bucket | null>(null);

  const canCreate = useMemo(
    () => name.trim().length > 0 && Number(target) > 0 && !submitting,
    [name, target, submitting]
  );

  useEffect(() => {
    if (!user) return;
    const col = collection(db, "users", user.uid, "buckets");
    const q = query(col, orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const next: Bucket[] = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data() as DocumentData;
        next.push({
          id: docSnap.id,
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

  // Create
  const openCreate = () => setCreateVisible(true);
  const closeCreate = () => {
    setCreateVisible(false);
    setName("");
    setTarget("");
    setBalance("");
    setColor(COLORS[0]);
  };

  const onAddBucket = async () => {
    if (!user) return;
    // ✅ validate numbers
    const t = Number(target);
    const b = balance ? Number(balance) : 0;
    if (!Number.isFinite(t) || t <= 0) return;
    if (!Number.isFinite(b) || b < 0) return;

    setSubmitting(true);
    try {
      const col = collection(db, "users", user.uid, "buckets");
      await addDoc(col, {
        name: name.trim(),
        target: t,
        balance: b,
        color: color ?? null,
        createdAt: serverTimestamp(),
      });
      closeCreate();
    } catch (e) {
      console.error("Failed to add bucket:", e);
    } finally {
      setSubmitting(false);
    }
  };

  // Edit
  const openMenu = (bucketId: string) => setMenuAnchor(bucketId);
  const closeMenu = () => setMenuAnchor(null);

  const startEdit = (b: Bucket) => {
    setEditing(b);
    closeMenu();
    setEditVisible(true);
  };

  const closeEdit = () => {
    setEditVisible(false);
    setEditing(null);
  };

  const onSaveEdit = async () => {
    if (!user || !editing) return;

    // ✅ validate numbers
    const t = Number(editing.target);
    const b = Number(editing.balance);
    if (!Number.isFinite(t) || t <= 0) return;
    if (!Number.isFinite(b) || b < 0) return;

    setSubmitting(true);
    try {
      const ref = doc(db, "users", user.uid, "buckets", editing.id);
      await updateDoc(ref, {
        name: editing.name.trim(),
        target: t,
        balance: b,
        color: editing.color ?? null,
      });
      closeEdit();
    } catch (e) {
      console.error("Failed to update bucket:", e);
    } finally {
      setSubmitting(false);
    }
  };

  // Delete
  const startDelete = (b: Bucket) => {
    setEditing(b);
    closeMenu();
    setDeleteVisible(true);
  };

  const closeDelete = () => {
    setDeleteVisible(false);
    setEditing(null);
  };

  const onConfirmDelete = async () => {
    if (!user || !editing) return;
    setSubmitting(true);
    try {
      const ref = doc(db, "users", user.uid, "buckets", editing.id);
      await deleteDoc(ref);
      closeDelete();
    } catch (e) {
      console.error("Failed to delete bucket:", e);
    } finally {
      setSubmitting(false);
    }
  };

  const renderItem = ({ item }: { item: Bucket }) => {
    const pct = item.target > 0 ? Math.min(item.balance / item.target, 1) : 0;
    const isMenuOpen = menuAnchor === item.id;

    return (
      <Card style={[styles.card, { backgroundColor: item.color ?? "#1F2937" }]} elevation={3}>
        <Card.Content>
          <View style={styles.cardHeader}>
            <Text variant="titleMedium" style={styles.cardTitle}>
              {item.name}
            </Text>

            <Menu
              visible={isMenuOpen}
              onDismiss={closeMenu}
              anchor={
                <IconButton
                  icon="dots-vertical"
                  iconColor="white"
                  size={20}
                  onPress={() => openMenu(item.id)}
                />
              }
            >
              <Menu.Item title="Edit" onPress={() => startEdit(item)} />
              <Menu.Item title="Delete" onPress={() => startDelete(item)} />
            </Menu>
          </View>

          <Text style={styles.sub}>
            {formatCurrency(item.balance)} / {formatCurrency(item.target)}
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
        <Button mode="contained" onPress={openCreate}>
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

      {/* Create Dialog */}
      <Portal>
        <Dialog visible={createVisible} onDismiss={closeCreate}>
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
            <Button onPress={closeCreate}>Cancel</Button>
            <Button mode="contained" onPress={onAddBucket} disabled={!canCreate} loading={submitting}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Edit Dialog */}
      <Portal>
        <Dialog visible={editVisible} onDismiss={closeEdit}>
          <Dialog.Title>Edit Bucket</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Name"
              value={editing?.name ?? ""}
              onChangeText={(v) => setEditing((prev) => (prev ? { ...prev, name: v } : prev))}
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Target Amount"
              value={editing?.target?.toString() ?? ""}
              onChangeText={(v) =>
                setEditing((prev) => (prev ? { ...prev, target: Number(v) || 0 } : prev))
              }
              keyboardType="numeric"
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Balance"
              value={editing?.balance?.toString() ?? ""}
              onChangeText={(v) =>
                setEditing((prev) => (prev ? { ...prev, balance: Number(v) || 0 } : prev))
              }
              keyboardType="numeric"
              style={{ marginBottom: 16 }}
            />

            <Text style={{ marginBottom: 8 }}>Color</Text>
            <View style={styles.colorRow}>
              {COLORS.map((c) => (
                <Chip
                  key={c}
                  selected={editing?.color === c}
                  onPress={() =>
                    setEditing((prev) => (prev ? { ...prev, color: c } : prev))
                  }
                  style={[styles.colorChip, { backgroundColor: c }]}
                  textStyle={{ color: "white", fontWeight: "600" }}
                >
                  {editing?.color === c ? "Selected" : " "}
                </Chip>
              ))}
            </View>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeEdit}>Cancel</Button>
            <Button mode="contained" onPress={onSaveEdit} loading={submitting}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Delete Confirm */}
      <Portal>
  <Dialog visible={deleteVisible} onDismiss={closeDelete}>
    <Dialog.Title>Delete Bucket</Dialog.Title>
    <Dialog.Content>
      <Text>
        Are you sure you want to delete{" "}
        <Text style={{ fontWeight: "700" }}>{editing?.name}</Text>?
      </Text>
    </Dialog.Content>
    <Dialog.Actions>
      <Button onPress={closeDelete}>Cancel</Button>
      <Button mode="contained" onPress={onConfirmDelete} loading={submitting}>
        Delete
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
    minHeight: 160,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  cardTitle: { color: "white", fontWeight: "700", marginBottom: 4, flex: 1, paddingRight: 6 },
  sub: { color: "white", opacity: 0.9, marginBottom: 8 },
  progress: { height: 10, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.3)" },
  percent: { color: "white", textAlign: "right", marginTop: 6, opacity: 0.95 },
  emptyContainer: { flex: 1, justifyContent: "center" },
  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  colorChip: { marginRight: 8, marginBottom: 8, borderRadius: 999 },
});
