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
// - Read-only except for Cancel (6.5): no Invite-Again/Accept/Decline
//   action of any kind - a terminal row (accepted/declined/expired/
//   cancelled) remains pure display. Only an effective-pending row ever
//   shows a Cancel trigger, gated by canCancelTripInvitation (which
//   itself reuses effectiveTripInvitationStatus - never a second,
//   independent expiry check).
//
// Checkpoint 6.5: this component owns WHICH invitation is selected for
// cancellation and the confirmation dialog's open/closed state only -
// CancelTripInvitationDialog owns the actual cancelTripInvitation call,
// its own in-flight/error state. On success or on a detected race
// (permission-denied), this component re-fetches via its own existing
// load() - it never synthesizes a fake local "cancelled" row; the
// server-refetched list remains the sole source of truth.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useFocusEffect } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { CancelTripInvitationDialog } from "./CancelTripInvitationDialog";
import { cardShadowFor, radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { useAuth } from "../../src/contexts/AuthContext";
import { fetchInvitationsForTrip } from "../../src/services/firebase/tripInvitations";
import {
  canCancelTripInvitation,
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
  ownerId,
  isOwner,
}: {
  tripId: string;
  ownerId: string | null | undefined;
  isOwner: boolean;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();
  const { user } = useAuth();

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedForCancel, setSelectedForCancel] = useState<TripInvitation | null>(null);
  const [stateChangedNotice, setStateChangedNotice] = useState<string | null>(null);

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

  const onCancelPress = useCallback((invitation: TripInvitation) => {
    setStateChangedNotice(null);
    setSelectedForCancel(invitation);
  }, []);

  const onCloseCancelDialog = useCallback(() => {
    setSelectedForCancel(null);
  }, []);

  const onCancelled = useCallback(() => {
    setSelectedForCancel(null);
    load();
  }, [load]);

  const onCancelStateChanged = useCallback(
    (message: string) => {
      setSelectedForCancel(null);
      setStateChangedNotice(message);
      load();
    },
    [load]
  );

  if (!isOwner) {
    return null;
  }
  if (state.status === "ready" && state.invitations.length === 0) {
    return null;
  }

  const now = new Date();
  const rows = state.status === "ready" ? buildSortedRows(state.invitations, now) : [];
  const requestingUid = user?.uid ?? "";

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

      {stateChangedNotice ? (
        <Text style={[styles.stateChangedNotice, { color: colors.textMuted }]}>
          {stateChangedNotice}
        </Text>
      ) : null}

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
            const cancellable = canCancelTripInvitation(
              invitation,
              ownerId ?? "",
              requestingUid,
              now
            );
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
                {cancellable ? (
                  <Pressable
                    onPress={() => onCancelPress(invitation)}
                    accessibilityRole="button"
                    accessibilityLabel={`Cancel invitation to ${invitation.inviteeEmail}`}
                    style={styles.cancelTrigger}
                  >
                    <Text style={[styles.cancelTriggerText, { color: colors.coral }]}>
                      Cancel Invitation
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      <CancelTripInvitationDialog
        visible={selectedForCancel !== null}
        tripId={tripId}
        invitation={selectedForCancel}
        onClose={onCloseCancelDialog}
        onCancelled={onCancelled}
        onStateChanged={onCancelStateChanged}
      />
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
  stateChangedNotice: { fontSize: 12, fontWeight: "600", marginBottom: spacing.xs },
  cancelTrigger: { alignSelf: "flex-start", marginTop: 2 },
  cancelTriggerText: { fontSize: 12, fontWeight: "700" },
});
