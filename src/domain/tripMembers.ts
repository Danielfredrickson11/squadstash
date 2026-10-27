// Pure, presentation-agnostic Trip Members view-model logic (Checkpoint
// 6.1). No Firestore, no React, no navigation, and - deliberately -
// no dependency on any UI component module: a pure domain module must
// never import from components/ (the wrong dependency direction).
// Avatar-initials computation is the UI layer's own job (see
// TripMembersSection.tsx, which already imports initialsFromName
// alongside AvatarCircle) - this module hands it only the final,
// already-resolved-or-fallback `nameLabel` to compute initials from.
//
// Mirrors this project's existing pure-builder convention (e.g.
// savingsTransactionAttribution.ts's buildExpenseDescriptionIndex) and
// the already-proven inline resolvePayer/resolveBalanceMember fallback
// logic in app/(tabs)/trips/[tripId]/index.tsx, extracted here so it is
// directly unit-testable and reusable by the new TripMembersSection
// component.
//
// Current-membership authority is Trip.ownerId/Trip.memberIds ONLY, via
// the existing, already-proven deriveCurrentMemberUids (expenseSubmission.ts)
// - never trip.memberIds read directly, and never
// tripMembershipAcceptances, which remains proof of HOW a member joined
// a Trip, never a source for WHO currently is one (frozen 5C
// architecture - see docs/audits/
// TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md §7).
import { deriveCurrentMemberUids } from "./expenseSubmission";
import type { PublicProfile } from "../types/domain";

export type TripMemberViewModel = {
  uid: string;
  nameLabel: string;
  photoURL?: string;
  isOwner: boolean;
};

const FALLBACK_LABEL = "Trip member";

// Deterministic, stable-order fallback label for every uid with no
// resolved display name - mirrors the existing missingPayerLabels/
// fallbackBalanceLabels convention exactly: exactly one simultaneously-
// unresolved member reads as "Trip member"; more than one reads as
// "Trip member 1"/"Trip member 2" in the order `uids` was given, never
// re-sorted here (the caller already controls the canonical member
// order via deriveCurrentMemberUids).
function fallbackLabelsFor(uids: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  uids.forEach((uid, i) => {
    labels.set(uid, uids.length > 1 ? `${FALLBACK_LABEL} ${i + 1}` : FALLBACK_LABEL);
  });
  return labels;
}

/**
 * Builds the Trip Members section's complete view-model list. `profiles`
 * should be an empty map whenever the caller's own profile subscription
 * is not in a trustworthy "ready" state (loading or error) - every
 * current member then safely falls back to a deterministic label rather
 * than this function ever needing a separate loading/error mode of its
 * own.
 * @param {string | null | undefined} ownerId Trip.ownerId.
 * @param {(string | null | undefined)[] | null | undefined} memberIds Trip.memberIds.
 * @param {ReadonlyMap<string, PublicProfile>} profiles Resolved public
 *   profiles, keyed by uid. Never the private users/{uid} collection.
 * @return {TripMemberViewModel[]} One entry per canonical current
 *   member, in deriveCurrentMemberUids' own order, never duplicated.
 */
export function buildTripMemberViewModels(
  ownerId: string | null | undefined,
  memberIds: (string | null | undefined)[] | null | undefined,
  profiles: ReadonlyMap<string, PublicProfile>
): TripMemberViewModel[] {
  const currentMemberUids = deriveCurrentMemberUids(ownerId, memberIds);

  const missingUids = currentMemberUids.filter(
    (uid) => !profiles.get(uid)?.displayName?.trim()
  );
  const fallbackLabels = fallbackLabelsFor(missingUids);

  return currentMemberUids.map((uid) => {
    const profile = profiles.get(uid);
    const name = profile?.displayName?.trim();

    if (name) {
      return {
        uid,
        nameLabel: name,
        photoURL: profile?.photoURL?.trim() || undefined,
        isOwner: uid === ownerId,
      };
    }

    const fallback = fallbackLabels.get(uid) ?? FALLBACK_LABEL;
    return {
      uid,
      nameLabel: fallback,
      photoURL: undefined,
      isOwner: uid === ownerId,
    };
  });
}
