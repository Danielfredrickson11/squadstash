import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import {
  Button,
  Dialog,
  Portal,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { AccentColorPicker } from "../../../components/buckets/AccentColorPicker";
import { AvatarCircle, initialsFromName, shortUid } from "../../../components/buckets/AvatarCircle";
import { BucketGridCard } from "../../../components/buckets/BucketGridCard";
import { useAuth } from "../../../src/contexts/AuthContext";
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
import { radii, spacing, typography } from "../../../src/theme/tokens";
import { useSemanticColors } from "../../../src/theme/useSemanticColors";
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

type BucketFilter = "all" | "personal" | "shared";

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
  const colors = useSemanticColors();
  const router = useRouter();
  // Global center-create action (Milestone 3 Checkpoint 3F.2): the
  // BottomNav's "New Bucket" option navigates here with ?openCreate=1
  // rather than duplicating this screen's own creation dialog/state -
  // see components/navigation/CreateActionSheet.tsx.
  const params = useLocalSearchParams<{ openCreate?: string }>();

  // Ownership here is a UI affordance only (hide/disable actions that are
  // guaranteed to fail). Firestore rules remain the authoritative
  // permission check for every write - see firestore.rules SEC-001.
  const isBucketOwner = (b: { ownerId?: string } | null | undefined) =>
    !!(user?.uid && b?.ownerId === user.uid);

  // Checkpoint 3F.2: mobile-first target is a 2-column compact grid
  // (previously 1 column below 700px) - the approved reference's
  // Personal Essentials grid is 2-column even on a ~390-430px phone.
  const numColumns = useMemo(() => {
    if (width >= 1100) return 4;
    if (width >= 700) return 3;
    return 2;
  }, [width]);

  const GAP = 12;

  const cardWidth = useMemo(() => {
    const available = width - CONTENT_PADDING * 2;
    const totalGaps = GAP * (numColumns - 1);
    return Math.floor((available - totalGaps) / numColumns);
  }, [width, numColumns]);

  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [publicUsers, setPublicUsers] = useState<Record<string, PublicProfile>>({});

  // Optional: show a friendly message if permissions fail
  const [readError, setReadError] = useState<string | null>(null);

  const [filter, setFilter] = useState<BucketFilter>("all");

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

  // Global center-create action support: opens this screen's own
  // existing New Bucket dialog when navigated here with ?openCreate=1 -
  // see components/navigation/CreateActionSheet.tsx. Reuses openCreate()
  // above rather than any new creation path.
  useEffect(() => {
    if (params.openCreate) {
      openCreate();
    }
  }, [params.openCreate]);

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
  // dropped directly into the card, so the card stays presentation-
  // focused - see components/buckets/BucketGridCard.tsx's onOpenBucket prop.
  const openBucketDetail = (bucket: Bucket) => {
    router.push({
      pathname: "/(tabs)/buckets/[bucketId]",
      params: { bucketId: bucket.id },
    });
  };

  // Checkpoint 3F.3B.4: a trip_personal Bucket ("My Stash") belongs to
  // the Trip experience, not the ordinary Buckets tab - filtered out
  // here at the presentation layer only (never deleted, never excluded
  // from subscribeToUserBuckets itself, so the user's real data/access
  // is unaffected - Trip Detail reads the exact same underlying
  // document directly by its own id). This is deliberately the ONLY
  // place that filter is applied on this screen; totalStashed below is
  // computed from the same filtered list so the Buckets tab's own
  // summary stays consistent with what it actually displays.
  const visibleBuckets = useMemo(
    () => buckets.filter((b) => b.bucketType !== "trip_personal"),
    [buckets]
  );

  // Truthful client-side segmentation (Milestone 3 Checkpoint 3F.2) -
  // derived entirely from the already-subscribed real `buckets` list, no
  // new query. "Shared" = memberIds.length > 1 (more than just the
  // owner); "Personal" = everything else. This is the "closest truthful
  // existing definition" the checkpoint's own audit instruction allows
  // when a strict ownerId-based split isn't meaningfully different -
  // every bucket falls into exactly one section, with no gap/overlap.
  const personalBuckets = useMemo(
    () => visibleBuckets.filter((b) => (b.memberIds?.length ?? 0) <= 1),
    [visibleBuckets]
  );
  const sharedBuckets = useMemo(
    () => visibleBuckets.filter((b) => (b.memberIds?.length ?? 0) > 1),
    [visibleBuckets]
  );

  const totalStashed = useMemo(
    () => visibleBuckets.reduce((sum, b) => sum + (Number(b.balance) || 0), 0),
    [visibleBuckets]
  );

  const showPersonal = filter !== "shared";
  const showShared = filter !== "personal";

  // Chunk personalBuckets into rows of `numColumns` for the compact
  // grid - a plain flex-wrap layout (not FlatList) since this screen now
  // renders two different card shapes (compact grid + full-width shared
  // rows) in one scrollable composition.
  const personalRows = useMemo(() => {
    const rows: Bucket[][] = [];
    for (let i = 0; i < personalBuckets.length; i += numColumns) {
      rows.push(personalBuckets.slice(i, i + numColumns));
    }
    return rows;
  }, [personalBuckets, numColumns]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: theme.colors.onBackground }]}>Buckets</Text>
            <Text style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
              Smart saving for your essentials & squad goals.
            </Text>

            {readError ? (
              <Text style={{ marginTop: 6, color: theme.colors.error }}>{readError}</Text>
            ) : null}
          </View>

          <Pressable
            onPress={openCreate}
            accessibilityRole="button"
            accessibilityLabel="New Goal"
            style={[styles.addButton, { backgroundColor: theme.colors.primary }]}
          >
            <MaterialCommunityIcons name="plus" size={22} color={theme.colors.onPrimary} />
          </Pressable>
        </View>

        {/* Checkpoint 3F.3A: the Buckets screen's Total Stashed treatment
            is intentionally different from Home's dark-navy hero - the
            approved mockup calls for a pale mint/cool surface card with
            deep navy text here specifically. Dark Mode keeps its
            original surface+border card unchanged. */}
        <View
          style={[
            styles.summaryCard,
            theme.dark
              ? { backgroundColor: theme.colors.surface, borderColor: colors.border }
              : { backgroundColor: colors.mintSurface, borderColor: "transparent" },
          ]}
        >
          <Text style={[styles.summaryLabel, { color: theme.colors.onSurfaceVariant }]}>
            TOTAL STASHED
          </Text>
          <Text style={[styles.summaryValue, { color: theme.colors.onSurface }]}>
            {formatCurrency(totalStashed)}
          </Text>
        </View>

        <View style={styles.filterRow}>
          {(
            [
              { key: "all", label: "All Buckets" },
              { key: "personal", label: "Personal" },
              { key: "shared", label: "Shared" },
            ] as const
          ).map((opt) => {
            const active = filter === opt.key;
            // Checkpoint 3F.3A: Dark Mode keeps its original mint-
            // highlighted selected pill unchanged. The approved Light
            // Mode mockup instead calls for a deep-navy filled selected
            // pill with white text, and a soft blue-gray/light surface
            // for unselected pills.
            const chipColors = theme.dark
              ? {
                  background: active ? colors.mintSurface : theme.colors.surface,
                  border: active ? colors.mint : colors.border,
                  text: active ? colors.mintText : theme.colors.onSurfaceVariant,
                }
              : {
                  background: active ? colors.navy : colors.surfaceTertiary,
                  border: active ? colors.navy : colors.border,
                  text: active ? "#FFFFFF" : colors.textSecondary,
                };
            return (
              <Pressable
                key={opt.key}
                onPress={() => setFilter(opt.key)}
                accessibilityRole="button"
                accessibilityLabel={opt.label}
                accessibilityState={{ selected: active }}
                style={[
                  styles.filterChip,
                  { backgroundColor: chipColors.background, borderColor: chipColors.border },
                ]}
              >
                <Text style={[styles.filterChipText, { color: chipColors.text }]}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {visibleBuckets.length === 0 ? (
          <View
            style={[
              styles.emptyCard,
              { backgroundColor: theme.colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.emptyTitle, { color: theme.colors.onSurface }]}>
              You don’t have any buckets yet.
            </Text>
            <Text style={[styles.emptySub, { color: theme.colors.onSurfaceVariant }]}>
              Create your first goal to start tracking savings.
            </Text>
            <View style={{ height: 12 }} />
            <Button mode="contained" icon="plus" onPress={openCreate}>
              New Goal
            </Button>
          </View>
        ) : (
          <>
            {showPersonal && personalBuckets.length > 0 ? (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Personal Essentials
                </Text>
                {personalRows.map((row, rowIdx) => (
                  <View key={rowIdx} style={[styles.gridRow, { gap: GAP }]}>
                    {row.map((b, colIdx) => (
                      <BucketGridCard
                        key={b.id}
                        variant="compact"
                        bucket={b}
                        accentIndex={rowIdx * numColumns + colIdx}
                        isOwner={isBucketOwner(b)}
                        isMenuOpen={menuAnchor === b.id}
                        width={cardWidth}
                        avatarForUid={avatarForUid}
                        onOpenBucket={openBucketDetail}
                        onOpenMembers={openMembers}
                        onOpenMenu={openMenu}
                        onCloseMenu={closeMenu}
                        onEdit={startEdit}
                        onDelete={startDelete}
                      />
                    ))}
                  </View>
                ))}
              </View>
            ) : null}

            {showShared ? (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Shared Buckets
                </Text>
                {sharedBuckets.length === 0 ? (
                  <View
                    style={[
                      styles.emptyCard,
                      { backgroundColor: theme.colors.surface, borderColor: colors.border },
                    ]}
                  >
                    <Text style={[styles.emptySub, { color: theme.colors.onSurfaceVariant }]}>
                      No shared buckets yet. Add a member to a bucket to see it here.
                    </Text>
                  </View>
                ) : (
                  <View style={{ gap: spacing.sm }}>
                    {sharedBuckets.map((b, index) => (
                      <BucketGridCard
                        key={b.id}
                        variant="shared"
                        bucket={b}
                        accentIndex={index}
                        isOwner={isBucketOwner(b)}
                        isMenuOpen={menuAnchor === b.id}
                        avatarForUid={avatarForUid}
                        onOpenBucket={openBucketDetail}
                        onOpenMembers={openMembers}
                        onOpenMenu={openMenu}
                        onCloseMenu={closeMenu}
                        onEdit={startEdit}
                        onDelete={startDelete}
                      />
                    ))}
                  </View>
                )}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* Members Dialog */}
      <Portal>
        <Dialog
          visible={membersVisible}
          onDismiss={closeMembers}
          style={[styles.dialogSurface, { backgroundColor: colors.surfaceElevated }]}
        >
          <Dialog.Title style={styles.dialogTitle}>Bucket Members</Dialog.Title>
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

      {/* Create Dialog - Checkpoint 3F.2A: compact dark premium surface,
          explicit backgroundColor override since Paper's default Dialog
          surface color is auto-computed from an MD3 elevation overlay
          that reads as an off-brand tint against this app's palette
          (the exact same category of issue diagnosed for Bucket Detail's
          Add Money button in the 3F.1 review). Fields switched to
          mode="outlined" + dense for a compact height; functionality
          (state/handlers/idempotency) is completely unchanged below. */}
      <Portal>
        <Dialog
          visible={createVisible}
          onDismiss={cancelCreate}
          style={[styles.dialogSurface, { backgroundColor: colors.surfaceElevated }]}
        >
          <Dialog.Title style={styles.dialogTitle}>New Bucket</Dialog.Title>
          <Dialog.Content>
            <TextInput
              mode="outlined"
              dense
              label="Name (e.g., Rent, Food, Vacation)"
              value={name}
              onChangeText={setName}
              style={styles.dialogField}
            />
            <TextInput
              mode="outlined"
              dense
              label="Target Amount (e.g., 5000)"
              value={target}
              onChangeText={setTarget}
              keyboardType="numeric"
              style={styles.dialogField}
            />
            <TextInput
              mode="outlined"
              dense
              label="Starting Balance (optional)"
              value={balance}
              onChangeText={setBalance}
              keyboardType="numeric"
              style={styles.dialogField}
            />

            <Text style={[styles.dialogLabel, { color: theme.colors.onSurfaceVariant }]}>
              Accent Color
            </Text>
            <AccentColorPicker colors={COLORS} selected={color} onSelect={setColor} />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={cancelCreate} disabled={submitting} textColor={theme.colors.onSurfaceVariant}>
              Cancel
            </Button>
            <Button
              mode="contained"
              buttonColor={theme.colors.primary}
              textColor={theme.colors.onPrimary}
              onPress={onAddBucket}
              disabled={!canCreate}
              loading={submitting}
            >
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Edit Dialog - same compact dark treatment as Create, for visual
          consistency. */}
      <Portal>
        <Dialog
          visible={editVisible}
          onDismiss={closeEdit}
          style={[styles.dialogSurface, { backgroundColor: colors.surfaceElevated }]}
        >
          <Dialog.Title style={styles.dialogTitle}>Edit Bucket</Dialog.Title>
          <Dialog.Content>
            <TextInput
              mode="outlined"
              dense
              label="Name"
              value={editing?.name ?? ""}
              onChangeText={(v) => setEditing((p) => (p ? { ...p, name: v } : p))}
              style={styles.dialogField}
            />
            <TextInput
              mode="outlined"
              dense
              label="Target Amount"
              value={editing?.target?.toString() ?? ""}
              onChangeText={(v) => setEditing((p) => (p ? { ...p, target: Number(v) || 0 } : p))}
              keyboardType="numeric"
              disabled={!editingIsOwner}
              style={styles.dialogField}
            />
            <Text style={[styles.dialogLabel, { color: theme.colors.onSurfaceVariant }]}>
              Current Balance
            </Text>
            <Text style={[styles.dialogBalance, { color: theme.colors.onSurface }]}>
              {formatCurrency(editing?.balance ?? 0)}
            </Text>
            <Text style={[styles.dialogHint, { color: theme.colors.onSurfaceVariant }]}>
              Use Add Money or Withdraw (on Bucket Detail) to change savings.
            </Text>

            {!editingIsOwner ? (
              <Text style={[styles.dialogHint, { color: theme.colors.onSurfaceVariant }]}>
                Only the bucket owner can change the target.
              </Text>
            ) : null}

            <Text style={[styles.dialogLabel, { color: theme.colors.onSurfaceVariant }]}>
              Accent Color
            </Text>
            <AccentColorPicker
              colors={COLORS}
              selected={editing?.color ?? null}
              onSelect={(c) => setEditing((p) => (p ? { ...p, color: c } : p))}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeEdit} textColor={theme.colors.onSurfaceVariant}>
              Cancel
            </Button>
            <Button
              mode="contained"
              buttonColor={theme.colors.primary}
              textColor={theme.colors.onPrimary}
              onPress={onSaveEdit}
              loading={submitting}
            >
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* The single shared money-action sheet (Milestone 3 Checkpoint
          3D) is rendered once in app/(tabs)/buckets/_layout.tsx
          (MoneyActionSheet), not per-screen. It is opened only from
          Bucket Detail now (Checkpoint 3F.2 design decision - list
          cards no longer surface Add Money/Withdraw directly, matching
          the approved reference's card design; both actions remain
          fully reachable from Bucket Detail, unchanged). */}

      {/* Delete Confirm */}
      <Portal>
        <Dialog
          visible={deleteVisible}
          onDismiss={closeDelete}
          style={[styles.dialogSurface, { backgroundColor: colors.surfaceElevated }]}
        >
          <Dialog.Title style={styles.dialogTitle}>Delete Bucket</Dialog.Title>
          <Dialog.Content>
            <Text>
              Are you sure you want to delete{" "}
              <Text style={{ fontWeight: "800" }}>{editing?.name}</Text>?
            </Text>
            <Text style={{ marginTop: 8, opacity: 0.7 }}>Only the bucket owner can delete.</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeDelete} textColor={theme.colors.onSurfaceVariant}>
              Cancel
            </Button>
            <Button
              mode="contained"
              buttonColor={colors.coral}
              textColor="#FFFFFF"
              onPress={onConfirmDelete}
              loading={submitting}
            >
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { padding: CONTENT_PADDING, paddingBottom: 140 },

  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: spacing.md,
  },
  title: { ...typography.pageTitle },
  subtitle: { ...typography.body, marginTop: spacing.xs },

  addButton: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },

  summaryCard: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  summaryLabel: { ...typography.meta, textTransform: "uppercase", letterSpacing: 0.6 },
  summaryValue: { ...typography.majorValue, fontSize: 26, marginTop: 2 },

  filterRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  filterChipText: { fontSize: 12, fontWeight: "700" },

  section: { marginBottom: spacing.lg },
  sectionTitle: { ...typography.sectionTitle, marginBottom: spacing.sm },
  gridRow: { flexDirection: "row", marginBottom: 12 },

  emptyCard: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.lg,
  },
  emptyTitle: { ...typography.cardTitle, marginBottom: 4 },
  emptySub: { ...typography.body },

  // Checkpoint 3F.2A dialog restyle - compact dark premium surface for
  // Members/Create/Edit/Delete. See the usage sites above for why an
  // explicit backgroundColor override is needed rather than trusting
  // Paper's default Dialog elevation color.
  dialogSurface: { borderRadius: radii.xl },
  dialogTitle: { fontSize: 17, fontWeight: "700" },
  dialogField: { marginBottom: spacing.sm },
  dialogLabel: { ...typography.meta, marginBottom: spacing.sm },
  dialogBalance: { fontSize: 16, fontWeight: "800", marginBottom: 4 },
  dialogHint: { fontSize: 12, marginBottom: spacing.md },

  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
});
