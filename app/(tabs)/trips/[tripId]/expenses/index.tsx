// Full Expense history route (Checkpoint 4D.2), per the frozen
// docs/audits/TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §5/§11-§13. A
// dedicated pushed screen - shares ExpenseRow + subscribeToExpensesForTrip
// with the Trip Detail summary card (never a second, differently-shaped
// implementation), but renders EVERY Expense the service returns (no
// slice(0,3), no pagination). Reversed/replacement/corrected records are
// never hidden - history stays historical truth.
//
// NO Expense creation, NO Expense detail, NO reversal/correction UI here -
// this checkpoint is read-only (4D.3/4D.5/4D.6/4D.7 add those later).
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { BAR_HEIGHT, CENTER_BUTTON_SIZE } from "../../../../../components/navigation/BottomNav";
import { initialsFromName } from "../../../../../components/buckets/AvatarCircle";
import { ExpenseRow, type ExpenseRowPayer } from "../../../../../components/expenses/ExpenseRow";
import { cardShadowFor, radii, spacing, typography } from "../../../../../src/theme/tokens";
import { useSemanticColors } from "../../../../../src/theme/useSemanticColors";
import { fetchTripById } from "../../../../../src/services/firebase/trips";
import { subscribeToExpensesForTrip } from "../../../../../src/services/firebase/expenses";
import { subscribeToPublicUsersByIdsChunked } from "../../../../../src/services/firebase/users";
import type { Expense, PublicProfile, Trip } from "../../../../../src/types/domain";

// Same nav-clearance math as Trip Detail (../index.tsx) - not a hardcoded
// constant. See that file's own comment for the iOS-vs-Android/web
// SafeAreaView-inset rationale; duplicated here rather than extracted,
// matching this codebase's own established "small deliberate duplication"
// convention (see e.g. stashCreateErrorMessage/sharedActionErrorMessage).
const NAV_BUTTON_PEEK = CENTER_BUTTON_SIZE / 2 - 4;
const NAV_BREATHING_ROOM = spacing.xxl;

// Centered, readable content width on wide/desktop - narrower than Trips
// index's own 1100 (a card grid) or Trip Detail's 560 mainCol, since a
// single-column list of compact rows reads best at a document-like width
// rather than stretching edge-to-edge on a large screen.
const MAX_CONTENT_WIDTH = 720;

type TripLoadState = { status: "loading" } | { status: "not_found" } | { status: "ready"; trip: Trip };

type ExpenseHistoryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; expenses: Expense[] };

type PayerProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; profiles: Map<string, PublicProfile> };

