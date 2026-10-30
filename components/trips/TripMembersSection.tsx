// Trip Members card (Checkpoint 6.1, extended by 6.2) - current-
// membership display, plus (6.2) an owner-only Invite Member entry
// point. Still no pending-invitation visibility, no remove/leave
// action, no membership or financial write of any kind - those remain
// explicitly deferred to later checkpoints (6.4/6.5). Matches the
// existing Trip Detail card conventions exactly (same card/border/
// shadow/icon-bubble/title-subtitle treatment as the Balances card in
// app/(tabs)/trips/[tripId]/index.tsx) rather than introducing a new
// visual language.
//
// Data flow (approved preflight): Trip.ownerId/Trip.memberIds (via the
// existing deriveCurrentMemberUids) -> the existing, already-proven
// subscribeToPublicUsersByIdsChunked live query against the safe
// `publicUsers` collection only -> buildTripMemberViewModels (pure) ->
// this presentational list. Never reads the private `users/{uid}`
// collection, never reads tripMembershipAcceptances, never queries any
// financial/ownership collection merely to render membership.
//
// Checkpoint 6.2: this component owns only the Invite Member button's
// visibility and the dialog's open/closed state plus the post-send
// success confirmation copy - InviteTripMemberDialog.tsx owns every
// other piece (email field, Terms-prerequisite gate, submit lifecycle,
// error mapping, the actual createTripInvitation call). Sending an
// invitation never changes `members` above - membership (and this
// card's own member count) changes only after the invitee independently
// accepts through the existing, separate acceptance flow.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { AvatarCircle, initialsFromName } from "../buckets/AvatarCircle";
import { InviteTripMemberDialog } from "./InviteTripMemberDialog";
import { RemoveTripMemberDialog } from "./RemoveTripMemberDialog";
import { cardShadowFor, radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { deriveCurrentMemberUids } from "../../src/domain/expenseSubmission";
import { buildTripMemberViewModels, type TripMemberViewModel } from "../../src/domain/tripMembers";
import { subscribeToPublicUsersByIdsChunked } from "../../src/services/firebase/users";
import type { PublicProfile } from "../../src/types/domain";

type ProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; profiles: Map<string, PublicProfile> };

const EMPTY_PROFILES: Map<string, PublicProfile> = new Map();

