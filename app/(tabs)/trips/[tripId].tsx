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

import { BAR_HEIGHT, CENTER_BUTTON_SIZE } from "../../../components/navigation/BottomNav";
import { spacing } from "../../../src/theme/tokens";
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
import { formatTripDates, isValidCanonicalDate, todayCanonicalDate } from "../../../src/domain/tripDates";
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

  const weeklyPlans = [
    { label: "4 wks", weeks: 4 },
    { label: "8 wks", weeks: 8 },
    { label: "12 wks", weeks: 12 },
  ].map((p) => ({
    ...p,
    perWeekTotal: remaining / p.weeks,
    perWeekPerPerson: perPersonRemaining / p.weeks,
  }));

  const dangerBg = theme.colors.errorContainer ?? "#FEE2E2";
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
      {/* Top bar */}
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.topBtn,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.outline,
            },
            pressed && { opacity: 0.85 },
          ]}
          hitSlop={10}
        >
          <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>← Back</Text>
        </Pressable>

        <View style={{ flexDirection: "row", gap: 10 }}>
          {/* Checkpoint 3F.3B.3: "Record Expense" removed - it was a
              dead control (onPress={() => console.log(...)}, no real
              expense architecture exists to wire it to yet). See the
              checkpoint report: SquadStash's frozen Milestone 2A domain
              model already defines Expense/ExpenseSplit/Settlement types
              for a future shared-vs-personal expense system, but none of
              it has a service, Cloud Function, or Firestore rules today
              - restoring this button requires that foundation first, not
              a placeholder here. */}
          {isOwner ? (
            <Pressable
              onPress={onDeleteTrip}
              style={({ pressed }) => [
                styles.topBtn,
                { backgroundColor: dangerBg, borderColor: theme.colors.outline },
                pressed && { opacity: 0.9 },
              ]}
              hitSlop={12}
            >
              <Text style={{ color: dangerText, fontWeight: "900" }}>Delete</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.page, { paddingBottom: scrollBottomInset }]}
      >
        <View style={isWide ? styles.gridWide : undefined}>
          {/* Main */}
          <View style={isWide ? styles.mainCol : undefined}>
            <View
              style={[
                styles.heroWrap,
                {
                  height: headerHeight,
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.outline,
                },
              ]}
            >
              <Image
                source={{ uri: imageUri }}
                style={styles.heroImg}
                resizeMode="cover"
                onError={() => setImgFailed(true)}
              />
              <View style={styles.heroOverlay} />

              <View style={styles.heroText}>
                <Text style={styles.heroTitle} numberOfLines={1}>
                  {title}
                </Text>
                <Text style={styles.heroLocation} numberOfLines={1}>
                  {location}
                </Text>
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
                  >
                    <Text style={[styles.heroDate, styles.heroDateEditable]} numberOfLines={1}>
                      {dateText} · Edit
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={styles.heroDate} numberOfLines={1}>
                    {dateText}
                  </Text>
                )}
              </View>

              <View
                style={[
                  styles.pill,
                  {
                    backgroundColor: theme.dark
                      ? "rgba(17,24,42,0.85)"
                      : "rgba(255,255,255,0.85)",
                    borderColor: "rgba(0,0,0,0.08)",
                  },
                ]}
              >
                <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>
                  {Math.round(pct * 100)}% funded
                </Text>
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
                  { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
                ]}
              >
                <Text style={[styles.cardTitle, { color: theme.colors.onBackground }]}>
                  Trip dates
                </Text>

                <View style={{ height: 10 }} />

                <Text style={[styles.dateFieldLabel, { color: theme.colors.onSurfaceVariant }]}>
                  Trip starts (YYYY-MM-DD)
                </Text>
                <TextInput
                  value={editStart}
                  onChangeText={(v) => {
                    setEditStart(v);
                    if (dateErr) setDateErr(null);
                  }}
                  placeholder={todayCanonicalDate()}
                  placeholderTextColor={theme.colors.onSurfaceVariant}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.dateInput,
                    {
                      color: theme.colors.onBackground,
                      borderColor: theme.colors.outline,
                      backgroundColor: theme.colors.background,
                    },
                  ]}
                />

                <View style={{ height: 10 }} />

                <Text style={[styles.dateFieldLabel, { color: theme.colors.onSurfaceVariant }]}>
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
                    styles.dateInput,
                    {
                      color: theme.colors.onBackground,
                      borderColor: theme.colors.outline,
                      backgroundColor: theme.colors.background,
                    },
                  ]}
                />

                {dateErr ? (
                  <Text style={[styles.dateErrorText, { color: dangerText }]}>{dateErr}</Text>
                ) : null}

                <View style={{ height: 12 }} />

                <View style={{ flexDirection: "row", gap: 10 }}>
                  <Pressable
                    onPress={saveDates}
                    disabled={dateSaving}
                    style={({ pressed }) => [
                      styles.topBtn,
                      { backgroundColor: theme.colors.primary },
                      (pressed || dateSaving) && { opacity: 0.85 },
                    ]}
                  >
                    <Text style={{ color: theme.colors.onPrimary, fontWeight: "900" }}>
                      {dateSaving ? "Saving…" : "Save"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={cancelEditDates}
                    disabled={dateSaving}
                    style={({ pressed }) => [
                      styles.topBtn,
                      { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>
                      Cancel
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View
              style={[
                styles.card,
                { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
              ]}
            >
              <View style={styles.stashHeaderRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardTitle, { color: theme.colors.onBackground }]}>
                    Shared Stash
                  </Text>
                  <Text style={[styles.stashSub, { color: theme.colors.onSurfaceVariant }]}>
                    Group savings for shared trip costs
                  </Text>
                </View>
              </View>

              <View style={{ height: 6 }} />

              <View style={styles.amountRow}>
                <Text style={[styles.amountBig, { color: theme.colors.onBackground }]}>
                  {money(saved)}
                </Text>
                <Text style={[styles.amountSmall, { color: theme.colors.onSurfaceVariant }]}>
                  {" "}
                  / {money(target)}
                </Text>
              </View>

              <View
                style={[
                  styles.progressOuter,
                  { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outline },
                ]}
              >
                <View
                  style={[
                    styles.progressInner,
                    { width: `${pct * 100}%`, backgroundColor: theme.colors.primary },
                  ]}
                />
              </View>

              <Text style={[styles.remaining, { color: theme.colors.onSurfaceVariant }]}>
                Remaining:{" "}
                <Text style={{ fontWeight: "900", color: theme.colors.onBackground }}>
                  {money(remaining)}
                </Text>
              </Text>

              {/* Checkpoint 3F.3B.4: real Add Money/Withdraw for the
                  Shared Stash - resourceType: "trip", resourceId:
                  trip.id, self-attributed to the authenticated member
                  (memberUid: user.uid, never a client-chosen other
                  member), via the same trusted recordSavingsTransaction
                  path Buckets already use. */}
              {!sharedAction.visible ? (
                <View style={styles.stashActionsRow}>
                  <Pressable
                    onPress={() => openSharedAction("contribution")}
                    style={({ pressed }) => [
                      styles.stashActionBtn,
                      { backgroundColor: theme.colors.primary },
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <Text style={{ color: theme.colors.onPrimary, fontWeight: "900" }}>
                      Add Money
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => openSharedAction("withdrawal")}
                    style={({ pressed }) => [
                      styles.stashActionBtn,
                      { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline, borderWidth: 1 },
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>
                      Withdraw
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.stashActionForm}>
                  <Text style={[styles.dateFieldLabel, { color: theme.colors.onSurfaceVariant }]}>
                    {sharedAction.type === "contribution" ? "Add to Shared Stash" : "Withdraw from Shared Stash"}
                  </Text>
                  <TextInput
                    value={sharedAction.amountText}
                    onChangeText={setSharedAmountText}
                    placeholder="0.00"
                    placeholderTextColor={theme.colors.onSurfaceVariant}
                    keyboardType="numeric"
                    editable={!sharedAction.submitting}
                    style={[
                      styles.dateInput,
                      {
                        color: theme.colors.onBackground,
                        borderColor: theme.colors.outline,
                        backgroundColor: theme.colors.background,
                      },
                    ]}
                  />

                  <View style={{ height: 8 }} />

                  <TextInput
                    value={sharedAction.note}
                    onChangeText={setSharedNote}
                    placeholder="Note (optional)"
                    placeholderTextColor={theme.colors.onSurfaceVariant}
                    editable={!sharedAction.submitting}
                    maxLength={MAX_TRANSACTION_NOTE_LENGTH}
                    style={[
                      styles.dateInput,
                      {
                        color: theme.colors.onBackground,
                        borderColor: theme.colors.outline,
                        backgroundColor: theme.colors.background,
                      },
                    ]}
                  />
                  {sharedAction.error ? (
                    <Text style={[styles.dateErrorText, { color: dangerText }]}>
                      {sharedAction.error}
                    </Text>
                  ) : null}
                  <View style={{ height: 10 }} />
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <Pressable
                      onPress={submitSharedAction}
                      disabled={sharedAction.submitting}
                      style={({ pressed }) => [
                        styles.topBtn,
                        { backgroundColor: theme.colors.primary },
                        (pressed || sharedAction.submitting) && { opacity: 0.85 },
                      ]}
                    >
                      <Text style={{ color: theme.colors.onPrimary, fontWeight: "900" }}>
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
                        styles.topBtn,
                        { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
                        pressed && { opacity: 0.9 },
                      ]}
                    >
                      <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>
                        Cancel
                      </Text>
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
            <View
              style={[
                styles.card,
                { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
              ]}
            >
              <Text style={[styles.cardTitle, { color: theme.colors.onBackground }]}>
                My Stash
              </Text>

              {myStash === undefined ? (
                <View style={{ paddingVertical: 12, alignItems: "center" }}>
                  <ActivityIndicator />
                </View>
              ) : myStash === null ? (
                isCreatingStash ? (
                  <View style={{ marginTop: 10 }}>
                    <Text style={[styles.dateFieldLabel, { color: theme.colors.onSurfaceVariant }]}>
                      Personal spending target
                    </Text>
                    <TextInput
                      value={stashTargetText}
                      onChangeText={(v) => {
                        setStashTargetText(v);
                        if (stashCreateErr) setStashCreateErr(null);
                      }}
                      placeholder="1000"
                      placeholderTextColor={theme.colors.onSurfaceVariant}
                      keyboardType="numeric"
                      editable={!stashCreating}
                      style={[
                        styles.dateInput,
                        {
                          color: theme.colors.onBackground,
                          borderColor: theme.colors.outline,
                          backgroundColor: theme.colors.background,
                        },
                      ]}
                    />
                    {stashCreateErr ? (
                      <Text style={[styles.dateErrorText, { color: dangerText }]}>
                        {stashCreateErr}
                      </Text>
                    ) : null}
                    <View style={{ height: 10 }} />
                    <View style={{ flexDirection: "row", gap: 10 }}>
                      <Pressable
                        onPress={submitCreateStash}
                        disabled={stashCreating}
                        style={({ pressed }) => [
                          styles.topBtn,
                          { backgroundColor: theme.colors.primary },
                          (pressed || stashCreating) && { opacity: 0.85 },
                        ]}
                      >
                        <Text style={{ color: theme.colors.onPrimary, fontWeight: "900" }}>
                          {stashCreating ? "Creating…" : "Create My Stash"}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={cancelCreateStash}
                        disabled={stashCreating}
                        style={({ pressed }) => [
                          styles.topBtn,
                          { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
                          pressed && { opacity: 0.9 },
                        ]}
                      >
                        <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>
                          Cancel
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View style={{ marginTop: 6 }}>
                    <Text style={[styles.stashSub, { color: theme.colors.onSurfaceVariant }]}>
                      No personal stash yet
                    </Text>
                    <View style={{ height: 10 }} />
                    <Pressable
                      onPress={startCreateStash}
                      style={({ pressed }) => [
                        styles.stashActionBtn,
                        { backgroundColor: theme.colors.primary, alignSelf: "flex-start" },
                        pressed && { opacity: 0.9 },
                      ]}
                    >
                      <Text style={{ color: theme.colors.onPrimary, fontWeight: "900" }}>
                        Create My Stash
                      </Text>
                    </Pressable>
                  </View>
                )
              ) : (
                <>
                  <Text style={[styles.stashSub, { color: theme.colors.onSurfaceVariant }]}>
                    Your personal spending money
                  </Text>
                  <View style={styles.amountRow}>
                    <Text style={[styles.amountBig, { color: theme.colors.onBackground }]}>
                      {money(myStash.balance)}
                    </Text>
                    <Text style={[styles.amountSmall, { color: theme.colors.onSurfaceVariant }]}>
                      {" "}
                      / {money(myStash.target)}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.progressOuter,
                      { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outline },
                    ]}
                  >
                    <View
                      style={[
                        styles.progressInner,
                        {
                          width: `${clamp01(myStash.target > 0 ? myStash.balance / myStash.target : 0) * 100}%`,
                          backgroundColor: theme.colors.primary,
                        },
                      ]}
                    />
                  </View>

                  {/* My Stash IS an ordinary Bucket - reuses the exact
                      same trusted useSavingsMoneyAction()/
                      MoneyActionSheet Bucket Detail already uses, not a
                      new financial write system. */}
                  <View style={styles.stashActionsRow}>
                    <Pressable
                      onPress={() => openMoneyAction(myStash, "contribution")}
                      style={({ pressed }) => [
                        styles.stashActionBtn,
                        { backgroundColor: theme.colors.primary },
                        pressed && { opacity: 0.9 },
                      ]}
                    >
                      <Text style={{ color: theme.colors.onPrimary, fontWeight: "900" }}>
                        Add Money
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => openMoneyAction(myStash, "withdrawal")}
                      style={({ pressed }) => [
                        styles.stashActionBtn,
                        { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline, borderWidth: 1 },
                        pressed && { opacity: 0.9 },
                      ]}
                    >
                      <Text style={{ color: theme.colors.onBackground, fontWeight: "900" }}>
                        Withdraw
                      </Text>
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
                { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
              ]}
            >
              <Text style={[styles.cardTitle, { color: theme.colors.onBackground }]}>
                Quick Analysis
              </Text>
              <Text style={[styles.sub, { color: theme.colors.onSurfaceVariant }]}>
                Based on your goal and members.
              </Text>

              <View style={{ height: 12 }} />

              <Row label="Members" value={`${membersCount}`} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />
              <Row label="Saved" value={money(saved)} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />
              <Row label="Remaining" value={money(remaining)} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />

              <View style={[styles.divider, { backgroundColor: theme.colors.outline }]} />

              <Row label="Target / person" value={money(perPersonTarget)} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />
              <Row label="Remaining / person" value={money(perPersonRemaining)} themeText={theme.colors.onBackground} muted={theme.colors.onSurfaceVariant} />

              <View style={[styles.divider, { backgroundColor: theme.colors.outline }]} />

              <Text style={[styles.cardLabel, { color: theme.colors.onSurfaceVariant, marginBottom: 8 }]}>
                Suggested weekly savings (total / per person)
              </Text>

              {weeklyPlans.map((p) => (
                <Row
                  key={p.label}
                  label={p.label}
                  value={`${money(p.perWeekTotal)} / ${money(p.perWeekPerPerson)}`}
                  themeText={theme.colors.onBackground}
                  muted={theme.colors.onSurfaceVariant}
                />
              ))}
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
      <Text style={[styles.qaValue, { color: themeText }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  topBar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  topBtn: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },

  // Checkpoint 3F.3B.4B: bottom padding is applied dynamically via
  // scrollBottomInset (computed above from the real floating BottomNav
  // dimensions), not a static value here.
  page: { padding: 16 },

  gridWide: { flexDirection: "row", gap: 16, alignItems: "flex-start" },
  mainCol: { flex: 1, minWidth: 560 },
  sideCol: { width: 380 },

  heroWrap: {
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    position: "relative",
  },
  heroImg: { width: "100%", height: "100%" },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  heroText: { position: "absolute", left: 16, right: 16, bottom: 16 },
  heroTitle: { color: "#fff", fontSize: 32, fontWeight: "900" },
  heroLocation: { marginTop: 4, color: "rgba(255,255,255,0.9)", fontSize: 14, fontWeight: "700" },
  heroDate: { marginTop: 4, color: "rgba(255,255,255,0.78)", fontSize: 12, fontWeight: "600" },
  heroDateEditable: { textDecorationLine: "underline" },

  dateFieldLabel: { fontSize: 12, fontWeight: "700", marginBottom: 6 },
  dateInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  dateErrorText: { marginTop: 10, fontSize: 12, fontWeight: "700" },

  pill: {
    position: "absolute",
    right: 16,
    bottom: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },

  card: {
    marginTop: 14,
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
  },
  cardTitle: { fontSize: 16, fontWeight: "900" },
  cardLabel: { fontSize: 12, fontWeight: "800" },

  stashHeaderRow: { flexDirection: "row", alignItems: "flex-start" },
  stashSub: { fontSize: 12, marginTop: 2 },
  stashActionsRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  stashActionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  stashActionForm: { marginTop: 14 },

  amountRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 6 },
  amountBig: { fontSize: 34, fontWeight: "900" },
  amountSmall: { fontSize: 14, fontWeight: "800", marginBottom: 6 },

  progressOuter: {
    marginTop: 10,
    height: 12,
    borderRadius: 999,
    borderWidth: 1,
    overflow: "hidden",
  },
  progressInner: { height: "100%", borderRadius: 999 },

  remaining: { marginTop: 10, fontSize: 13, fontWeight: "800" },

  divider: { height: 1, marginVertical: 12 },

  qaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 10,
  },
  qaLabel: { fontWeight: "800" },
  qaValue: { fontWeight: "900" },

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
