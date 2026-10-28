// app/(tabs)/trips/[tripId]/terms.tsx
//
// Checkpoint 6.3 - dedicated Trip Terms view/edit/review route, per the
// approved preflight. Deep-link-safe like invitations/[invitationId].tsx:
// loads its own Trip and current terms fresh from `tripId` alone, never
// trusting any Trip Detail state carried in navigation. The optional
// `mode` param is a one-shot UX hint only ("open straight into editing")
// - never authorization. Real owner authorization is independently
// derived from this screen's own freshly-loaded Trip.ownerId, and the
// trusted publishTripTerms callable remains the sole backend-enforced
// owner gate regardless of what this screen renders.
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, View } from "react-native";
import { Button, Text, useTheme } from "react-native-paper";
import type { MD3Theme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import {
  TERMS_FIELD_DEFS,
  TripTermsEditor,
} from "../../../../components/trips/TripTermsEditor";
import { useAuth } from "../../../../src/contexts/AuthContext";
import { isTripOwner } from "../../../../src/domain/tripPermissions";
import { fetchTripById } from "../../../../src/services/firebase/trips";
import { fetchCurrentTripTerms } from "../../../../src/services/firebase/tripTerms";
import { radii, spacing, typography } from "../../../../src/theme/tokens";
import { useSemanticColors } from "../../../../src/theme/useSemanticColors";
import type { Trip, TripTerms } from "../../../../src/types/domain";

const MAX_CONTENT_WIDTH = 640;

function isTripArchived(trip: Trip): boolean {
  return trip.archivedAt !== undefined && trip.archivedAt !== null;
}

function formatPublishedDate(terms: TripTerms): string {
  const date = terms.createdAt.toDate();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

type LoadPhase =
  | "loading"
  | "not_found"
  | "load_error"
  | "loading_terms"
  | "terms_error"
  | "ready"
  // Review fix: a successful publishTripTerms call followed by a failed
  // post-publish fetchCurrentTripTerms refresh must never be represented
  // as "no terms exist" - this phase preserves the fact that publication
  // already succeeded while the UI waits for a safe re-read, and its
  // only recovery action re-reads current terms, never republishes.
  | "publish_refresh_error";
type ViewMode = "view" | "edit";

export default function TripTermsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const colors = useSemanticColors();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ tripId?: string | string[]; mode?: string | string[] }>();

  const tripId =
    typeof params.tripId === "string" && params.tripId.length > 0 ? params.tripId : null;
  const modeHint = typeof params.mode === "string" ? params.mode : null;

  const [phase, setPhase] = useState<LoadPhase>(tripId ? "loading" : "not_found");
  const [trip, setTrip] = useState<Trip | null>(null);
  const [currentTerms, setCurrentTerms] = useState<TripTerms | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("view");
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  // Review fix: the server-returned version from the publish that
  // succeeded, kept only for truthful success messaging once the
  // follow-up read eventually succeeds (possibly after one or more
  // Retry presses) - the subsequent fetchCurrentTripTerms call remains
  // the sole source of truth for the full terms document itself.
  const [publishedVersionAwaitingRefresh, setPublishedVersionAwaitingRefresh] = useState<
    number | null
  >(null);

  const isOwner = isTripOwner(trip?.ownerId, user?.uid);

  const loadAll = useCallback(async () => {
    if (!tripId) {
      setPhase("not_found");
      return;
    }
    setPhase("loading");
    setTrip(null);
    setCurrentTerms(null);
    setSuccessNotice(null);

    let fetchedTrip: Trip | null;
    try {
      fetchedTrip = await fetchTripById(tripId);
    } catch (e) {
      console.log("fetchTripById error:", e);
      setPhase("load_error");
      return;
    }
    if (!fetchedTrip) {
      setPhase("not_found");
      return;
    }
    setTrip(fetchedTrip);
    setPhase("loading_terms");

    try {
      const terms = await fetchCurrentTripTerms(tripId);
      setCurrentTerms(terms);
      setPhase("ready");
      // One-shot navigation hint, honored only when the freshly-loaded
      // Trip itself proves the caller is the current owner - never
      // trusted from the param alone (§ "client visibility is not
      // security authority").
      const ownerMatch = isTripOwner(fetchedTrip.ownerId, user?.uid);
      if (modeHint === "edit" && ownerMatch) {
        setViewMode("edit");
      }
    } catch (e) {
      console.log("fetchCurrentTripTerms error:", e);
      setPhase("terms_error");
    }
    // modeHint/user intentionally excluded from deps - this effect is
    // keyed only on tripId; the one-shot hint above is applied once per
    // load using whatever modeHint/user value was in scope at the time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const onStartEdit = useCallback(() => {
    setSuccessNotice(null);
    setViewMode("edit");
  }, []);

  const onCancelEdit = useCallback(() => {
    setViewMode("view");
  }, []);

  const onPublished = useCallback(
    async (result: { id: string; version: number }) => {
      if (!tripId) return;
      setViewMode("view");
      try {
        const refreshed = await fetchCurrentTripTerms(tripId);
        setCurrentTerms(refreshed);
        setPhase("ready");
        setPublishedVersionAwaitingRefresh(null);
        setSuccessNotice(`Trip Terms published — Version ${result.version} is now current.`);
      } catch (e) {
        console.log("fetchCurrentTripTerms (post-publish refresh) error:", e);
        // Publication itself already succeeded - never fall back to
        // "no terms exist" or lose that fact merely because this
        // follow-up read failed. currentTerms is deliberately left
        // untouched (never set to null here).
        setPublishedVersionAwaitingRefresh(result.version);
        setSuccessNotice(null);
        setPhase("publish_refresh_error");
      }
    },
    [tripId]
  );

  // Review fix: Retry from the publish_refresh_error phase ONLY re-reads
  // current terms - it must never call publishTripTerms again, since
  // the publication that led here already succeeded.
  const retryPostPublishRefresh = useCallback(async () => {
    if (!tripId) return;
    try {
      const refreshed = await fetchCurrentTripTerms(tripId);
      setCurrentTerms(refreshed);
      setPhase("ready");
      setSuccessNotice(
        publishedVersionAwaitingRefresh !== null
          ? `Trip Terms published — Version ${publishedVersionAwaitingRefresh} is now current.`
          : null
      );
      setPublishedVersionAwaitingRefresh(null);
    } catch (e) {
      console.log("fetchCurrentTripTerms (post-publish refresh retry) error:", e);
      // Stay in publish_refresh_error - still never republishes.
    }
  }, [tripId, publishedVersionAwaitingRefresh]);

  let body: React.ReactNode;
  switch (phase) {
    case "loading":
      body = <LoadingRow label="Loading trip…" theme={theme} colors={colors} />;
      break;
    case "not_found":
      body = (
        <FriendlyNotice
          icon="map-marker-off-outline"
          title="This trip could not be found."
          message="It may have been removed, or the link may be incorrect."
          colors={colors}
          theme={theme}
        />
      );
      break;
    case "load_error":
      body = (
        <FriendlyNotice
          icon="wifi-alert"
          title="Something went wrong loading this trip."
          message="Please check your connection and try again."
          colors={colors}
          theme={theme}
          action={
            <Button mode="outlined" onPress={loadAll}>
              Try again
            </Button>
          }
        />
      );
      break;
    case "loading_terms":
      body = <LoadingRow label="Loading Trip Terms…" theme={theme} colors={colors} />;
      break;
    case "publish_refresh_error":
      body = (
        <FriendlyNotice
          icon="cloud-alert"
          title="Trip Terms were published successfully, but we couldn't refresh the latest version."
          message="Please try again."
          colors={colors}
          theme={theme}
          action={
            <Button
              mode="outlined"
              onPress={retryPostPublishRefresh}
              accessibilityLabel="Try again"
            >
              Try again
            </Button>
          }
        />
      );
      break;
    case "terms_error":
      body = (
        <FriendlyNotice
          icon="file-document-alert-outline"
          title="We couldn't load the current Trip Terms safely."
          message="Please try again or contact support."
          colors={colors}
          theme={theme}
          action={
            <Button mode="outlined" onPress={loadAll}>
              Try again
            </Button>
          }
        />
      );
      break;
    case "ready":
      if (viewMode === "edit" && isOwner && trip) {
        body = (
          <TripTermsEditor
            tripId={tripId as string}
            initialTerms={currentTerms}
            isArchived={isTripArchived(trip)}
            onCancel={onCancelEdit}
            onPublished={onPublished}
          />
        );
      } else if (currentTerms === null) {
        body = (
          <FriendlyNotice
            icon="file-document-outline"
            title={
              isOwner
                ? "No terms have been published yet."
                : "This trip's owner hasn't published Trip Terms yet."
            }
            message={
              isOwner
                ? "Set the expectations members will review before joining."
                : "Check back later to review this trip's expectations and guidelines."
            }
            colors={colors}
            theme={theme}
            action={
              isOwner ? (
                <Button mode="contained" onPress={onStartEdit}>
                  Set Up Trip Terms
                </Button>
              ) : undefined
            }
          />
        );
      } else {
        body = (
          <>
            <Text style={[styles.versionHeader, { color: theme.colors.onBackground }]}>
              Version {currentTerms.version} · Published {formatPublishedDate(currentTerms)}
            </Text>
            {TERMS_FIELD_DEFS.map(({ key, label }) => (
              <View
                key={key}
                style={[
                  styles.fieldCard,
                  { backgroundColor: theme.colors.surface, borderColor: colors.border },
                ]}
              >
                <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{label}</Text>
                <Text style={[styles.fieldValue, { color: theme.colors.onSurface }]}>
                  {currentTerms[key]}
                </Text>
              </View>
            ))}
            {isOwner ? (
              <Button mode="outlined" onPress={onStartEdit} style={{ marginTop: spacing.sm }}>
                Edit / Publish New Version
              </Button>
            ) : null}
          </>
        );
      }
      break;
    default:
      body = null;
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.contentWrap}>
          <Text style={[styles.pageTitle, { color: theme.colors.onBackground }]}>
            Trip Terms
          </Text>

          {successNotice ? (
            <View
              style={[
                styles.noticeBanner,
                { backgroundColor: colors.surfaceTertiary, borderColor: colors.border },
              ]}
            >
              <MaterialCommunityIcons
                name="check-circle-outline"
                size={18}
                color={theme.colors.primary}
              />
              <Text style={[styles.noticeText, { color: theme.colors.onSurface }]}>
                {successNotice}
              </Text>
            </View>
          ) : null}

          {body}

          <View style={{ height: spacing.sm }} />
          <Button mode="text" onPress={() => router.back()}>
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
      <Text style={[styles.loadingText, { color: colors.textMuted }]}>{label}</Text>
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

  versionHeader: { ...typography.sectionTitle, fontSize: 16, marginBottom: spacing.sm },

  fieldCard: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  fieldLabel: { ...typography.meta, fontWeight: "700", marginBottom: spacing.xs },
  fieldValue: { ...typography.body },

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
});
