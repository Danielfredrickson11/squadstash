// app/(tabs)/trips/invitations/[invitationId].tsx
//
// Checkpoint 5C.3C (client cutover + invitation review UI), per the
// frozen docs/audits/TRIP_INVITATION_CLIENT_UX_PREFLIGHT_2026-10-18.md.
//
// The route carries ONLY invitationId (§9/§13) - this screen must work
// correctly from a deep link, a cold app start, or a restored
// navigation state, never assuming any Trips-list state exists. The
// load order is STRICTLY sequential (§14, a hard frozen requirement):
// getTripInvitationPreview(invitationId) must resolve and supply
// preview.tripId BEFORE fetchCurrentTripTerms is ever called - never in
// parallel, never using any client-carried tripId.
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Button, Text, useTheme } from "react-native-paper";
import type { MD3Theme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { useAuth } from "../../../../src/contexts/AuthContext";
import {
  acceptTripInvitation,
  declineTripInvitation,
  getTripInvitationPreview,
} from "../../../../src/services/firebase/tripInvitations";
import { fetchCurrentTripTerms } from "../../../../src/services/firebase/tripTerms";
import { isTripInvitationTermsChangedError } from "../../../../src/domain/tripInvitation";
import { formatTripDates } from "../../../../src/domain/tripDates";
import { cardShadowFor, radii, spacing, typography } from "../../../../src/theme/tokens";
import { useSemanticColors } from "../../../../src/theme/useSemanticColors";
import type { TripInvitationPreview, TripTerms } from "../../../../src/types/domain";

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1200&q=60";
const MAX_CONTENT_WIDTH = 640;

// The exact five terms fields, verbatim-rendered, in the frozen order
// (docs/audits/TRIP_INVITATION_CLIENT_UX_PREFLIGHT_2026-10-18.md §10/
// §12 and §17 of this checkpoint) - never summarized, truncated, or
// paraphrased. This is consent/disclosure content.
const TERMS_FIELDS: readonly {
  key:
    | "contributionExpectations"
    | "expenseAllocationExpectations"
    | "sharedStashSpendingAuthority"
    | "withdrawalExpectations"
    | "settlementExpectations";
  label: string;
}[] = [
  { key: "contributionExpectations", label: "Contribution Expectations" },
  { key: "expenseAllocationExpectations", label: "Expense Allocation" },
  {
    key: "sharedStashSpendingAuthority",
    label: "Shared Stash Spending Authority",
  },
  { key: "withdrawalExpectations", label: "Withdrawal Expectations" },
  { key: "settlementExpectations", label: "Settlement Expectations" },
];

type Phase =
  | "loading-preview"
  | "loading-terms"
  | "ready"
  | "terms-unavailable"
  | "terms-error"
  | "invalid-route"
  | "not-found"
  | "not-actionable"
  | "load-error";

// Maps a caught getTripInvitationPreview error to a user-facing phase -
// never a security decision (the backend/Rules already made that), only
// a presentation choice. `failed-precondition` covers every "invitation
// is no longer eligible" case the backend can report (expired,
// declined, cancelled, already accepted, archived Trip, stale inviter,
// self-invite) - the backend does not (and need not) distinguish these
// with a separate machine-readable reason the way acceptTripInvitation's
// `terms_changed` does, so they share one friendly message here.
function classifyPreviewError(
  error: unknown
): "not-found" | "not-actionable" | "load-error" {
  const code = (error as { code?: string } | null | undefined)?.code;
  if (code === "functions/not-found" || code === "functions/permission-denied") {
    return "not-found";
  }
  if (
    code === "functions/failed-precondition" ||
    code === "functions/invalid-argument"
  ) {
    return "not-actionable";
  }
  return "load-error";
}

export default function InvitationReviewScreen() {
  const router = useRouter();
  const theme = useTheme();
  const colors = useSemanticColors();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ invitationId?: string | string[] }>();

  // Checkpoint 5C.3C §13: the route contract is invitationId ONLY - one
  // non-empty string. An array-shaped or missing param is a malformed
  // route, never something to attempt a preview against.
  const rawInvitationId = params.invitationId;
  const invitationId =
    typeof rawInvitationId === "string" && rawInvitationId.length > 0
      ? rawInvitationId
      : null;

  const [phase, setPhase] = useState<Phase>(
    invitationId ? "loading-preview" : "invalid-route"
  );
  const [preview, setPreview] = useState<TripInvitationPreview | null>(null);
  const [terms, setTerms] = useState<TripTerms | null>(null);
  const [termsChangedNotice, setTermsChangedNotice] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  // Checkpoint 5C.3C §21: ONE shared synchronous mutex covering BOTH
  // Accept and Decline, matching create.tsx's own established
  // submitInFlightRef pattern exactly. Checked/acquired at the absolute
  // start of each handler, before any await - React state
  // (accepting/declining) alone is not a synchronous guard and cannot
  // reliably prevent two rapid presses (Accept+Accept, Decline+Decline,
  // or Accept+Decline) from both entering their handler before the
  // first render reflecting a disabled button ever lands.
  const submitInFlightRef = useRef(false);

  const loadPreviewAndTerms = useCallback(async () => {
    if (!invitationId) {
      setPhase("invalid-route");
      return;
    }

    setPhase("loading-preview");
    setPreview(null);
    setTerms(null);
    setTermsChangedNotice(false);
    setActionError(null);
    setImgFailed(false);

    let fetchedPreview: TripInvitationPreview;
    try {
      // Step 1 - the ONLY starting input is invitationId. No Trips-list
      // state, carried invitation object, or client-known tripId is
      // ever read or trusted here.
      fetchedPreview = await getTripInvitationPreview(invitationId);
    } catch (e) {
      console.log("getTripInvitationPreview error:", e);
      setPhase(classifyPreviewError(e));
      return;
    }

    // Step 2 - preview.tripId, from the trusted response, is now the
    // ONLY authoritative Trip id for the rest of this review session.
    setPreview(fetchedPreview);
    setPhase("loading-terms");

    try {
      // Step 3 - fetchCurrentTripTerms is never called before this
      // point; it depends on fetchedPreview.tripId, never a route param
      // or any other source.
      const fetchedTerms = await fetchCurrentTripTerms(fetchedPreview.tripId);
      if (fetchedTerms === null) {
        setPhase("terms-unavailable");
        return;
      }
      setTerms(fetchedTerms);
      setPhase("ready");
    } catch (e) {
      console.log("fetchCurrentTripTerms error:", e);
      // Covers both TripTermsCorruptionError (a plain Error subclass,
      // not a security boundary) and any other read/network failure -
      // neither's raw internal text is ever shown to the user; both map
      // to the same generic, retryable "terms-error" phase/message.
      setPhase("terms-error");
    }
  }, [invitationId]);

  useEffect(() => {
    loadPreviewAndTerms();
  }, [loadPreviewAndTerms]);

  const onAccept = useCallback(async () => {
    if (phase !== "ready" || !preview || !terms || !invitationId) return;
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setAccepting(true);
    setActionError(null);
    try {
      const result = await acceptTripInvitation(invitationId, terms.id);
      router.replace({
        pathname: "/(tabs)/trips/[tripId]",
        params: { tripId: result.tripId },
      });
    } catch (e) {
      console.log("acceptTripInvitation error:", e);
      if (isTripInvitationTermsChangedError(e)) {
        // Checkpoint 5C.3C §19: never auto-retry. Re-fetch current
        // terms, replace the displayed terms, and require a fresh
        // explicit Accept press.
        setTermsChangedNotice(true);
        try {
          const refreshedTerms = await fetchCurrentTripTerms(preview.tripId);
          if (refreshedTerms === null) {
            setTerms(null);
            setPhase("terms-unavailable");
          } else {
            setTerms(refreshedTerms);
            setPhase("ready");
          }
        } catch (refreshError) {
          console.log(
            "fetchCurrentTripTerms (terms_changed refresh) error:",
            refreshError
          );
          setTerms(null);
          setPhase("terms-error");
        }
      } else {
        setActionError("Couldn't accept this invitation. Please try again.");
      }
    } finally {
      submitInFlightRef.current = false;
      setAccepting(false);
    }
  }, [phase, preview, terms, invitationId, router]);

  const onDecline = useCallback(async () => {
    if (!preview || !user) return;
    if (phase !== "ready" && phase !== "terms-unavailable" && phase !== "terms-error") {
      return;
    }
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setDeclining(true);
    setActionError(null);
    try {
      await declineTripInvitation(preview.tripId, user.uid);
      router.replace("/(tabs)/trips");
    } catch (e) {
      console.log("declineTripInvitation error:", e);
      setActionError("Couldn't decline this invitation. Please try again.");
    } finally {
      submitInFlightRef.current = false;
      setDeclining(false);
    }
  }, [phase, preview, user, router]);

  const canDecline =
    (phase === "ready" || phase === "terms-unavailable" || phase === "terms-error") &&
    !accepting &&
    !declining;
  const canAccept = phase === "ready" && !accepting && !declining;

  const previewHeader =
    preview === null ? null : (
      <View
        style={[
          styles.previewCard,
          { backgroundColor: theme.colors.surface, borderColor: colors.border },
          theme.dark ? null : cardShadowFor(false),
        ]}
      >
        <Image
          source={{ uri: !imgFailed && preview.imageUrl ? preview.imageUrl : FALLBACK_IMAGE }}
          style={styles.coverImage}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
        <View style={styles.previewBody}>
          <Text style={[styles.tripTitle, { color: theme.colors.onSurface }]}>
            {preview.title}
          </Text>
          {preview.location ? (
            <Text style={[styles.tripMeta, { color: theme.colors.onSurfaceVariant }]}>
              {preview.location}
            </Text>
          ) : null}
          {formatTripDates(preview.tripStartDate, preview.tripEndDate) ? (
            <Text style={[styles.tripMeta, { color: theme.colors.onSurfaceVariant }]}>
              {formatTripDates(preview.tripStartDate, preview.tripEndDate)}
            </Text>
          ) : null}
        </View>
      </View>
    );

  let body: React.ReactNode;
  switch (phase) {
    case "invalid-route":
      body = (
        <FriendlyNotice
          icon="link-variant-off"
          title="This invitation link looks incomplete."
          message="Please open it again from your Trips screen."
          colors={colors}
          theme={theme}
        />
      );
      break;
    case "loading-preview":
      body = <LoadingRow label="Loading invitation…" theme={theme} colors={colors} />;
      break;
    case "not-found":
      body = (
        <FriendlyNotice
          icon="email-off-outline"
          title="This invitation couldn't be found."
          message="It may have been removed, or the link may be incorrect."
          colors={colors}
          theme={theme}
        />
      );
      break;
    case "not-actionable":
      body = (
        <FriendlyNotice
          icon="email-alert-outline"
          title="This invitation is no longer available to review."
          message="It may have expired, been responded to already, or the trip may no longer be accepting new members."
          colors={colors}
          theme={theme}
        />
      );
      break;
    case "load-error":
      body = (
        <FriendlyNotice
          icon="wifi-alert"
          title="Something went wrong loading this invitation."
          message="Please check your connection and try again."
          colors={colors}
          theme={theme}
          action={
            <Button mode="outlined" onPress={loadPreviewAndTerms}>
              Try again
            </Button>
          }
        />
      );
      break;
    case "loading-terms":
      body = (
        <>
          {previewHeader}
          <LoadingRow label="Loading trip terms…" theme={theme} colors={colors} />
        </>
      );
      break;
    case "terms-unavailable":
      body = (
        <>
          {previewHeader}
          <FriendlyNotice
            icon="file-document-alert-outline"
            title="This trip hasn't published its terms yet."
            message="You can decline this invitation, or check back later to review and accept."
            colors={colors}
            theme={theme}
          />
        </>
      );
      break;
    case "terms-error":
      body = (
        <>
          {previewHeader}
          <FriendlyNotice
            icon="file-document-alert-outline"
            title="Unable to load trip terms."
            message="Please try again, or decline this invitation."
            colors={colors}
            theme={theme}
            action={
              <Button mode="outlined" onPress={loadPreviewAndTerms}>
                Try again
              </Button>
            }
          />
        </>
      );
      break;
    case "ready":
      body = (
        <>
          {previewHeader}
          {termsChangedNotice ? (
            <View
              style={[
                styles.noticeBanner,
                { backgroundColor: colors.surfaceTertiary, borderColor: colors.border },
              ]}
            >
              <MaterialCommunityIcons
                name="information-outline"
                size={18}
                color={theme.colors.primary}
              />
              <Text style={[styles.noticeText, { color: theme.colors.onSurface }]}>
                The Trip terms were updated. Please review them again before accepting.
              </Text>
            </View>
          ) : null}

          <Text style={[styles.sectionTitle, { color: theme.colors.onBackground }]}>
            Trip Terms
          </Text>
          {TERMS_FIELDS.map(({ key, label }) => (
            <View
              key={key}
              style={[
                styles.termsCard,
                { backgroundColor: theme.colors.surface, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.termsLabel, { color: theme.colors.onSurfaceVariant }]}>
                {label}
              </Text>
              <Text style={[styles.termsValue, { color: theme.colors.onSurface }]}>
                {terms![key]}
              </Text>
            </View>
          ))}
        </>
      );
      break;
    default:
      body = null;
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.contentWrap}>
          <Text style={[styles.pageTitle, { color: theme.colors.onBackground }]}>
            Trip Invitation
          </Text>

          {body}

          {actionError ? (
            <Text style={[styles.actionErrorText, { color: colors.coral }]}>
              {actionError}
            </Text>
          ) : null}

          {canAccept || canDecline ? (
            <View style={styles.actionsRow}>
              <Button
                mode="contained"
                buttonColor={theme.colors.primary}
                textColor={theme.colors.onPrimary}
                onPress={onAccept}
                loading={accepting}
                disabled={!canAccept}
              >
                Accept Invitation
              </Button>
              <View style={{ height: spacing.sm }} />
              <Button
                mode="outlined"
                onPress={onDecline}
                loading={declining}
                disabled={!canDecline}
              >
                Decline
              </Button>
            </View>
          ) : null}

          <View style={{ height: spacing.sm }} />
          <Button mode="text" onPress={() => router.back()} disabled={accepting || declining}>
            Back
          </Button>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function LoadingRow({
  label,
  theme,
  colors,
}: {
  label: string;
  theme: MD3Theme;
  colors: ReturnType<typeof useSemanticColors>;
}) {
  return (
    <View style={styles.loadingWrap}>
      <ActivityIndicator color={theme.colors.primary} />
      <Text style={[styles.loadingText, { color: theme.colors.onSurfaceVariant }]}>
        {label}
      </Text>
    </View>
  );
}

function FriendlyNotice({
  icon,
  title,
  message,
  theme,
  colors,
  action,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  title: string;
  message: string;
  theme: MD3Theme;
  colors: ReturnType<typeof useSemanticColors>;
  action?: React.ReactNode;
}) {
  return (
    <View
      style={[
        styles.noticeWrap,
        { backgroundColor: theme.colors.surface, borderColor: colors.border },
      ]}
    >
      <MaterialCommunityIcons name={icon} size={28} color={colors.textMuted} />
      <Text style={[styles.noticeTitle, { color: theme.colors.onBackground }]}>{title}</Text>
      <Text style={[styles.noticeMessage, { color: theme.colors.onSurfaceVariant }]}>
        {message}
      </Text>
      {action ? <View style={{ marginTop: spacing.sm }}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollContent: { padding: spacing.lg, paddingBottom: 140, alignItems: "center" },
  contentWrap: { width: "100%", maxWidth: MAX_CONTENT_WIDTH },

  pageTitle: { ...typography.pageTitle, marginBottom: spacing.md },

  previewCard: {
    borderRadius: radii.xl,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: spacing.lg,
  },
  coverImage: { width: "100%", height: 180 },
  previewBody: { padding: spacing.lg },
  tripTitle: { ...typography.sectionTitle, fontSize: 20 },
  tripMeta: { ...typography.body, marginTop: spacing.xs },

  sectionTitle: { ...typography.sectionTitle, marginBottom: spacing.sm },

  termsCard: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  termsLabel: { ...typography.meta, fontWeight: "700", marginBottom: spacing.xs },
  termsValue: { ...typography.body },

  noticeBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  noticeText: { ...typography.body, flex: 1 },

  noticeWrap: {
    alignItems: "center",
    textAlign: "center",
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.xl,
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  noticeTitle: { ...typography.sectionTitle, fontSize: 16, textAlign: "center" },
  noticeMessage: { ...typography.body, textAlign: "center" },

  loadingWrap: { paddingVertical: spacing.xl, alignItems: "center", gap: 10 },
  loadingText: { fontSize: 13, fontWeight: "600" },

  actionErrorText: { marginTop: spacing.sm, fontWeight: "700", fontSize: 13 },
  actionsRow: { marginTop: spacing.lg },
});
