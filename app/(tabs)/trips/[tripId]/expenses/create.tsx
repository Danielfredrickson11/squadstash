// Add Expense route/controller (Checkpoint 4D.3, extended by 4D.4 for
// percentage/custom split strategies), per the frozen docs/audits/
// TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md. Owns Trip loading, the
// current-member/profile subscription, ALL field state (including every
// strategy's own per-participant inputs), the idempotency controller,
// the trusted recordTripExpense call, and navigation -
// components/expenses/AddExpenseForm.tsx (+ its two small split-input
// sub-components) is presentation only. paymentSource:
// "member_out_of_pocket" only; no occurredAt/date field; no correction
// mode (replacesExpenseId is always null in 4D).
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { BAR_HEIGHT, CENTER_BUTTON_SIZE } from "../../../../../components/navigation/BottomNav";
import { initialsFromName } from "../../../../../components/buckets/AvatarCircle";
import {
  AddExpenseForm,
  type MemberOption,
  type SplitStrategyValue,
} from "../../../../../components/expenses/AddExpenseForm";
import { CorrectExpenseConfirmDialog } from "../../../../../components/expenses/CorrectExpenseConfirmDialog";
import { cardShadowFor, radii, spacing, typography } from "../../../../../src/theme/tokens";
import { useSemanticColors } from "../../../../../src/theme/useSemanticColors";
import { useAuth } from "../../../../../src/contexts/AuthContext";
import { useExpenseSuccess } from "../../../../../src/hooks/useExpenseSuccess";
import { fetchTripById } from "../../../../../src/services/firebase/trips";
import {
  fetchExpenseById,
  fetchExpenseSplitsForExpense,
  generateExpenseClientRequestId,
  recordTripExpense,
  reverseTripExpense,
  type RecordTripExpenseInput,
} from "../../../../../src/services/firebase/expenses";
import { subscribeToPublicUsersByIdsChunked } from "../../../../../src/services/firebase/users";
import {
  canSelectParticipant,
  canonicalizeCustomParticipants,
  canonicalizeEqualParticipants,
  canonicalizePercentageParticipants,
  defaultParticipantSelection,
  deriveCurrentMemberUids,
  parseExpenseMoneyInput,
  parseExpenseShareMoneyInput,
  parsePercentageToBasisPoints,
  resolveExpenseClientRequestId,
  sumSafeIntegers,
  validateExpenseCategory,
  validateExpenseDescription,
  type ExpenseCreationFacts,
  type PendingExpenseCreationRequest,
} from "../../../../../src/domain/expenseSubmission";
import {
  CORRECTION_REVERSAL_REASON,
  buildCorrectionPrefill,
  canClaimCorrection,
  initialCorrectionPhase,
  partitionParticipantsByEligibility,
  resolveCorrectionAction,
  type CorrectionSourceExpense,
  type CorrectionSourceSplit,
} from "../../../../../src/domain/expenseCorrection";
import {
  resolveExpenseReversalClientRequestId,
  type ExpenseReversalFacts,
  type PendingExpenseReversalRequest,
} from "../../../../../src/domain/expenseReversal";
import { formatCurrency } from "../../../../../utils/format";
import type { Expense, ExpenseSplit, PublicProfile, Trip } from "../../../../../src/types/domain";

const NAV_BUTTON_PEEK = CENTER_BUTTON_SIZE / 2 - 4;
const NAV_BREATHING_ROOM = spacing.xxl;
const MAX_CONTENT_WIDTH = 560;

type TripLoadState = { status: "loading" } | { status: "not_found" } | { status: "ready"; trip: Trip };

type PayerProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; profiles: Map<string, PublicProfile> };

// Checkpoint 4D.7: the old Expense (+ its immutable Splits) being
// corrected, loaded ONE-SHOT via this route's own tripId (§2).
type OldExpenseState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error" }
  | { status: "ready"; expense: Expense; splits: ExpenseSplit[] };

// Local error mapper (Checkpoint 4D.3 §27) - matches the existing
// per-feature convention (savingsErrorMessage, stashCreateErrorMessage,
// sharedActionErrorMessage) rather than a shared app-wide abstraction.
// `knownArchived` lets this function show the SPECIFIC archived-Trip copy
// only when the client independently already knows that fact - never
// guessed from the error code alone.
function expenseErrorMessage(e: unknown, knownArchived: boolean): string {
  const code = (e as { code?: string } | null | undefined)?.code;
  switch (code) {
    case "functions/invalid-argument":
      return "That information isn't valid — please check and try again.";
    case "functions/permission-denied":
      return "You don't have permission to do that.";
    case "functions/failed-precondition":
      return knownArchived
        ? "This trip is archived and no longer accepts new expenses."
        : "We couldn't save this expense because its trip or member information changed. Refresh and try again.";
    case "functions/not-found":
      return "This expense or trip could not be found.";
    case "functions/already-exists":
      return "We couldn't safely reconcile this expense request. Review it and try again.";
    case "functions/unavailable":
    case "functions/deadline-exceeded":
      return "We couldn't reach the server, so we can't confirm this went through — it's safe to try again.";
    default:
      return "We couldn't reach the server, so we can't confirm this went through — it's safe to try again.";
  }
}

// Reversal-step failure classification for the correction flow's own
// two-step mutation (Checkpoint 4D.7A §4) - a SEPARATE table from
// reversalErrorMessage in expenses/[expenseId].tsx (that screen has its
// own live-listener-informed distinction this one-shot route has no
// equivalent of). Reuses 4D.6/4D.6A's own finalized principle: the
// backend's functions/failed-precondition code is returned for MULTIPLE
// distinct reasons in reverseTripExpense.ts (malformed tripId on the
// Expense record, a missing Trip, AND "already reversed by a different
// reverser/request") - the code ALONE is never sufficient to claim that
// last, specific outcome. Only an INDEPENDENT re-fetch of the old
// Expense's own currently-persisted status (via the same route-bound
// fetchExpenseById this screen already uses everywhere else) can confirm
// it. If the re-fetch itself fails, or doesn't confirm "reversed", this
// falls back to honest generic copy rather than a specific claim without
// independently verified evidence - never promoted to "definitely a
// different request" merely because the error code, by itself, could
// mean that.
async function classifyCorrectionReverseFailure(
  e: unknown,
  tripId: string,
  oldExpenseId: string
): Promise<string> {
  const code = (e as { code?: string } | null | undefined)?.code;
  if (code === "functions/failed-precondition") {
    try {
      const latest = await fetchExpenseById(tripId, oldExpenseId);
      if (latest && latest.status === "reversed") {
        return "This expense was already reversed by a different request. Go back to the expense to see its current status.";
      }
    } catch (verifyErr) {
      console.error("Failed to verify reversal status after failed-precondition:", verifyErr);
    }
    return "We couldn't reverse this expense because its trip or record information changed. Refresh and try again.";
  }
  switch (code) {
    case "functions/invalid-argument":
      return "That information isn't valid — please check and try again.";
    case "functions/permission-denied":
      return "You don't have permission to do that.";
    case "functions/not-found":
      return "This expense could not be found.";
    case "functions/already-exists":
      return "We couldn't safely reconcile this reversal request. Review it and try again.";
    default:
      return "We couldn't reach the server, so we can't confirm this went through — it's safe to try again.";
  }
}

