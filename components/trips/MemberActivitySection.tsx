// Member Activity card (Checkpoint 6.8C) - the human-readable
// membership-activity history for one Trip. Matches the existing Trip
// Detail card conventions exactly (same card/border/shadow/icon-bubble/
// title treatment as TripMembersSection's own card), rather than
// introducing a new visual language.
//
// Data flow (approved 6.8 architecture): the trusted, already-strict
// fetchTripMembershipActivityPage (src/services/firebase/
// tripMembershipActivity.ts) is the SOLE data source - this component
// never issues a new Firestore query path of its own. Firestore Rules
// (6.8B3) remain the sole authorization authority: this component makes
// no access-control decision whatsoever, never derives hidden history
// locally, and never attempts to show activity the Rules would deny.
//
// Name resolution reuses the existing, already-proven
// subscribeToPublicUsersByIdsChunked (src/services/firebase/users.ts) -
// no second profile-caching architecture. Unlike TripMembersSection
// (whose small, static member list blocks rendering behind the first
// profile-subscription emission), this feed's own loading/empty/error
// state is governed SOLELY by the activity query - profile names
// resolve asynchronously and simply update in place, falling back to
// "Trip member" (buildTripMembershipActivityRowViewModel's own
// fallback) until resolved. This is deliberate: an activity feed can be
// long and paginated, and blocking the whole feed behind profile
// resolution would make "Load more" feel slower and would conflict with
// keeping already-resolved names visible while new pages' uids resolve.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { AvatarCircle, initialsFromName } from "../buckets/AvatarCircle";
import { cardShadowFor, radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { fetchTripMembershipActivityPage } from "../../src/services/firebase/tripMembershipActivity";
import type { TripMembershipActivityCursor } from "../../src/services/firebase/tripMembershipActivity";
import { subscribeToPublicUsersByIdsChunked } from "../../src/services/firebase/users";
import {
  buildTripMembershipActivityRowViewModels,
  collectTripMembershipActivityProfileUids,
} from "../../src/domain/tripMembershipActivityRow";
import type { TripMembershipActivityRowViewModel } from "../../src/domain/tripMembershipActivityRow";
import type { PublicProfile, TripMembershipActivityEvent } from "../../src/types/domain";

type PageState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      events: TripMembershipActivityEvent[];
      cursor: TripMembershipActivityCursor | null;
      hasMore: boolean;
    };

type LoadMoreStatus = "idle" | "loading" | "error";

const EMPTY_PROFILES: Map<string, PublicProfile> = new Map();

