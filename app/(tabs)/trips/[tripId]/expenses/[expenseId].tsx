// Expense Detail (Checkpoint 4D.5), per the frozen docs/audits/
// TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §6/§8/§9/§21/§28-§33.
// READ-ONLY - no Reverse/Correct actions exist here (4D.6/4D.7). Shows
// the persisted Expense (live), its immutable Split breakdown
// (one-shot), and its immediate-neighbor correction lineage.
//
// Route-tripId integrity is enforced entirely by the existing, frozen
// subscribeToExpenseById(tripId, expenseId, ...)/fetchExpenseById(tripId,
// linkedId) service functions (Checkpoint 4D.0B) - this file never reads
// tripExpenses/{expenseId} directly and never weakens that binding. A
// permission-denied listener error is treated identically to a missing
// Expense (anti-enumeration, matching the preflight's own §30 "same copy
// as missing, never distinguished from doesn't exist" principle).
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { BAR_HEIGHT, CENTER_BUTTON_SIZE } from "../../../../../components/navigation/BottomNav";
import { AvatarCircle, initialsFromName } from "../../../../../components/buckets/AvatarCircle";
import { StatusChip } from "../../../../../components/expenses/StatusChip";
import { ReverseExpenseDialog } from "../../../../../components/expenses/ReverseExpenseDialog";
import { cardShadowFor, radii, spacing, typography } from "../../../../../src/theme/tokens";
import { useSemanticColors } from "../../../../../src/theme/useSemanticColors";
import { useAuth } from "../../../../../src/contexts/AuthContext";
import { useExpenseSuccess } from "../../../../../src/hooks/useExpenseSuccess";
import {
  fetchExpenseById,
  fetchExpenseSplitsForExpense,
  generateExpenseClientRequestId,
  reverseTripExpense,
  subscribeToExpenseById,
} from "../../../../../src/services/firebase/expenses";
import { subscribeToPublicUsersByIdsChunked } from "../../../../../src/services/firebase/users";
import { fetchTripById } from "../../../../../src/services/firebase/trips";
import {
  canReverseExpense,
  isDefinitiveDifferentRequestFailure,
  normalizeReversalReason,
  reduceReversalOutcome,
  resolveExpenseReversalClientRequestId,
  type ExpenseReversalFacts,
  type PendingExpenseReversalRequest,
  type ReversalOutcomeResult,
} from "../../../../../src/domain/expenseReversal";
import { formatCurrency, formatTransactionTimestamp } from "../../../../../utils/format";
import type { Expense, ExpenseSplit, PublicProfile, SplitStrategy, Trip } from "../../../../../src/types/domain";

// Local error mapper (Checkpoint 4D.6), matching the exact existing
// per-feature convention (expenseErrorMessage in expenses/create.tsx,
// savingsErrorMessage, stashCreateErrorMessage) rather than a shared
// app-wide abstraction - the same definitive-vs-ambiguous table from the
// frozen UI preflight §20, applied to reversal. `knownAlreadyReversed`
// lets this function show the SPECIFIC "already reversed" copy only when
// the client independently has the freshest, live-confirmed persisted
// status - never guessed from the failed-precondition code alone.
function reversalErrorMessage(e: unknown, knownAlreadyReversed: boolean): string {
  const code = (e as { code?: string } | null | undefined)?.code;
  switch (code) {
    case "functions/invalid-argument":
      return "That information isn't valid — please check and try again.";
    case "functions/permission-denied":
      return "You don't have permission to do that.";
    case "functions/failed-precondition":
      return knownAlreadyReversed
        ? "This expense has already been reversed."
        : "We couldn't reverse this expense because its trip or record information changed. Refresh and try again.";
    case "functions/not-found":
      return "This expense could not be found.";
    case "functions/already-exists":
      return "We couldn't safely reconcile this reversal request. Review it and try again.";
    case "functions/unavailable":
    case "functions/deadline-exceeded":
      return "We couldn't reach the server, so we can't confirm this went through — it's safe to try again.";
    default:
      return "We couldn't reach the server, so we can't confirm this went through — it's safe to try again.";
  }
}

const NAV_BUTTON_PEEK = CENTER_BUTTON_SIZE / 2 - 4;
const NAV_BREATHING_ROOM = spacing.xxl;
const MAX_CONTENT_WIDTH = 720;

const SPLIT_STRATEGY_LABELS: Record<SplitStrategy, string> = {
  equal: "Equal",
  percentage: "Percentage",
  custom: "Custom",
};

type ExpenseLoadState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error" }
  | { status: "ready"; expense: Expense };

type SplitsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; splits: ExpenseSplit[] };

type PayerProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; profiles: Map<string, PublicProfile> };

type LineageLinkState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; id: string; description: string };

