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
import { cardShadowFor, radii, spacing, typography } from "../../../../../src/theme/tokens";
import { useSemanticColors } from "../../../../../src/theme/useSemanticColors";
import { useAuth } from "../../../../../src/contexts/AuthContext";
import { useExpenseSuccess } from "../../../../../src/hooks/useExpenseSuccess";
import { fetchTripById } from "../../../../../src/services/firebase/trips";
import { generateExpenseClientRequestId, recordTripExpense } from "../../../../../src/services/firebase/expenses";
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
import { formatCurrency } from "../../../../../utils/format";
import type { PublicProfile, Trip } from "../../../../../src/types/domain";

const NAV_BUTTON_PEEK = CENTER_BUTTON_SIZE / 2 - 4;
const NAV_BREATHING_ROOM = spacing.xxl;
const MAX_CONTENT_WIDTH = 560;

type TripLoadState = { status: "loading" } | { status: "not_found" } | { status: "ready"; trip: Trip };

type PayerProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; profiles: Map<string, PublicProfile> };

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

export default function AddExpenseScreen() {
  const router = useRouter();
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
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
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    if (!user || tripState.status !== "ready") return;
    if (!currentMemberUids.includes(user.uid)) return;
    setPayerUid(user.uid);
    setSelectedParticipants(defaultParticipantSelection(currentMemberUids, user.uid));
    initializedRef.current = true;
  }, [user, tripState, currentMemberUids]);

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
        occurredAtInstantMs: null,
        replacesExpenseId: null,
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
          occurredAtInstantMs: null,
          replacesExpenseId: null,
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
          occurredAtInstantMs: null,
          replacesExpenseId: null,
          splitStrategy: "custom",
          participants: canonicalizeCustomParticipants(parsed),
        };
      }
    }

    if (!facts) return;

    const clientRequestId = resolveExpenseClientRequestId(
      pendingRef,
      facts,
      generateExpenseClientRequestId
    );

    inFlightRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      // Checkpoint 4D.4 §27/§28/§29: switching on facts.splitStrategy
      // (not merging into one generic call) lets TypeScript correctly
      // narrow facts.participants to the matching wire shape for each
      // strategy - no direct Firestore writes, no preview allocation
      // values sent, the backend independently recomputes/validates the
      // exact split regardless of strategy.
      switch (facts.splitStrategy) {
        case "equal":
          await recordTripExpense({
            tripId: facts.tripId,
            payerUid: facts.payerUid,
            amountMinor: facts.amountMinor,
            currency: facts.currency,
            description: facts.description,
            ...(facts.category !== null ? { category: facts.category } : {}),
            splitStrategy: "equal",
            participants: facts.participants,
            clientRequestId,
          });
          break;
        case "percentage":
          await recordTripExpense({
            tripId: facts.tripId,
            payerUid: facts.payerUid,
            amountMinor: facts.amountMinor,
            currency: facts.currency,
            description: facts.description,
            ...(facts.category !== null ? { category: facts.category } : {}),
            splitStrategy: "percentage",
            participants: facts.participants,
            clientRequestId,
          });
          break;
        case "custom":
          await recordTripExpense({
            tripId: facts.tripId,
            payerUid: facts.payerUid,
            amountMinor: facts.amountMinor,
            currency: facts.currency,
            description: facts.description,
            ...(facts.category !== null ? { category: facts.category } : {}),
            splitStrategy: "custom",
            participants: facts.participants,
            clientRequestId,
          });
          break;
      }

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

  return (
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
            <Text style={[styles.title, { color: colors.textPrimary }]}>Add Expense</Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>
              Choose who shared this cost and how to split it.
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
                  This trip is archived and no longer accepts new expenses.
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
            ) : payerUid === null || selectedParticipants === null ? (
              <Text style={[styles.stateText, { color: colors.textMuted }]}>Loading trip members…</Text>
            ) : (
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
              />
            )}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
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
});