export default function TripExpensesScreen() {
  const router = useRouter();
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const theme = useTheme();
  const colors = useSemanticColors();
  const insets = useSafeAreaInsets();

  const scrollBottomInset = useMemo(() => {
    const navSafeAreaPadding = Platform.OS === "ios" ? 0 : Math.max(insets.bottom, spacing.sm);
    return BAR_HEIGHT + NAV_BUTTON_PEEK + navSafeAreaPadding + NAV_BREATHING_ROOM;
  }, [insets.bottom]);

  const goToTripDetail = useCallback(() => {
    if (!tripId) return;
    router.replace({ pathname: "/(tabs)/trips/[tripId]", params: { tripId } });
  }, [router, tripId]);

  // ------------------------------------------------------------------
  // Trip context - one-shot, per the checkpoint's own instruction (no
  // new Trip subscription system in this checkpoint). Only used for
  // page title/subtitle/archived-indicator context; never gates whether
  // Expense history itself loads.
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
        console.error("Trip fetch error (expense list):", err);
        if (!cancelled) setTripState({ status: "not_found" });
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  // ------------------------------------------------------------------
  // Expense history - identical live-subscription/retry-nonce shape to
  // Trip Detail's own Expenses card (see that file's matching comment).
  // ------------------------------------------------------------------
  const [expenseState, setExpenseState] = useState<ExpenseHistoryState>({ status: "loading" });
  const expenseUnsubRef = useRef<(() => void) | null>(null);
  const [expenseRetryNonce, setExpenseRetryNonce] = useState(0);
  const retryExpenses = useCallback(() => setExpenseRetryNonce((n) => n + 1), []);

  useEffect(() => {
    expenseUnsubRef.current?.();
    expenseUnsubRef.current = null;
    if (!tripId) return undefined;
    setExpenseState({ status: "loading" });
    expenseUnsubRef.current = subscribeToExpensesForTrip(
      tripId,
      (expenses) => setExpenseState({ status: "ready", expenses }),
      (err) => {
        console.error("Expense history subscription error:", err);
        setExpenseState({ status: "error" });
      }
    );
    return () => {
      expenseUnsubRef.current?.();
      expenseUnsubRef.current = null;
    };
  }, [tripId, expenseRetryNonce]);

  // Every returned Expense renders - no slice, no pagination (§13). Wrapped
  // in its own useMemo (rather than a plain conditional expression) so its
  // identity is stable across renders that don't actually change it -
  // otherwise a new [] literal on every non-"ready" render would make the
  // payerUids useMemo below think its dependency changed every time.
  const allExpenses = useMemo(
    () => (expenseState.status === "ready" ? expenseState.expenses : []),
    [expenseState]
  );

  // ------------------------------------------------------------------
  // Payer-profile resolution - identical shape to Trip Detail's, derived
  // from the FULL list here (not a 3-item slice), since every row on this
  // page is actually rendered.
  // ------------------------------------------------------------------
  const payerUids = useMemo(() => {
    const uids = new Set<string>();
    allExpenses.forEach((expense) => {
      if (expense.paymentSource === "member_out_of_pocket" && expense.payerUid) {
        uids.add(expense.payerUid);
      }
    });
    return Array.from(uids).sort();
  }, [allExpenses]);
  const payerUidsKey = payerUids.join("|");

  const [profileState, setProfileState] = useState<PayerProfileState>({ status: "loading" });
  const profileUnsubRef = useRef<(() => void) | null>(null);
  const [profileRetryNonce, setProfileRetryNonce] = useState(0);
  const retryPayerProfiles = useCallback(() => setProfileRetryNonce((n) => n + 1), []);

  useEffect(() => {
    profileUnsubRef.current?.();
    profileUnsubRef.current = null;
    setProfileState({ status: "loading" });
    if (payerUids.length === 0) {
      setProfileState({ status: "ready", profiles: new Map() });
      return undefined;
    }
    profileUnsubRef.current = subscribeToPublicUsersByIdsChunked(
      payerUids,
      (profiles) => setProfileState({ status: "ready", profiles: new Map(profiles.map((p) => [p.uid, p])) }),
      (err) => {
        console.error("Expense payer profile subscription error:", err);
        setProfileState({ status: "error" });
      }
    );
    return () => {
      profileUnsubRef.current?.();
      profileUnsubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payerUidsKey, profileRetryNonce]);

  const missingPayerLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (profileState.status !== "ready") return labels;
    const missing = payerUids.filter((uid) => !profileState.profiles.get(uid)?.displayName?.trim());
    missing.forEach((uid, i) => {
      labels.set(uid, missing.length > 1 ? `Trip member ${i + 1}` : "Trip member");
    });
    return labels;
  }, [profileState, payerUids]);

  const resolvePayer = useCallback(
    (expense: Expense): ExpenseRowPayer => {
      if (expense.paymentSource === "shared_stash") return { kind: "shared_stash" };

      const uid = expense.payerUid;
      if (!uid) return { kind: "member", avatarLabel: "Trip member", nameLabel: "Trip member" };

      if (profileState.status === "loading") {
        return { kind: "member", avatarLabel: "Loading member", nameLabel: "Loading member…" };
      }
      if (profileState.status === "error") {
        return { kind: "member", avatarLabel: "Trip member", nameLabel: "Trip member" };
      }

      const profile = profileState.profiles.get(uid);
      const name = profile?.displayName?.trim();
      if (name) {
        return {
          kind: "member",
          avatarLabel: initialsFromName(name),
          nameLabel: name,
          photoURL: profile?.photoURL?.trim() || undefined,
        };
      }
      const fallback = missingPayerLabels.get(uid) ?? "Trip member";
      return { kind: "member", avatarLabel: fallback, nameLabel: fallback };
    },
    [profileState, missingPayerLabels]
  );

  const tripTitle = tripState.status === "ready" ? tripState.trip.title?.trim() || "Trip" : null;
  const isArchived = tripState.status === "ready" && !!tripState.trip.archivedAt;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: scrollBottomInset }]}
      >
        <View style={styles.contentWrap}>
          <View style={styles.headerRow}>
            <Pressable
              onPress={goToTripDetail}
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

          <Text style={[styles.h1, { color: colors.textPrimary }]}>Expenses</Text>
          {tripTitle ? (
            <Text style={[styles.sub, { color: colors.textMuted }]} numberOfLines={1}>
              {tripTitle}
              {isArchived ? " · Archived" : ""}
            </Text>
          ) : null}

          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: colors.border },
              cardShadowFor(theme.dark),
            ]}
          >
            {tripState.status === "not_found" ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>
                  This trip could not be found.
                </Text>
                <Text style={[styles.stateSub, { color: colors.textMuted }]}>
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
                  <Text style={[styles.primaryActionText, { color: colors.onMint }]}>
                    Back to Trips
                  </Text>
                </Pressable>
              </View>
            ) : expenseState.status === "loading" ? (
              <View style={styles.stateWrap}>
                <ActivityIndicator size="small" />
                <Text style={[styles.stateSub, { color: colors.textMuted }]}>Loading expenses…</Text>
              </View>
            ) : expenseState.status === "error" ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateSub, { color: colors.textMuted }]}>
                  We couldn’t load expenses.
                </Text>
                <Pressable
                  onPress={retryExpenses}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading expenses"
                  style={({ pressed }) => [
                    styles.secondaryActionBtn,
                    { borderColor: colors.border },
                    pressed && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>Retry</Text>
                </Pressable>
              </View>
            ) : allExpenses.length === 0 ? (
              <View style={styles.stateWrap}>
                <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>No expenses yet.</Text>
                <Text style={[styles.stateSub, { color: colors.textMuted }]}>
                  Trip expenses will appear here.
                </Text>
              </View>
            ) : (
              <>
                <View>
                  {allExpenses.map((expense) => (
                    <ExpenseRow key={expense.id} expense={expense} payer={resolvePayer(expense)} />
                  ))}
                </View>

                {profileState.status === "error" ? (
                  <View style={styles.profileErrorRow}>
                    <Text style={[styles.profileErrorText, { color: colors.textMuted }]}>
                      Some member names couldn’t be loaded.
                    </Text>
                    <Pressable
                      onPress={retryPayerProfiles}
                      accessibilityRole="button"
                      accessibilityLabel="Retry loading member names"
                    >
                      <Text style={[styles.profileErrorRetryText, { color: colors.blue }]}>Retry</Text>
                    </Pressable>
                  </View>
                ) : null}
              </>
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

  h1: { ...typography.pageTitle, marginTop: spacing.md },
  sub: { ...typography.body, marginTop: spacing.xs },

  card: {
    marginTop: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
  },

  stateWrap: { paddingVertical: spacing.lg, alignItems: "center", gap: spacing.sm },
  stateTitle: { fontSize: 15, fontWeight: "800" },
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
  secondaryActionText: { fontSize: 13, fontWeight: "800" },

  profileErrorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  profileErrorText: { fontSize: 11, fontWeight: "600", flex: 1, marginRight: spacing.sm },
  profileErrorRetryText: { fontSize: 12, fontWeight: "800" },
});
