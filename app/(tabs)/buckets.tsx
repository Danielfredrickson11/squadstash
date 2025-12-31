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
import { httpsCallable } from "firebase/functions";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Image,
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

import { db, functions } from "../../firebase";
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

type PublicUser = {
  uid: string;
  displayName?: string;
  photoURL?: string;
  emailLower?: string;
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

function initialsFromName(name?: string) {
  const s = (name ?? "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map((p) => (p?.[0] ?? "").toUpperCase()).join("");
}

function shortUid(uid: string) {
  return `${uid.slice(0, 6)}…${uid.slice(-4)}`;
}

function isValidInviteEmail(email: string) {
  const e = email.trim().toLowerCase();
  return e.includes("@") && e.includes(".") && e.length >= 6;
}

function AvatarCircle(props: {
  index: number;
  label: string;
  photoURL?: string;
  size?: number;
}) {
  const { index, label, photoURL, size = 26 } = props;

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: 999,
          marginLeft: index === 0 ? 0 : -10,
        },
      ]}
    >
      {photoURL ? (
        <Image
          source={{ uri: photoURL }}
          style={{ width: size - 2, height: size - 2, borderRadius: 999 }}
        />
      ) : (
        <RNText style={styles.avatarText}>{label}</RNText>
      )}
    </View>
  );
}

