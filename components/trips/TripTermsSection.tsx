// Trip Terms card (Checkpoint 6.3) - compact summary only. The full
// five-field view/edit/review flow lives on its own dedicated route
// (app/(tabs)/trips/[tripId]/terms.tsx) - this card never renders any
// of the five (up to 2,000-character) terms fields inline inside Trip
// Detail, per the approved preflight's explicit instruction not to
// expand full terms content on this already-large screen.
//
// Data flow: fetchCurrentTripTerms(tripId) (existing, Checkpoint 5A.1/
// 5A.2 service) -> local loading/ready/error state -> this
// presentational summary. Visibility (preflight §3/§7): EVERY current
// Trip member may view current Trip Terms - this card is never
// owner-only. Only the Set Up/Edit entry points are owner-only, and
// that is a UX convenience, never a security boundary - publishTripTerms
// itself remains the sole, backend-enforced owner-authorization gate.
//
// Refresh-on-return (Checkpoint 6.3 review fix): reuses this project's
// existing useFocusEffect convention exactly as app/(tabs)/trips/
// index.tsx's own fetchTrips/fetchInvitations refresh already does -
// never a new global store or event bus. useFocusEffect already fires
// on initial mount AND on every re-focus, so this single registration
// covers both "load on mount" and "refetch after returning from the
// Terms route" - no separate plain useEffect/polling is layered on top.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useFocusEffect, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { cardShadowFor, radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { fetchCurrentTripTerms } from "../../src/services/firebase/tripTerms";
import type { TripTerms } from "../../src/types/domain";

type TermsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; terms: TripTerms | null };

function formatPublishedDate(terms: TripTerms): string {
  const date = terms.createdAt.toDate();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TripTermsSection({
  tripId,
  isOwner,
}: {
  tripId: string;
  isOwner: boolean;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();
  const router = useRouter();

  const [state, setState] = useState<TermsState>({ status: "loading" });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (mountedRef.current) setState({ status: "loading" });
    fetchCurrentTripTerms(tripId)
      .then((terms) => {
        if (mountedRef.current) setState({ status: "ready", terms });
      })
      .catch((err) => {
        console.error("Trip terms fetch error:", err);
        if (mountedRef.current) setState({ status: "error" });
      });
  }, [tripId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const retry = useCallback(() => {
    load();
  }, [load]);

  const goToTermsRoute = useCallback(
    (mode?: "edit") => {
      router.push({
        pathname: "/(tabs)/trips/[tripId]/terms",
        params: mode ? { tripId, mode } : { tripId },
      });
    },
    [router, tripId]
  );

  let body: React.ReactNode;
  if (state.status === "loading") {
    body = (
      <Text style={[styles.bodyText, { color: colors.textMuted }]}>Loading Trip Terms…</Text>
    );
  } else if (state.status === "error") {
    body = (
      <Pressable onPress={retry} accessibilityRole="button" accessibilityLabel="Retry loading Trip Terms">
        <Text style={[styles.bodyText, { color: colors.textMuted }]}>
          We couldn’t load the current Trip Terms safely. Tap to retry.
        </Text>
      </Pressable>
    );
  } else if (state.terms === null) {
    body = isOwner ? (
      <>
        <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
          No terms have been published yet.
        </Text>
        <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
          Set the expectations members will review before joining.
        </Text>
        <Pressable
          onPress={() => goToTermsRoute("edit")}
          accessibilityRole="button"
          accessibilityLabel="Set Up Trip Terms"
          style={({ pressed }) => [
            styles.primaryActionBtn,
            { backgroundColor: colors.mint },
            pressed && { opacity: 0.9 },
          ]}
        >
          <Text style={[styles.primaryActionText, { color: colors.onMint }]}>
            Set Up Trip Terms
          </Text>
        </Pressable>
      </>
    ) : (
      <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
        This trip&apos;s owner hasn&apos;t published Trip Terms yet.
      </Text>
    );
  } else {
    const terms = state.terms;
    body = (
      <>
        <Text style={[styles.versionText, { color: colors.textSecondary }]}>
          Version {terms.version} · Published {formatPublishedDate(terms)}
        </Text>
        <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
          Current expectations and group guidelines for this trip.
        </Text>
        <View style={styles.actionsRow}>
          <Pressable
            onPress={() => goToTermsRoute()}
            accessibilityRole="button"
            accessibilityLabel="View Terms"
            style={({ pressed }) => [
              styles.secondaryActionBtn,
              { borderColor: colors.border },
              pressed && { opacity: 0.9 },
            ]}
          >
            <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>
              View Terms
            </Text>
          </Pressable>
          {isOwner ? (
            <Pressable
              onPress={() => goToTermsRoute("edit")}
              accessibilityRole="button"
              accessibilityLabel="Edit or Publish New Version"
              style={({ pressed }) => [
                styles.secondaryActionBtn,
                { borderColor: colors.border },
                pressed && { opacity: 0.9 },
              ]}
            >
              <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>
                Edit / Publish New Version
              </Text>
            </Pressable>
          ) : null}
        </View>
      </>
    );
  }

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: colors.border },
        cardShadowFor(theme.dark),
      ]}
    >
      <View style={styles.cardHeaderRow}>
        <View style={[styles.iconBubble, { backgroundColor: colors.bluePale }]}>
          <MaterialCommunityIcons name="file-document-outline" size={18} color={colors.blue} />
        </View>
        <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Trip Terms</Text>
      </View>

      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  iconBubble: {
    width: 34,
    height: 34,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { ...typography.cardTitle, fontSize: 15 },
  versionText: { fontSize: 12, fontWeight: "700" },
  bodyText: { fontSize: 13, fontWeight: "600" },
  actionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  primaryActionBtn: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
  },
  primaryActionText: { fontSize: 13, fontWeight: "700" },
  secondaryActionBtn: {
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  secondaryActionText: { fontSize: 13, fontWeight: "700" },
});
