import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import {
  Button,
  Card,
  Chip,
  Dialog,
  Portal,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";

import { AvatarCircle, initialsFromName, shortUid } from "../../../components/buckets/AvatarCircle";
import { BucketCard } from "../../../components/buckets/BucketCard";
import { useAuth } from "../../../src/contexts/AuthContext";
import { useSavingsMoneyAction } from "../../../src/hooks/useSavingsMoneyAction";
import {
  addBucketMember,
  createBucket,
  deleteBucket,
  generateBucketClientRequestId,
  removeBucketMember,
  subscribeToUserBuckets,
  updateBucket,
} from "../../../src/services/firebase/buckets";
import type { UpdateBucketInput } from "../../../src/services/firebase/buckets";
import { lookupUserByEmail } from "../../../src/services/firebase/functions";
import { subscribeToPublicUsersByIds } from "../../../src/services/firebase/users";
import type { Bucket, PublicProfile } from "../../../src/types/domain";
import { formatCurrency, parseDollarsToMinorUnits } from "../../../utils/format";

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

// Matches styles.container's own padding below - used by the cardWidth
// calculation (Checkpoint 3D goal-layout fix) so per-card widths are
// computed against the actual available content width.
const CONTENT_PADDING = 16;

function isValidInviteEmail(email: string) {
  const e = email.trim().toLowerCase();
  return e.includes("@") && e.includes(".") && e.length >= 6;
}

function isPermissionDeniedError(e: unknown): boolean {
  return (e as { code?: string } | null | undefined)?.code === "permission-denied";
}

// Extracts a Firebase callable error's "functions/<code>" string, if
// present, without repeating the unsafe cast at every call site.
function firebaseErrorCode(e: unknown): string | undefined {
  return (e as { code?: string } | null | undefined)?.code;
}

// Never surfaces raw Firebase error details to the user - only a coarse
// permission-denied vs. other-failure distinction.
function permissionAwareErrorMessage(e: unknown): string {
  return isPermissionDeniedError(e)
    ? "You do not have permission to change one or more of these bucket fields."
    : "We could not save your changes. Please try again.";
}

// Never surfaces raw HttpsError/FirebaseError technical text - maps the
// httpsCallable client SDK's "functions/<code>" error codes (see
// functions/src/callables/createBucket.ts for the exact codes this
// callable can throw) to plain user-facing copy.
function createBucketErrorMessage(e: unknown): string {
  const code = firebaseErrorCode(e);
  switch (code) {
    case "functions/unauthenticated":
      return "You must be signed in to create a bucket.";
    case "functions/invalid-argument":
      return "Check the name, target, and starting balance, then try again.";
    case "functions/already-exists":
      return "That request could not be completed. Please try again.";
    case "functions/failed-precondition":
      return "We couldn't create that bucket right now. Please try again.";
    case "functions/unavailable":
    case "functions/deadline-exceeded":
      return "We couldn't reach the server, so we can't confirm this went through - it's safe to try again.";
    default:
      return "We couldn't create that bucket. Please try again.";
  }
}

// One in-flight/retryable Bucket creation request, keyed by the exact
// facts the trusted backend's creationRequest marker stores (not just
// clientRequestId, for the same reason PendingSavingsRequest isn't keyed
// on id alone - see resolveClientRequestId). name MUST be the already-
// trimmed value: the backend stores/compares the trimmed name, so " Fund "
// and "Fund" must resolve to the same pending logical request.
type PendingCreateBucketRequest = {
  clientRequestId: string;
  name: string;
  target: number;
  startingBalanceMinor: number;
  color: string | null;
};

// Returns the clientRequestId to use for this create submission: reuses
// the previous attempt's id if the retained pending request has the
// exact same normalized facts (a retry of a failed submit), otherwise
// generates a fresh id and replaces the pending record (a genuinely new
// submission - e.g. the user edited the form after a failure). Mirrors
// resolveClientRequestId's exact shape/contract for savings requests.
function resolveCreateBucketClientRequestId(
  pendingRef: React.MutableRefObject<PendingCreateBucketRequest | null>,
  facts: Omit<PendingCreateBucketRequest, "clientRequestId">
): string {
  const pending = pendingRef.current;
  if (
    pending &&
    pending.name === facts.name &&
    pending.target === facts.target &&
    pending.startingBalanceMinor === facts.startingBalanceMinor &&
    pending.color === facts.color
  ) {
    return pending.clientRequestId;
  }

  const clientRequestId = generateBucketClientRequestId();
  pendingRef.current = { ...facts, clientRequestId };
  return clientRequestId;
}

// React Native's Alert.alert() is not reliably implemented on React
// Native Web, so failure alerts need a web fallback. Mirrors the same
// Platform.OS branch already used elsewhere in the app (see
// app/(tabs)/trips/[tripId].tsx's `notify`), kept local here rather than
// shared to stay a small, contained fix. Native wording/behavior is
// unchanged - only the web path goes from silent/no-op to working.
function notifyError(title: string, message: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

export default function BucketsScreen() {
  const { user, loading } = useAuth();
  const { width } = useWindowDimensions();
  const theme = useTheme();
  const router = useRouter();

  // Ownership here is a UI affordance only (hide/disable actions that are
  // guaranteed to fail). Firestore rules remain the authoritative
  // permission check for every write - see firestore.rules SEC-001.
  const isBucketOwner = (b: { ownerId?: string } | null | undefined) =>
    !!(user?.uid && b?.ownerId === user.uid);

  const numColumns = useMemo(() => {
    if (width >= 1100) return 3;
    if (width >= 700) return 2;
    return 1;
  }, [width]);

  // Explicit per-card pixel width (Checkpoint 3D goal-layout fix),
  // mirroring app/(tabs)/trips/index.tsx's proven cardWidth pattern
  // exactly - replaces the previous flex:1 card sizing, which is only
  // well-defined for equal-width sharing inside a bounded
  // columnWrapperStyle row (numColumns > 1). When numColumns is 1,
  // FlatList renders each card as a direct item in its own vertically
  // scrolling (effectively unbounded-height) list, where flex-grow has
  // no natural-content meaning - a known React Native list-item
  // anti-pattern. CONTENT_PADDING/CARD_GAP mirror this screen's own
  // container padding (16) and row gap (GAP, below).
  const cardWidth = useMemo(() => {
    const available = width - CONTENT_PADDING * 2;
    const totalGaps = GAP * (numColumns - 1);
    return Math.floor((available - totalGaps) / numColumns);
  }, [width, numColumns]);

  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [publicUsers, setPublicUsers] = useState<Record<string, PublicProfile>>({});

  // Optional: show a friendly message if permissions fail
  const [readError, setReadError] = useState<string | null>(null);

  // Create dialog
  const [createVisible, setCreateVisible] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [balance, setBalance] = useState("");
  const [color, setColor] = useState<string | null>(COLORS[0]);
  const [submitting, setSubmitting] = useState(false);
  // Retains the clientRequestId (plus the normalized creation facts it
  // was generated for) so a retry of the exact same submit reuses the
  // same idempotency key instead of creating a second logical Bucket.
  // Retained across a failed/ambiguous outcome and while a request is
  // still in flight (see createInFlightRef) - cleared only after a
  // validated successful response, or when the user explicitly abandons
  // the attempt via cancelCreate AFTER no request is in flight (see
  // cancelCreate/closeCreate below).
  const createPendingRef = useRef<PendingCreateBucketRequest | null>(null);
  // Synchronous serialization guard mirroring quickAddInFlightRef: the
  // submitting state alone can't prevent a second tap from racing past
  // it before React re-renders. Checked/set synchronously before any
  // await; submitting remains solely responsible for the visible
  // loading/disabled UI.
  const createInFlightRef = useRef(false);

  // The shared Personal Savings money-action controller (Milestone 3
  // Checkpoint 3D) - see src/hooks/useSavingsMoneyAction.tsx for why this
  // is a single Context-based controller rather than per-screen state:
  // this screen and the Bucket detail screen both open the SAME
  // underlying sheet/mutation, with one idempotency/serialization owner
  // between them. Replaces the pre-3D quickAddSubmittingId/
  // quickAddPendingRef/quickAddInFlightRef and the entire moneyDialog*
  // state block that used to live here.
  const { open: openMoneyAction } = useSavingsMoneyAction();

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

    const unsub = subscribeToUserBuckets(
      user.uid,
      (next) => {
        setBuckets(next.map((b) => ({ ...b, name: String(b.name ?? "") })));
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
      const unsub = subscribeToPublicUsersByIds(
        chunk,
        (users) => {
          setPublicUsers((prev) => {
            const next = { ...prev };
            users.forEach((publicUser) => {
              next[publicUser.uid] = publicUser;
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
  // The unconditional internal reset - always clears the form AND the
  // pending request ref, with no guard of its own. onAddBucket's success
  // path calls this directly while createInFlightRef.current is still
  // true (it only flips back to false in onAddBucket's outer finally,
  // which runs after this), so closeCreate must never itself refuse to
  // run while a request is in flight - that would block normal
  // successful creation from closing/resetting the dialog. User-
  // initiated cancellation goes through cancelCreate (below) instead,
  // which is what actually decides whether abandoning is currently safe.
  const closeCreate = () => {
    setCreateVisible(false);
    setName("");
    setTarget("");
    setBalance("");
    setColor(COLORS[0]);
    createPendingRef.current = null;
  };

  // The user-facing cancel/dismiss path - Cancel button, backdrop tap,
  // hardware back, or any other Dialog dismissal. Ignored outright while
  // a create request is still unresolved (createInFlightRef.current):
  // the server may have already succeeded, so clearing the pending
  // request id here would let a later resubmission generate a fresh id
  // and create a duplicate Bucket, defeating the whole point of the
  // idempotency key. Once no request is in flight (idle, or a failed/
  // ambiguous attempt has already returned), cancelling is a genuine,
  // explicit abandonment of that logical attempt, so it's safe to reset
  // via closeCreate. Checked via the synchronous ref, not submitting
  // state, so the small interval before a re-render lands is still safe.
  const cancelCreate = () => {
    if (createInFlightRef.current) return;
    closeCreate();
  };

  const onAddBucket = async () => {
    if (!user) return;
    // Serializes create submissions, checked/set synchronously before any
    // await so a double tap cannot start a second competing call - see
    // createInFlightRef's declaration.
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;

    try {
      // name MUST be trimmed here, not just for display: the trusted
      // backend stores/compares the trimmed value, so this exact
      // normalized string is what resolveCreateBucketClientRequestId's
      // fact-comparison (and, on the server, creationRequest replay
      // matching) must use too.
      const normalizedName = name.trim();
      const t = Number(target);
      // Deterministic integer-minor-unit parsing, not Number(balanceText)
      // - an empty field preserves today's "blank means zero" convenience
      // by resolving to "0" before parsing, and allowZero:true lets an
      // explicit $0 Starting Balance through (unlike contribution/
      // withdrawal parsing elsewhere in this file, which must keep
      // rejecting zero).
      const startingBalanceMinor = parseDollarsToMinorUnits(
        balance.trim() === "" ? "0" : balance,
        { allowZero: true }
      );

      if (
        normalizedName.length === 0 ||
        !Number.isFinite(t) ||
        t <= 0 ||
        startingBalanceMinor === null
      ) {
        return;
      }

      const facts = {
        name: normalizedName,
        target: t,
        startingBalanceMinor,
        color: color ?? null,
      };
      const clientRequestId = resolveCreateBucketClientRequestId(
        createPendingRef,
        facts
      );

      setSubmitting(true);
      try {
        await createBucket({ ...facts, clientRequestId });
        // closeCreate() clears createPendingRef as part of its reset - a
        // later create is a new logical request and must get a new id.
        closeCreate();
      } catch (e) {
        console.error("Failed to add bucket:", e);
        // already-exists is the one outcome that is NOT ambiguous: the
        // backend has definitively told us this clientRequestId already
        // identifies a conflicting request (different facts, or a
        // legacy/direct-created document at that id - see
        // createBucketCore's replay check), so retrying with the SAME id
        // can only ever fail the same way again. Clearing the pending
        // record here (without closing/resetting the form) means the
        // next Save press generates a fresh id and retries the same
        // facts as a genuinely new request.
        //
        // Every other failure (unavailable, deadline-exceeded, a locally
        // malformed response, or any other/unknown error) is deliberately
        // left retaining the pending id - the server may have actually
        // completed the create, so retrying this exact submit must reuse
        // the same clientRequestId (see resolveCreateBucketClientRequestId).
        // If the user instead edits the form, the next submit's facts
        // naturally won't match this pending record and a fresh id is
        // generated automatically regardless of which branch ran here.
        if (firebaseErrorCode(e) === "functions/already-exists") {
          createPendingRef.current = null;
        }
        notifyError("Couldn't create bucket", createBucketErrorMessage(e));
      } finally {
        setSubmitting(false);
      }
    } finally {
      createInFlightRef.current = false;
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
    if (!Number.isFinite(t) || t <= 0) return;

    const editingOwner = isBucketOwner(editing);

    setSubmitting(true);
    try {
      const payload: UpdateBucketInput = {
        name: String(editing.name ?? "").trim(),
        color: editing.color ?? null,
        lastUpdatedBy: user.uid,
      };

      // Only the bucket owner may change target. Never send this field
      // from a non-owner save - Firestore rules would reject it anyway,
      // but this keeps the request itself honest and minimal. balance is
      // never sent from here at all - it is no longer an editable field;
      // it only ever changes through a trusted recordSavingsTransaction
      // contribution/withdrawal (see quickAdd/onSubmitMoneyDialog).
      if (editingOwner) {
        payload.target = t;
      }

      await updateBucket(editing.id, payload);
      closeEdit();
    } catch (e) {
      console.error("Failed to update bucket:", e);
      notifyError("Couldn't save changes", permissionAwareErrorMessage(e));
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
      await deleteBucket(editing.id);
      closeDelete();
    } catch (e) {
      console.error("Failed to delete bucket:", e);
    } finally {
      setSubmitting(false);
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
  const currentIsOwner = isBucketOwner(membersBucket);
  const editingIsOwner = isBucketOwner(editing);

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
      const data = await lookupUserByEmail(email);
      const uid = String(data?.uid ?? "").trim();

      if (!uid) {
        setMembersError("Could not find a user for that email.");
        return;
      }
      if ((membersBucket.memberIds ?? []).includes(uid)) {
        setMembersError("That user is already a member of this bucket.");
        return;
      }

      await addBucketMember(membersBucket.id, uid, user.uid);

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
      await removeBucketMember(membersBucket.id, uidToRemove, user.uid);
    } catch (e) {
      console.error("Failed to remove member:", e);
      setMembersError("Failed to remove member.");
    } finally {
      setMembersSubmitting(false);
    }
  };

  const leaveBucket = () => {
    if (!user || !membersBucket) return;

    if (membersBucket.ownerId === user.uid) {
      setMembersError("Owners can’t leave. Transfer ownership later.");
      return;
    }

    // Non-owners can never successfully change memberIds under the
    // current Firestore rules (Milestone 1 SEC-001 hardening), so this
    // would always be denied. Show this inline via membersError instead
    // of sending a write that is guaranteed to fail - Alert.alert is not
    // reliably implemented on React Native Web, so this cannot depend on
    // the native Alert API (see PR #2 web smoke-test finding).
    setMembersError(
      "Leaving a shared bucket isn't available yet. Ask the bucket owner to remove you as a member."
    );
  };

  const inviteDisabled = useMemo(() => {
    const email = inviteEmail.trim().toLowerCase();
    if (!currentIsOwner) return true;
    if (!isValidInviteEmail(email)) return true;
    if ((user?.email ?? "").toLowerCase() === email) return true;
    return membersSubmitting;
  }, [inviteEmail, currentIsOwner, user?.email, membersSubmitting]);

  // Navigates to the dedicated Bucket detail screen (Milestone 3
  // Checkpoint 3B). A plain presentation callback, not Expo Router
  // dropped directly into BucketCard, so the card stays presentation-
  // focused - see components/buckets/BucketCard.tsx's onOpenBucket prop.
  const openBucketDetail = (bucket: Bucket) => {
    router.push({
      pathname: "/(tabs)/buckets/[bucketId]",
      params: { bucketId: bucket.id },
    });
  };

  // Presentation lives in BucketCard (components/buckets/BucketCard.tsx)
  // - this closure only supplies the per-item state slices and the
  // existing screen-owned handlers (quickAdd/openMoneyDialog/etc. still
  // perform every actual Firebase read/write; the card only invokes
  // them).
  const renderItem = ({ item }: { item: Bucket }) => {
    return (
      <BucketCard
        bucket={item}
        isOwner={isBucketOwner(item)}
        isMenuOpen={menuAnchor === item.id}
        cardWidth={cardWidth}
        avatarForUid={avatarForUid}
        onOpenBucket={openBucketDetail}
        onOpenMembers={openMembers}
        onOpenMenu={openMenu}
        onCloseMenu={closeMenu}
        onEdit={startEdit}
        onDelete={startDelete}
        onOpenMoneyAction={openMoneyAction}
      />
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text variant="headlineSmall" style={styles.title}>
            Personal Buckets
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
            Track and manage your savings goals.
          </Text>

          {readError ? (
            <Text style={{ marginTop: 6, color: theme.colors.error }}>{readError}</Text>
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
              <Text style={[styles.muted, { color: theme.colors.onSurfaceVariant }]}>
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

                {membersError ? (
                  <Text style={{ color: theme.colors.error, marginBottom: 8 }}>{membersError}</Text>
                ) : null}

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
                  <Text style={{ color: theme.colors.error, marginBottom: 8 }}>{membersError}</Text>
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
                  <View
                    key={uid}
                    style={[styles.memberRow, { borderBottomColor: theme.colors.outline }]}
                  >
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
        <Dialog visible={createVisible} onDismiss={cancelCreate}>
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
            <Button onPress={cancelCreate} disabled={submitting}>Cancel</Button>
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
              disabled={!editingIsOwner}
              style={{ marginBottom: 12 }}
            />
            <Text style={{ marginBottom: 4, opacity: 0.7 }}>Current Balance</Text>
            <Text style={{ marginBottom: 4, fontSize: 16, fontWeight: "800" }}>
              {formatCurrency(editing?.balance ?? 0)}
            </Text>
            <Text style={{ marginBottom: 16, opacity: 0.6, fontSize: 12 }}>
              Use Contribute or Withdraw to change savings.
            </Text>

            {!editingIsOwner ? (
              <Text style={{ marginBottom: 12, opacity: 0.7, fontSize: 12 }}>
                Only the bucket owner can change the target.
              </Text>
            ) : null}

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

      {/* The single shared money-action sheet (Milestone 3 Checkpoint
          3D) is rendered once in app/(tabs)/buckets/_layout.tsx
          (MoneyActionSheet), not per-screen - see openMoneyAction above. */}

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
  container: { flex: 1, padding: 16 },

  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  title: { fontWeight: "900" },
  subtitle: { marginTop: 2 },

  row: { gap: GAP, marginBottom: GAP },

  muted: {},

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
    gap: 10,
  },
});
