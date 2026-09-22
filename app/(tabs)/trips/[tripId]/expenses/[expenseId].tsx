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
import { cardShadowFor, radii, spacing, typography } from "../../../../../src/theme/tokens";
import { useSemanticColors } from "../../../../../src/theme/useSemanticColors";
import {
  fetchExpenseById,
  fetchExpenseSplitsForExpense,
  subscribeToExpenseById,
} from "../../../../../src/services/firebase/expenses";
import { subscribeToPublicUsersByIdsChunked } from "../../../../../src/services/firebase/users";
import { formatCurrency, formatTransactionTimestamp } from "../../../../../utils/format";
import type { Expense, ExpenseSplit, PublicProfile, SplitStrategy } from "../../../../../src/types/domain";

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

  const expense = expenseState.status === "ready" ? expenseState.expense : null;
  const isReversed = expense?.status === "reversed";
  const isCorrection = !!expense?.replacesExpenseId;
  const categoryText = expense?.category && expense.category.trim().length > 0 ? expense.category : "None";
  const timestampText = expense ? formatTransactionTimestamp(expense.occurredAt ?? expense.createdAt) : "";
  const payerLabel = expense?.paymentSource === "member_out_of_pocket" && expense.payerUid
    ? resolveMemberLabel(expense.payerUid)
    : null;

  return (
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
              </>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
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