export function TripMembersSection({
  tripId,
  ownerId,
  memberIds,
  isOwner,
  isArchived,
  onRemoved,
}: {
  tripId: string;
  ownerId: string | null | undefined;
  memberIds: (string | null | undefined)[] | null | undefined;
  isOwner: boolean;
  isArchived: boolean;
  // Checkpoint 6.7C: called with the removed member's uid once the
  // trusted removeTripMember call succeeds (or exact-replays as
  // success) - this component never mutates memberIds/the parent's Trip
  // state itself, since it only receives memberIds as a prop. The
  // parent decides how to reflect the removal (see
  // app/(tabs)/trips/[tripId]/index.tsx's own optimistic-patch
  // convention, matching saveDates).
  onRemoved?: (targetUid: string) => void;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();

  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [invitedEmailNotice, setInvitedEmailNotice] = useState<string | null>(null);

  const onInvitePress = useCallback(() => {
    setInvitedEmailNotice(null);
    setInviteDialogOpen(true);
  }, []);

  const onCloseInviteDialog = useCallback(() => {
    setInviteDialogOpen(false);
  }, []);

  const onInvitationSent = useCallback((normalizedEmail: string) => {
    setInviteDialogOpen(false);
    setInvitedEmailNotice(normalizedEmail);
  }, []);

  // Checkpoint 6.7C: per-row target state + a single shared dialog
  // instance at the bottom of this card - mirrors
  // TripInvitationsSection's own selectedForCancel/CancelTripInvitationDialog
  // wiring exactly.
  const [removeTarget, setRemoveTarget] = useState<TripMemberViewModel | null>(null);

  const onRemovePress = useCallback((member: TripMemberViewModel) => {
    setRemoveTarget(member);
  }, []);

  const onCloseRemoveDialog = useCallback(() => {
    setRemoveTarget(null);
  }, []);

  const onMemberRemoved = useCallback(
    (targetUid: string) => {
      setRemoveTarget(null);
      onRemoved?.(targetUid);
    },
    [onRemoved]
  );

  const currentMemberUids = useMemo(
    () => deriveCurrentMemberUids(ownerId, memberIds),
    [ownerId, memberIds]
  );
  // A stable primitive key (sorted, so member order never spuriously
  // retriggers the effect) - mirrors payerUidsKey/balanceUidsKey's own
  // existing convention in app/(tabs)/trips/[tripId]/index.tsx exactly.
  const uidsKey = useMemo(() => currentMemberUids.slice().sort().join("|"), [currentMemberUids]);

  const [profileState, setProfileState] = useState<ProfileState>({ status: "loading" });
  const profileUnsubRef = useRef<(() => void) | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

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
        console.error("Trip members profile subscription error:", err);
        setProfileState({ status: "error" });
      }
    );
    return () => {
      profileUnsubRef.current?.();
      profileUnsubRef.current = null;
    };
    // uidsKey is the real dependency (a stable primitive derived from
    // currentMemberUids' content) - currentMemberUids itself is included
    // so the effect body always closes over the exact array that
    // produced the key, mirroring the existing payerUidsKey/
    // balanceUidsKey pattern exactly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uidsKey, retryNonce]);

  // A failed subscription must never hide known Trip members - an empty
  // profile map makes every member fall back to a safe deterministic
  // label inside buildTripMemberViewModels, never an empty list.
  const resolvedProfiles = profileState.status === "ready" ? profileState.profiles : EMPTY_PROFILES;
  const members: TripMemberViewModel[] = useMemo(
    () => buildTripMemberViewModels(ownerId, memberIds, resolvedProfiles),
    [ownerId, memberIds, resolvedProfiles]
  );

  const isLoading = profileState.status === "loading";
  const subtitle = `${members.length} ${members.length === 1 ? "member" : "members"} on this trip`;

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
          <MaterialCommunityIcons name="account-multiple" size={18} color={colors.blue} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Members</Text>
          <Text style={[styles.cardSub, { color: colors.textMuted }]}>{subtitle}</Text>
        </View>
      </View>

      {isLoading ? (
        <Text style={[styles.loadingText, { color: colors.textMuted }]}>Loading members…</Text>
      ) : (
        <View style={styles.list}>
          {members.map((member) => (
            <View key={member.uid} style={styles.row}>
              <AvatarCircle
                index={0}
                label={initialsFromName(member.nameLabel)}
                photoURL={member.photoURL}
                size={32}
              />
              <Text numberOfLines={1} style={[styles.name, { color: colors.textPrimary }]}>
                {member.nameLabel}
              </Text>
              {member.isOwner ? (
                <View style={[styles.ownerBadge, { backgroundColor: colors.bluePale }]}>
                  <Text style={[styles.ownerBadgeText, { color: colors.blue }]}>Owner</Text>
                </View>
              ) : null}
              {/* Checkpoint 6.7C: owner-only, never on the owner's own
                  row - client hiding is convenience only, the trusted
                  removeTripMember callable remains the real,
                  backend-enforced owner/target gate regardless. */}
              {isOwner && !member.isOwner ? (
                <Pressable
                  onPress={() => onRemovePress(member)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${member.nameLabel} from trip`}
                  style={styles.removeTrigger}
                >
                  <Text style={[styles.removeTriggerText, { color: colors.coral }]}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      )}

      {profileState.status === "error" ? (
        <Text style={[styles.errorNote, { color: colors.textMuted }]} onPress={retry}>
          Some member names couldn’t load. Tap to retry.
        </Text>
      ) : null}

      {invitedEmailNotice ? (
        <Text style={[styles.inviteNotice, { color: colors.textSecondary }]}>
          Invitation sent to {invitedEmailNotice}
        </Text>
      ) : null}

      {/* Checkpoint 6.2 §6/§16: owner-only, and never rendered at all on
          an archived Trip - client hiding is convenience only, the
          trusted createTripInvitation callable remains the real,
          backend-enforced owner/archived gate regardless. */}
      {isOwner && !isArchived ? (
        <Pressable
          onPress={onInvitePress}
          accessibilityRole="button"
          accessibilityLabel="Invite Member"
          style={({ pressed }) => [
            styles.inviteBtn,
            { borderColor: colors.border },
            pressed && { opacity: 0.9 },
          ]}
        >
          <Text style={[styles.inviteBtnText, { color: colors.textPrimary }]}>Invite Member</Text>
        </Pressable>
      ) : null}

      <InviteTripMemberDialog
        visible={inviteDialogOpen}
        tripId={tripId}
        onClose={onCloseInviteDialog}
        onSent={onInvitationSent}
      />

      <RemoveTripMemberDialog
        visible={removeTarget !== null}
        tripId={tripId}
        targetUid={removeTarget?.uid ?? null}
        targetNameLabel={removeTarget?.nameLabel ?? ""}
        onClose={onCloseRemoveDialog}
        onRemoved={onMemberRemoved}
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
  cardSub: { fontSize: 12, fontWeight: "600", marginTop: 1 },
  loadingText: { fontSize: 13, fontWeight: "600" },
  list: { gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { flex: 1, fontSize: 14, fontWeight: "600" },
  ownerBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  ownerBadgeText: { fontSize: 11, fontWeight: "800" },
  removeTrigger: { paddingHorizontal: spacing.xs, paddingVertical: 2 },
  removeTriggerText: { fontSize: 12, fontWeight: "700" },
  errorNote: { fontSize: 12, fontWeight: "600", marginTop: spacing.sm },
  inviteNotice: { fontSize: 12, fontWeight: "600", marginTop: spacing.sm },
  inviteBtn: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  inviteBtnText: { fontSize: 13, fontWeight: "700" },
});
