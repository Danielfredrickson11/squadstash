import React, { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, View, useWindowDimensions } from "react-native";
import {
  Button,
  Card,
  Dialog,
  IconButton,
  Menu,
  Portal,
  ProgressBar,
  Text,
  TextInput,
  Chip,
} from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
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
import { db } from "../../firebase";
import { useAuth } from "../../src/contexts/AuthContext";
import { formatCurrency } from "../../utils/format";

type Bucket = {
  id: string;
  name: string;
  target: number; // goal amount
  balance: number; // current saved
  color?: string | null; // accent color
  createdAt?: any;
};

const COLORS = [
  "#2563EB", // blue
  "#10B981", // emerald
  "#8B5CF6", // violet
  "#F59E0B", // amber
  "#EF4444", // red
  "#06B6D4", // cyan
  "#EC4899", // pink
  "#0EA5E9", // sky
];

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(n, max));
}

export default function BucketsScreen() {
  const { user } = useAuth();
  const { width } = useWindowDimensions();

  // Responsive columns (web can show 3 like your screenshot)
  const numColumns = useMemo(() => {
    if (width >= 1100) return 3;
    if (width >= 700) return 2;
    return 1;
  }, [width]);

  const [buckets, setBuckets] = useState<Bucket[]>([]);

  // Create dialog state
  const [createVisible, setCreateVisible] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [balance, setBalance] = useState("");
  const [color, setColor] = useState<string | null>(COLORS[0]);
  const [submitting, setSubmitting] = useState(false);

  // Edit/Delete state
  const [menuAnchor, setMenuAnchor] = useState<string | null>(null); // bucketId
  const [editVisible, setEditVisible] = useState(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [editing, setEditing] = useState<Bucket | null>(null);

  const canCreate = useMemo(
    () => name.trim().length > 0 && Number(target) > 0 && !submitting,
    [name, target, submitting]
  );

  useEffect(() => {
    if (!user) return;

    const colRef = collection(db, "users", user.uid, "buckets");
    const qRef = query(colRef, orderBy("createdAt", "desc"));

    const unsub = onSnapshot(qRef, (snap) => {
      const next: Bucket[] = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data() as DocumentData;
        next.push({
          id: docSnap.id,
          name: String(d.name ?? "Untitled"),
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

    const t = Number(target);
    const b = balance ? Number(balance) : 0;

    if (!Number.isFinite(t) || t <= 0) return;
    if (!Number.isFinite(b) || b < 0) return;

    setSubmitting(true);
    try {
      const colRef = collection(db, "users", user.uid, "buckets");
      await addDoc(colRef, {
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

  // Edit/Delete menu
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

  // Quick add (+$50 / +$100)
  const quickAdd = async (bucket: Bucket, amount: number) => {
    if (!user) return;
    const nextBalance = (Number(bucket.balance) || 0) + amount;

    try {
      const ref = doc(db, "users", user.uid, "buckets", bucket.id);
      await updateDoc(ref, { balance: nextBalance });
    } catch (e) {
      console.error("Failed to quick add:", e);
    }
  };

  const renderItem = ({ item }: { item: Bucket }) => {
    const accent = item.color ?? COLORS[0];
    const pct = item.target > 0 ? clamp(item.balance / item.target, 0, 1) : 0;

    const isMenuOpen = menuAnchor === item.id;

    return (
      <Card style={styles.card} mode="elevated">
        <Card.Content>
          {/* Top row: icon bubble + menu */}
          <View style={styles.cardTopRow}>
            <View style={[styles.iconBubble, { backgroundColor: `${accent}22` }]}>
              <MaterialCommunityIcons name="bullseye-arrow" size={20} color={accent} />
            </View>

            <Menu
              visible={isMenuOpen}
              onDismiss={closeMenu}
              anchor={
                <IconButton
                  icon="dots-horizontal"
                  size={20}
                  onPress={() => openMenu(item.id)}
                />
              }
            >
              <Menu.Item title="Edit" onPress={() => startEdit(item)} />
              <Menu.Item title="Delete" onPress={() => startDelete(item)} />
            </Menu>
          </View>

          {/* Name */}
          <Text style={styles.bucketName} numberOfLines={1}>
            {item.name}
          </Text>

          {/* Big amount */}
          <View style={styles.amountRow}>
            <Text style={styles.bigAmount}>{formatCurrency(item.balance)}</Text>
            <Text style={styles.ofAmount}> / {formatCurrency(item.target)}</Text>
          </View>

          {/* Progress */}
          <ProgressBar progress={pct} style={styles.progress} color={accent} />

          <View style={styles.completedRow}>
            <Text style={styles.muted}>{Math.round(pct * 100)}% Completed</Text>
          </View>

          {/* Quick add buttons */}
          <View style={styles.quickRow}>
            <Button
              mode="outlined"
              onPress={() => quickAdd(item, 50)}
              style={styles.quickBtn}
              compact
            >
              + {formatCurrency(50)}
            </Button>
            <Button
              mode="outlined"
              onPress={() => quickAdd(item, 100)}
              style={styles.quickBtn}
              compact
            >
              + {formatCurrency(100)}
            </Button>
          </View>
        </Card.Content>
      </Card>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header like your screenshot */}
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text variant="headlineSmall" style={styles.title}>
            Personal Buckets
          </Text>
          <Text style={styles.subtitle}>Track and manage your savings goals.</Text>
        </View>

        <Button mode="contained" icon="plus" onPress={openCreate}>
          New Goal
        </Button>
      </View>

      <FlatList
        data={buckets}
        keyExtractor={(b) => b.id}
        renderItem={renderItem}
        numColumns={numColumns}
        key={numColumns} // forces layout recalculation when columns change
        columnWrapperStyle={numColumns > 1 ? styles.row : undefined}
        contentContainerStyle={buckets.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <Card style={{ borderRadius: 12 }}>
            <Card.Content>
              <Text style={{ fontWeight: "700", marginBottom: 6 }}>
                You don’t have any buckets yet.
              </Text>
              <Text style={styles.muted}>
                Create your first goal to start tracking savings.
              </Text>
              <View style={{ height: 12 }} />
              <Button mode="contained" icon="plus" onPress={openCreate}>
                New Goal
              </Button>
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

            <Text style={{ marginBottom: 8 }}>Accent Color</Text>
            <View style={styles.colorRow}>
              {COLORS.map((c) => (
                <Chip
                  key={c}
                  selected={color === c}
                  onPress={() => setColor(c)}
                  style={[
                    styles.colorChip,
                    { backgroundColor: c },
                    color === c ? styles.colorChipSelected : null,
                  ]}
                  textStyle={{ color: "white", fontWeight: "700" }}
                >
                  {color === c ? "Selected" : " "}
                </Chip>
              ))}
            </View>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeCreate}>Cancel</Button>
            <Button
              mode="contained"
              onPress={onAddBucket}
              disabled={!canCreate}
              loading={submitting}
            >
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
              onChangeText={(v) =>
                setEditing((prev) => (prev ? { ...prev, name: v } : prev))
              }
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Target Amount"
              value={editing?.target?.toString() ?? ""}
              onChangeText={(v) =>
                setEditing((prev) =>
                  prev ? { ...prev, target: Number(v) || 0 } : prev
                )
              }
              keyboardType="numeric"
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Balance"
              value={editing?.balance?.toString() ?? ""}
              onChangeText={(v) =>
                setEditing((prev) =>
                  prev ? { ...prev, balance: Number(v) || 0 } : prev
                )
              }
              keyboardType="numeric"
              style={{ marginBottom: 16 }}
            />

            <Text style={{ marginBottom: 8 }}>Accent Color</Text>
            <View style={styles.colorRow}>
              {COLORS.map((c) => (
                <Chip
                  key={c}
                  selected={editing?.color === c}
                  onPress={() =>
                    setEditing((prev) => (prev ? { ...prev, color: c } : prev))
                  }
                  style={[
                    styles.colorChip,
                    { backgroundColor: c },
                    editing?.color === c ? styles.colorChipSelected : null,
                  ]}
                  textStyle={{ color: "white", fontWeight: "700" }}
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
              <Text style={{ fontWeight: "800" }}>{editing?.name}</Text>?
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
  container: { flex: 1, padding: 16, backgroundColor: "#F6F7FB" },

  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  title: { fontWeight: "900" },
  subtitle: { opacity: 0.7, marginTop: 2 },

  row: {
    gap: GAP,
    marginBottom: GAP,
  },

  card: {
    flex: 1,
    borderRadius: 16,
    marginBottom: GAP,
    backgroundColor: "white",
  },

  cardTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  iconBubble: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },

  bucketName: {
    fontWeight: "900",
    fontSize: 18,
    marginBottom: 8,
  },

  amountRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginBottom: 10,
  },
  bigAmount: { fontWeight: "900", fontSize: 22 },
  ofAmount: { opacity: 0.6 },

  progress: { height: 10, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.06)" },

  completedRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 10,
    marginBottom: 12,
  },
  muted: { opacity: 0.7 },

  quickRow: {
    flexDirection: "row",
    gap: 10,
  },
  quickBtn: { flex: 1, borderRadius: 12 },

  emptyContainer: { flexGrow: 1, justifyContent: "center" },

  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  colorChip: { borderRadius: 999, marginBottom: 8 },
  colorChipSelected: { borderWidth: 2, borderColor: "rgba(0,0,0,0.15)" },
});
