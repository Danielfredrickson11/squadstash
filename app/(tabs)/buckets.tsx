import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  DocumentData,
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Text as RNText,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
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
  target: number;
  balance: number;
  color?: string | null;
  createdAt?: any;

  ownerId: string;
  memberIds: string[];
};

const COLORS = [
  "#2563EB",
  "#10B981",
  "#8B5CF6",
  "#F59E0B",
  "#EF4444",
  "#06B6D4",
  "#EC4899",
  "#0EA5E9",
];

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(n, max));
}

// ✅ Toggle this ON until names show, then set false
const DEBUG_NAME_BOX = false;

export default function BucketsScreen() {
  const { user } = useAuth();
  const { width } = useWindowDimensions();

  const numColumns = useMemo(() => {
    if (width >= 1100) return 3;
    if (width >= 700) return 2;
    return 1;
  }, [width]);

  const [buckets, setBuckets] = useState<Bucket[]>([]);

  // Create dialog
  const [createVisible, setCreateVisible] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [balance, setBalance] = useState("");
  const [color, setColor] = useState<string | null>(COLORS[0]);
  const [submitting, setSubmitting] = useState(false);

  // Edit/Delete state
  const [menuAnchor, setMenuAnchor] = useState<string | null>(null);
  const [editVisible, setEditVisible] = useState(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [editing, setEditing] = useState<Bucket | null>(null);

  // ✅ Members dialog state
  const [membersVisible, setMembersVisible] = useState(false);
  const [membersBucket, setMembersBucket] = useState<Bucket | null>(null);
  const [inviteUid, setInviteUid] = useState("");
  const [membersSubmitting, setMembersSubmitting] = useState(false);

  const canCreate = useMemo(
    () => name.trim().length > 0 && Number(target) > 0 && !submitting,
    [name, target, submitting]
  );

  // Read buckets where user is a member
  useEffect(() => {
    if (!user) return;

    const colRef = collection(db, "buckets");
    const qRef = query(
      colRef,
      where("memberIds", "array-contains", user.uid),
      orderBy("createdAt", "desc")
    );

    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const next: Bucket[] = [];
        snap.forEach((docSnap) => {
          const d = docSnap.data() as DocumentData;
          next.push({
            id: docSnap.id,
            name: String(d.name ?? ""),
            target: Number(d.target) || 0,
            balance: Number(d.balance) || 0,
            color: d.color ?? null,
            createdAt: d.createdAt,
            ownerId: String(d.ownerId ?? ""),
            memberIds: Array.isArray(d.memberIds) ? d.memberIds : [],
          });
        });
        setBuckets(next);

        console.log(
          "BUCKETS SNAPSHOT:",
          next.map((b) => ({ id: b.id.slice(0, 6), name: b.name }))
        );
      },
      (err) => console.error("Buckets snapshot error:", err)
    );

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
      const colRef = collection(db, "buckets");
      await addDoc(colRef, {
        name: name.trim(),
        target: t,
        balance: b,
        color: color ?? null,
        createdAt: serverTimestamp(),
        ownerId: user.uid,
        memberIds: [user.uid],
      });
      closeCreate();
    } catch (e) {
      console.error("Failed to add bucket:", e);
    } finally {
      setSubmitting(false);
    }
  };

  // Menu helpers
  const openMenu = (bucketId: string) => setMenuAnchor(bucketId);
  const closeMenu = () => setMenuAnchor(null);

  // Edit
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
      const ref = doc(db, "buckets", editing.id);
      await updateDoc(ref, {
        name: String(editing.name ?? "").trim(),
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
      if (editing.ownerId !== user.uid) {
        console.warn("Only the owner can delete this bucket.");
        return;
      }
      const ref = doc(db, "buckets", editing.id);
      await deleteDoc(ref);
      closeDelete();
    } catch (e) {
      console.error("Failed to delete bucket:", e);
    } finally {
      setSubmitting(false);
    }
  };

  // Quick add
  const quickAdd = async (bucket: Bucket, amount: number) => {
    if (!user) return;
    const nextBalance = (Number(bucket.balance) || 0) + amount;
    try {
      const ref = doc(db, "buckets", bucket.id);
      await updateDoc(ref, { balance: nextBalance });
    } catch (e) {
      console.error("Failed to quick add:", e);
    }
  };

  // ✅ Members dialog
  const openMembers = (b: Bucket) => {
    setMembersBucket(b);
    setInviteUid("");
    setMembersVisible(true);
    closeMenu();
  };

  const closeMembers = () => {
    setMembersVisible(false);
    setMembersBucket(null);
    setInviteUid("");
  };

  const inviteMemberByUid = async () => {
    if (!user || !membersBucket) return;

    const uid = inviteUid.trim();
    if (!uid) return;

    if (membersBucket.ownerId !== user.uid) {
      console.warn("Only the owner can add members.");
      return;
    }

    setMembersSubmitting(true);
    try {
      const ref = doc(db, "buckets", membersBucket.id);
      await updateDoc(ref, {
        memberIds: arrayUnion(uid),
      });
      setInviteUid("");
    } catch (e) {
      console.error("Failed to invite member:", e);
    } finally {
      setMembersSubmitting(false);
    }
  };

  const removeMember = async (uidToRemove: string) => {
    if (!user || !membersBucket) return;

    if (membersBucket.ownerId !== user.uid) {
      console.warn("Only the owner can remove members.");
      return;
    }

    if (uidToRemove === membersBucket.ownerId) {
      console.warn("Owner cannot be removed.");
      return;
    }

    setMembersSubmitting(true);
    try {
      const ref = doc(db, "buckets", membersBucket.id);
      await updateDoc(ref, {
        memberIds: arrayRemove(uidToRemove),
      });
    } catch (e) {
      console.error("Failed to remove member:", e);
    } finally {
      setMembersSubmitting(false);
    }
  };

  const renderItem = ({ item }: { item: Bucket }) => {
    const accent = item.color ?? COLORS[0];
    const pct = item.target > 0 ? clamp(item.balance / item.target, 0, 1) : 0;

    const isMenuOpen = menuAnchor === item.id;
    const isOwner = !!(user?.uid && item.ownerId === user.uid);

    const displayName = item.name?.trim() ? item.name.trim() : "Untitled";

    return (
      <Card style={styles.card} mode="elevated">
        <Card.Content>
          <View style={styles.cardTopRow}>
            <View style={[styles.iconBubble, { backgroundColor: `${accent}22` }]}>
              <MaterialCommunityIcons name="bullseye-arrow" size={20} color={accent} />
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              <IconButton
                icon="account-multiple"
                size={20}
                onPress={() => openMembers(item)}
              />

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
                <Menu.Item title="Members" onPress={() => openMembers(item)} />
                <Menu.Item title="Edit" onPress={() => startEdit(item)} />
                <Menu.Item
                  title="Delete"
                  onPress={() => startDelete(item)}
                  disabled={!isOwner}
                />
              </Menu>
            </View>
          </View>

          <View style={[styles.nameWrap, DEBUG_NAME_BOX ? styles.debugBox : null]}>
            <RNText style={styles.bucketNameText}>{displayName}</RNText>
          </View>

          <View style={styles.amountRow}>
            <Text style={styles.bigAmount}>{formatCurrency(item.balance)}</Text>
            <Text style={styles.ofAmount}> / {formatCurrency(item.target)}</Text>
          </View>

          <ProgressBar progress={pct} style={styles.progress} color={accent} />

          <View style={styles.completedRow}>
            <Text style={styles.muted}>{Math.round(pct * 100)}% Completed</Text>
          </View>

          <View style={styles.memberMetaRow}>
            <Text style={styles.muted}>
              Members: {item.memberIds?.length ?? 0}
              {isOwner ? " • You’re owner" : ""}
            </Text>
          </View>

          <View style={styles.quickRow}>
            <Button mode="outlined" onPress={() => quickAdd(item, 50)} style={styles.quickBtn} compact>
              + {formatCurrency(50)}
            </Button>
            <Button mode="outlined" onPress={() => quickAdd(item, 100)} style={styles.quickBtn} compact>
              + {formatCurrency(100)}
            </Button>
          </View>
        </Card.Content>
      </Card>
    );
  };

  const currentMembers = membersBucket?.memberIds ?? [];
  const currentIsOwner = !!(user?.uid && membersBucket?.ownerId === user.uid);

  return (
    <View style={styles.container}>
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
        key={numColumns}
        columnWrapperStyle={numColumns > 1 ? styles.row : undefined}
        contentContainerStyle={buckets.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <Card style={{ borderRadius: 12 }}>
            <Card.Content>
              <Text style={{ fontWeight: "700", marginBottom: 6 }}>
                You don’t have any buckets yet.
              </Text>
              <Text style={styles.muted}>Create your first goal to start tracking savings.</Text>
              <View style={{ height: 12 }} />
              <Button mode="contained" icon="plus" onPress={openCreate}>
                New Goal
              </Button>
            </Card.Content>
          </Card>
        }
      />

      {/* ✅ Members Dialog */}
      <Portal>
        <Dialog visible={membersVisible} onDismiss={closeMembers}>
          <Dialog.Title>Bucket Members</Dialog.Title>
          <Dialog.Content>
            <Text style={{ marginBottom: 8, opacity: 0.7 }}>
              Bucket: <Text style={{ fontWeight: "800" }}>{membersBucket?.name || "Untitled"}</Text>
            </Text>

            {!currentIsOwner ? (
              <Text style={{ marginBottom: 12, opacity: 0.7 }}>
                Only the bucket owner can add/remove members (for now).
              </Text>
            ) : (
              <>
                <TextInput
                  label="Invite by UID (for now)"
                  value={inviteUid}
                  onChangeText={setInviteUid}
                  autoCapitalize="none"
                  style={{ marginBottom: 10 }}
                />
                <Button
                  mode="contained"
                  onPress={inviteMemberByUid}
                  loading={membersSubmitting}
                  disabled={!inviteUid.trim()}
                >
                  Add Member
                </Button>
                <View style={{ height: 14 }} />
              </>
            )}

            <Text style={{ fontWeight: "800", marginBottom: 8 }}>Current members</Text>
            {currentMembers.length === 0 ? (
              <Text style={{ opacity: 0.7 }}>No members.</Text>
            ) : (
              currentMembers.map((m) => {
                const short = `${m.slice(0, 6)}…${m.slice(-4)}`;
                const isOwnerMember = membersBucket?.ownerId === m;

                return (
                  <View key={m} style={styles.memberRow}>
                    <Text style={{ flex: 1 }}>
                      {short} {isOwnerMember ? "(owner)" : ""}
                    </Text>

                    {currentIsOwner && !isOwnerMember ? (
                      <Button
                        mode="text"
                        onPress={() => removeMember(m)}
                        loading={membersSubmitting}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </View>
                );
              })
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeMembers}>Done</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

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
              onChangeText={(v) => setEditing((p) => (p ? { ...p, name: v } : p))}
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Target Amount"
              value={editing?.target?.toString() ?? ""}
              onChangeText={(v) =>
                setEditing((p) => (p ? { ...p, target: Number(v) || 0 } : p))
              }
              keyboardType="numeric"
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Balance"
              value={editing?.balance?.toString() ?? ""}
              onChangeText={(v) =>
                setEditing((p) => (p ? { ...p, balance: Number(v) || 0 } : p))
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
                  onPress={() => setEditing((p) => (p ? { ...p, color: c } : p))}
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
            <Text style={{ marginTop: 8, opacity: 0.7 }}>
              Only the bucket owner can delete.
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

  row: { gap: GAP, marginBottom: GAP },

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

  nameWrap: {
    minHeight: 26,
    justifyContent: "center",
    marginBottom: 8,
  },
  bucketNameText: {
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 22,
    color: "#111827",
    flexShrink: 1,
  },

  debugBox: {
    backgroundColor: "yellow",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
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

  memberMetaRow: { marginBottom: 10 },

  quickRow: { flexDirection: "row", gap: 10 },
  quickBtn: { flex: 1, borderRadius: 12 },

  emptyContainer: { flexGrow: 1, justifyContent: "center" },

  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  colorChip: { borderRadius: 999, marginBottom: 8 },
  colorChipSelected: { borderWidth: 2, borderColor: "rgba(0,0,0,0.15)" },

  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.08)",
  },
});