// Creation-step error mapper for the correction flow (§9/§10/§25) - by
// the time this step runs, the original Expense IS already reversed
// (either just now, in "start" mode, or previously, in "finish" mode),
// so the ambiguous/ostherwise-unclassified fallback below is truthful in
// both modes.
function correctionCreateErrorMessage(e: unknown, knownArchived: boolean): string {
  const code = (e as { code?: string } | null | undefined)?.code;
  switch (code) {
    case "functions/invalid-argument":
      return "That information isn't valid — please check and try again.";
    case "functions/permission-denied":
      return "You don't have permission to do that.";
    case "functions/failed-precondition":
      return knownArchived
        ? "This trip is archived and no longer accepts a corrected replacement."
        : "We couldn't save the correction — the original may already have a replacement, or trip/member information changed. Refresh and try again.";
    case "functions/not-found":
      return "The original expense could not be found.";
    case "functions/already-exists":
      return "We couldn't safely reconcile this request. Review it and try again.";
    default:
      return "The original expense was reversed, but we couldn't save the corrected version. Your edits are still here — try saving again.";
  }
}

// Bridges the strategy-discriminated ExpenseCreationFacts (§19/§23 of the
// checkpoint prompt) to the wire-shaped RecordTripExpenseInput, shared by
// BOTH the ordinary Add Expense submit path and the correction submit
// path below - occurredAt/replacesExpenseId are always null for ordinary
// creation, so this single builder produces IDENTICAL requests to the
// pre-4D.7 inline switch for that case, and only adds the two correction
// fields when facts actually carry them.
function buildRecordTripExpenseInput(
  facts: ExpenseCreationFacts,
  clientRequestId: string
): RecordTripExpenseInput {
  const common = {
    tripId: facts.tripId,
    payerUid: facts.payerUid,
    amountMinor: facts.amountMinor,
    currency: facts.currency,
    description: facts.description,
    ...(facts.category !== null ? { category: facts.category } : {}),
    ...(facts.occurredAtInstantMs !== null ? { occurredAt: new Date(facts.occurredAtInstantMs) } : {}),
    ...(facts.replacesExpenseId !== null ? { replacesExpenseId: facts.replacesExpenseId } : {}),
    clientRequestId,
  };
  switch (facts.splitStrategy) {
    case "equal":
      return { ...common, splitStrategy: "equal", participants: facts.participants };
    case "percentage":
      return { ...common, splitStrategy: "percentage", participants: facts.participants };
    case "custom":
      return { ...common, splitStrategy: "custom", participants: facts.participants };
  }
}