export function MemberActivitySection({
  tripId,
  refreshToken,
}: {
  tripId: string;
  // Checkpoint 6.8 review fix: bumped by the parent (Trip Detail)
  // whenever a sibling same-screen mutation (a successful invitation
  // creation or cancellation) means this feed's first page is now
  // stale. Folded into the SAME initial-load effect/request-generation
  // guard this component already uses for tripId changes/manual Retry -
  // never a second, independent fetch path. A refresh always replaces
  // the first page (matching this effect's existing semantics for a
  // tripId change or Retry) rather than attempting to merge/patch the
  // already-loaded feed.
  refreshToken?: number;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();

  const [pageState, setPageState] = useState<PageState>({ status: "loading" });
  const [loadMoreStatus, setLoadMoreStatus] = useState<LoadMoreStatus>("idle");
  const [retryNonce, setRetryNonce] = useState(0);

  // Checkpoint 6.8C §10: a request-generation counter, the imperative-
  // callback equivalent of this codebase's established `let cancelled =
  // false` effect-cleanup idiom (see app/(tabs)/home.tsx). Needed here
  // because loadMore is an event-triggered async callback, not itself
  // scoped by a single effect's own cleanup - a stale response (from a
  // request started before tripId changed, or after unmount) must never
  // overwrite state for the CURRENT tripId.
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  // A synchronous mutex, not React state (mirrors the invitation review
  // screen's own established submitInFlightRef convention exactly) -
  // two rapid Load More presses can both fire before React has
  // re-rendered with loadMoreStatus: "loading", so the loadMoreStatus
  // state check alone cannot reliably prevent a second simultaneous
  // request; this ref is checked/set synchronously, before anything
  // else, at the very start of loadMore.
  const loadMoreInFlightRef = useRef(false);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    setPageState({ status: "loading" });
    setLoadMoreStatus("idle");
    loadMoreInFlightRef.current = false;
    fetchTripMembershipActivityPage(tripId)
      .then((page) => {
        if (!mountedRef.current || requestGenerationRef.current !== generation) return;
        setPageState({
          status: "ready",
          events: page.events,
          cursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      })
      .catch((err) => {
        if (!mountedRef.current || requestGenerationRef.current !== generation) return;
        console.error("MemberActivitySection: initial load failed:", err);
        setPageState({ status: "error" });
      });
  }, [tripId, retryNonce, refreshToken]);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  const loadMore = useCallback(() => {
    if (pageState.status !== "ready" || !pageState.hasMore) return;
    // Prevents a simultaneous duplicate load-more request (6.8C §9) -
    // checked/set synchronously, before anything else (see
    // loadMoreInFlightRef's own comment above for why this must be a
    // ref, not the loadMoreStatus state).
    if (loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;

    const generation = requestGenerationRef.current;
    const cursor = pageState.cursor;
    setLoadMoreStatus("loading");
    fetchTripMembershipActivityPage(tripId, { cursor })
      .then((page) => {
        loadMoreInFlightRef.current = false;
        if (!mountedRef.current || requestGenerationRef.current !== generation) return;
        setPageState((prev) => {
          if (prev.status !== "ready") return prev;
          // De-dupe defensively by id, even though a correct cursor
          // should never return an already-seen event.
          const existingIds = new Set(prev.events.map((e) => e.id));
          const newEvents = page.events.filter((e) => !existingIds.has(e.id));
          return {
            status: "ready",
            events: [...prev.events, ...newEvents],
            cursor: page.nextCursor,
            hasMore: page.hasMore,
          };
        });
        setLoadMoreStatus("idle");
      })
      .catch((err) => {
        loadMoreInFlightRef.current = false;
        if (!mountedRef.current || requestGenerationRef.current !== generation) return;
        console.error("MemberActivitySection: load more failed:", err);
        // The first page's already-loaded events are untouched - only
        // loadMoreStatus changes, never pageState, on a pagination
        // failure.
        setLoadMoreStatus("error");
      });
  }, [tripId, pageState]);

  const events = useMemo(
    () => (pageState.status === "ready" ? pageState.events : []),
    [pageState]
  );

  const uidsToResolve = useMemo(
    () => collectTripMembershipActivityProfileUids(events),
    [events]
  );
  const uidsKey = useMemo(() => uidsToResolve.slice().sort().join("|"), [uidsToResolve]);

  // A cumulative map, never wholesale-replaced or cleared on re-
  // subscription - this is what lets already-resolved names from page
  // one keep working while page two's newly-introduced uids resolve
  // (6.8C §9), and what keeps a profile-subscription failure from ever
  // corrupting the underlying activity list (a failure only means
  // newly-introduced uids fall back to the same "Trip member" label
  // any other unresolved uid already uses - never an error state for
  // the list itself).
  const [profiles, setProfiles] = useState<Map<string, PublicProfile>>(EMPTY_PROFILES);
  const [profilesErrored, setProfilesErrored] = useState(false);
  const profileUnsubRef = useRef<(() => void) | null>(null);
  const [profileRetryNonce, setProfileRetryNonce] = useState(0);

  useEffect(() => {
    profileUnsubRef.current?.();
    profileUnsubRef.current = null;
    // 6.8D lifecycle fix: reset UNCONDITIONALLY, before the early
    // return below - otherwise a stale "Some names couldn't load" note
    // from a PREVIOUS Trip (or a previous, now-superseded uid set) could
    // misleadingly persist once the current uid set becomes empty (e.g.
    // a new Trip's first page has zero activity, or none of its events
    // have resolvable uids), since the early-return path never reached
    // this reset before.
    setProfilesErrored(false);
    if (uidsToResolve.length === 0) {
      return undefined;
    }
    profileUnsubRef.current = subscribeToPublicUsersByIdsChunked(
      uidsToResolve,
      (resolved) => {
        setProfiles((prev) => {
          const next = new Map(prev);
          for (const p of resolved) {
            next.set(p.uid, p);
          }
          return next;
        });
      },
      (err) => {
        console.error("MemberActivitySection: profile subscription error:", err);
        setProfilesErrored(true);
      }
    );
    return () => {
      profileUnsubRef.current?.();
      profileUnsubRef.current = null;
    };
    // uidsKey is the real dependency (a stable primitive derived from
    // uidsToResolve's content) - mirrors TripMembersSection's own
    // identical uidsKey/currentMemberUids convention exactly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uidsKey, profileRetryNonce]);

  const retryProfiles = useCallback(() => setProfileRetryNonce((n) => n + 1), []);

  const rows: TripMembershipActivityRowViewModel[] = useMemo(
    () => buildTripMembershipActivityRowViewModels(events, profiles),
    [events, profiles]
  );

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
          <MaterialCommunityIcons name="history" size={18} color={colors.blue} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Member Activity</Text>
        </View>
      </View>

      {pageState.status === "loading" ? (
        <Text style={[styles.loadingText, { color: colors.textMuted }]}>Loading activity…</Text>
      ) : pageState.status === "error" ? (
        <View>
          <Text style={[styles.errorText, { color: colors.textMuted }]}>
            Member activity couldn’t be loaded.
          </Text>
          <Pressable
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel="Retry loading member activity"
            style={styles.retryBtn}
          >
            <Text style={[styles.retryBtnText, { color: colors.blue }]}>Retry</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <Text style={[styles.emptyText, { color: colors.textMuted }]}>
          No membership activity yet.
        </Text>
      ) : (
        <View style={styles.list}>
          {rows.map((row) => (
            <View key={row.id} style={styles.row}>
              {row.kind === "system" ? (
                <View
                  style={[styles.systemIconBubble, { backgroundColor: colors.surfaceTertiary }]}
                  accessibilityLabel="System"
                >
                  <MaterialCommunityIcons
                    name="shield-check-outline"
                    size={16}
                    color={colors.textMuted}
                  />
                </View>
              ) : (
                <AvatarCircle
                  index={0}
                  label={initialsFromName(row.actorNameLabel)}
                  photoURL={row.actorPhotoURL}
                  size={28}
                />
              )}
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    row.kind === "system" ? styles.systemCopy : styles.copy,
                    { color: row.kind === "system" ? colors.textMuted : colors.textPrimary },
                  ]}
                >
                  {row.copy}
                </Text>
                <Text style={[styles.timestamp, { color: colors.textMuted }]}>
                  {row.timestampLabel}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {profilesErrored ? (
        <Text style={[styles.profilesErrorNote, { color: colors.textMuted }]} onPress={retryProfiles}>
          Some names couldn’t load. Tap to retry.
        </Text>
      ) : null}

      {pageState.status === "ready" && pageState.hasMore ? (
        loadMoreStatus === "error" ? (
          <View style={styles.loadMoreErrorRow}>
            <Text style={[styles.errorText, { color: colors.textMuted }]}>
              Couldn’t load more activity.
            </Text>
            <Pressable
              onPress={loadMore}
              accessibilityRole="button"
              accessibilityLabel="Retry loading more activity"
              style={styles.retryBtn}
            >
              <Text style={[styles.retryBtnText, { color: colors.blue }]}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={loadMore}
            disabled={loadMoreStatus === "loading"}
            accessibilityRole="button"
            accessibilityLabel="Load more activity"
            style={({ pressed }) => [
              styles.loadMoreBtn,
              { borderColor: colors.border },
              pressed && { opacity: 0.9 },
              loadMoreStatus === "loading" && { opacity: 0.6 },
            ]}
          >
            {loadMoreStatus === "loading" ? (
              <ActivityIndicator size="small" color={colors.blue} />
            ) : (
              <Text style={[styles.loadMoreBtnText, { color: colors.textPrimary }]}>
                Load more
              </Text>
            )}
          </Pressable>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
  },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm },
  iconBubble: {
    width: 34,
    height: 34,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { ...typography.cardTitle, fontSize: 15 },
  loadingText: { fontSize: 13, fontWeight: "600" },
  emptyText: { fontSize: 13, fontWeight: "600" },
  errorText: { fontSize: 13, fontWeight: "600" },
  list: { gap: spacing.md },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  systemIconBubble: {
    width: 28,
    height: 28,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { fontSize: 14, fontWeight: "600" },
  systemCopy: { fontSize: 13, fontWeight: "600", fontStyle: "italic" },
  timestamp: { fontSize: 12, fontWeight: "500", marginTop: 2 },
  profilesErrorNote: { fontSize: 12, fontWeight: "600", marginTop: spacing.sm },
  retryBtn: { marginTop: spacing.xs, alignSelf: "flex-start" },
  retryBtnText: { fontSize: 13, fontWeight: "700" },
  loadMoreErrorRow: { marginTop: spacing.sm },
  loadMoreBtn: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
    minWidth: 96,
    alignItems: "center",
  },
  loadMoreBtnText: { fontSize: 13, fontWeight: "700" },
});
