import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Image,
    Platform,
    Pressable,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useWindowDimensions,
    View,
} from "react-native";
import { useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { BAR_HEIGHT, CENTER_BUTTON_SIZE } from "../../../components/navigation/BottomNav";
import { cardShadowFor, radii, spacing, typography, type SemanticColors } from "../../../src/theme/tokens";
import { useSemanticColors } from "../../../src/theme/useSemanticColors";
import { useAuth } from "../../../src/contexts/AuthContext";
import { deleteTrip, fetchTripById, updateTripDates } from "../../../src/services/firebase/trips";
import {
  createBucket,
  fetchBucketById,
  generateBucketClientRequestId,
  subscribeToBucketById,
} from "../../../src/services/firebase/buckets";
import {
  generateSavingsClientRequestId,
  MAX_TRANSACTION_NOTE_LENGTH,
  recordSavingsTransaction,
} from "../../../src/services/firebase/savingsTransactions";
import {
  formatCanonicalDateShort,
  formatTripDates,
  isValidCanonicalDate,
  todayCanonicalDate,
} from "../../../src/domain/tripDates";
import {
  computeTripSavingsGuidance,
  formatTripHorizonText,
  type TripSavingsGuidance,
} from "../../../src/domain/tripSavingsGuidance";
import { isMatchingTripPersonalBucket, tripPersonalBucketId } from "../../../src/domain/tripPersonalFund";
import {
  normalizeTransactionNote,
  resolveAmountMinor,
  resolveMoneyActionClientRequestId,
  type PendingMoneyActionRequest,
} from "../../../src/domain/savingsMoneyAction";
import { useSavingsMoneyAction } from "../../../src/hooks/useSavingsMoneyAction";
import type { Bucket, SavingsTransactionType, Trip } from "../../../src/types/domain";

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1600&q=60";

// Checkpoint 3F.3B.4A: module-level, matching useSavingsMoneyAction's
// own CLOSED_STATE convention exactly, rather than redefining a fresh
// object on every render.
const CLOSED_SHARED_ACTION = {
  visible: false,
  type: "contribution" as SavingsTransactionType,
  amountText: "",
  note: "",
  submitting: false,
  error: null as string | null,
};

// Checkpoint 3F.3B.4B: how far the floating "+" button's TOP sits above
// the bar's own top edge - mirrors BottomNav's own
// `bottom: BAR_HEIGHT - CENTER_BUTTON_SIZE / 2 + 4` math for
// centerButton exactly, so this is the real tallest point of the nav,
// not a guess.
const NAV_BUTTON_PEEK = CENTER_BUTTON_SIZE / 2 - 4;
// A comfortable gap between the last piece of real content and the
// nav, once the nav itself is fully cleared - not an arbitrary
// 200-300px spacer.
const NAV_BREATHING_ROOM = spacing.xxl;

function money(n?: number) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export default function TripDetails() {
  const router = useRouter();
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { width } = useWindowDimensions();
  const { user } = useAuth();
  const theme = useTheme();
  const colors = useSemanticColors();
  const insets = useSafeAreaInsets();

  // Checkpoint 3F.3B.4B: the floating BottomNav renders as an absolutely-
  // positioned overlay OUTSIDE this screen's own SafeAreaView (it's
  // mounted once by the outer Tabs navigator - see
  // components/navigation/BottomNav.tsx), so scrolled content here can
  // end up hidden underneath it unless the scroll container's own bottom
  // padding accounts for the nav's real height.
  //
  // On iOS, the `SafeAreaView` below (from "react-native") already
  // shrinks this screen's own viewport by `insets.bottom` natively, so
  // adding it again here would double-count it. On Android and web, that
  // native SafeAreaView inset behavior is a no-op, so the nav's own
  // safe-area padding (Math.max(insets.bottom, spacing.sm), matching
  // BottomNav's own `wrap` style exactly) has to be added explicitly
  // instead - otherwise those platforms would be short by exactly that
  // amount.
  const scrollBottomInset = useMemo(() => {
    const navSafeAreaPadding =
      Platform.OS === "ios" ? 0 : Math.max(insets.bottom, spacing.sm);
    return BAR_HEIGHT + NAV_BUTTON_PEEK + navSafeAreaPadding + NAV_BREATHING_ROOM;
  }, [insets.bottom]);

  const [loading, setLoading] = useState(true);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  // Checkpoint 3F.3B.3: owner-only compact date-edit flow. A direct
  // client write (matching createTrip/deleteTrip's own pattern - Trip
  // has no trusted callable at all today), gated by firestore.rules'
  // owner-only tripStartDate/tripEndDate update allowlist. Persists via
  // updateTripDates, so a reload re-fetches the real saved value - no
  // local-only/optimistic-only state.
  const [isEditingDates, setIsEditingDates] = useState(false);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [dateSaving, setDateSaving] = useState(false);
  const [dateErr, setDateErr] = useState<string | null>(null);

  const isWide = width >= 980;

  const headerHeight = useMemo(() => {
    if (width >= 1200) return 340;
    if (width >= 800) return 300;
    return 240;
  }, [width]);

  const notify = useCallback((title: string, message?: string) => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.alert(message ? `${title}\n\n${message}` : title);
      return;
    }
    Alert.alert(title, message);
  }, []);

  const confirmDelete = useCallback((onConfirm: () => void) => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const ok = window.confirm(
        "Delete trip?\n\nThis will permanently delete this trip. This cannot be undone."
      );
      if (ok) onConfirm();
      return;
    }

    Alert.alert(
      "Delete trip?",
      "This will permanently delete this trip. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: onConfirm },
      ]
    );
  }, []);

  const fetchTrip = useCallback(async () => {
    if (!tripId) return;
    setLoading(true);
    try {
      const result = await fetchTripById(tripId);
      setTrip(result);
    } catch (e) {
      console.log("fetchTrip error:", e);
      setTrip(null);
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    fetchTrip();
  }, [fetchTrip]);

  const isOwner = !!user?.uid && !!trip?.ownerId && user.uid === trip.ownerId;

  const onDeleteTrip = useCallback(() => {
    if (!tripId || !trip) return;

    confirmDelete(async () => {
      try {
        setLoading(true);
        await deleteTrip(tripId);
        router.replace("/(tabs)/trips");
      } catch (e: any) {
        console.log("delete trip error:", e);
        notify(
          "Couldn’t delete trip",
          e?.message ||
            "You may not have permission, or there was a network error."
        );
      } finally {
        setLoading(false);
      }
    });
  }, [tripId, trip, confirmDelete, router, notify]);

  const startEditDates = useCallback(() => {
    if (!isOwner || !trip) return;
    setEditStart(trip.tripStartDate ?? "");
    setEditEnd(trip.tripEndDate ?? "");
    setDateErr(null);
    setIsEditingDates(true);
  }, [isOwner, trip]);

  const cancelEditDates = useCallback(() => {
    setIsEditingDates(false);
    setDateErr(null);
  }, []);

  const saveDates = useCallback(async () => {
    if (!tripId || !trip || !isOwner || !user) return;

    const cleanStart = editStart.trim();
    const cleanEnd = editEnd.trim();

    if (!isValidCanonicalDate(cleanStart)) {
      setDateErr("Enter a valid trip start date (YYYY-MM-DD).");
      return;
    }
    if (cleanStart < todayCanonicalDate()) {
      setDateErr("Trip start date cannot be before today.");
      return;
    }
    if (cleanEnd) {
      if (!isValidCanonicalDate(cleanEnd)) {
        setDateErr("Enter a valid trip end date (YYYY-MM-DD), or leave it blank.");
        return;
      }
      if (cleanEnd < cleanStart) {
        setDateErr("Trip end date cannot be before the start date.");
        return;
      }
    }

    setDateSaving(true);
    setDateErr(null);

    try {
      await updateTripDates(tripId, {
        tripStartDate: cleanStart,
        tripEndDate: cleanEnd ? cleanEnd : null,
        lastUpdatedBy: user.uid,
      });
      // Reflects the just-confirmed write directly rather than waiting
      // on a full refetch - a reload still re-fetches the real
      // persisted value from fetchTripById, so this is never the only
      // source of truth for it.
      setTrip((prev) =>
        prev ? { ...prev, tripStartDate: cleanStart, tripEndDate: cleanEnd ? cleanEnd : null } : prev
      );
      setIsEditingDates(false);
    } catch (e) {
      console.error("Failed to update trip dates:", e);
      setDateErr("Couldn't save dates. Please try again.");
    } finally {
      setDateSaving(false);
    }
  }, [tripId, trip, isOwner, user, editStart, editEnd]);

  // ==========================================================================
  // Checkpoint 3F.3B.4: SHARED STASH (existing trusted Trip ledger) +
  // MY STASH (a private trip_personal Bucket owned by the authenticated
  // member, linked to this Trip). See the checkpoint report for the full
  // architecture rationale - in short: Shared Stash reuses
  // recordSavingsTransaction(resourceType: "trip") directly (no shared
  // UI component exists for a Trip resource yet, so this is a small,
  // locally-scoped action form reusing the exact same trusted call and
  // the exact same pure idempotency helpers
  // (resolveMoneyActionClientRequestId etc.) the Bucket money-action
  // controller already relies on - never a second/weaker financial
  // write system). My Stash IS an ordinary Bucket
  // (bucketType: "trip_personal", linkedTripId: this trip), so it reuses
  // useSavingsMoneyAction()/MoneyActionSheet 100% unchanged, exactly like
  // Bucket Detail does.
  // ==========================================================================

  const { open: openMoneyAction, announceSuccess } = useSavingsMoneyAction();

  // My Stash - undefined while the first snapshot hasn't arrived yet,
  // null once confirmed the fund doesn't exist, a real Bucket once it
  // does. Looked up by its DETERMINISTIC id (tripPersonalBucketId) - a
  // direct document subscription, no query, no new Firestore index.
  //
  // Checkpoint 3F.3B.4A: the effect below references only this extracted
  // `myStashUid` primitive, never `user` itself, so its dependency array
  // ([tripId, myStashUid]) is exhaustive and complete - `user`'s object
  // identity can change (e.g. a profile field update) without needing to
  // tear down and recreate this subscription, which only ever actually
  // needs to change when the uid itself changes.
  //
  // Checkpoint 3F.3B.4C root-cause finding: contrary to this file's
  // earlier assumption, onSnapshot on a not-yet-existing document does
  // NOT reliably "keep listening and fire again once it's created". This
  // collection's rules (firestore.rules: isBucketMember()/isBucketOwner()
  // both read resource.data) evaluate `resource` as null for a
  // nonexistent document, and referencing `.data` on a null resource is
  // a Firestore Rules evaluation error, which Firestore treats as
  // permission-denied - not as an empty/not-found snapshot. A
  // permission-denied listener error is TERMINAL: the SDK does not
  // retry it the way it retries transient errors like `unavailable`, so
  // once this mount-time listener hits that error (which it always will,
  // for a member creating their fund for the first time) it is
  // permanently dead - it will never observe the document even after the
  // trusted callable creates it moments later. This is a real, pre-
  // existing Firestore Rules defect (not introduced by this checkpoint),
  // but per this checkpoint's scope it is reported, not patched here -
  // see the checkpoint report. Firestore rules are NOT modified in this
  // checkpoint.
  //
  // The onError handler below still treats that permission-denied as "no
  // fund yet" (correct for this specific first-mount case - it's
  // indistinguishable client-side from "genuinely doesn't exist"), but
  // the listener it came from is deliberately never reused afterward -
  // attachMyStashListener() below always tears down whatever listener is
  // currently active and installs a fresh one, which is what actually
  // recovers live updates once the fund is confirmed (via an explicit
  // read, see reconcileMyStash) to exist.
  const myStashUid = user?.uid;
  const [myStash, setMyStash] = useState<Bucket | null | undefined>(undefined);
  const myStashUnsubRef = useRef<(() => void) | null>(null);

  const attachMyStashListener = useCallback((bucketId: string) => {
    myStashUnsubRef.current?.();
    myStashUnsubRef.current = subscribeToBucketById(
      bucketId,
      (bucket) => setMyStash(bucket),
      (err) => {
        console.error("My Stash subscription error:", err);
        setMyStash(null);
      }
    );
  }, []);

  useEffect(() => {
    setMyStash(undefined);
    myStashUnsubRef.current?.();
    myStashUnsubRef.current = null;
    if (!tripId || !myStashUid) return undefined;
    attachMyStashListener(tripPersonalBucketId(tripId, myStashUid));
    return () => {
      myStashUnsubRef.current?.();
      myStashUnsubRef.current = null;
    };
  }, [tripId, myStashUid, attachMyStashListener]);

  // Checkpoint 3F.3B.4C: explicit post-create/post-already-exists
  // reconciliation (see submitCreateStash below) - a one-shot trusted
  // read, never a second source of truth. The live listener
  // (attachMyStashListener) remains the ongoing source of updates once
  // re-attached; this only bridges the gap for the one read that a dead
  // mount-time listener can't. Validates bucketType/linkedTripId/ownerId
  // rather than trusting the read blindly, so a structurally-wrong
  // document (or one belonging to someone else, which Firestore Rules
  // should never actually return, but this stays a real check rather
  // than an assumption) surfaces a real error instead of silently
  // rendering as this member's fund.
  const reconcileMyStash = useCallback(
    async (bucketId: string): Promise<Bucket> => {
      const fetched = await fetchBucketById(bucketId);
      if (!tripId || !myStashUid || !isMatchingTripPersonalBucket(fetched, tripId, myStashUid)) {
        throw new Error(
          "Your My Stash was saved, but couldn't be loaded. Please try again."
        );
      }
      return fetched as Bucket;
    },
    [tripId, myStashUid]
  );

  const [isCreatingStash, setIsCreatingStash] = useState(false);
  const [stashTargetText, setStashTargetText] = useState("");
  const [stashCreating, setStashCreating] = useState(false);
  const [stashCreateErr, setStashCreateErr] = useState<string | null>(null);
  // Mirrors resolveCreateBucketClientRequestId's exact contract
  // (app/(tabs)/buckets/index.tsx) - reuses the previous attempt's
  // clientRequestId only when the retry has the exact same facts,
  // otherwise mints a fresh one.
  const stashPendingRef = useRef<{
    clientRequestId: string;
    name: string;
    target: number;
  } | null>(null);

  const startCreateStash = useCallback(() => {
    setStashTargetText("");
    setStashCreateErr(null);
    setIsCreatingStash(true);
  }, []);

  const cancelCreateStash = useCallback(() => {
    if (stashCreating) return;
    setIsCreatingStash(false);
    setStashCreateErr(null);
  }, [stashCreating]);

  const stashCreateErrorMessage = (e: unknown): string => {
    const code = (e as { code?: string } | null | undefined)?.code;
    switch (code) {
      case "functions/not-found":
        return "This Trip could not be found.";
      case "functions/permission-denied":
        return "You must be a member of this Trip to create a personal trip fund.";
      case "functions/already-exists":
        return "You already have a My Stash for this Trip.";
      case "functions/invalid-argument":
        return "Enter a target amount greater than 0.";
      case "functions/unavailable":
      case "functions/deadline-exceeded":
        return "We couldn't reach the server, so we can't confirm this went through - it's safe to try again.";
      default:
        return "We couldn't create My Stash. Please try again.";
    }
  };

  const submitCreateStash = useCallback(async () => {
    if (!tripId || !trip || !user || stashCreating) return;

    const cleaned = stashTargetText.replace(/[^0-9.]/g, "");
    const target = Number(cleaned);
    if (!Number.isFinite(target) || target <= 0) {
      setStashCreateErr("Enter a target amount greater than 0.");
      return;
    }

    const tripTitle = trip.title?.trim() || "Trip";
    const facts = { name: `${tripTitle} — My Stash`, target };

    const pending = stashPendingRef.current;
    const clientRequestId =
      pending && pending.name === facts.name && pending.target === facts.target
        ? pending.clientRequestId
        : generateBucketClientRequestId();
    stashPendingRef.current = { ...facts, clientRequestId };

    setStashCreating(true);
    setStashCreateErr(null);

    try {
      const result = await createBucket({
        name: facts.name,
        target: facts.target,
        // Minimum viable creation flow (Checkpoint 3F.3B.4): a starting
        // balance field is deliberately not exposed here yet, even
        // though createBucket already supports one generically - kept
        // out to match "Minimum: Personal spending target" exactly.
        startingBalanceMinor: 0,
        color: null,
        clientRequestId,
        bucketType: "trip_personal",
        linkedTripId: tripId,
      });

      // Checkpoint 3F.3B.4C: reconcile via an explicit read rather than
      // waiting on the (likely already-dead, see the effect above) live
      // listener. The trusted callable does not return until its
      // transaction commits, so this read resolves the committed
      // document immediately - if it somehow doesn't, reconcileMyStash
      // throws and the catch block below surfaces a real error instead
      // of silently reverting to "No personal stash yet".
      const created = await reconcileMyStash(result.bucketId);
      // Success clears the pending record - a later create is a new
      // logical request and must get a new id.
      stashPendingRef.current = null;
      setMyStash(created);
      attachMyStashListener(result.bucketId);
      setIsCreatingStash(false);
    } catch (e) {
      console.error("Failed to create My Stash:", e);
      const code = (e as { code?: string } | null | undefined)?.code;

      if (code === "functions/already-exists") {
        // Definitive, not ambiguous - and for trip_personal specifically
        // (Checkpoint 3F.3B.4C section C), it also means a real fund
        // already exists: the earlier-looking "failed" attempt may have
        // actually succeeded server-side. The deterministic id is known
        // client-side regardless of this request's own outcome, so fetch
        // and show that real fund instead of leaving the user stuck on a
        // dead-end error - this is a READ only, so it can never create a
        // duplicate or overwrite the existing fund's stored target with
        // this attempt's form data.
        stashPendingRef.current = null;
        if (tripId && myStashUid) {
          try {
            const existingId = tripPersonalBucketId(tripId, myStashUid);
            const existing = await reconcileMyStash(existingId);
            setMyStash(existing);
            attachMyStashListener(existingId);
            setIsCreatingStash(false);
            return;
          } catch (reconcileErr) {
            console.error("Failed to load existing My Stash:", reconcileErr);
            // Falls through to the generic error message below - the
            // create form stays open with a real error rather than
            // silently reverting to "No personal stash yet".
          }
        }
      }

      setStashCreateErr(stashCreateErrorMessage(e));
    } finally {
      setStashCreating(false);
    }
  }, [
    tripId,
    trip,
    user,
    myStashUid,
    stashCreating,
    stashTargetText,
    reconcileMyStash,
    attachMyStashListener,
  ]);

  // Shared Stash - a small, locally-scoped action form (not the shared
  // Bucket-specific MoneyActionSheet, which is typed around Bucket and
  // renders Bucket-specific copy) reusing the exact same trusted
  // recordSavingsTransaction call and the exact same pure
  // resolveAmountMinor/normalizeTransactionNote/
  // resolveMoneyActionClientRequestId helpers the Bucket controller
  // uses - resourceId/memberUid are resource-agnostic already, so no
  // modification to any of them was needed.
  //
  // Checkpoint 3F.3B.4A: audited line-by-line against
  // useSavingsMoneyAction and brought to full behavioral parity -
  // CLOSED_STATE-equivalent full reset on close (not just visible:
  // false), state setters guarded against editing while submitting (the
  // TextInputs below are also `editable={!submitting}`, but the state
  // guard matches the Bucket controller's own defense-in-depth exactly),
  // an optional note with the same MAX_TRANSACTION_NOTE_LENGTH
  // validation, and a real success toast via the shared controller's
  // announceSuccess (see the module import) instead of silently closing
  // with no feedback.
  const [sharedAction, setSharedAction] = useState(CLOSED_SHARED_ACTION);

  const sharedPendingRef = useRef<PendingMoneyActionRequest | null>(null);
  const sharedInFlightRef = useRef(false);

  const openSharedAction = useCallback((type: SavingsTransactionType) => {
    if (sharedInFlightRef.current) return;
    setSharedAction({ ...CLOSED_SHARED_ACTION, visible: true, type });
  }, []);

  const closeSharedAction = useCallback(() => {
    if (sharedInFlightRef.current) return;
    setSharedAction(CLOSED_SHARED_ACTION);
  }, []);

  const setSharedAmountText = useCallback((text: string) => {
    setSharedAction((s) => (s.submitting ? s : { ...s, amountText: text, error: null }));
  }, []);

  const setSharedNote = useCallback((note: string) => {
    setSharedAction((s) => (s.submitting ? s : { ...s, note }));
  }, []);

  const sharedActionErrorMessage = (e: unknown): string => {
    const code = (e as { code?: string } | null | undefined)?.code;
    switch (code) {
      case "functions/failed-precondition":
        return "That amount isn't allowed right now - it may take the balance below zero. Please check the amount and try again.";
      case "functions/permission-denied":
        return "You do not have permission to record this transaction.";
      case "functions/already-exists":
        return "That request could not be completed. Please try again.";
      case "functions/unavailable":
      case "functions/deadline-exceeded":
        return "We couldn't reach the server, so we can't confirm this went through - it's safe to try again.";
      default:
        return "We couldn't record that. Please try again.";
    }
  };

  const submitSharedAction = useCallback(async () => {
    if (!tripId || !trip || !user || sharedInFlightRef.current) return;

    const amountMinor = resolveAmountMinor(sharedAction.amountText, null);
    if (amountMinor === null) {
      setSharedAction((s) => ({
        ...s,
        error: "Enter a valid amount greater than 0, with at most 2 decimal places.",
      }));
      return;
    }

    const note = normalizeTransactionNote(sharedAction.note);
    if (note !== undefined && note.length > MAX_TRANSACTION_NOTE_LENGTH) {
      setSharedAction((s) => ({
        ...s,
        error: `Note must be ${MAX_TRANSACTION_NOTE_LENGTH} characters or fewer.`,
      }));
      return;
    }

    // Non-authoritative client-side hint only, mirroring
    // useSavingsMoneyAction's own withdrawal check - trip.saved is a
    // dollar-denominated DISPLAY cache; the trusted backend is the sole
    // authority on whether a withdrawal is actually valid.
    if (sharedAction.type === "withdrawal") {
      const currentBalanceMinor = Math.round((trip.saved ?? 0) * 100);
      if (amountMinor > currentBalanceMinor) {
        setSharedAction((s) => ({
          ...s,
          error: `You can withdraw up to ${money(trip.saved)} from the Shared Stash.`,
        }));
        return;
      }
    }

    const facts = {
      resourceId: tripId,
      memberUid: user.uid,
      type: sharedAction.type,
      amountMinor,
      note,
    };
    const clientRequestId = resolveMoneyActionClientRequestId(
      sharedPendingRef,
      facts,
      generateSavingsClientRequestId
    );

    sharedInFlightRef.current = true;
    setSharedAction((s) => ({ ...s, submitting: true, error: null }));

    try {
      await recordSavingsTransaction({
        resourceType: "trip",
        resourceId: tripId,
        memberUid: user.uid,
        type: sharedAction.type,
        amountMinor,
        currency: "USD",
        note,
        clientRequestId,
      });
      // Success clears the pending record - a later submission is a new
      // logical request and must get a new id (matches
      // useSavingsMoneyAction's submit() exactly).
      sharedPendingRef.current = null;

      const verb = sharedAction.type === "contribution" ? "Added" : "Withdrew";
      const preposition = sharedAction.type === "contribution" ? "to" : "from";
      announceSuccess(`${verb} ${money(amountMinor / 100)} ${preposition} Shared Stash`);

      setSharedAction(CLOSED_SHARED_ACTION);
      // The trusted write already landed - refetch to show the real
      // updated Shared Stash balance (this screen has no live Trip
      // subscription, only the one-shot fetchTrip already used
      // elsewhere - a data-refresh mechanism difference from Buckets,
      // which IS live-subscribed, not a semantic gap in the money-action
      // handling itself).
      fetchTrip();
    } catch (e) {
      console.error("Failed to record Shared Stash transaction:", e);
      // already-exists is DEFINITIVE (retrying the same id can only fail
      // identically forever) - every other failure (including
      // unavailable/deadline-exceeded) deliberately RETAINS the pending
      // record so a retry of the exact same submission reuses the same
      // clientRequestId. Matches useSavingsMoneyAction's submit() catch
      // block exactly.
      if ((e as { code?: string } | null | undefined)?.code === "functions/already-exists") {
        sharedPendingRef.current = null;
      }
      setSharedAction((s) => ({ ...s, submitting: false, error: sharedActionErrorMessage(e) }));
    } finally {
      sharedInFlightRef.current = false;
    }
  }, [tripId, trip, user, sharedAction.amountText, sharedAction.note, sharedAction.type, announceSuccess, fetchTrip]);

  const title = trip?.title?.trim() || "Trip Details";
  const location = (trip?.location ?? "").trim() || "No location";
  // Checkpoint 3F.3B.2: real trip dates, never fabricated. Unlike the
  // Home/Trips hero and Other Stashes cards (which omit the line
  // entirely for a legacy trip with no stored date, since no edit flow
  // exists to act on a prompt there), Trip Detail is the trip's own
  // identity page - a truthful "Add trip dates" status label reads as
  // information here, not as a dead call-to-action, so it's shown
  // instead of omitted.
  const dateText = formatTripDates(trip?.tripStartDate, trip?.tripEndDate) ?? "Add trip dates";
  const saved = Number(trip?.saved ?? 0);
  const target = Number(trip?.target ?? 0);
  const pct = target > 0 ? clamp01(saved / target) : 0;

  const imageUri =
    !imgFailed && trip?.imageUrl ? trip.imageUrl : FALLBACK_IMAGE;

  // ✅ Quick Analysis
  const membersCount = Math.max(1, trip?.memberIds?.length ?? 1);
  const remaining = Math.max(0, target - saved);
  const perPersonTarget = target / membersCount;
  const perPersonRemaining = remaining / membersCount;

  // Checkpoint 3F.3D: replaces the old arbitrary 4/8/12-week scenarios
  // with real date-driven guidance. Shared Stash's own saved/target/
  // membersCount only - My Stash is never an input here (see the
  // checkpoint report: mixing the two targets was explicitly out of
  // scope). trip.saved/trip.target are dollar-denominated display
  // caches, converted to integer minor units here for the same reason
  // submitSharedAction's own withdrawal check does
  // (Math.round(dollars * 100)) - computeTripSavingsGuidance does all
  // its arithmetic in minor units.
  const sharedGuidance = computeTripSavingsGuidance({
    tripStartDate: trip?.tripStartDate,
    targetMinor: Math.round(target * 100),
    savedMinor: Math.round(saved * 100),
    membersCount,
  });

  // Checkpoint 3F.3E: personal guidance for My Stash, via the SAME
  // computeTripSavingsGuidance() call above - not a second calculation
  // engine. Only computed when a real My Stash exists (myStash is a
  // Bucket, not undefined/null) so the loading/no-fund-yet states never
  // show a fabricated pace. Inputs are exclusively THIS member's own
  // already-loaded myStash.balance/myStash.target - never Shared
  // Stash's saved/target, never trip.memberIds.length, and never
  // another member's fund (this screen never queries one - see
  // myStash's own subscription effect above, keyed to this member's
  // deterministic bucket id only). membersCount is hardcoded to 1: a
  // personal fund has exactly one "member" by definition, so the UI
  // (PersonalPaceSection) only ever reads rateTotalMinor, never
  // ratePerPersonMinor - see tripSavingsGuidance.ts's own module
  // comment for why that's safe to do generically.
  const personalGuidance = myStash
    ? computeTripSavingsGuidance({
        tripStartDate: trip?.tripStartDate,
        targetMinor: Math.round(myStash.target * 100),
        savedMinor: Math.round(myStash.balance * 100),
        membersCount: 1,
      })
    : null;

  const dangerText = theme.colors.onErrorContainer ?? "#991B1B";

  if (loading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator />
          <Text style={[styles.loadingText, { color: theme.colors.onSurfaceVariant }]}>
            Loading…
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!trip) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        <View style={styles.loadingWrap}>
          <Text style={[styles.h1, { color: theme.colors.onBackground }]}>Trip not found</Text>
          <Text style={[styles.sub, { color: theme.colors.onSurfaceVariant }]}>
            This trip may have been deleted.
          </Text>

          <Pressable
            onPress={() => router.back()}
            style={[styles.primaryBtn, { backgroundColor: theme.colors.primary }]}
          >
            <Text style={styles.primaryBtnText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.page, { paddingBottom: scrollBottomInset }]}
      >
        <View style={isWide ? styles.gridWide : undefined}>
          {/* Main */}
          <View style={isWide ? styles.mainCol : undefined}>
            <View
              style={[
                styles.heroWrap,
                { height: headerHeight },
                cardShadowFor(theme.dark),
              ]}
            >
              <Image
                source={{ uri: imageUri }}
                style={styles.heroImg}
                resizeMode="cover"
                onError={() => setImgFailed(true)}
              />
              {/* Checkpoint 3F.3C: a bottom-weighted two-band graduated
                  scrim (mirrors components/home/ActiveStashHero.tsx's
                  identical technique - no gradient dependency) instead of
                  the previous flat rgba(0,0,0,0.28) wash over the WHOLE
                  photo, so the top of the image stays bright/image-
                  forward and only the lower text-bearing band is
                  darkened. */}
              <View pointerEvents="none" style={[styles.heroScrimWide, { height: headerHeight * 0.55 }]} />
              <View pointerEvents="none" style={[styles.heroScrimStrong, { height: headerHeight * 0.32 }]} />

              {/* Checkpoint 3F.3C: compact floating controls over the
                  photo replace the previous full-width topBar strip
                  above the hero - saves vertical space and reads as a
                  modern travel-app detail screen. Back/Delete behavior
                  is unchanged, only relocated and restyled; these pill
                  backgrounds use the same fixed dark-on-photo treatment
                  as ActiveStashHero's badges (PHOTO_NAVY-family, not
                  semantic tokens) since they must stay legible over any
                  photo regardless of the active app theme. */}
              <View style={styles.heroTopRow}>
                <Pressable
                  onPress={() => router.back()}
                  accessibilityRole="button"
                  accessibilityLabel="Back"
                  style={({ pressed }) => [styles.navPill, pressed && { opacity: 0.85 }]}
                  hitSlop={8}
                >
                  <MaterialCommunityIcons name="chevron-left" size={18} color="#FFFFFF" />
                  <Text style={styles.navPillText}>Back</Text>
                </Pressable>

                {/* Checkpoint 3F.3B.3: "Record Expense" removed - it was
                    a dead control (onPress={() => console.log(...)}, no
                    real expense architecture exists to wire it to yet).
                    See the checkpoint report: SquadStash's frozen
                    Milestone 2A domain model already defines Expense/
                    ExpenseSplit/Settlement types for a future shared-vs-
                    personal expense system, but none of it has a
                    service, Cloud Function, or Firestore rules today -
                    restoring this button requires that foundation
                    first, not a placeholder here. */}
                {isOwner ? (
                  <Pressable
                    onPress={onDeleteTrip}
                    accessibilityRole="button"
                    accessibilityLabel="Delete trip"
                    style={({ pressed }) => [styles.iconOnlyPill, pressed && { opacity: 0.85 }]}
                    hitSlop={10}
                  >
                    <MaterialCommunityIcons name="trash-can-outline" size={16} color="#FF8A85" />
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.heroText}>
                <Text style={styles.heroTitle} numberOfLines={1}>
                  {title}
                </Text>
                {location !== "No location" ? (
                  <Text style={styles.heroLocation} numberOfLines={1}>
                    {location}
                  </Text>
                ) : null}
                {/* Checkpoint 3F.3B.3: owner-only tap-to-edit; a
                    non-owner member sees the identical text but it's
                    plain (read-only), matching "Owner may update dates;
                    Member may NOT". */}
                {isOwner ? (
                  <Pressable
                    onPress={startEditDates}
                    accessibilityRole="button"
                    accessibilityLabel="Edit trip dates"
                    hitSlop={6}
                    style={styles.heroDateRow}
                  >
                    <MaterialCommunityIcons name="calendar-blank-outline" size={12} color="rgba(255,255,255,0.75)" />
                    <Text style={[styles.heroDate, styles.heroDateEditable]} numberOfLines={1}>
                      {dateText} · Edit
                    </Text>
                  </Pressable>
                ) : (
                  <View style={styles.heroDateRow}>
                    <MaterialCommunityIcons name="calendar-blank-outline" size={12} color="rgba(255,255,255,0.75)" />
                    <Text style={styles.heroDate} numberOfLines={1}>
                      {dateText}
                    </Text>
                  </View>
                )}
              </View>

              <View style={styles.fundedPill}>
                <Text style={styles.fundedPillText}>{Math.round(pct * 100)}% funded</Text>
              </View>
            </View>

            {/* Checkpoint 3F.3B.3: compact owner-only date-edit form -
                a real Cancel/Save flow, not a fake local-only control.
                Rendered as its own card rather than overlaid on the
                photo, since text inputs need a plain background. */}
            {isEditingDates ? (
              <View
                style={[
                  styles.card,
                  { backgroundColor: theme.colors.surface, borderColor: colors.border },
                  cardShadowFor(theme.dark),
                ]}
              >
                <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Trip dates</Text>

                <View style={{ height: spacing.sm }} />

                <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>
                  Trip starts (YYYY-MM-DD)
                </Text>
                <TextInput
                  value={editStart}
                  onChangeText={(v) => {
                    setEditStart(v);
                    if (dateErr) setDateErr(null);
                  }}
                  placeholder={todayCanonicalDate()}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.input,
                    {
                      color: colors.textPrimary,
                      borderColor: colors.border,
                      backgroundColor: theme.colors.background,
                    },
                  ]}
                />

                <View style={{ height: spacing.sm }} />

                <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>
                  Trip ends (optional, YYYY-MM-DD)
                </Text>
                <TextInput
                  value={editEnd}
                  onChangeText={(v) => {
                    setEditEnd(v);
                    if (dateErr) setDateErr(null);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.input,
                    {
                      color: colors.textPrimary,
                      borderColor: colors.border,
                      backgroundColor: theme.colors.background,
                    },
                  ]}
                />

                {dateErr ? (
                  <Text style={[styles.errorText, { color: dangerText }]}>{dateErr}</Text>
                ) : null}

                <View style={styles.actionsRow}>
                  <Pressable
                    onPress={saveDates}
                    disabled={dateSaving}
                    style={({ pressed }) => [
                      styles.primaryActionBtn,
                      { backgroundColor: colors.mint },
                      (pressed || dateSaving) && { opacity: 0.85 },
                    ]}
                  >
                    <Text style={[styles.primaryActionText, { color: colors.onMint }]}>
                      {dateSaving ? "Saving…" : "Save"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={cancelEditDates}
                    disabled={dateSaving}
                    style={({ pressed }) => [
                      styles.secondaryActionBtn,
                      { borderColor: colors.border },
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>
                      Cancel
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View
              style={[
                styles.card,
                { backgroundColor: theme.colors.surface, borderColor: colors.border },
                cardShadowFor(theme.dark),
              ]}
            >
              <View style={styles.cardHeaderRow}>
                <View style={[styles.iconBubble, { backgroundColor: colors.bluePale }]}>
                  <MaterialCommunityIcons name="account-group-outline" size={18} color={colors.blue} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Shared Stash</Text>
                  <Text style={[styles.cardSub, { color: colors.textMuted }]}>
                    Group money for the trip
                  </Text>
                </View>
              </View>

              <View style={styles.amountRow}>
                <Text style={[styles.amountBig, { color: colors.textPrimary }]}>{money(saved)}</Text>
                <Text style={[styles.amountSmall, { color: colors.textMuted }]}> / {money(target)}</Text>
              </View>

              <View style={[styles.progressTrack, { backgroundColor: colors.slatePale }]}>
                <View
                  style={[styles.progressFill, { width: `${pct * 100}%`, backgroundColor: colors.mint }]}
                />
              </View>

              <Text style={[styles.remainingText, { color: colors.textMuted }]}>
                {money(remaining)} remaining
              </Text>

              {/* Checkpoint 3F.3B.4: real Add Money/Withdraw for the
                  Shared Stash - resourceType: "trip", resourceId:
                  trip.id, self-attributed to the authenticated member
                  (memberUid: user.uid, never a client-chosen other
                  member), via the same trusted recordSavingsTransaction
                  path Buckets already use. */}
              {!sharedAction.visible ? (
                <View style={styles.actionsRow}>
                  <Pressable
                    onPress={() => openSharedAction("contribution")}
                    style={({ pressed }) => [
                      styles.primaryActionBtn,
                      { backgroundColor: colors.mint },
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <Text style={[styles.primaryActionText, { color: colors.onMint }]}>Add Money</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => openSharedAction("withdrawal")}
                    style={({ pressed }) => [
                      styles.secondaryActionBtn,
                      { borderColor: colors.border },
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>Withdraw</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.inlineForm}>
                  <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>
                    {sharedAction.type === "contribution" ? "Add to Shared Stash" : "Withdraw from Shared Stash"}
                  </Text>
                  <TextInput
                    value={sharedAction.amountText}
                    onChangeText={setSharedAmountText}
                    placeholder="0.00"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numeric"
                    editable={!sharedAction.submitting}
                    style={[
                      styles.input,
                      { color: colors.textPrimary, borderColor: colors.border, backgroundColor: theme.colors.background },
                    ]}
                  />

                  <TextInput
                    value={sharedAction.note}
                    onChangeText={setSharedNote}
                    placeholder="Note (optional)"
                    placeholderTextColor={colors.textMuted}
                    editable={!sharedAction.submitting}
                    maxLength={MAX_TRANSACTION_NOTE_LENGTH}
                    style={[
                      styles.input,
                      { color: colors.textPrimary, borderColor: colors.border, backgroundColor: theme.colors.background },
                    ]}
                  />
                  {sharedAction.error ? (
                    <Text style={[styles.errorText, { color: dangerText }]}>{sharedAction.error}</Text>
                  ) : null}
                  <View style={styles.actionsRow}>
                    <Pressable
                      onPress={submitSharedAction}
                      disabled={sharedAction.submitting}
                      style={({ pressed }) => [
                        styles.primaryActionBtn,
                        { backgroundColor: colors.mint },
                        (pressed || sharedAction.submitting) && { opacity: 0.85 },
                      ]}
                    >
                      <Text style={[styles.primaryActionText, { color: colors.onMint }]}>
                        {sharedAction.submitting
                          ? "Saving…"
                          : sharedAction.type === "contribution"
                            ? "Add"
                            : "Withdraw"}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={closeSharedAction}
                      disabled={sharedAction.submitting}
                      style={({ pressed }) => [
                        styles.secondaryActionBtn,
                        { borderColor: colors.border },
                        pressed && { opacity: 0.9 },
                      ]}
                    >
                      <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>

            {/* Checkpoint 3F.3B.4: MY STASH - a private trip_personal
                Bucket owned by the authenticated member, linked to this
                Trip. Never shows another member's balance/target/
                transactions - myStash is looked up by THIS member's own
                deterministic bucket id only (see the effect above), and
                Firestore rules independently enforce that a Bucket's
                access is governed solely by its own memberIds regardless
                of who owns the linked Trip. */}
            <View style={[styles.card, styles.privateCard, { backgroundColor: theme.colors.surface }]}>
              {/* Checkpoint 3F.3C.1: a translucent mint tint OVER the
                  normal card surface, instead of `colors.mintSurface`
                  used as an opaque solid fill - the solid fill (approved
                  in 3F.3C) read as too saturated/panel-like in review.
                  Combines the same two existing semantic tokens
                  (mintSurface + the ordinary card surface) rather than
                  hardcoding a new lighter green - halving mintSurface's
                  opacity here is the "lighten one step" requested, not a
                  new color. `pointerEvents="none"` + being the first
                  child (painted below every subsequent sibling) keeps it
                  purely decorative. */}
              <View pointerEvents="none" style={[styles.privateTint, { backgroundColor: colors.mintSurface }]} />
              <View style={styles.cardHeaderRow}>
                <View style={[styles.iconBubble, { backgroundColor: theme.colors.surface }]}>
                  <MaterialCommunityIcons name="lock-outline" size={18} color={colors.mintDark} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>My Stash</Text>
                  <Text style={[styles.cardSub, { color: colors.mintText }]}>Private to you</Text>
                </View>
              </View>

              {myStash === undefined ? (
                <View style={styles.stashLoadingWrap}>
                  <ActivityIndicator />
                </View>
              ) : myStash === null ? (
                isCreatingStash ? (
                  <View style={styles.inlineForm}>
                    <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>
                      Personal spending target
                    </Text>
                    <TextInput
                      value={stashTargetText}
                      onChangeText={(v) => {
                        setStashTargetText(v);
                        if (stashCreateErr) setStashCreateErr(null);
                      }}
                      placeholder="1000"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="numeric"
                      editable={!stashCreating}
                      style={[
                        styles.input,
                        { color: colors.textPrimary, borderColor: colors.mintDark, backgroundColor: theme.colors.surface },
                      ]}
                    />
                    {stashCreateErr ? (
                      <Text style={[styles.errorText, { color: dangerText }]}>{stashCreateErr}</Text>
                    ) : null}
                    <View style={styles.actionsRow}>
                      <Pressable
                        onPress={submitCreateStash}
                        disabled={stashCreating}
                        style={({ pressed }) => [
                          styles.primaryActionBtn,
                          { backgroundColor: colors.mintDark },
                          (pressed || stashCreating) && { opacity: 0.85 },
                        ]}
                      >
                        <Text style={[styles.primaryActionText, { color: colors.onMint }]}>
                          {stashCreating ? "Creating…" : "Create My Stash"}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={cancelCreateStash}
                        disabled={stashCreating}
                        style={({ pressed }) => [
                          styles.secondaryActionBtn,
                          { borderColor: colors.mintDark },
                          pressed && { opacity: 0.9 },
                        ]}
                      >
                        <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View style={styles.stashEmptyWrap}>
                    <Text style={[styles.cardSub, { color: colors.textSecondary }]}>
                      No personal stash yet
                    </Text>
                    <Pressable
                      onPress={startCreateStash}
                      style={({ pressed }) => [
                        styles.primaryActionBtn,
                        styles.inlinePrimaryBtn,
                        { backgroundColor: colors.mintDark },
                        pressed && { opacity: 0.9 },
                      ]}
                    >
                      <Text style={[styles.primaryActionText, { color: colors.onMint }]}>
                        Create My Stash
                      </Text>
                    </Pressable>
                  </View>
                )
              ) : (
                <>
                  <Text style={[styles.cardSub, { color: colors.textSecondary }]}>
                    Your personal spending money
                  </Text>
                  <View style={styles.amountRow}>
                    <Text style={[styles.amountBig, { color: colors.textPrimary }]}>
                      {money(myStash.balance)}
                    </Text>
                    <Text style={[styles.amountSmall, { color: colors.textSecondary }]}>
                      {" "}
                      / {money(myStash.target)}
                    </Text>
                  </View>
                  <View style={[styles.progressTrack, { backgroundColor: colors.slatePale }]}>
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: `${clamp01(myStash.target > 0 ? myStash.balance / myStash.target : 0) * 100}%`,
                          backgroundColor: colors.mintDark,
                        },
                      ]}
                    />
                  </View>

                  {/* Checkpoint 3F.3E: compact personal pace, derived
                      live from myStash's own real-time subscription -
                      no new listener, nothing persisted. */}
                  {personalGuidance ? (
                    <PersonalPaceSection guidance={personalGuidance} colors={colors} />
                  ) : null}

                  {/* My Stash IS an ordinary Bucket - reuses the exact
                      same trusted useSavingsMoneyAction()/
                      MoneyActionSheet Bucket Detail already uses, not a
                      new financial write system. */}
                  <View style={styles.actionsRow}>
                    <Pressable
                      onPress={() =>
                        openMoneyAction(myStash, "contribution", {
                          displayTitle: "My Stash",
                          displaySubtitle: title,
                        })
                      }
                      style={({ pressed }) => [
                        styles.primaryActionBtn,
                        { backgroundColor: colors.mintDark },
                        pressed && { opacity: 0.9 },
                      ]}
                    >
                      <Text style={[styles.primaryActionText, { color: colors.onMint }]}>Add Money</Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        openMoneyAction(myStash, "withdrawal", {
                          displayTitle: "My Stash",
                          displaySubtitle: title,
                        })
                      }
                      style={({ pressed }) => [
                        styles.secondaryActionBtn,
                        { borderColor: colors.mintDark },
                        pressed && { opacity: 0.9 },
                      ]}
                    >
                      <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>Withdraw</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          </View>

          {/* Side */}
          <View style={isWide ? styles.sideCol : undefined}>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.colors.surface, borderColor: colors.border },
                cardShadowFor(theme.dark),
              ]}
            >
              <View style={styles.cardHeaderRow}>
                <View style={[styles.iconBubble, { backgroundColor: colors.slatePale }]}>
                  <MaterialCommunityIcons name="chart-donut" size={18} color={colors.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Quick Analysis</Text>
                  <Text style={[styles.cardSub, { color: colors.textMuted }]}>
                    Based on your shared goal
                  </Text>
                </View>
              </View>

              <View style={styles.metricRow}>
                <MetricBlock label="Members" value={`${membersCount}`} colors={colors} />
                <MetricBlock label="Saved" value={money(saved)} colors={colors} />
                <MetricBlock label="Remaining" value={money(remaining)} colors={colors} />
              </View>

              <Text style={[styles.groupLabel, { color: colors.textMuted }]}>Per Person</Text>
              <Row label="Target" value={money(perPersonTarget)} themeText={colors.textPrimary} muted={colors.textMuted} />
              <Row label="Remaining" value={money(perPersonRemaining)} themeText={colors.textPrimary} muted={colors.textMuted} />

              {/* Checkpoint 3F.3D: real date-driven guidance, replacing
                  the old arbitrary 4/8/12-week scenarios entirely - see
                  TripTimelineSection below for the per-state copy
                  (missing date / trip started / goal reached / active
                  pace). Derived purely from current screen state
                  (sharedGuidance above), never persisted. */}
              <Text style={[styles.groupLabel, { color: colors.textMuted, marginTop: spacing.md }]}>
                Trip Timeline
              </Text>
              <TripTimelineSection
                guidance={sharedGuidance}
                tripStartDate={trip.tripStartDate}
                colors={colors}
              />
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  label,
  value,
  themeText,
  muted,
}: {
  label: string;
  value: string;
  themeText: string;
  muted: string;
}) {
  return (
    <View style={styles.qaRow}>
      <Text style={[styles.qaLabel, { color: muted }]}>{label}</Text>
      <Text style={[styles.qaValue, { color: themeText }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

// Checkpoint 3F.3C: compact "mini metric block" for Quick Analysis' top
// row (Members | Saved | Remaining) - a small value-over-label chip,
// matching the density/scannability direction requested for this
// checkpoint. No calculation logic lives here; it only renders values
// already computed above.
function MetricBlock({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: SemanticColors;
}) {
  return (
    <View style={[styles.metricBlock, { backgroundColor: colors.background }]}>
      <Text style={[styles.metricValue, { color: colors.textPrimary }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.metricLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  );
}

// Checkpoint 3F.3D: renders Quick Analysis' "Trip Timeline" section from
// a computeTripSavingsGuidance() result - one clearly-separated branch
// per truthful state (never a fabricated "on track" claim, never a
// fallback to the old 4/8/12-week scenarios). Purely presentational -
// all the arithmetic already happened in src/domain/tripSavingsGuidance.ts;
// this only formats and lays out the result. tripStartDate is passed
// separately (not derived from `guidance`) solely to render the real
// "by <date>" footnote on the ACTIVE branch - the guidance computation
// itself never returns the raw date string.
function TripTimelineSection({
  guidance,
  tripStartDate,
  colors,
}: {
  guidance: TripSavingsGuidance;
  tripStartDate: string | null | undefined;
  colors: SemanticColors;
}) {
  // Checkpoint 3F.3D.1: checked ahead of MISSING_DATE/TRIP_STARTED to
  // match computeTripSavingsGuidance's own precedence - a target that
  // was never usable is unrelated to whether the trip has a date.
  if (guidance.status === "INVALID_TARGET") {
    return (
      <Text style={[styles.guidanceMuted, { color: colors.textMuted }]}>
        Set a shared savings target to calculate your recommended pace.
      </Text>
    );
  }

  if (guidance.status === "MISSING_DATE") {
    return (
      <Text style={[styles.guidanceMuted, { color: colors.textMuted }]}>
        Add a trip start date to calculate your savings pace.
      </Text>
    );
  }

  if (guidance.status === "TRIP_STARTED") {
    return (
      <Text style={[styles.guidanceHeadline, { color: colors.textPrimary }]}>
        {guidance.startsToday ? "Trip starts today" : "Trip has started"}
      </Text>
    );
  }

  if (guidance.status === "GOAL_REACHED") {
    return (
      <>
        <Text style={[styles.guidanceHeadline, { color: colors.mintText }]}>
          Shared goal reached
        </Text>
        <Text style={[styles.guidanceSub, { color: colors.textMuted }]}>
          {money(guidance.savedMinor / 100)} saved
        </Text>
      </>
    );
  }

  // ACTIVE - a real required pace, never an "on track" prediction (no
  // contribution-history/expected-pace model exists to truthfully claim
  // that yet).
  const unit = guidance.pace === "weekly" ? "week" : "day";
  const startText = formatCanonicalDateShort(tripStartDate);

  return (
    <>
      <Text style={[styles.guidanceHeadline, { color: colors.textPrimary }]}>
        {formatTripHorizonText(guidance.fullWeeksUntilStart, guidance.extraDays)}
      </Text>
      <Text style={[styles.guidanceSub, { color: colors.textMuted }]}>
        {money(guidance.remainingMinor / 100)} left to save
      </Text>

      <Text style={[styles.groupLabel, { color: colors.textMuted, marginTop: spacing.md }]}>
        Recommended Pace
      </Text>
      <Text style={[styles.paceValue, { color: colors.textPrimary }]}>
        {money(guidance.rateTotalMinor / 100)} / {unit} total
      </Text>
      <Text style={[styles.paceValueMuted, { color: colors.textMuted }]}>
        {money(guidance.ratePerPersonMinor / 100)} / {unit} per person
      </Text>

      <Text style={[styles.guidanceFootnote, { color: colors.textMuted }]}>
        {startText
          ? `Average needed from today to reach the shared goal by ${startText}.`
          : "Average needed from today to reach the shared goal."}
      </Text>
    </>
  );
}

// Checkpoint 3F.3E: a COMPACT personal-pace section rendered inside the
// existing My Stash card (never a second full-width analysis card, and
// never rendered for My Stash's loading/no-fund-yet states - see the
// `personalGuidance` computation above, which is null in both of
// those). Deliberately much shorter than TripTimelineSection: no
// separate headline/sub/footnote layout, since My Stash's own "$X / Y"
// balance line and progress bar already establish the amount context -
// this only adds the pace itself. Personalizes every state's copy
// ("personal"/"your" instead of "shared") and, for ACTIVE, renders ONLY
// guidance.rateTotalMinor - never ratePerPersonMinor and never the
// words "total"/"per person", which belong to Shared guidance only (My
// Stash IS already one person's fund, so a second "per person" number
// would just be a confusing duplicate of the same figure).
function PersonalPaceSection({
  guidance,
  colors,
}: {
  guidance: TripSavingsGuidance;
  colors: SemanticColors;
}) {
  if (guidance.status === "INVALID_TARGET") {
    return (
      <Text style={[styles.guidanceMuted, { color: colors.textSecondary }]}>
        Set a personal savings target to calculate your pace.
      </Text>
    );
  }

  if (guidance.status === "MISSING_DATE") {
    return (
      <Text style={[styles.guidanceMuted, { color: colors.textSecondary }]}>
        Add a trip start date to calculate your personal pace.
      </Text>
    );
  }

  if (guidance.status === "TRIP_STARTED") {
    return (
      <Text style={[styles.guidanceMuted, { color: colors.textSecondary }]}>
        {guidance.startsToday ? "Trip starts today" : "Trip has started"}
      </Text>
    );
  }

  if (guidance.status === "GOAL_REACHED") {
    return (
      <View style={styles.personalPaceWrap}>
        <Text style={[styles.paceValue, { color: colors.mintText }]}>Personal goal reached</Text>
        <Text style={[styles.guidanceSub, { color: colors.textSecondary }]}>
          {money(guidance.savedMinor / 100)} saved
        </Text>
      </View>
    );
  }

  // ACTIVE - rateTotalMinor only (see the module comment above).
  const unit = guidance.pace === "weekly" ? "week" : "day";
  return (
    <View style={styles.personalPaceWrap}>
      <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>Your Pace</Text>
      <Text style={[styles.paceValue, { color: colors.textPrimary }]}>
        {money(guidance.rateTotalMinor / 100)} / {unit}
      </Text>
      <Text style={[styles.guidanceSub, { color: colors.textSecondary }]}>
        {money(guidance.remainingMinor / 100)} left ·{" "}
        {formatTripHorizonText(guidance.fullWeeksUntilStart, guidance.extraDays)}
      </Text>
    </View>
  );
}

// Checkpoint 3F.3C: fixed (non-semantic) dark-on-photo treatment for
// controls/badges drawn directly over the hero image - mirrors
// components/home/ActiveStashHero.tsx's identical PHOTO_MINT/PHOTO_NAVY
// rationale exactly: text/icons on a travel photo need to stay legible
// regardless of whether the app theme is Light or Dark, so these
// intentionally do NOT come from useSemanticColors().
const PHOTO_MINT = "#45F0AE";

const styles = StyleSheet.create({
  safe: { flex: 1 },

  // Checkpoint 3F.3B.4B: bottom padding is applied dynamically via
  // scrollBottomInset (computed above from the real floating BottomNav
  // dimensions), not a static value here.
  page: { padding: spacing.lg },

  gridWide: { flexDirection: "row", gap: spacing.lg, alignItems: "flex-start" },
  mainCol: { flex: 1, minWidth: 560 },
  sideCol: { width: 360 },

  // --- Hero -----------------------------------------------------------
  heroWrap: {
    borderRadius: radii.xl,
    overflow: "hidden",
    position: "relative",
  },
  heroImg: { width: "100%", height: "100%", position: "absolute" },
  heroScrimWide: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(9,14,26,0.2)",
  },
  heroScrimStrong: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(9,14,26,0.45)",
  },

  heroTopRow: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 2,
  },
  navPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 32,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: "rgba(9,14,26,0.55)",
  },
  navPillText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  iconOnlyPill: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(9,14,26,0.55)",
  },

  heroText: { position: "absolute", left: spacing.lg, right: spacing.lg, bottom: spacing.md },
  heroTitle: { ...typography.headline, fontSize: 24, color: "#FFFFFF" },
  heroLocation: { marginTop: 2, color: "rgba(255,255,255,0.85)", fontSize: 13, fontWeight: "600" },
  heroDateRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  heroDate: { color: "rgba(255,255,255,0.78)", fontSize: 11, fontWeight: "600" },
  heroDateEditable: { textDecorationLine: "underline" },

  fundedPill: {
    position: "absolute",
    right: spacing.md,
    bottom: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: "rgba(9,14,26,0.55)",
  },
  fundedPillText: { color: PHOTO_MINT, fontSize: 11, fontWeight: "800" },

  // --- Shared form/field primitives (date edit, Shared Stash inline
  // form, My Stash create form) ----------------------------------------
  fieldLabel: { ...typography.meta, marginBottom: spacing.xs },
  input: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    marginBottom: spacing.sm,
  },
  errorText: { fontSize: 12, fontWeight: "700", marginTop: 2, marginBottom: spacing.xs },
  inlineForm: { marginTop: spacing.sm },

  actionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  primaryActionBtn: {
    flex: 1,
    height: 42,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryActionText: { fontSize: 13, fontWeight: "800" },
  secondaryActionBtn: {
    flex: 1,
    height: 42,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryActionText: { fontSize: 13, fontWeight: "800" },
  inlinePrimaryBtn: { flex: undefined, alignSelf: "flex-start", paddingHorizontal: spacing.lg, marginTop: spacing.sm },

  // --- Cards ------------------------------------------------------------
  card: {
    marginTop: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
  },
  // My Stash's pale mint tint IS its border - an explicit border would
  // read as a harsh edge against its own near-white-mint background.
  // overflow: "hidden" clips privateTint (below) to the card's own
  // rounded corners instead of bleeding square corners over them.
  privateCard: { borderWidth: 0, overflow: "hidden" },
  // Checkpoint 3F.3C.1: half-opacity so the mint wash reads as a subtle
  // tint over the card's normal surface rather than 3F.3C's solid,
  // fully-saturated mintSurface fill.
  privateTint: { ...StyleSheet.absoluteFillObject, opacity: 0.5 },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm },
  iconBubble: {
    width: 34,
    height: 34,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { ...typography.cardTitle, fontSize: 15 },
  cardSub: { fontSize: 12, fontWeight: "600", marginTop: 1 },

  amountRow: { flexDirection: "row", alignItems: "flex-end", marginTop: spacing.xs },
  amountBig: { fontSize: 28, fontWeight: "800" },
  amountSmall: { fontSize: 13, fontWeight: "700", marginBottom: 3 },

  progressTrack: {
    marginTop: spacing.sm,
    height: 8,
    borderRadius: radii.pill,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: radii.pill },

  remainingText: { marginTop: spacing.sm, fontSize: 12, fontWeight: "700" },

  stashLoadingWrap: { paddingVertical: spacing.md, alignItems: "center" },
  stashEmptyWrap: { marginTop: spacing.xs },

  // --- Quick Analysis -----------------------------------------------
  groupLabel: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  metricRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  metricBlock: {
    flex: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  metricValue: { fontSize: 16, fontWeight: "800" },
  metricLabel: { fontSize: 10, fontWeight: "700", marginTop: 2 },

  qaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.xs,
  },
  qaLabel: { fontSize: 13, fontWeight: "700" },
  qaValue: { fontSize: 13, fontWeight: "800", marginLeft: spacing.sm },

  // Checkpoint 3F.3D: Trip Timeline / Recommended Pace text (see
  // TripTimelineSection) - short, stacked lines rather than one dense
  // combined string, consistent with 3F.3C.1's wrapping/clipping fix for
  // the section this one replaces.
  guidanceMuted: { fontSize: 13, fontWeight: "600", marginTop: spacing.xs },
  guidanceHeadline: { fontSize: 15, fontWeight: "800", marginTop: spacing.xs },
  guidanceSub: { fontSize: 12, fontWeight: "600", marginTop: 2 },
  paceValue: { fontSize: 15, fontWeight: "800", marginTop: 2 },
  // Deliberately smaller/quieter than paceValue (the total rate) - keeps
  // the per-person figure from reading as a second, equally-important
  // number, matching 3F.3C.1's identical rationale for the section this
  // replaces.
  paceValueMuted: { fontSize: 12, fontWeight: "600", marginTop: 1 },
  guidanceFootnote: { fontSize: 11, fontWeight: "500", marginTop: spacing.xs },

  // Checkpoint 3F.3E: My Stash's compact personal-pace area (see
  // PersonalPaceSection) - a small gap above/below so it reads as its
  // own compact block between the progress bar and the Add Money/
  // Withdraw buttons, without materially growing the card.
  personalPaceWrap: { marginTop: spacing.sm, marginBottom: spacing.xs },

  // --- Loading / not-found (unchanged states) -------------------------
  loadingWrap: { paddingTop: 60, alignItems: "center", gap: 10 },
  loadingText: { fontSize: 13 },
  h1: { fontSize: 20, fontWeight: "900" },
  sub: { fontSize: 13, marginTop: 6 },

  primaryBtn: {
    marginTop: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
  },
  primaryBtnText: { color: "#fff", fontWeight: "900" },
});