export default function AddExpenseScreen() {
  const router = useRouter();
  const { tripId, replaces: replacesExpenseId } = useLocalSearchParams<{ tripId: string; replaces?: string }>();
  const isCorrectionRoute = typeof replacesExpenseId === "string" && replacesExpenseId.length > 0;
  const { user } = useAuth();
  const theme = useTheme();
  const colors = useSemanticColors();
  const insets = useSafeAreaInsets();
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
  // Trip context - one-shot, matching the full list route's own pattern.
  // ------------------------------------------------------------------
  const [tripState, setTripState] = useState<TripLoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!tripId) return undefined;
    setTripState({ status: "loading" });
    fetchTripById(tripId)
      .then((trip) => {
        if (cancelled) return;
        setTripState(trip ? { status: "ready", trip } : { status: "not_found" });
      })
      .catch((err) => {
        console.error("Trip fetch error (add expense):", err);
        if (!cancelled) setTripState({ status: "not_found" });
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  const isArchived = tripState.status === "ready" && !!tripState.trip.archivedAt;

  // Current Trip-member set (§8): ownerId UNION memberIds, deduped,
  // malformed/empty ids ignored. Never a security boundary - the backend
  // remains authoritative regardless of this client-side derivation.
  const currentMemberUids = useMemo(() => {
    if (tripState.status !== "ready") return [];
    return deriveCurrentMemberUids(tripState.trip.ownerId, tripState.trip.memberIds);
  }, [tripState]);

  const isCurrentMember = !!user && currentMemberUids.includes(user.uid);
  const isOverCapacity = currentMemberUids.length > 100;

  // ------------------------------------------------------------------
  // Correction mode (Checkpoint 4D.7) - the old Expense + its immutable
  // Splits are loaded ONE-SHOT, via the route's OWN tripId (§2: "Enforce
  // route-tripId integrity on every read" - fetchExpenseById/
  // fetchExpenseSplitsForExpense already internally re-verify this).
  // Never a live subscription: this route only ever reads the old
  // Expense once, at entry, and any race that develops after that (e.g.
  // someone else finishes a competing correction) surfaces honestly as a
  // recordTripExpense failure at submit time (§11) rather than through a
  // second data source this screen would have to reconcile.
  // ------------------------------------------------------------------
  const [oldExpenseState, setOldExpenseState] = useState<OldExpenseState>({ status: "idle" });
  const [oldExpenseRetryNonce, setOldExpenseRetryNonce] = useState(0);
  const retryOldExpense = useCallback(() => setOldExpenseRetryNonce((n) => n + 1), []);

  useEffect(() => {
    if (!isCorrectionRoute) {
      setOldExpenseState({ status: "idle" });
      return undefined;
    }
    if (!tripId || typeof replacesExpenseId !== "string") return undefined;
    let cancelled = false;
    setOldExpenseState({ status: "loading" });
    Promise.all([
      fetchExpenseById(tripId, replacesExpenseId),
      fetchExpenseSplitsForExpense(tripId, replacesExpenseId),
    ])
      .then(([expense, splits]) => {
        if (cancelled) return;
        setOldExpenseState(expense ? { status: "ready", expense, splits } : { status: "unavailable" });
      })
      .catch((err) => {
        console.error("Old expense fetch error (correction):", err);
        if (!cancelled) setOldExpenseState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [isCorrectionRoute, tripId, replacesExpenseId, oldExpenseRetryNonce]);

  const oldExpense = oldExpenseState.status === "ready" ? oldExpenseState.expense : null;

  // Advisory-only correction-link authorization/state gating (§1/§27),
  // reusing the EXACT same pure logic Expense Detail uses to decide
  // whether to offer "Correct expense"/"Finish correction" in the first
  // place - the backend independently re-authorizes and re-validates
  // state regardless of what this computes.
  const canClaim = useMemo(() => {
    if (!oldExpense) return false;
    return canClaimCorrection({
      currentUid: user?.uid,
      expenseCreatedBy: oldExpense.createdBy,
      expenseReversedBy: oldExpense.reversedBy,
      tripOwnerId: tripState.status === "ready" ? tripState.trip.ownerId : undefined,
      tripMemberIds: tripState.status === "ready" ? tripState.trip.memberIds : undefined,
    });
  }, [oldExpense, user?.uid, tripState]);

  const correctionAction = useMemo(() => {
    if (!oldExpense) return { kind: "none" as const };
    return resolveCorrectionAction({
      expenseStatus: oldExpense.status,
      replacedByExpenseId: oldExpense.replacedByExpenseId,
      canClaim,
    });
  }, [oldExpense, canClaim]);

  // Pure prefill mapping (§3/§5/§26) - a VALIDATOR, never a repairer;
  // malformed persisted split data surfaces as an explicit error rather
  // than a silently-guessed form.
  const prefillResult = useMemo(() => {
    if (!oldExpense || oldExpenseState.status !== "ready") return null;

    // Checkpoint 4D.7A §3: fail closed rather than silently truncating
    // any sub-millisecond precision a persisted occurredAt Timestamp
    // might carry. This app's own writers only ever construct occurredAt
    // from a millisecond-precision Date (recordTripExpense.ts's own
    // contract), so this should never actually fire against data this
    // app itself wrote - but Timestamp.toMillis() below IS a lossy
    // operation in general, and silently losing precision during a
    // "correction" would itself be an unreviewed, unintended data
    // change, exactly what this whole correction model exists to avoid.
    if (oldExpense.occurredAt && oldExpense.occurredAt.nanoseconds % 1_000_000 !== 0) {
      return {
        ok: false as const,
        error: "This expense's original date/time can't be preserved exactly and can't be corrected here.",
      };
    }

    const sourceExpense: CorrectionSourceExpense = {
      paymentSource: oldExpense.paymentSource,
      payerUid: oldExpense.payerUid,
      description: oldExpense.description,
      amountMinor: oldExpense.amountMinor,
      category: oldExpense.category,
      splitStrategy: oldExpense.splitStrategy,
      occurredAtInstantMs: oldExpense.occurredAt ? oldExpense.occurredAt.toMillis() : null,
    };
    const sourceSplits: CorrectionSourceSplit[] = oldExpenseState.splits.map((s) => ({
      userId: s.userId,
      amountMinor: s.amountMinor,
      percentageBasisPoints: s.percentageBasisPoints,
    }));
    return buildCorrectionPrefill(sourceExpense, sourceSplits);
  }, [oldExpense, oldExpenseState]);

  // Historical participants (§4) no longer among the CURRENT Trip member
  // set - never silently dropped/transferred. AddExpenseForm's own
  // member selector already only lists current members, so an ineligible
  // historical participant simply can't be preselected here; the banner
  // below (rendered alongside the form) explains this explicitly and the
  // form's OWN existing split-total validation then requires the user to
  // explicitly adjust participants/splits before "Save correction" can
  // succeed - never an automatic transfer of their share to anyone else.
  const eligibilityPartition = useMemo(() => {
    if (!prefillResult || !prefillResult.ok) return null;
    return partitionParticipantsByEligibility(prefillResult.data.participantUids, currentMemberUids);
  }, [prefillResult, currentMemberUids]);

  // Checkpoint 4D.7A §1: whether the ORIGINAL payer is no longer a
  // current Trip member - drives both the "never auto-reassign" prefill
  // decision below and the explicit-choice explanation banner. Never
  // itself decides what payerUid should become; it only reports the
  // fact.
  const originalPayerIneligible = useMemo(() => {
    if (!prefillResult || !prefillResult.ok) return false;
    return !currentMemberUids.includes(prefillResult.data.payerUid);
  }, [prefillResult, currentMemberUids]);

  // Explicit "I've reviewed the removed participants and the revised
  // split" acknowledgment (§1) - required before handleSubmit will
  // proceed whenever any historical participant is no longer eligible.
  // This is the safety net for Equal splits specifically: Equal has no
  // aggregate-total validation of its own (unlike Percentage/Custom, an
  // unacknowledged silent drop-and-redistribute would otherwise sail
  // through undetected).
  const [removedParticipantsAcknowledged, setRemovedParticipantsAcknowledged] = useState(false);

  // ------------------------------------------------------------------
  // Public-profile resolution (§9) over the FULL current-member set -
  // both the payer and participant selectors need every member's
  // display identity, not just already-selected ones.
  // ------------------------------------------------------------------
  const memberUidsKey = currentMemberUids.slice().sort().join("|");
  const [profileState, setProfileState] = useState<PayerProfileState>({ status: "loading" });
  const profileUnsubRef = useRef<(() => void) | null>(null);
  const [profileRetryNonce, setProfileRetryNonce] = useState(0);
  const retryProfiles = useCallback(() => setProfileRetryNonce((n) => n + 1), []);

  useEffect(() => {
    profileUnsubRef.current?.();
    profileUnsubRef.current = null;
    setProfileState({ status: "loading" });
    if (currentMemberUids.length === 0) {
      setProfileState({ status: "ready", profiles: new Map() });
      return undefined;
    }
    profileUnsubRef.current = subscribeToPublicUsersByIdsChunked(
      currentMemberUids,
      (profiles) => setProfileState({ status: "ready", profiles: new Map(profiles.map((p) => [p.uid, p])) }),
      (err) => {
        console.error("Trip member profile subscription error:", err);
        setProfileState({ status: "error" });
      }
    );
    return () => {
      profileUnsubRef.current?.();
      profileUnsubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberUidsKey, profileRetryNonce]);

  const missingMemberLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (profileState.status !== "ready") return labels;
    const sortedUids = [...currentMemberUids].sort();
    const missing = sortedUids.filter((uid) => !profileState.profiles.get(uid)?.displayName?.trim());
    missing.forEach((uid, i) => {
      labels.set(uid, missing.length > 1 ? `Trip member ${i + 1}` : "Trip member");
    });
    return labels;
  }, [profileState, currentMemberUids]);

  const members: MemberOption[] = useMemo(() => {
    const sortedUids = [...currentMemberUids].sort();
    return sortedUids.map((uid) => {
      const isCurrentUser = uid === user?.uid;
      if (profileState.status === "loading") {
        return { uid, avatarLabel: "Loading member", nameLabel: "Loading member…", isCurrentUser };
      }
      if (profileState.status === "error") {
        return { uid, avatarLabel: "Trip member", nameLabel: "Trip member", isCurrentUser };
      }
      const profile = profileState.profiles.get(uid);
      const name = profile?.displayName?.trim();
      if (name) {
        return {
          uid,
          avatarLabel: initialsFromName(name),
          nameLabel: name,
          photoURL: profile?.photoURL?.trim() || undefined,
          isCurrentUser,
        };
      }
      const fallback = missingMemberLabels.get(uid) ?? "Trip member";
      return { uid, avatarLabel: fallback, nameLabel: fallback, isCurrentUser };
    });
  }, [currentMemberUids, profileState, missingMemberLabels, user?.uid]);

  // ------------------------------------------------------------------
  // Form field state.
  // ------------------------------------------------------------------
  const [description, setDescription] = useState("");
  const [amountText, setAmountText] = useState("");
  const [category, setCategory] = useState("");
  const [payerUid, setPayerUid] = useState<string | null>(null);
  const [selectedParticipants, setSelectedParticipants] = useState<Set<string> | null>(null);

  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [participantsError, setParticipantsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Defaults payerUid/selectedParticipants exactly ONCE, the first time
  // Trip + member data is actually available - never re-runs and clobbers
  // the user's own edits on a later re-render (e.g. a profile retry).
  // Checkpoint 4D.7: skipped entirely in correction mode - the dedicated
  // correction-prefill effect below (which needs splitStrategy/
  // percentage/custom state declared further down) owns initialization
  // there instead, so the two initializers never race each other.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (isCorrectionRoute) return;
    if (initializedRef.current) return;
    if (!user || tripState.status !== "ready") return;
    if (!currentMemberUids.includes(user.uid)) return;
    setPayerUid(user.uid);
    setSelectedParticipants(defaultParticipantSelection(currentMemberUids, user.uid));
    initializedRef.current = true;
  }, [isCorrectionRoute, user, tripState, currentMemberUids]);

  // ------------------------------------------------------------------
  // Split-strategy state (Checkpoint 4D.4 §4/§19/§20) - percentageInputs/
  // customInputs hold ONLY raw per-participant text, keyed by uid.
  // Switching strategy always resets the ABANDONED strategy's own values
  // (never carried across strategies); deselecting a participant always
  // retires THEIR OWN abandoned strategy-specific value (whichever
  // strategy is currently active) so re-selecting/switching back never
  // silently resurrects stale financial input.
  // ------------------------------------------------------------------
  const [splitStrategy, setSplitStrategyValue] = useState<SplitStrategyValue>("equal");
  const [percentageInputs, setPercentageInputs] = useState<Record<string, string>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [percentageErrors, setPercentageErrors] = useState<Record<string, string>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const [splitAggregateError, setSplitAggregateError] = useState<string | null>(null);

  // Correction-mode initialization (Checkpoint 4D.7/4D.7A §2/§3/§4/§5/
  // §26) - mirrors the ordinary initializedRef effect's own "exactly
  // once, never clobbers later edits" discipline, but sourced from the
  // validated prefillResult instead of Trip-member defaults.
  //
  // Checkpoint 4D.7A §2 fix: requires tripState to actually be "ready"
  // AND the signed-in user to be a CONFIRMED current member before
  // initializing anything. currentMemberUids is [] while tripState is
  // still "loading"/"not_found" - without this gate, an old-Expense
  // fetch that resolved before the Trip fetch could previously
  // initialize the correction form against an empty member set (every
  // historical participant treated as ineligible, payerUid reset) and
  // then PERMANENTLY lock itself out via correctionInitializedRef, since
  // the guard never re-ran once tripState later became ready.
  const correctionInitializedRef = useRef(false);
  useEffect(() => {
    if (!isCorrectionRoute) return;
    if (correctionInitializedRef.current) return;
    if (!user) return;
    if (tripState.status !== "ready") return;
    if (!currentMemberUids.includes(user.uid)) return;
    if (!prefillResult || !prefillResult.ok) return;
    if (!eligibilityPartition) return;

    const { data } = prefillResult;
    setDescription(data.description);
    setAmountText(data.amountText);
    setCategory(data.category);
    // Checkpoint 4D.7A §1 fix: NEVER auto-reassign financial
    // responsibility. Only prefill the payer when the ORIGINAL payer is
    // still a current member - when they are not, payerUid is left null
    // (AddExpenseForm now accepts payerUid: string | null for exactly
    // this case) so the "Paid by" selector shows no selection at all,
    // and handleSubmit below refuses to proceed until the user
    // explicitly taps a real, eligible payer.
    setPayerUid(currentMemberUids.includes(data.payerUid) ? data.payerUid : null);
    setSelectedParticipants(new Set(eligibilityPartition.eligible));
    setSplitStrategyValue(data.splitStrategy);
    setPercentageInputs(data.percentageInputs);
    setCustomInputs(data.customInputs);
    correctionInitializedRef.current = true;
  }, [isCorrectionRoute, user, tripState, currentMemberUids, prefillResult, eligibilityPartition]);

  const changeSplitStrategy = useCallback(
    (next: SplitStrategyValue) => {
      if (splitStrategy === next) return;
      if (splitStrategy === "percentage") {
        setPercentageInputs({});
        setPercentageErrors({});
      } else if (splitStrategy === "custom") {
        setCustomInputs({});
        setCustomErrors({});
      }
      setSplitAggregateError(null);
      setSplitStrategyValue(next);
    },
    [splitStrategy]
  );

  const retireUidFromStrategyValues = useCallback((uid: string) => {
    setPercentageInputs((prev) => {
      if (!(uid in prev)) return prev;
      const copy = { ...prev };
      delete copy[uid];
      return copy;
    });
    setPercentageErrors((prev) => {
      if (!(uid in prev)) return prev;
      const copy = { ...prev };
      delete copy[uid];
      return copy;
    });
    setCustomInputs((prev) => {
      if (!(uid in prev)) return prev;
      const copy = { ...prev };
      delete copy[uid];
      return copy;
    });
    setCustomErrors((prev) => {
      if (!(uid in prev)) return prev;
      const copy = { ...prev };
      delete copy[uid];
      return copy;
    });
  }, []);

  const changePercentageInput = useCallback((uid: string, value: string) => {
    setPercentageInputs((prev) => ({ ...prev, [uid]: value }));
    setPercentageErrors((prev) => {
      if (!(uid in prev)) return prev;
      const copy = { ...prev };
      delete copy[uid];
      return copy;
    });
  }, []);

  const changeCustomInput = useCallback((uid: string, value: string) => {
    setCustomInputs((prev) => ({ ...prev, [uid]: value }));
    setCustomErrors((prev) => {
      if (!(uid in prev)) return prev;
      const copy = { ...prev };
      delete copy[uid];
      return copy;
    });
  }, []);

  const toggleParticipant = useCallback(
    (uid: string) => {
      setSelectedParticipants((prev) => {
        const current = prev ?? new Set<string>();
        const next = new Set(current);
        if (next.has(uid)) {
          next.delete(uid);
          retireUidFromStrategyValues(uid);
        } else if (canSelectParticipant(current, uid)) {
          next.add(uid);
        }
        return next;
      });
      setParticipantsError(null);
    },
    [retireUidFromStrategyValues]
  );

  const selectAllParticipants = useCallback(() => {
    setSelectedParticipants(new Set(currentMemberUids));
    setParticipantsError(null);
  }, [currentMemberUids]);

  const clearAllParticipants = useCallback(() => {
    setSelectedParticipants(new Set());
    setParticipantsError(null);
    setPercentageInputs({});
    setPercentageErrors({});
    setCustomInputs({});
    setCustomErrors({});
  }, []);

  // Live-parsed preview amount ONLY (never sets amountError itself -
  // errors surface on submit attempt, matching this app's existing
  // form-validation convention).
  const previewAmountMinor = useMemo(() => {
    const result = parseExpenseMoneyInput(amountText);
    return result.ok ? result.amountMinor : null;
  }, [amountText]);

  const selectedParticipantList = useMemo(
    () => (selectedParticipants ? Array.from(selectedParticipants).sort() : []),
    [selectedParticipants]
  );

  // ------------------------------------------------------------------
  // Live percentage/custom parsing + aggregate text (§10/§12/§17/§18) -
  // read-only DERIVED display state, recomputed every render from the
  // current raw inputs. Never writes into percentageErrors/customErrors
  // (those are reserved for a submit attempt, matching this form's
  // existing "validate on submit" convention) - only informs the live
  // aggregate copy and the preview's own gating.
  // ------------------------------------------------------------------
  const percentageParseResults = useMemo(() => {
    const results = new Map<string, ReturnType<typeof parsePercentageToBasisPoints>>();
    selectedParticipantList.forEach((uid) => {
      results.set(uid, parsePercentageToBasisPoints(percentageInputs[uid] ?? ""));
    });
    return results;
  }, [selectedParticipantList, percentageInputs]);

  const percentageAggregateText = useMemo(() => {
    if (splitStrategy !== "percentage" || selectedParticipantList.length === 0) return null;
    const allValid = selectedParticipantList.every((uid) => percentageParseResults.get(uid)?.ok);
    if (!allValid) return null;
    const total = sumSafeIntegers(
      selectedParticipantList.map((uid) => {
        const result = percentageParseResults.get(uid);
        return result && result.ok ? result.percentageBasisPoints : 0;
      })
    );
    if (total === null) return null;
    const totalText = (total / 100).toFixed(2);
    return total === 10000 ? `Total: ${totalText}%` : `Total: ${totalText}% — must equal 100.00%.`;
  }, [splitStrategy, selectedParticipantList, percentageParseResults]);

  const previewPercentageParticipants = useMemo(() => {
    if (splitStrategy !== "percentage" || selectedParticipantList.length === 0) return null;
    const allValid = selectedParticipantList.every((uid) => percentageParseResults.get(uid)?.ok);
    if (!allValid) return null;
    const entries = selectedParticipantList.map((uid) => {
      const result = percentageParseResults.get(uid);
      return { uid, percentageBasisPoints: result && result.ok ? result.percentageBasisPoints : 0 };
    });
    const total = sumSafeIntegers(entries.map((e) => e.percentageBasisPoints));
    return total === 10000 ? entries : null;
  }, [splitStrategy, selectedParticipantList, percentageParseResults]);

  const customParseResults = useMemo(() => {
    const results = new Map<string, ReturnType<typeof parseExpenseShareMoneyInput>>();
    selectedParticipantList.forEach((uid) => {
      results.set(uid, parseExpenseShareMoneyInput(customInputs[uid] ?? ""));
    });
    return results;
  }, [selectedParticipantList, customInputs]);

  const customAggregateText = useMemo(() => {
    if (splitStrategy !== "custom" || selectedParticipantList.length === 0 || previewAmountMinor === null) {
      return null;
    }
    const allValid = selectedParticipantList.every((uid) => customParseResults.get(uid)?.ok);
    if (!allValid) return null;
    const total = sumSafeIntegers(
      selectedParticipantList.map((uid) => {
        const result = customParseResults.get(uid);
        return result && result.ok ? result.amountMinor : 0;
      })
    );
    if (total === null) return null;
    const totalText = formatCurrency(total / 100);
    const targetText = formatCurrency(previewAmountMinor / 100);
    if (total === previewAmountMinor) return `Assigned: ${totalText} of ${targetText}`;
    const diffText = formatCurrency(Math.abs(previewAmountMinor - total) / 100);
    return total < previewAmountMinor
      ? `Assigned: ${totalText} of ${targetText} — ${diffText} remaining.`
      : `Assigned: ${totalText} of ${targetText} — ${diffText} over.`;
  }, [splitStrategy, selectedParticipantList, customParseResults, previewAmountMinor]);

  const previewCustomParticipants = useMemo(() => {
    if (splitStrategy !== "custom" || selectedParticipantList.length === 0 || previewAmountMinor === null) {
      return null;
    }
    const allValid = selectedParticipantList.every((uid) => customParseResults.get(uid)?.ok);
    if (!allValid) return null;
    const entries = selectedParticipantList.map((uid) => {
      const result = customParseResults.get(uid);
      return { uid, amountMinor: result && result.ok ? result.amountMinor : 0 };
    });
    const total = sumSafeIntegers(entries.map((e) => e.amountMinor));
    return total === previewAmountMinor ? entries : null;
  }, [splitStrategy, selectedParticipantList, customParseResults, previewAmountMinor]);

  // ------------------------------------------------------------------
  // Submission controller (§25/§26/§27/§28) - inFlightRef (synchronous
  // serialization guard) + pendingRef (idempotency facts retention),
  // mirroring src/hooks/useSavingsMoneyAction.tsx's submit() exactly.
  // ------------------------------------------------------------------
  const pendingRef = useRef<PendingExpenseCreationRequest | null>(null);
  const inFlightRef = useRef(false);

  const handleSubmit = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!user || tripState.status !== "ready" || !tripId) return;
    if (!isCurrentMember) {
      setSubmitError("You must be a current member of this trip to add an expense.");
      return;
    }

    const descResult = validateExpenseDescription(description);
    const amountResult = parseExpenseMoneyInput(amountText);
    const categoryResult = validateExpenseCategory(category);
    const participants = selectedParticipants ? Array.from(selectedParticipants) : [];

    setDescriptionError(descResult.ok ? null : descResult.error);
    setAmountError(amountResult.ok ? null : amountResult.error);
    setCategoryError(categoryResult.ok ? null : categoryResult.error);
    setParticipantsError(participants.length > 0 ? null : "Select at least one participant.");

    // Checkpoint 4D.7A §1: explicit resolution gates for correction mode
    // - checked BEFORE the generic bail below so each gets its own
    // honest, specific message rather than a silent no-op. Neither gate
    // can be satisfied merely by UI disablement elsewhere; both are
    // re-checked here independently, matching this handler's own
    // existing "UI disablement is never the sole authority" convention.
    if (isCorrectionRoute && !payerUid) {
      setSubmitError(
        "Choose who paid for this corrected expense — the original payer is no longer part of this trip."
      );
      return;
    }
    if (
      isCorrectionRoute &&
      eligibilityPartition &&
      eligibilityPartition.ineligible.length > 0 &&
      !removedParticipantsAcknowledged
    ) {
      setSubmitError("Review the removed participants above before saving.");
      return;
    }

    // Checkpoint 4D.4 §21: the route re-validates independently in
    // handleSubmit for every strategy - UI disablement is never the sole
    // authority. Each branch below re-parses from the raw text state,
    // never trusting the live/memoized preview values. Bailing out here
    // (rather than deep inside each branch) lets every branch below
    // safely rely on descResult/amountResult/categoryResult/payerUid
    // already being narrowed to their "ok" shapes by TypeScript's own
    // control-flow analysis - no `as` casts needed anywhere below.
    if (!descResult.ok || !amountResult.ok || !categoryResult.ok || participants.length === 0 || !payerUid) {
      return;
    }

    let facts: ExpenseCreationFacts | null = null;

    // Checkpoint 4D.7 §9: the logical creation identity includes
    // replacesExpenseId/occurredAtInstantMs - both null for ordinary
    // creation (unchanged from 4D.3/4D.4), both set from the validated
    // correction prefill when this route is in correction mode.
    const factOccurredAtInstantMs =
      isCorrectionRoute && prefillResult && prefillResult.ok ? prefillResult.data.occurredAtInstantMs : null;
    const factReplacesExpenseId =
      isCorrectionRoute && typeof replacesExpenseId === "string" ? replacesExpenseId : null;

    if (splitStrategy === "equal") {
      setPercentageErrors({});
      setCustomErrors({});
      setSplitAggregateError(null);
      facts = {
        tripId,
        payerUid,
        amountMinor: amountResult.amountMinor,
        currency: "USD",
        description: descResult.value,
        category: categoryResult.value,
        paymentSource: "member_out_of_pocket",
        occurredAtInstantMs: factOccurredAtInstantMs,
        replacesExpenseId: factReplacesExpenseId,
        splitStrategy: "equal",
        participants: canonicalizeEqualParticipants(participants),
      };
    } else if (splitStrategy === "percentage") {
      setCustomErrors({});
      const nextErrors: Record<string, string> = {};
      const parsed: { uid: string; percentageBasisPoints: number }[] = [];
      participants.forEach((uid) => {
        const result = parsePercentageToBasisPoints(percentageInputs[uid] ?? "");
        if (result.ok) parsed.push({ uid, percentageBasisPoints: result.percentageBasisPoints });
        else nextErrors[uid] = result.error;
      });
      setPercentageErrors(nextErrors);

      let aggregateOk = false;
      let aggregateMessage: string | null = null;
      if (Object.keys(nextErrors).length === 0 && parsed.length > 0) {
        const total = sumSafeIntegers(parsed.map((p) => p.percentageBasisPoints));
        if (total === 10000) {
          aggregateOk = true;
        } else if (total === null) {
          aggregateMessage = "Percentages are too large to total. Adjust and try again.";
        } else {
          aggregateMessage = `Total: ${(total / 100).toFixed(2)}% — must equal 100.00%.`;
        }
      }
      setSplitAggregateError(aggregateMessage);

      if (Object.keys(nextErrors).length === 0 && aggregateOk) {
        facts = {
          tripId,
          payerUid,
          amountMinor: amountResult.amountMinor,
          currency: "USD",
          description: descResult.value,
          category: categoryResult.value,
          paymentSource: "member_out_of_pocket",
          occurredAtInstantMs: factOccurredAtInstantMs,
          replacesExpenseId: factReplacesExpenseId,
          splitStrategy: "percentage",
          participants: canonicalizePercentageParticipants(parsed),
        };
      }
    } else {
      setPercentageErrors({});
      const nextErrors: Record<string, string> = {};
      const parsed: { uid: string; amountMinor: number }[] = [];
      participants.forEach((uid) => {
        const result = parseExpenseShareMoneyInput(customInputs[uid] ?? "");
        if (result.ok) parsed.push({ uid, amountMinor: result.amountMinor });
        else nextErrors[uid] = result.error;
      });
      setCustomErrors(nextErrors);

      let aggregateOk = false;
      let aggregateMessage: string | null = null;
      if (Object.keys(nextErrors).length === 0 && parsed.length > 0) {
        const total = sumSafeIntegers(parsed.map((p) => p.amountMinor));
        if (total === amountResult.amountMinor) {
          aggregateOk = true;
        } else if (total === null) {
          aggregateMessage = "Custom amounts are too large to total. Adjust and try again.";
        } else {
          aggregateMessage = `Assigned: ${formatCurrency(total / 100)} of ${formatCurrency(amountResult.amountMinor / 100)}.`;
        }
      }
      setSplitAggregateError(aggregateMessage);

      if (Object.keys(nextErrors).length === 0 && aggregateOk) {
        facts = {
          tripId,
          payerUid,
          amountMinor: amountResult.amountMinor,
          currency: "USD",
          description: descResult.value,
          category: categoryResult.value,
          paymentSource: "member_out_of_pocket",
          occurredAtInstantMs: factOccurredAtInstantMs,
          replacesExpenseId: factReplacesExpenseId,
          splitStrategy: "custom",
          participants: canonicalizeCustomParticipants(parsed),
        };
      }
    }

    if (!facts) return;

    // Checkpoint 4D.7 §7/§8/§24: correction mode NEVER submits directly
    // from this validation pass - the reviewed/validated facts are held
    // for the confirmation dialog, and the trusted mutation(s) only ever
    // run after an explicit "Save correction"/"Finish correction" tap
    // inside it (review-before-reverse ordering, §24 step F/G/H). Facts
    // are rebuilt from current field state on every Save tap, so editing
    // after Cancel and tapping Save again always reflects the latest
    // edits.
    if (isCorrectionRoute) {
      pendingCorrectionFactsRef.current = facts;
      setCorrectionSubmitError(null);
      setCorrectDialogVisible(true);
      return;
    }

    const clientRequestId = resolveExpenseClientRequestId(
      pendingRef,
      facts,
      generateExpenseClientRequestId
    );

    inFlightRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      await recordTripExpense(buildRecordTripExpenseInput(facts, clientRequestId));

      // Success clears the pending record - a later submission is a new
      // logical request and must get a new id.
      pendingRef.current = null;
      announceExpenseSuccess(`Added ${formatCurrency(facts.amountMinor / 100)} expense`);
      // The live history subscription on the Expense list reconciles the
      // real persisted Expense - no optimistic/fake row is ever injected
      // here.
      goToExpenseList();
    } catch (e) {
      console.error("Failed to record expense:", e);
      // already-exists is DEFINITIVE (this exact request id is
      // permanently associated with different committed facts) - clear
      // the pending record so the next attempt mints a fresh id. Every
      // other failure (including unavailable/deadline-exceeded) leaves
      // pendingRef untouched so an exact-facts retry reuses the same id.
      if ((e as { code?: string } | null | undefined)?.code === "functions/already-exists") {
        pendingRef.current = null;
      }
      setSubmitError(expenseErrorMessage(e, isArchived));
      setSubmitting(false);
    } finally {
      inFlightRef.current = false;
    }
  }, [
    user,
    tripState,
    tripId,
    isCurrentMember,
    isArchived,
    isCorrectionRoute,
    prefillResult,
    replacesExpenseId,
    eligibilityPartition,
    removedParticipantsAcknowledged,
    description,
    amountText,
    category,
    selectedParticipants,
    payerUid,
    splitStrategy,
    percentageInputs,
    customInputs,
    announceExpenseSuccess,
    goToExpenseList,
  ]);

  const handleCancel = useCallback(() => {
    if (submitting) return;
    goToExpenseList();
  }, [submitting, goToExpenseList]);

  // ------------------------------------------------------------------
  // Correction confirm dialog + trusted two-step mutation (Checkpoint
  // 4D.7 §7/§8/§9/§10/§11). Two INDEPENDENT pending-request facts (the
  // reversal of the OLD Expense, and the creation of the NEW replacement)
  // - never the same clientRequestId for both, per §8. handleSubmit above
  // only ever gets this far after validating/building `facts` and, in
  // correction mode, holding them in pendingCorrectionFactsRef pending
  // this explicit confirmation - no reversal or creation call is ever
  // issued merely by opening this dialog or navigating to this screen.
  // ------------------------------------------------------------------
  const pendingCorrectionFactsRef = useRef<ExpenseCreationFacts | null>(null);
  const pendingReversalRef = useRef<PendingExpenseReversalRequest | null>(null);
  const correctionInFlightRef = useRef(false);
  const [correctDialogVisible, setCorrectDialogVisible] = useState(false);
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [correctionSubmitError, setCorrectionSubmitError] = useState<string | null>(null);

  // Guards the two-step mutation's own state updates against a stale
  // continuation after unmount/route-change (§11) - this component has
  // no other async work that outlives a render the way this dialog's
  // confirm handler can (an in-flight reverseTripExpense/recordTripExpense
  // pair), so a dedicated ref is added here rather than reusing any
  // existing one-shot effect's local `cancelled` flag.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const closeCorrectDialog = useCallback(() => {
    // Ignored while a request is unresolved, mirroring
    // ReverseExpenseDialog's own guardedCancel - pendingReversalRef/
    // pendingRef are deliberately never cleared merely by dismissing the
    // dialog, so re-opening it (by tapping "Save correction" again)
    // still safely reuses the same clientRequestId(s) for any step that
    // hasn't yet been confirmed successful.
    if (correctionInFlightRef.current) return;
    setCorrectDialogVisible(false);
  }, []);

  const handleConfirmCorrection = useCallback(async () => {
    if (correctionInFlightRef.current) return;
    if (!tripId) return;
    const facts = pendingCorrectionFactsRef.current;
    if (!facts || !facts.replacesExpenseId) return;
    const oldExpenseId = facts.replacesExpenseId;

    correctionInFlightRef.current = true;
    setCorrectionSubmitting(true);
    setCorrectionSubmitError(null);

    try {
      // Step 1 (§8/§24 step H.1) - ONLY when initialCorrectionPhase says
      // the reversal step is still pending for THIS route's own
      // one-shot-loaded state (Checkpoint 4D.7A §5's tested contract).
      // Once a reversal attempt here is confirmed successful,
      // oldExpenseState is updated to reflect that (below), so a later
      // retry of THIS confirmation (e.g. after step 2 failed) re-derives
      // "create" from initialCorrectionPhase and never re-issues a
      // second reversal - matching §8's "skip reversal entirely" rule
      // for an already-reversed original exactly, without needing a
      // separate ambiguous-outcome recovery banner: the dialog's own
      // Confirm button, tapped again, IS the retry, and
      // reverseTripExpense's own exact-replay support (reused unchanged
      // from 4D.6) makes that retry safe regardless of whether an
      // earlier ambiguous attempt actually committed.
      if (
        oldExpenseState.status === "ready" &&
        initialCorrectionPhase(oldExpenseState.expense.status) === "reverse"
      ) {
        const reversalFacts: ExpenseReversalFacts = {
          expenseId: oldExpenseId,
          reversalReason: CORRECTION_REVERSAL_REASON,
        };
        const reversalClientRequestId = resolveExpenseReversalClientRequestId(
          pendingReversalRef,
          reversalFacts,
          generateExpenseClientRequestId
        );
        try {
          await reverseTripExpense({
            expenseId: reversalFacts.expenseId,
            reversalReason: reversalFacts.reversalReason,
            clientRequestId: reversalClientRequestId,
          });
        } catch (e) {
          if (!isMountedRef.current) return;
          console.error("Failed to reverse original expense during correction:", e);
          // Checkpoint 4D.7A §4: classification may re-fetch the old
          // Expense to independently confirm status before claiming a
          // specific cause - never inferred from the error code alone.
          const message = await classifyCorrectionReverseFailure(e, tripId, oldExpenseId);
          if (!isMountedRef.current) return;
          setCorrectionSubmitError(message);
          return;
        }
        if (!isMountedRef.current) return;
        // Verified successful (no throw) - reflect it locally so a retry
        // of this same confirmation never attempts a second reversal,
        // and clear the reversal's own pending id (a LATER, unrelated
        // correction attempt must never reuse it).
        pendingReversalRef.current = null;
        setOldExpenseState((prev) =>
          prev.status === "ready" ? { ...prev, expense: { ...prev.expense, status: "reversed" } } : prev
        );
      }

      // Step 2 (§8/§24 step H.2) - only ever reached once step 1 is
      // skipped (already reversed) or verified successful above.
      const clientRequestId = resolveExpenseClientRequestId(pendingRef, facts, generateExpenseClientRequestId);
      try {
        await recordTripExpense(buildRecordTripExpenseInput(facts, clientRequestId));
      } catch (e) {
        if (!isMountedRef.current) return;
        console.error("Failed to save corrected expense:", e);
        if ((e as { code?: string } | null | undefined)?.code === "functions/already-exists") {
          pendingRef.current = null;
        }
        setCorrectionSubmitError(correctionCreateErrorMessage(e, isArchived));
        return;
      }

      if (!isMountedRef.current) return;
      pendingRef.current = null;
      pendingCorrectionFactsRef.current = null;
      setCorrectDialogVisible(false);
      announceExpenseSuccess(`Saved corrected expense`);
      goToExpenseList();
    } finally {
      if (isMountedRef.current) {
        correctionInFlightRef.current = false;
        setCorrectionSubmitting(false);
      }
    }
  }, [tripId, oldExpenseState, isArchived, announceExpenseSuccess, goToExpenseList]);

  return (
    <>
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: scrollBottomInset }]}>
        <View style={styles.contentWrap}>
          <View style={styles.headerRow}>
            <Pressable
              onPress={handleCancel}
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

          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: colors.border },
              cardShadowFor(theme.dark),
            ]}
          >
            <Text style={[styles.title, { color: colors.textPrimary }]}>
              {isCorrectionRoute
                ? correctionAction.kind === "finish"
                  ? "Finish correction"
                  : "Correct expense"
                : "Add Expense"}
            </Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>
              {isCorrectionRoute
                ? correctionAction.kind === "finish"
                  ? "The original expense is already reversed and has no replacement yet. Review the details below to finish the correction."
                  : "Review the details before replacing the original expense."
                : "Choose who shared this cost and how to split it."}
            </Text>

            <View style={{ height: spacing.md }} />

            {tripState.status === "loading" ? (
              <Text style={[styles.stateText, { color: colors.textMuted }]}>Loading trip…</Text>
            ) : tripState.status === "not_found" ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>
                  This trip could not be found.
                </Text>
                <Text style={[styles.stateText, { color: colors.textMuted }]}>
                  It may have been deleted, or you may no longer have access to it.
                </Text>
                <Pressable
                  onPress={() => router.replace("/(tabs)/trips")}
                  accessibilityRole="button"
                  accessibilityLabel="Back to Trips"
                  style={({ pressed }) => [
                    styles.primaryActionBtn,
                    { backgroundColor: colors.mint },
                    pressed && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[styles.primaryActionText, { color: colors.onMint }]}>Back to Trips</Text>
                </Pressable>
              </View>
            ) : isArchived ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>
                  {isCorrectionRoute
                    ? "This trip is archived, so a corrected replacement can’t be created here."
                    : "This trip is archived and no longer accepts new expenses."}
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
            ) : !isCurrentMember ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>
                  You don’t have permission to add an expense here.
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
            ) : isCorrectionRoute && (oldExpenseState.status === "idle" || oldExpenseState.status === "loading") ? (
              <Text style={[styles.stateText, { color: colors.textMuted }]}>Loading original expense…</Text>
            ) : isCorrectionRoute && oldExpenseState.status === "unavailable" ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>
                  This expense could not be found.
                </Text>
                <Text style={[styles.stateText, { color: colors.textMuted }]}>
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
            ) : isCorrectionRoute && oldExpenseState.status === "error" ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateText, { color: colors.textMuted }]}>
                  We couldn’t load the original expense.
                </Text>
                <Pressable
                  onPress={retryOldExpense}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading the original expense"
                  style={({ pressed }) => [
                    styles.secondaryActionBtn,
                    { borderColor: colors.border },
                    pressed && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>Retry</Text>
                </Pressable>
              </View>
            ) : isCorrectionRoute && oldExpenseState.status === "ready" && !canClaim ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>
                  You don’t have permission to correct this expense.
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
            ) : isCorrectionRoute && correctionAction.kind === "none" ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>
                  This expense has already been corrected.
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
            ) : isCorrectionRoute && prefillResult && !prefillResult.ok ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>{prefillResult.error}</Text>
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
            ) : selectedParticipants === null ? (
              // Checkpoint 4D.7A §1: payerUid is deliberately EXCLUDED
              // from this gate - in correction mode it can legitimately
              // stay null (awaiting an explicit payer choice) once
              // everything else has finished loading, and the form must
              // render (not show an indefinite "Loading…") so the user
              // can actually make that choice. Ordinary Add Expense is
              // unaffected: its own initializedRef effect always sets a
              // real payerUid together with selectedParticipants, so
              // payerUid is never null once this branch is reached there.
              <Text style={[styles.stateText, { color: colors.textMuted }]}>Loading trip members…</Text>
            ) : (
              <>
              {isCorrectionRoute &&
              (originalPayerIneligible || (eligibilityPartition && eligibilityPartition.ineligible.length > 0)) ? (
                <View style={[styles.ineligibleBanner, { backgroundColor: colors.surfaceTertiary }]}>
                  {originalPayerIneligible ? (
                    <Text style={[styles.ineligibleBannerText, { color: colors.textMuted }]}>
                      {payerUid
                        ? "The original payer is no longer part of this trip — a new payer has been selected below."
                        : "The original payer is no longer part of this trip. Choose who paid below before saving."}
                    </Text>
                  ) : null}
                  {eligibilityPartition && eligibilityPartition.ineligible.length > 0 ? (
                    <>
                      <Text
                        style={[
                          styles.ineligibleBannerText,
                          { color: colors.textMuted, marginTop: originalPayerIneligible ? spacing.xs : 0 },
                        ]}
                      >
                        {eligibilityPartition.ineligible.length === 1
                          ? "The original expense included 1 person who is no longer part of this trip. Their participation can’t be reproduced automatically — review the participants and split below before saving."
                          : `The original expense included ${eligibilityPartition.ineligible.length} people who are no longer part of this trip. Their participation can’t be reproduced automatically — review the participants and split below before saving.`}
                      </Text>
                      <Pressable
                        onPress={() => setRemovedParticipantsAcknowledged((v) => !v)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: removedParticipantsAcknowledged }}
                        accessibilityLabel="I've reviewed the removed participants and the revised split"
                        style={styles.acknowledgeRow}
                      >
                        <MaterialCommunityIcons
                          name={removedParticipantsAcknowledged ? "checkbox-marked" : "checkbox-blank-outline"}
                          size={18}
                          color={removedParticipantsAcknowledged ? colors.blue : colors.textMuted}
                        />
                        <Text style={[styles.acknowledgeText, { color: colors.textPrimary }]}>
                          I’ve reviewed the removed participants and the revised split
                        </Text>
                      </Pressable>
                    </>
                  ) : null}
                </View>
              ) : null}
              <AddExpenseForm
                colors={colors}
                members={members}
                isOverCapacity={isOverCapacity}
                description={description}
                onChangeDescription={(v) => {
                  setDescription(v);
                  if (descriptionError) setDescriptionError(null);
                }}
                descriptionError={descriptionError}
                amountText={amountText}
                onChangeAmountText={(v) => {
                  setAmountText(v);
                  if (amountError) setAmountError(null);
                }}
                amountError={amountError}
                category={category}
                onChangeCategory={(v) => {
                  setCategory(v);
                  if (categoryError) setCategoryError(null);
                }}
                categoryError={categoryError}
                payerUid={payerUid}
                onSelectPayer={setPayerUid}
                selectedParticipantUids={selectedParticipants}
                onToggleParticipant={toggleParticipant}
                onSelectAllParticipants={selectAllParticipants}
                onClearAllParticipants={clearAllParticipants}
                participantsError={participantsError}
                profileErrorVisible={profileState.status === "error"}
                onRetryProfiles={retryProfiles}
                previewAmountMinor={previewAmountMinor}
                splitStrategy={splitStrategy}
                onChangeSplitStrategy={changeSplitStrategy}
                percentageValues={percentageInputs}
                onChangePercentageValue={changePercentageInput}
                percentageErrors={percentageErrors}
                percentageAggregateText={percentageAggregateText}
                percentageAggregateError={splitStrategy === "percentage" ? splitAggregateError : null}
                previewPercentageParticipants={previewPercentageParticipants}
                customValues={customInputs}
                onChangeCustomValue={changeCustomInput}
                customErrors={customErrors}
                customAggregateText={customAggregateText}
                customAggregateError={splitStrategy === "custom" ? splitAggregateError : null}
                previewCustomParticipants={previewCustomParticipants}
                submitting={submitting}
                submitError={submitError}
                onSubmit={handleSubmit}
                onCancel={handleCancel}
                primaryActionLabel={
                  isCorrectionRoute ? (correctionAction.kind === "finish" ? "Finish correction" : "Save correction") : undefined
                }
                primaryActionAccessibilityLabel={
                  isCorrectionRoute ? (correctionAction.kind === "finish" ? "Finish correction" : "Save correction") : undefined
                }
              />
              </>
            )}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
    {isCorrectionRoute && oldExpenseState.status === "ready" ? (
      <CorrectExpenseConfirmDialog
        visible={correctDialogVisible}
        mode={correctionAction.kind === "finish" ? "finish" : "start"}
        expenseDescription={description}
        expenseAmountMinor={previewAmountMinor ?? oldExpenseState.expense.amountMinor}
        submitting={correctionSubmitting}
        submitError={correctionSubmitError}
        onCancel={closeCorrectDialog}
        onConfirm={handleConfirmCorrection}
        colors={colors}
      />
    ) : null}
    </>
  );
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

  card: {
    marginTop: spacing.md,
    borderRadius: radii.xl,
    borderWidth: 1,
    padding: spacing.lg,
  },
  title: { ...typography.sectionTitle, fontSize: 18 },
  subtitle: { ...typography.body, marginTop: spacing.xs },

  stateWrap: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.md },
  stateTitle: { fontSize: 15, fontWeight: "800", textAlign: "center" },
  stateText: { fontSize: 13, fontWeight: "600" },

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
  secondaryActionText: { fontSize: 13, fontWeight: "800" },

  ineligibleBanner: {
    borderRadius: radii.md,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  ineligibleBannerText: { fontSize: 12, fontWeight: "600", lineHeight: 17 },
  acknowledgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  acknowledgeText: { fontSize: 12, fontWeight: "700", flex: 1 },
});