export default function ExpenseDetailScreen() {
  const router = useRouter();
  const { tripId, expenseId } = useLocalSearchParams<{ tripId: string; expenseId: string }>();
  const theme = useTheme();
  const colors = useSemanticColors();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { announceExpenseSuccess } = useExpenseSuccess();

  const scrollBottomInset = useMemo(() => {
    const navSafeAreaPadding = Platform.OS === "ios" ? 0 : Math.max(insets.bottom, spacing.sm);
    return BAR_HEIGHT + NAV_BUTTON_PEEK + navSafeAreaPadding + NAV_BREATHING_ROOM;
  }, [insets.bottom]);

  const goToExpenseList = useCallback(() => {
    if (!tripId) return;
    router.replace({ pathname: "/(tabs)/trips/[tripId]/expenses", params: { tripId } });
  }, [router, tripId]);

  // ------------------------------------------------------------------
  // Expense - LIVE (§7). status/reversal/lineage fields can change while
  // this screen is mounted (relevant starting 4D.6). Retry-nonce pattern
  // matches every other Expense screen's own listener-error handling.
  // ------------------------------------------------------------------
  const [expenseState, setExpenseState] = useState<ExpenseLoadState>({ status: "loading" });
  const expenseUnsubRef = useRef<(() => void) | null>(null);
  const [expenseRetryNonce, setExpenseRetryNonce] = useState(0);
  const retryExpense = useCallback(() => setExpenseRetryNonce((n) => n + 1), []);

  useEffect(() => {
    expenseUnsubRef.current?.();
    expenseUnsubRef.current = null;
    if (!tripId || !expenseId) return undefined;
    setExpenseState({ status: "loading" });
    expenseUnsubRef.current = subscribeToExpenseById(
      tripId,
      expenseId,
      (expense) => setExpenseState(expense ? { status: "ready", expense } : { status: "unavailable" }),
      (err) => {
        console.error("Expense detail subscription error:", err);
        // permission-denied gets the SAME "unavailable" treatment as a
        // missing Expense (§8) - never tells the caller whether the
        // document actually exists. Any other failure (transient
        // network error, a mapping exception surfaced from the service)
        // is a genuinely different, retry-worthy "error" state.
        const code = (err as { code?: string } | null | undefined)?.code;
        setExpenseState(code === "permission-denied" ? { status: "unavailable" } : { status: "error" });
      }
    );
    return () => {
      expenseUnsubRef.current?.();
      expenseUnsubRef.current = null;
    };
  }, [tripId, expenseId, expenseRetryNonce]);

  // ------------------------------------------------------------------
  // Splits - ONE-SHOT (§9/§10). Only fetched once the Expense is
  // confirmed accessible; depends on expenseState.status only (not the
  // whole expenseState object) so a later LIVE Expense update (e.g. a
  // future reversal) never re-triggers a redundant refetch of immutable
  // Split records.
  // ------------------------------------------------------------------
  const [splitsState, setSplitsState] = useState<SplitsState>({ status: "loading" });
  const [splitsRetryNonce, setSplitsRetryNonce] = useState(0);
  const retrySplits = useCallback(() => setSplitsRetryNonce((n) => n + 1), []);

  useEffect(() => {
    if (expenseState.status !== "ready" || !tripId || !expenseId) return undefined;
    let cancelled = false;
    setSplitsState({ status: "loading" });
    fetchExpenseSplitsForExpense(tripId, expenseId)
      .then((splits) => {
        if (!cancelled) setSplitsState({ status: "ready", splits });
      })
      .catch((err) => {
        console.error("Expense splits fetch error:", err);
        if (!cancelled) setSplitsState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [expenseState.status, tripId, expenseId, splitsRetryNonce]);

  // ------------------------------------------------------------------
  // Correction lineage (§23/§24/§25) - immediate neighbors only, each
  // its own one-shot fetch, ALWAYS bound to the current route's own
  // tripId (fetchExpenseById re-verifies this internally regardless). A
  // lineage-link failure never hides the current Expense - it renders a
  // truthful non-tappable fallback instead.
  // ------------------------------------------------------------------
  const [oldLineage, setOldLineage] = useState<LineageLinkState>({ status: "idle" });
  useEffect(() => {
    if (expenseState.status !== "ready" || !tripId) {
      setOldLineage({ status: "idle" });
      return undefined;
    }
    const linkedId = expenseState.expense.replacesExpenseId;
    if (!linkedId) {
      setOldLineage({ status: "idle" });
      return undefined;
    }
    let cancelled = false;
    setOldLineage({ status: "loading" });
    fetchExpenseById(tripId, linkedId)
      .then((linked) => {
        if (cancelled) return;
        setOldLineage(linked ? { status: "ready", id: linked.id, description: linked.description } : { status: "unavailable" });
      })
      .catch((err) => {
        console.error("Lineage fetch error (replaces):", err);
        if (!cancelled) setOldLineage({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [expenseState, tripId]);

  const [newLineage, setNewLineage] = useState<LineageLinkState>({ status: "idle" });
  useEffect(() => {
    if (expenseState.status !== "ready" || !tripId) {
      setNewLineage({ status: "idle" });
      return undefined;
    }
    const linkedId = expenseState.expense.replacedByExpenseId;
    if (!linkedId) {
      setNewLineage({ status: "idle" });
      return undefined;
    }
    let cancelled = false;
    setNewLineage({ status: "loading" });
    fetchExpenseById(tripId, linkedId)
      .then((linked) => {
        if (cancelled) return;
        setNewLineage(linked ? { status: "ready", id: linked.id, description: linked.description } : { status: "unavailable" });
      })
      .catch((err) => {
        console.error("Lineage fetch error (replacedBy):", err);
        if (!cancelled) setNewLineage({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [expenseState, tripId]);

  // ------------------------------------------------------------------
  // Public-profile resolution (§12/§13/§14) - derived from the payer (if
  // member_out_of_pocket) UNION every Split's own userId, never assumed
  // to still be current Trip members. Dedupe + sort for a stable
  // subscription key, matching every other Expense screen's identical
  // pattern.
  // ------------------------------------------------------------------
  const profileUids = useMemo(() => {
    const uids = new Set<string>();
    if (expenseState.status === "ready") {
      const expense = expenseState.expense;
      if (expense.paymentSource === "member_out_of_pocket" && expense.payerUid) {
        uids.add(expense.payerUid);
      }
    }
    if (splitsState.status === "ready") {
      splitsState.splits.forEach((split) => uids.add(split.userId));
    }
    return Array.from(uids).sort();
  }, [expenseState, splitsState]);
  const profileUidsKey = profileUids.join("|");

  const [profileState, setProfileState] = useState<PayerProfileState>({ status: "loading" });
  const profileUnsubRef = useRef<(() => void) | null>(null);
  const [profileRetryNonce, setProfileRetryNonce] = useState(0);
  const retryProfiles = useCallback(() => setProfileRetryNonce((n) => n + 1), []);

  useEffect(() => {
    profileUnsubRef.current?.();
    profileUnsubRef.current = null;
    setProfileState({ status: "loading" });
    if (profileUids.length === 0) {
      setProfileState({ status: "ready", profiles: new Map() });
      return undefined;
    }
    profileUnsubRef.current = subscribeToPublicUsersByIdsChunked(
      profileUids,
      (profiles) => setProfileState({ status: "ready", profiles: new Map(profiles.map((p) => [p.uid, p])) }),
      (err) => {
        console.error("Expense detail profile subscription error:", err);
        setProfileState({ status: "error" });
      }
    );
    return () => {
      profileUnsubRef.current?.();
      profileUnsubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileUidsKey, profileRetryNonce]);

  const missingMemberLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (profileState.status !== "ready") return labels;
    const missing = profileUids.filter((uid) => !profileState.profiles.get(uid)?.displayName?.trim());
    missing.forEach((uid, i) => {
      labels.set(uid, missing.length > 1 ? `Trip member ${i + 1}` : "Trip member");
    });
    return labels;
  }, [profileState, profileUids]);

  const resolveMemberLabel = useCallback(
    (uid: string): { avatarLabel: string; nameLabel: string; photoURL?: string } => {
      if (profileState.status === "loading") {
        return { avatarLabel: "Loading member", nameLabel: "Loading member…" };
      }
      if (profileState.status === "error") {
        return { avatarLabel: "Trip member", nameLabel: "Trip member" };
      }
      const profile = profileState.profiles.get(uid);
      const name = profile?.displayName?.trim();
      if (name) {
        return {
          avatarLabel: initialsFromName(name),
          nameLabel: name,
          photoURL: profile?.photoURL?.trim() || undefined,
        };
      }
      const fallback = missingMemberLabels.get(uid) ?? "Trip member";
      return { avatarLabel: fallback, nameLabel: fallback };
    },
    [profileState, missingMemberLabels]
  );

  // ------------------------------------------------------------------
  // Trip - one-shot, AUTHORIZATION-ONLY (Checkpoint 4D.6). A read
  // failure must never accidentally grant reversal authority: `trip`
  // stays `undefined` (loading) or `null` (unavailable/failed) rather
  // than a fabricated value, and canReverseExpense already fails closed
  // on missing owner/member data by construction - no special-case
  // "Trip unavailable" branch is needed here. A Trip-read failure never
  // hides the Expense's own already-loaded historical content above.
  // ------------------------------------------------------------------
  const [trip, setTrip] = useState<Trip | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!tripId) {
      setTrip(null);
      return undefined;
    }
    setTrip(undefined);
    fetchTripById(tripId)
      .then((t) => {
        if (!cancelled) setTrip(t);
      })
      .catch((err) => {
        console.error("Trip fetch error (expense detail, reversal authorization only):", err);
        if (!cancelled) setTrip(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  const expense = expenseState.status === "ready" ? expenseState.expense : null;
  const isReversed = expense?.status === "reversed";
  const isCorrection = !!expense?.replacesExpenseId;
  const categoryText = expense?.category && expense.category.trim().length > 0 ? expense.category : "None";
  const timestampText = expense ? formatTransactionTimestamp(expense.occurredAt ?? expense.createdAt) : "";
  const payerLabel = expense?.paymentSource === "member_out_of_pocket" && expense.payerUid
    ? resolveMemberLabel(expense.payerUid)
    : null;

  // ------------------------------------------------------------------
  // Reversal authorization (advisory only - reverseTripExpense
  // independently re-authorizes server-side regardless).
  // ------------------------------------------------------------------
  const canReverse = useMemo(() => {
    if (!expense) return false;
    return canReverseExpense({
      currentUid: user?.uid,
      expenseStatus: expense.status,
      expenseCreatedBy: expense.createdBy,
      tripOwnerId: trip?.ownerId,
      tripMemberIds: trip?.memberIds,
    });
  }, [expense, user?.uid, trip]);

  // ------------------------------------------------------------------
  // Reversal dialog + submission controller (§25/§26/§27/§28 of the
  // Add-Expense checkpoint's own idempotency architecture, reused
  // exactly - inFlightRef + pendingRef, mirroring
  // src/hooks/useSavingsMoneyAction.tsx's submit() precisely).
  //
  // Checkpoint 4D.6A hardening: ALL outcome decisions (direct success,
  // a definitive/ambiguous failure, a passive live-listener update) are
  // routed through the pure reduceReversalOutcome reducer
  // (src/domain/expenseReversal.ts) rather than inferring success from
  // `reversedBy === currentUid` alone - that inference was unsound (the
  // same account can independently reverse the same Expense from a
  // different device/session with a different clientRequestId). Only an
  // ACTUAL successful trusted-callable response (the original
  // submission, or an explicit user-initiated exact-replay verification
  // of a previously-ambiguous one) can ever resolve to genuine success.
  // ------------------------------------------------------------------
  const [reverseDialogVisible, setReverseDialogVisible] = useState(false);
  const [reasonText, setReasonText] = useState("");
  const [reversalSubmitting, setReversalSubmitting] = useState(false);
  const [reversalSubmitError, setReversalSubmitError] = useState<string | null>(null);
  // Mirrors pendingReversalRef.current !== null, but as real React state
  // so the "Check reversal status" recovery affordance can render even
  // once the ordinary "Reverse expense" trigger disappears (the Expense
  // is already showing as reversed) - a ref alone can't drive a render.
  const [hasPendingReversal, setHasPendingReversal] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const pendingReversalRef = useRef<PendingExpenseReversalRequest | null>(null);
  const reversalInFlightRef = useRef(false);

  // Prevents a stale async continuation (a reverseTripExpense call still
  // in flight at unmount/route-change time) from touching this
  // component's state after it can no longer legitimately do so -
  // matches this file's own established `cancelled` pattern used by
  // every other one-shot effect, applied here to the two event-handler-
  // triggered async functions below (which aren't themselves inside a
  // useEffect and so need their own persistent mounted-flag).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Kept in sync via effect so the eventual catch() below (which may run
  // after a live Expense update has already arrived) reads the FRESHEST
  // persisted status, never a stale closure snapshot from when the
  // request was first fired - required for the "only conclude already-
  // reversed if independently confirmed" rule.
  const expenseStateRef = useRef(expenseState);
  useEffect(() => {
    expenseStateRef.current = expenseState;
  }, [expenseState]);

  // Applies a reduceReversalOutcome result as the one place every
  // resulting state change happens - every call site below (direct
  // submit, explicit verification, the passive live-update effect)
  // funnels through this, so "success" can only ever be declared once
  // per pending request (action "none" is always a no-op) and the
  // announcement/dialog-close/pending-clear side effects never drift out
  // of sync with each other.
  const applyReversalOutcome = useCallback(
    (result: ReversalOutcomeResult) => {
      if (result.action === "none") return;
      setReversalSubmitting(false);
      setVerifying(false);
      if (result.action === "success") {
        pendingReversalRef.current = null;
        setHasPendingReversal(false);
        setReverseDialogVisible(false);
        setReversalSubmitError(null);
        setVerifyError(null);
        announceExpenseSuccess("Expense reversed.");
      } else if (result.action === "reversed_by_other") {
        pendingReversalRef.current = null;
        setHasPendingReversal(false);
        setReversalSubmitError("This expense was already reversed.");
        setVerifyError("This expense was already reversed.");
      } else if (result.action === "show_error") {
        // Definitive-but-not-confirmed-already-reversed, or ambiguous -
        // pendingReversalRef is deliberately PRESERVED (never cleared
        // here) so an identical-facts retry safely reuses the same
        // clientRequestId, matching the existing ambiguous-failure
        // precedent exactly.
        setReversalSubmitError(result.message);
        setVerifyError(result.message);
      }
    },
    [announceExpenseSuccess]
  );

  // Checkpoint 4D.6A follow-up review: classifies a caught
  // reverseTripExpense failure for reconciliation, shared by both
  // handleConfirmReverse and verifyPendingReversal's own catch blocks so
  // neither can independently drift out of sync. Critically, this does
  // NOT derive "definitely a different request" from the live listener
  // alone (that was the original bug) - it requires the FAILURE'S OWN
  // error code to be the backend's specific "already reversed" rejection
  // (isDefinitiveDifferentRequestFailure), in addition to the live
  // listener confirming reversed status. An ambiguous transport failure
  // (unavailable/deadline-exceeded/unknown) is NEVER promoted to
  // "definitely different" merely because the Expense already displays
  // Reversed - it always falls through to honest "couldn't verify" copy,
  // preserving the pending request for another explicit retry.
  const classifyReversalFailure = useCallback(
    (e: unknown): { definitelyDifferentRequest: boolean; errorMessage: string } => {
      const latest = expenseStateRef.current;
      const liveStatusIsReversed = latest.status === "ready" && latest.expense.status === "reversed";
      const errorCode = (e as { code?: string } | null | undefined)?.code;
      const definitelyDifferentRequest = isDefinitiveDifferentRequestFailure({
        errorCode,
        liveStatusIsReversed,
      });

      if (definitelyDifferentRequest) {
        return { definitelyDifferentRequest: true, errorMessage: "This expense has already been reversed." };
      }
      if (liveStatusIsReversed) {
        // The Expense already shows Reversed live, but THIS specific
        // request's own outcome could not be confirmed (an ambiguous
        // transport failure, or a non-"already reversed" definitive
        // rejection) - honest, distinct copy from the generic ambiguous
        // message, naming both true facts without conflating them.
        return {
          definitelyDifferentRequest: false,
          errorMessage:
            "This expense shows as reversed, but we couldn’t confirm whether your request was the one that went through. It’s safe to check again.",
        };
      }
      return { definitelyDifferentRequest: false, errorMessage: reversalErrorMessage(e, false) };
    },
    []
  );

  const openReverseDialog = useCallback(() => {
    if (reversalInFlightRef.current) return;
    // Prefills from any still-pending request's own facts (never from
    // stale form state) - reopening after an ambiguous failure this way
    // guarantees a same-facts retry reuses the same clientRequestId.
    setReasonText(pendingReversalRef.current?.reversalReason ?? "");
    setReversalSubmitError(null);
    setReverseDialogVisible(true);
  }, []);

  const closeReverseDialog = useCallback(() => {
    // Ignored while a request is unresolved - mirrors
    // useSavingsMoneyAction's own close() guard; pendingReversalRef is
    // deliberately NEVER cleared merely by dismissing the dialog, so a
    // later re-open with the same reason still safely reuses the same
    // clientRequestId.
    if (reversalInFlightRef.current) return;
    setReverseDialogVisible(false);
  }, []);

  const changeReasonText = useCallback((value: string) => {
    setReasonText(value);
    setReversalSubmitError(null);
  }, []);

  // Passive reconciliation against the LIVE Expense subscription - fires
  // whenever the live listener reports a status change while we still
  // have an unresolved pending request of our own. Per the fix, this can
  // ONLY ever safely conclude "reversed_by_other" (a definitively
  // different uid - never us, on any device) - a same-uid match is
  // explicitly left unresolved ("none") rather than assumed successful;
  // see reduceReversalOutcome's own module comment for the full
  // reasoning. Never issues a retry itself.
  useEffect(() => {
    if (expenseState.status !== "ready") return;
    const current = expenseState.expense;
    applyReversalOutcome(
      reduceReversalOutcome(
        {
          type: "live_update",
          expenseStatus: current.status,
          expenseReversedBy: current.reversedBy,
          currentUid: user?.uid,
        },
        pendingReversalRef.current !== null
      )
    );
  }, [expenseState, user?.uid, applyReversalOutcome]);

  const handleConfirmReverse = useCallback(async () => {
    if (reversalInFlightRef.current) return;
    if (!expense) return;
    if (!canReverse) {
      setReversalSubmitError("You don't have permission to do that.");
      return;
    }

    const reasonResult = normalizeReversalReason(reasonText);
    if (!reasonResult.ok) {
      setReversalSubmitError(reasonResult.error);
      return;
    }

    const facts: ExpenseReversalFacts = { expenseId: expense.id, reversalReason: reasonResult.value };
    const clientRequestId = resolveExpenseReversalClientRequestId(
      pendingReversalRef,
      facts,
      generateExpenseClientRequestId
    );
    setHasPendingReversal(true);

    reversalInFlightRef.current = true;
    setReversalSubmitting(true);
    setReversalSubmitError(null);

    try {
      await reverseTripExpense({
        expenseId: facts.expenseId,
        ...(facts.reversalReason !== undefined ? { reversalReason: facts.reversalReason } : {}),
        clientRequestId,
      });
      if (!isMountedRef.current) return;
      // The existing live Expense subscription independently reconciles
      // the real persisted Reversed status/reversedAt/reversalReason -
      // no optimistic/fabricated mutation is ever applied here.
      applyReversalOutcome(reduceReversalOutcome({ type: "callable_success" }, true));
    } catch (e) {
      if (!isMountedRef.current) return;
      console.error("Failed to reverse expense:", e);
      const { definitelyDifferentRequest, errorMessage } = classifyReversalFailure(e);
      applyReversalOutcome(
        reduceReversalOutcome({ type: "callable_failure", definitelyDifferentRequest, errorMessage }, true)
      );
    } finally {
      if (isMountedRef.current) reversalInFlightRef.current = false;
    }
  }, [expense, canReverse, reasonText, applyReversalOutcome, classifyReversalFailure]);

  // Explicit, user-initiated recovery action (Checkpoint 4D.6A
  // requirement #3/#4) - re-submits the EXACT pending request (same
  // clientRequestId, same normalized reason) through the trusted
  // callable to get a VERIFIED answer, never inferred from `reversedBy`
  // alone. Reachable even once the ordinary "Reverse expense" trigger
  // has disappeared (the Expense already shows as reversed), so the
  // user is never forced to mint a new request id just to find out
  // whether their own previous attempt actually committed. Never fires
  // automatically - only ever called from an explicit tap.
  const verifyPendingReversal = useCallback(async () => {
    if (reversalInFlightRef.current) return;
    const pending = pendingReversalRef.current;
    if (!pending) return;

    reversalInFlightRef.current = true;
    setVerifying(true);
    setVerifyError(null);

    try {
      await reverseTripExpense({
        expenseId: pending.expenseId,
        ...(pending.reversalReason !== undefined ? { reversalReason: pending.reversalReason } : {}),
        clientRequestId: pending.clientRequestId,
      });
      if (!isMountedRef.current) return;
      applyReversalOutcome(reduceReversalOutcome({ type: "callable_success" }, true));
    } catch (e) {
      if (!isMountedRef.current) return;
      console.error("Failed to verify pending reversal:", e);
      const { definitelyDifferentRequest, errorMessage } = classifyReversalFailure(e);
      applyReversalOutcome(
        reduceReversalOutcome({ type: "callable_failure", definitelyDifferentRequest, errorMessage }, true)
      );
    } finally {
      if (isMountedRef.current) reversalInFlightRef.current = false;
    }
  }, [applyReversalOutcome, classifyReversalFailure]);

  return (
    <>
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: scrollBottomInset }]}>
        <View style={styles.contentWrap}>
          <View style={styles.headerRow}>
            <Pressable
              onPress={goToExpenseList}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={({ pressed }) => [
                styles.backPill,
                { backgroundColor: colors.surfaceTertiary },
                pressed && { opacity: 0.85 },
              ]}
              hitSlop={8}
            >
              <MaterialCommunityIcons name="chevron-left" size={18} color={colors.textPrimary} />
              <Text style={[styles.backPillText, { color: colors.textPrimary }]}>Back</Text>
            </Pressable>
          </View>

          <Text style={[styles.h1, { color: colors.textPrimary }]}>Expense</Text>

          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: colors.border },
              cardShadowFor(theme.dark),
            ]}
          >
            {expenseState.status === "loading" ? (
              <View style={styles.stateWrap}>
                <ActivityIndicator size="small" />
                <Text style={[styles.stateSub, { color: colors.textMuted }]}>Loading expense…</Text>
              </View>
            ) : expenseState.status === "unavailable" ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>
                  This expense could not be found.
                </Text>
                <Text style={[styles.stateSub, { color: colors.textMuted }]}>
                  It may have been part of a trip you no longer have access to.
                </Text>
                <Pressable
                  onPress={goToExpenseList}
                  accessibilityRole="button"
                  accessibilityLabel="Back to Expense history"
                  style={({ pressed }) => [
                    styles.primaryActionBtn,
                    { backgroundColor: colors.mint },
                    pressed && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[styles.primaryActionText, { color: colors.onMint }]}>
                    Back to Expense history
                  </Text>
                </Pressable>
              </View>
            ) : expenseState.status === "error" ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateSub, { color: colors.textMuted }]}>
                  We couldn’t load this expense.
                </Text>
                <Pressable
                  onPress={retryExpense}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading this expense"
                  style={({ pressed }) => [
                    styles.secondaryActionBtn,
                    { borderColor: colors.border },
                    pressed && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>Retry</Text>
                </Pressable>
              </View>
            ) : expense ? (
              <>
                <Text style={[styles.description, { color: colors.textPrimary }]}>
                  {expense.description}
                </Text>
                <Text style={[styles.amount, { color: colors.textPrimary }]}>
                  {formatCurrency(expense.amountMinor / 100)}
                </Text>

                {isReversed || isCorrection ? (
                  <View style={styles.chipRow}>
                    {isReversed ? <StatusChip label="Reversed" tone="neutral" /> : null}
                    {isCorrection ? <StatusChip label="Correction" tone="info" /> : null}
                  </View>
                ) : null}

                <View style={styles.divider} />

                <View style={styles.metaRow}>
                  {expense.paymentSource === "shared_stash" ? (
                    <View style={[styles.sourceBubble, { backgroundColor: colors.bluePale }]}>
                      <MaterialCommunityIcons name="account-group-outline" size={16} color={colors.blue} />
                    </View>
                  ) : (
                    <AvatarCircle
                      index={0}
                      label={payerLabel?.avatarLabel ?? "Trip member"}
                      photoURL={payerLabel?.photoURL}
                      size={32}
                    />
                  )}
                  <View style={styles.metaTextWrap}>
                    <Text style={[styles.metaLabel, { color: colors.textMuted }]}>
                      {expense.paymentSource === "shared_stash" ? "Paid from" : "Paid by"}
                    </Text>
                    <Text style={[styles.metaValue, { color: colors.textPrimary }]}>
                      {expense.paymentSource === "shared_stash"
                        ? "Shared Stash"
                        : payerLabel?.nameLabel ?? "Trip member"}
                    </Text>
                  </View>
                </View>

                <DetailFieldRow label="Date" value={timestampText} colors={colors} />
                <DetailFieldRow label="Category" value={categoryText} colors={colors} />
                <DetailFieldRow
                  label="Split strategy"
                  value={SPLIT_STRATEGY_LABELS[expense.splitStrategy]}
                  colors={colors}
                />

                {isReversed ? (
                  <View style={styles.reversalWrap}>
                    {expense.reversedAt ? (
                      <DetailFieldRow
                        label="Reversed on"
                        value={formatTransactionTimestamp(expense.reversedAt)}
                        colors={colors}
                      />
                    ) : null}
                    {expense.reversalReason ? (
                      <DetailFieldRow label="Reason" value={expense.reversalReason} colors={colors} />
                    ) : null}
                  </View>
                ) : null}

                {profileState.status === "error" ? (
                  <View style={styles.profileErrorRow}>
                    <Text style={[styles.profileErrorText, { color: colors.textMuted }]}>
                      Some member names couldn’t be loaded.
                    </Text>
                    <Pressable
                      onPress={retryProfiles}
                      accessibilityRole="button"
                      accessibilityLabel="Retry loading member names"
                    >
                      <Text style={[styles.profileErrorRetryText, { color: colors.blue }]}>Retry</Text>
                    </Pressable>
                  </View>
                ) : null}

                <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
                  Split breakdown
                </Text>
                {splitsState.status === "loading" ? (
                  <View style={styles.splitStateWrap}>
                    <ActivityIndicator size="small" />
                  </View>
                ) : splitsState.status === "error" ? (
                  <View style={styles.splitStateWrap}>
                    <Text style={[styles.stateSub, { color: colors.textMuted }]}>
                      We couldn’t load the split breakdown.
                    </Text>
                    <Pressable
                      onPress={retrySplits}
                      accessibilityRole="button"
                      accessibilityLabel="Retry loading the split breakdown"
                      style={({ pressed }) => [
                        styles.secondaryActionBtn,
                        styles.inlineRetryBtn,
                        { borderColor: colors.border },
                        pressed && { opacity: 0.9 },
                      ]}
                    >
                      <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>Retry</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View>
                    {splitsState.splits.map((split) => {
                      const label = resolveMemberLabel(split.userId);
                      return (
                        <View key={split.userId} style={styles.splitRow}>
                          <AvatarCircle index={0} label={label.avatarLabel} photoURL={label.photoURL} size={26} />
                          <Text style={[styles.splitName, { color: colors.textPrimary }]} numberOfLines={1}>
                            {label.nameLabel}
                          </Text>
                          {expense.splitStrategy === "percentage" && split.percentageBasisPoints !== undefined ? (
                            <Text style={[styles.splitPercent, { color: colors.textSecondary }]}>
                              {(split.percentageBasisPoints / 100).toFixed(2)}%
                            </Text>
                          ) : null}
                          <Text style={[styles.splitAmount, { color: colors.textPrimary }]}>
                            {formatCurrency(split.amountMinor / 100)}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}

                {expense.replacesExpenseId || expense.replacedByExpenseId ? (
                  <>
                    <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: spacing.lg }]}>
                      Correction history
                    </Text>
                    {expense.replacesExpenseId ? (
                      <LineageLine
                        link={oldLineage}
                        loadingText="Loading original expense…"
                        unavailableText="Corrected version unavailable."
                        buildLinkedText={(description) => `Corrected version of ${description}`}
                        accessibilityLabel="View original expense"
                        colors={colors}
                        onPress={(id) =>
                          router.push({
                            pathname: "/(tabs)/trips/[tripId]/expenses/[expenseId]",
                            params: { tripId, expenseId: id },
                          })
                        }
                      />
                    ) : null}
                    {expense.replacedByExpenseId ? (
                      <LineageLine
                        link={newLineage}
                        loadingText="Loading replacement expense…"
                        unavailableText="Replacement unavailable."
                        buildLinkedText={(description) => `Replaced by ${description}`}
                        accessibilityLabel="View replacement expense"
                        colors={colors}
                        onPress={(id) =>
                          router.push({
                            pathname: "/(tabs)/trips/[tripId]/expenses/[expenseId]",
                            params: { tripId, expenseId: id },
                          })
                        }
                      />
                    ) : null}
                  </>
                ) : null}

                {/* Checkpoint 4D.6: read-only view otherwise - the ONLY
                    mutation action on this screen. Shown only when the
                    Expense is active AND the current user is
                    authorized (advisory only - the trusted callable
                    independently re-authorizes). Never shown once
                    reversed - matches the frozen "no Reverse expense
                    action remains available once the record is
                    reversed" requirement. Archived Trips are NOT
                    gated here at all (reversal preflight §6) - an
                    authorized caller may reverse an Expense on an
                    archived Trip exactly like an active one. */}
                {canReverse ? (
                  <Pressable
                    onPress={openReverseDialog}
                    accessibilityRole="button"
                    accessibilityLabel="Reverse expense"
                    style={({ pressed }) => [
                      styles.secondaryActionBtn,
                      styles.reverseBtn,
                      { borderColor: colors.border },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>
                      Reverse expense
                    </Text>
                  </Pressable>
                ) : null}

                {/* Checkpoint 4D.6A: recovery affordance for an
                    unresolved (ambiguous-outcome) reversal request,
                    reachable even once the ordinary "Reverse expense"
                    trigger above has disappeared (the Expense already
                    shows as reversed, by an uncertain requester). The
                    user is never forced to mint a fresh request id just
                    to find out whether their own earlier attempt
                    actually committed - this re-submits the EXACT same
                    pending facts/clientRequestId for a verified answer,
                    never inferred from reversedBy alone. Only ever
                    fires from this explicit tap - never automatically. */}
                {isReversed && hasPendingReversal ? (
                  <View style={styles.recoveryWrap}>
                    <Text style={[styles.recoveryText, { color: colors.textMuted }]}>
                      We couldn’t confirm whether your reversal request went through.
                    </Text>
                    {verifyError ? (
                      <Text style={[styles.errorTextCentered, { color: colors.coral }]}>{verifyError}</Text>
                    ) : null}
                    <Pressable
                      onPress={verifyPendingReversal}
                      disabled={verifying}
                      accessibilityRole="button"
                      accessibilityLabel="Check reversal status"
                      style={({ pressed }) => [
                        styles.secondaryActionBtn,
                        styles.reverseBtn,
                        { borderColor: colors.border },
                        (pressed || verifying) && { opacity: 0.85 },
                      ]}
                    >
                      {verifying ? (
                        <ActivityIndicator size="small" color={colors.textPrimary} />
                      ) : (
                        <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>
                          Check reversal status
                        </Text>
                      )}
                    </Pressable>
                  </View>
                ) : null}
              </>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
    {expense ? (
      <ReverseExpenseDialog
        visible={reverseDialogVisible}
        expenseDescription={expense.description}
        expenseAmountMinor={expense.amountMinor}
        reasonText={reasonText}
        onChangeReasonText={changeReasonText}
        submitting={reversalSubmitting}
        submitError={reversalSubmitError}
        onCancel={closeReverseDialog}
        onConfirm={handleConfirmReverse}
        colors={colors}
      />
    ) : null}
    </>
  );
}

function DetailFieldRow({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useSemanticColors>;
}) {
  return (
    <View style={styles.fieldRow}>
      <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[styles.fieldValue, { color: colors.textPrimary }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function LineageLine({
  link,
  loadingText,
  unavailableText,
  buildLinkedText,
  accessibilityLabel,
  colors,
  onPress,
}: {
  link: LineageLinkState;
  loadingText: string;
  unavailableText: string;
  buildLinkedText: (description: string) => string;
  accessibilityLabel: string;
  colors: ReturnType<typeof useSemanticColors>;
  onPress: (id: string) => void;
}) {
  if (link.status === "loading") {
    return <Text style={[styles.lineageMuted, { color: colors.textMuted }]}>{loadingText}</Text>;
  }
  if (link.status === "unavailable") {
    return <Text style={[styles.lineageMuted, { color: colors.textMuted }]}>{unavailableText}</Text>;
  }
  if (link.status === "ready") {
    return (
      <Pressable
        onPress={() => onPress(link.id)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [pressed && { opacity: 0.7 }]}
      >
        <Text style={[styles.lineageLink, { color: colors.blue }]} numberOfLines={2}>
          {buildLinkedText(link.description)}
        </Text>
      </Pressable>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollContent: { padding: spacing.lg, alignItems: "center" },
  contentWrap: { width: "100%", maxWidth: MAX_CONTENT_WIDTH },

  headerRow: { flexDirection: "row", alignItems: "center" },
  backPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 32,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
  },
  backPillText: { fontSize: 12, fontWeight: "700" },

  h1: { ...typography.pageTitle, marginTop: spacing.md },

  card: {
    marginTop: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
  },

  stateWrap: { paddingVertical: spacing.lg, alignItems: "center", gap: spacing.sm },
  stateTitle: { fontSize: 15, fontWeight: "800", textAlign: "center" },
  stateSub: { fontSize: 13, fontWeight: "600", textAlign: "center" },

  primaryActionBtn: {
    height: 42,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryActionText: { fontSize: 13, fontWeight: "800" },
  secondaryActionBtn: {
    height: 42,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineRetryBtn: { alignSelf: "center", marginTop: spacing.xs },
  reverseBtn: { marginTop: spacing.lg, width: "100%" },
  recoveryWrap: { marginTop: spacing.lg, alignItems: "center", gap: spacing.xs },
  recoveryText: { fontSize: 12, fontWeight: "600", textAlign: "center" },
  errorTextCentered: { fontSize: 12, fontWeight: "700", textAlign: "center" },
  secondaryActionText: { fontSize: 13, fontWeight: "800" },

  description: { fontSize: 17, fontWeight: "800" },
  amount: { fontSize: 32, fontWeight: "800", marginTop: spacing.xs },
  chipRow: { flexDirection: "row", gap: spacing.xs, marginTop: spacing.sm },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: "transparent", marginTop: spacing.md },

  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md },
  sourceBubble: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  metaTextWrap: { flex: 1, minWidth: 0 },
  metaLabel: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.3 },
  metaValue: { fontSize: 14, fontWeight: "700", marginTop: 1 },

  fieldRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  fieldLabel: { fontSize: 12, fontWeight: "700" },
  fieldValue: { fontSize: 13, fontWeight: "700", flexShrink: 1, textAlign: "right" },

  reversalWrap: { marginTop: spacing.xs },

  profileErrorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.md,
  },
  profileErrorText: { fontSize: 11, fontWeight: "600", flex: 1, marginRight: spacing.sm },
  profileErrorRetryText: { fontSize: 12, fontWeight: "800" },

  sectionLabel: {
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  splitStateWrap: { alignItems: "center", gap: spacing.xs, paddingVertical: spacing.sm },
  splitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  splitName: { flex: 1, fontSize: 13, fontWeight: "700" },
  splitPercent: { fontSize: 12, fontWeight: "700", marginRight: spacing.sm },
  splitAmount: { fontSize: 13, fontWeight: "800" },

  lineageMuted: { fontSize: 13, fontWeight: "600", marginTop: spacing.xs },
  lineageLink: { fontSize: 13, fontWeight: "700", marginTop: spacing.xs },
});
