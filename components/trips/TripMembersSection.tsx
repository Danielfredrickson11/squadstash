// Trip Members card (Checkpoint 6.1) - current-membership DISPLAY only.
// No invitation UI, no pending-invitation visibility, no remove/leave
// action, no membership or financial write of any kind - those remain
// explicitly deferred to a later checkpoint (6.2+). Matches the existing
// Trip Detail card conventions exactly (same card/border/shadow/
// icon-bubble/title-subtitle treatment as the Balances card in
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { AvatarCircle, initialsFromName } from "../buckets/AvatarCircle";
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
  ownerId,
  memberIds,
}: {
  ownerId: string | null | undefined;
  memberIds: (string | null | undefined)[] | null | undefined;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();

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
            </View>
          ))}
        </View>
      )}

      {profileState.status === "error" ? (
        <Text style={[styles.errorNote, { color: colors.textMuted }]} onPress={retry}>
          Some member names couldn’t load. Tap to retry.
        </Text>
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
  errorNote: { fontSize: 12, fontWeight: "600", marginTop: spacing.sm },
});