export default function BucketsScreen() {
  const { user, loading } = useAuth();
  const { width } = useWindowDimensions();

  const numColumns = useMemo(() => {
    if (width >= 1100) return 3;
    if (width >= 700) return 2;
    return 1;
  }, [width]);

  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [publicUsers, setPublicUsers] = useState<Record<string, PublicUser>>({});

  // Optional: show a friendly message if permissions fail
  const [readError, setReadError] = useState<string | null>(null);

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

  // Members dialog state
  const [membersVisible, setMembersVisible] = useState(false);
  const [membersBucket, setMembersBucket] = useState<Bucket | null>(null);

  // Invite by email
  const [inviteEmail, setInviteEmail] = useState("");
  const [membersSubmitting, setMembersSubmitting] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  const canCreate = useMemo(
    () => name.trim().length > 0 && Number(target) > 0 && !submitting,
    [name, target, submitting]
  );

  // ✅ Buckets listener (ONE listener only, no fallback)
  const didLogRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (!user) return;

    if (!didLogRef.current) {
      didLogRef.current = true;
      console.log("Buckets listener starting for uid:", user.uid, user.email);
    }

    setReadError(null);

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
      },
      (err) => {
        console.error("Buckets snapshot error:", err);
        setReadError(
          "Can’t load buckets (permissions). Double-check Firestore rules."
        );
        // IMPORTANT: do NOT wipe buckets here, so UI doesn’t flicker empty.
      }
    );

    return () => unsub();
  }, [loading, user?.uid]);

  // ✅ publicUsers listener (only for member UIDs we actually have)
  useEffect(() => {
    if (loading) return;
    if (!user) return;

    const allUids = new Set<string>();
    buckets.forEach((b) =>
      (b.memberIds ?? []).forEach((uid) => allUids.add(uid))
    );
    allUids.add(user.uid);

    const uids = Array.from(allUids);
    if (uids.length === 0) return;

    const chunks: string[][] = [];
    for (let i = 0; i < uids.length; i += 30) chunks.push(uids.slice(i, i + 30));

    const unsubs: Array<() => void> = [];

    chunks.forEach((chunk) => {
      const qRef = query(
        collection(db, "publicUsers"),
        where("__name__", "in", chunk)
      );

      const unsub = onSnapshot(
        qRef,
        (snap) => {
          setPublicUsers((prev) => {
            const next = { ...prev };
            snap.forEach((docSnap) => {
              const d = docSnap.data() as any;
              next[docSnap.id] = {
                uid: docSnap.id,
                displayName: String(d.displayName ?? ""),
                photoURL: String(d.photoURL ?? ""),
                emailLower: String(d.emailLower ?? ""),
              };
            });
            return next;
          });
        },
        (err) => console.warn("publicUsers snapshot error:", err)
      );

      unsubs.push(unsub);
    });

    return () => unsubs.forEach((fn) => fn());
  }, [loading, buckets, user?.uid]);

  // Create dialog helpers
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
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
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
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
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

  const quickAdd = async (bucket: Bucket, amount: number) => {
    if (!user) return;
    const nextBalance = (Number(bucket.balance) || 0) + amount;
    try {
      const ref = doc(db, "buckets", bucket.id);
      await updateDoc(ref, {
        balance: nextBalance,
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
      });
    } catch (e) {
      console.error("Failed to quick add:", e);
    }
  };

  const openMembers = (b: Bucket) => {
    setMembersBucket(b);
    setInviteEmail("");
    setMembersError(null);
    setMembersVisible(true);
    closeMenu();
  };

  const closeMembers = () => {
    setMembersVisible(false);
    setMembersBucket(null);
    setInviteEmail("");
    setMembersError(null);
  };

  const currentMembers = membersBucket?.memberIds ?? [];
  const currentIsOwner = !!(user?.uid && membersBucket?.ownerId === user.uid);

  const nameForUid = (uid: string) => {
    const pu = publicUsers[uid];
    const dn = pu?.displayName?.trim();
    return dn || shortUid(uid);
  };

  const avatarForUid = (uid: string) => {
    const pu = publicUsers[uid];
    const dn = pu?.displayName?.trim();
    return {
      label: dn ? initialsFromName(dn) : uid.slice(0, 2).toUpperCase(),
      photoURL: pu?.photoURL?.trim() || "",
    };
  };

  const inviteMemberByEmail = async () => {
    if (!user || !membersBucket) return;

    const email = inviteEmail.trim().toLowerCase();
    if (!isValidInviteEmail(email)) {
      setMembersError("Enter a valid email.");
      return;
    }
    if ((user.email ?? "").toLowerCase() === email) {
      setMembersError("You can’t invite yourself.");
      return;
    }
    if (membersBucket.ownerId !== user.uid) {
      setMembersError("Only the bucket owner can add members.");
      return;
    }

    setMembersSubmitting(true);
    setMembersError(null);

    try {
      const lookup = httpsCallable(functions, "lookupUserByEmail");
      const res = await lookup({ email });

      const data = res.data as any;
      const uid = String(data?.uid ?? "").trim();

      if (!uid) {
        setMembersError("Could not find a user for that email.");
        return;
      }
      if ((membersBucket.memberIds ?? []).includes(uid)) {
        setMembersError("That user is already a member of this bucket.");
        return;
      }

      const ref = doc(db, "buckets", membersBucket.id);
      await updateDoc(ref, {
        memberIds: arrayUnion(uid),
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
      });

      setInviteEmail("");
    } catch (e: any) {
      console.warn("inviteMemberByEmail failed:", e);
      setMembersError("Invite failed. Double-check the email and try again.");
    } finally {
      setMembersSubmitting(false);
    }
  };

  const removeMember = async (uidToRemove: string) => {
    if (!user || !membersBucket) return;

    if (membersBucket.ownerId !== user.uid) {
      setMembersError("Only the bucket owner can remove members.");
      return;
    }
    if (uidToRemove === membersBucket.ownerId) {
      setMembersError("Owner cannot be removed.");
      return;
    }

    setMembersSubmitting(true);
    setMembersError(null);

    try {
      const ref = doc(db, "buckets", membersBucket.id);
      await updateDoc(ref, {
        memberIds: arrayRemove(uidToRemove),
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
      });
    } catch (e) {
      console.error("Failed to remove member:", e);
      setMembersError("Failed to remove member.");
    } finally {
      setMembersSubmitting(false);
    }
  };

  const leaveBucket = async () => {
    if (!user || !membersBucket) return;

    if (membersBucket.ownerId === user.uid) {
      setMembersError("Owners can’t leave. Transfer ownership later.");
      return;
    }

    setMembersSubmitting(true);
    setMembersError(null);

    try {
      const ref = doc(db, "buckets", membersBucket.id);
      await updateDoc(ref, {
        memberIds: arrayRemove(user.uid),
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: user.uid,
      });
      closeMembers();
    } catch (e) {
      console.error("Failed to leave bucket:", e);
      setMembersError("Failed to leave bucket.");
    } finally {
      setMembersSubmitting(false);
    }
  };

  const inviteDisabled = useMemo(() => {
    const email = inviteEmail.trim().toLowerCase();
    if (!currentIsOwner) return true;
    if (!isValidInviteEmail(email)) return true;
    if ((user?.email ?? "").toLowerCase() === email) return true;
    return membersSubmitting;
  }, [inviteEmail, currentIsOwner, user?.email, membersSubmitting]);

  const renderItem = ({ item }: { item: Bucket }) => {
    const accent = item.color ?? COLORS[0];
    const pct = item.target > 0 ? clamp(item.balance / item.target, 0, 1) : 0;

    const isMenuOpen = menuAnchor === item.id;
    const isOwner = !!(user?.uid && item.ownerId === user.uid);
    const displayName = item.name?.trim() ? item.name.trim() : "Untitled";

    const memberIds = item.memberIds ?? [];
    const topMembers = memberIds.slice(0, 3);
    const extraCount = Math.max(0, memberIds.length - topMembers.length);

    return (
      <Card style={styles.card} mode="elevated">
        <Card.Content>
          <View style={styles.cardTopRow}>
            <View style={[styles.iconBubble, { backgroundColor: `${accent}22` }]}>
              <MaterialCommunityIcons name="bullseye-arrow" size={20} color={accent} />
            </View>

            <View style={styles.memberCluster}>
              <Button
                compact
                mode="text"
                onPress={() => openMembers(item)}
                style={{ paddingHorizontal: 0 }}
                contentStyle={{ flexDirection: "row" }}
              >
                <View style={styles.avatarStack}>
                  {topMembers.map((uid, idx) => {
                    const a = avatarForUid(uid);
                    return (
                      <AvatarCircle
                        key={uid}
                        index={idx}
                        label={a.label}
                        photoURL={a.photoURL}
                      />
                    );
                  })}

                  {extraCount > 0 ? (
                    <View style={[styles.morePill, { marginLeft: -10 }]}>
                      <RNText style={styles.morePillText}>+{extraCount}</RNText>
                    </View>
                  ) : null}
                </View>
              </Button>

              <Menu
                visible={isMenuOpen}
                onDismiss={closeMenu}
                anchor={
                  <IconButton icon="dots-horizontal" size={20} onPress={() => openMenu(item.id)} />
                }
              >
                <Menu.Item title="Members" onPress={() => openMembers(item)} />
                <Menu.Item title="Edit" onPress={() => startEdit(item)} />
                <Menu.Item title="Delete" onPress={() => startDelete(item)} disabled={!isOwner} />
              </Menu>
            </View>
          </View>

          <View style={styles.nameWrap}>
            <RNText style={styles.bucketNameText} numberOfLines={1}>
              {displayName}
            </RNText>
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

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text variant="headlineSmall" style={styles.title}>
            Personal Buckets
          </Text>
          <Text style={styles.subtitle}>Track and manage your savings goals.</Text>

          {readError ? (
            <Text style={{ marginTop: 6, color: "#B91C1C" }}>{readError}</Text>
          ) : null}
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

      {/* Members Dialog */}
      <Portal>
        <Dialog visible={membersVisible} onDismiss={closeMembers}>
          <Dialog.Title>Bucket Members</Dialog.Title>
          <Dialog.Content>
            <Text style={{ marginBottom: 8, opacity: 0.7 }}>
              Bucket:{" "}
              <Text style={{ fontWeight: "800" }}>{membersBucket?.name || "Untitled"}</Text>
            </Text>

            {!currentIsOwner ? (
              <>
                <Text style={{ marginBottom: 12, opacity: 0.7 }}>
                  Only the bucket owner can add/remove members.
                </Text>

                <Button
                  mode="outlined"
                  onPress={leaveBucket}
                  loading={membersSubmitting}
                  disabled={membersSubmitting}
                >
                  Leave Bucket
                </Button>

                <View style={{ height: 12 }} />
              </>
            ) : (
              <>
                <TextInput
                  label="Invite by email"
                  value={inviteEmail}
                  onChangeText={(v) => {
                    setInviteEmail(v);
                    if (membersError) setMembersError(null);
                  }}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  style={{ marginBottom: 10 }}
                />

                {membersError ? (
                  <Text style={{ color: "#B91C1C", marginBottom: 8 }}>{membersError}</Text>
                ) : null}

                <Button
                  mode="contained"
                  onPress={inviteMemberByEmail}
                  loading={membersSubmitting}
                  disabled={inviteDisabled}
                >
                  Invite
                </Button>

                <View style={{ height: 14 }} />
              </>
            )}

            <Text style={{ fontWeight: "800", marginBottom: 8 }}>Current members</Text>

            {currentMembers.length === 0 ? (
              <Text style={{ opacity: 0.7 }}>No members.</Text>
            ) : (
              currentMembers.map((uid) => {
                const isOwnerMember = membersBucket?.ownerId === uid;
                const a = avatarForUid(uid);
                const display = nameForUid(uid);

                return (
                  <View key={uid} style={styles.memberRow}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                      <AvatarCircle index={0} label={a.label} photoURL={a.photoURL} size={30} />

                      <View style={{ flex: 1 }}>
                        <Text style={{ fontWeight: "700" }}>
                          {display} {isOwnerMember ? "(owner)" : ""}
                        </Text>
                        <Text style={{ opacity: 0.6, fontSize: 12 }}>{shortUid(uid)}</Text>
                      </View>
                    </View>

                    {currentIsOwner && !isOwnerMember ? (
                      <Button
                        mode="text"
                        onPress={() => removeMember(uid)}
                        loading={membersSubmitting}
                        disabled={membersSubmitting}
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
              onChangeText={(v) => setEditing((p) => (p ? { ...p, target: Number(v) || 0 } : p))}
              keyboardType="numeric"
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label="Balance"
              value={editing?.balance?.toString() ?? ""}
              onChangeText={(v) => setEditing((p) => (p ? { ...p, balance: Number(v) || 0 } : p))}
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
            <Text style={{ marginTop: 8, opacity: 0.7 }}>Only the bucket owner can delete.</Text>
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

  amountRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginBottom: 10,
  },
  bigAmount: { fontWeight: "900", fontSize: 22 },
  ofAmount: { opacity: 0.6 },

  progress: {
    height: 10,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.06)",
  },

  completedRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 10,
    marginBottom: 12,
  },
  muted: { opacity: 0.7 },

  memberMetaRow: { marginBottom: 10 },

  memberCluster: { flexDirection: "row", alignItems: "center", gap: 6 },
  avatarStack: { flexDirection: "row", alignItems: "center" },
  avatar: {
    borderWidth: 2,
    borderColor: "white",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E5E7EB",
    overflow: "hidden",
  },
  avatarText: { fontSize: 11, fontWeight: "800", color: "#111827" },
  morePill: {
    height: 26,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: "#EEF2FF",
    alignItems: "center",
    justifyContent: "center",
  },
  morePillText: { fontSize: 11, fontWeight: "800", color: "#3730A3" },

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
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.08)",
    gap: 10,
  },
});
