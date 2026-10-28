// Trip Invitations card (Checkpoint 6.4) - owner-only, READ-ONLY
// outgoing-invitation status history. A separate sibling to
// TripMembersSection/TripTermsSection, never folded into either - this
// card's whole purpose is historical invitation metadata, which is a
// different concept from current Trip membership (that remains
// Trip.memberIds's own sole authority, surfaced only by
// TripMembersSection) and different again from Trip Terms content.
//
// Data flow (approved preflight): fetchInvitationsForTrip(tripId)
// (existing, Checkpoint 5C.3C service, reused as-is - no service change)
// -> effectiveTripInvitationStatus (existing domain helper, extended
// this checkpoint) -> a sorted, presentational list. No private
// users/{uid} read, no public-profile lookup - the invitee's own email,
// already present on the invitation record, is the only identifier
// shown.
//
// FROZEN INVARIANTS (6.4 preflight):
// - Owner-only: a non-owner renders nothing and this component never
//   even calls fetchInvitationsForTrip for them (checked before the
//   focus-triggered fetch fires, not just before rendering).
// - Empty state (owner, zero invitations ever sent): renders nothing -
//   TripMembersSection's own Invite Member button is already the entry
//   point; an empty card here would be pure visual noise.
// - Read-only: no Cancel/Invite-Again/Accept/Decline action of any
//   kind - every row is pure display. Cancellation (6.5) will reuse the
//   already-existing cancelTripInvitation service function, but this
//   component never calls it.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useFocusEffect } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { cardShadowFor, radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { fetchInvitationsForTrip } from "../../src/services/firebase/tripInvitations";
import {
  effectiveTripInvitationStatus,
  type TripInvitationEffectiveStatus,
} from "../../src/domain/tripInvitation";
import type { PersistedTimestamp, TripInvitation } from "../../src/types/domain";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; invitations: TripInvitation[] };

// A small, component-local date formatter - deliberately NOT imported
// from app/(tabs)/trips/index.tsx's own formatInvitationExpiry (that
// would be the wrong dependency direction, a route importing into a
// component's territory) and deliberately NOT a new shared app-wide date
// utility for this one checkpoint - matches this codebase's established
// "small local formatter over premature shared abstraction" convention.
function formatInvitationDate(value: PersistedTimestamp | null | undefined): string {
  if (!value) return "";
  const date = value.toDate();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Pending sorts first; every terminal/history status shares the same
// second-tier rank so they interleave purely by recency within that
// tier - structured so a later checkpoint could promote this into two
// visible sections without changing the underlying data shape.
const STATUS_RANK: Record<TripInvitationEffectiveStatus, number> = {
  pending: 0,
  accepted: 1,
  declined: 1,
  expired: 1,
  cancelled: 1,
};

function statusLabel(
  invitation: TripInvitation,
  effectiveStatus: TripInvitationEffectiveStatus
): string {
  switch (effectiveStatus) {
    case "pending":
      return `Pending · Expires ${formatInvitationDate(invitation.expiresAt)}`;
    case "accepted":
      return `Accepted ${formatInvitationDate(invitation.respondedAt)}`;
    case "declined":
      return `Declined ${formatInvitationDate(invitation.respondedAt)}`;
    case "cancelled":
      return `Cancelled ${formatInvitationDate(invitation.respondedAt)}`;
    case "expired":
      return `Expired ${formatInvitationDate(invitation.expiresAt)}`;
  }
}

type Row = { invitation: TripInvitation; effectiveStatus: TripInvitationEffectiveStatus };

function buildSortedRows(invitations: TripInvitation[], now: Date): Row[] {
  const rows: Row[] = invitations.map((invitation) => ({
    invitation,
    effectiveStatus: effectiveTripInvitationStatus(invitation, now),
  }));
  return rows.slice().sort((a, b) => {
    const rankDiff = STATUS_RANK[a.effectiveStatus] - STATUS_RANK[b.effectiveStatus];
    if (rankDiff !== 0) return rankDiff;
    return (
      b.invitation.createdAt.toDate().getTime() - a.invitation.createdAt.toDate().getTime()
    );
  });
}

export function TripInvitationsSection({
  tripId,
  isOwner,
}: {
  tripId: string;
  isOwner: boolean;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();

  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Request-generation guard (same pattern established during the 6.2
  // InviteTripMemberDialog review fix): every load() call bumps this
  // ref and captures its own requestId - only the settle whose
  // requestId still matches the ref's CURRENT value may call setState,
  // so a stale, superseded fetch (e.g. two rapid refocuses) can never
  // overwrite a newer one's result, and an unmount bump prevents a
  // still-pending fetch from ever calling setState afterward.
  const requestRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    setState({ status: "loading" });
    fetchInvitationsForTrip(tripId)
      .then((invitations) => {
        if (requestId !== requestRef.current) return;
        setState({ status: "ready", invitations });
      })
      .catch((e) => {
        console.error("Trip invitations fetch error:", e);
        if (requestId !== requestRef.current) return;
        setState({ status: "error" });
      });
  }, [tripId]);

  // Owner-only, checked INSIDE the focus callback - a non-owner never
  // triggers fetchInvitationsForTrip at all (not merely "renders
  // nothing after fetching"). Fires on initial focus and every later
  // re-focus (e.g. returning from the Invitations... there is no
  // dedicated invitations route in 6.4, but returning from any other
  // screen still re-triggers this the same way TripTermsSection/
  // TripMembersSection already rely on).
  useFocusEffect(
    useCallback(() => {
      if (!isOwner) return;
      load();
    }, [isOwner, load])
  );

  useEffect(() => {
    return () => {
      requestRef.current += 1;
    };
  }, []);

  const retry = useCallback(() => {
    load();
  }, [load]);

  if (!isOwner) {
    return null;
  }
  if (state.status === "ready" && state.invitations.length === 0) {
    return null;
  }

  const rows = state.status === "ready" ? buildSortedRows(state.invitations, new Date()) : [];

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
          <MaterialCommunityIcons name="email-outline" size={18} color={colors.blue} />
        </View>
        <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Invitations</Text>
      </View>

      {state.status === "loading" ? (
        <Text style={[styles.bodyText, { color: colors.textMuted }]}>
          Loading invitations…
        </Text>
      ) : state.status === "error" ? (
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel="Retry loading invitations"
        >
          <Text style={[styles.bodyText, { color: colors.textMuted }]}>
            We couldn&apos;t load invitations. Tap to retry.
          </Text>
        </Pressable>
      ) : (
        <View style={styles.list}>
          {rows.map(({ invitation, effectiveStatus }) => {
            const isPendingRow = effectiveStatus === "pending";
            return (
              <View key={invitation.id} style={styles.row}>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.email,
                    { color: isPendingRow ? colors.textPrimary : colors.textMuted },
                  ]}
                >
                  {invitation.inviteeEmail}
                </Text>
                <Text
                  style={[
                    styles.statusText,
                    { color: isPendingRow ? colors.textSecondary : colors.textMuted },
                  ]}
                >
                  {statusLabel(invitation, effectiveStatus)}
                </Text>
              </View>
            );
          })}
        </View>
      )}
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
  bodyText: { fontSize: 13, fontWeight: "600" },
  list: { gap: spacing.sm },
  row: { gap: 2 },
  email: { fontSize: 14, fontWeight: "600" },
  statusText: { fontSize: 12, fontWeight: "600" },
});
