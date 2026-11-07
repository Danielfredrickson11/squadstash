// Pure, presentation-agnostic Member Activity row view-model logic
// (Checkpoint 6.8C). No Firestore, no React, no navigation, and -
// deliberately - no dependency on any UI component module, mirroring
// tripMembers.ts's own identical discipline exactly ("a pure domain
// module must never import from components/"). Avatar-INITIALS
// computation remains the UI layer's own job (MemberActivitySection.tsx
// calls initialsFromName on the nameLabel this module returns) - this
// module hands back only the resolved-or-fallback name, never initials.
//
// This module makes NO authorization decision of any kind - Firestore
// Rules already guarantee every event this module ever receives belongs
// to a Trip the current viewer is authorized to see (6.8B3). It only
// turns already-authorized data into display copy.
import { formatTransactionTimestamp } from "../../utils/format";
import type { PublicProfile, TripMembershipActivityEvent } from "../types/domain";

// Mirrors tripMembers.ts's own FALLBACK_LABEL exactly, for UI-copy
// consistency with the adjacent Trip Members card. Deliberately FLAT
// (never numbered "Trip member 1"/"Trip member 2" the way
// tripMembers.ts disambiguates a simultaneously-rendered, bounded
// roster) - an activity feed's actor/target are specific sentence
// ROLES, not an unordered list a reader compares side by side, and a
// stable per-row label matters more here than disambiguating two
// different unresolved people in the rare case both appear unresolved
// in the same row (an accepted, documented tradeoff - see this
// checkpoint's own "do not invent complicated grammar unless
// necessary" instruction).
const FALLBACK_LABEL = "Trip member";

export const HISTORY_TRACKING_STARTED_COPY =
  "Complete membership activity is tracked from this point forward.";

export type TripMembershipActivityRowViewModel =
  | {
      id: string;
      kind: "event";
      copy: string;
      timestampLabel: string;
      actorUid: string;
      actorNameLabel: string;
      actorPhotoURL?: string;
    }
  | {
      id: string;
      kind: "system";
      copy: string;
      timestampLabel: string;
    };

function nameFor(uid: string, profiles: ReadonlyMap<string, PublicProfile>): string {
  const name = profiles.get(uid)?.displayName?.trim();
  return name || FALLBACK_LABEL;
}

function photoFor(
  uid: string,
  profiles: ReadonlyMap<string, PublicProfile>
): string | undefined {
  return profiles.get(uid)?.photoURL?.trim() || undefined;
}

/**
 * Builds the exact human-readable copy for one real (non-system) event.
 * `actorLabel`/`targetLabel` are passed in already-resolved so this
 * stays a pure string-template function with no profile-lookup
 * concerns of its own.
 * @param {TripMembershipActivityEvent} event A real (non-system) event.
 * @param {string} actorLabel The resolved-or-fallback actor name.
 * @param {string} targetLabel The resolved-or-fallback target name.
 * @return {string} The rendered sentence.
 */
function copyForRealEvent(
  event: TripMembershipActivityEvent,
  actorLabel: string,
  targetLabel: string
): string {
  switch (event.type) {
    case "trip_created":
      return `${actorLabel} created the Trip`;
    case "invitation_created":
      return `${actorLabel} invited ${targetLabel}`;
    case "invitation_accepted":
      // Presentation semantics are JOINED, not technical acceptance -
      // actorUid === targetUid for this event type, so either label
      // would do; actorLabel is used for consistency with every other
      // actor-first template below.
      return `${actorLabel} joined the Trip`;
    case "invitation_declined":
      // actorUid === targetUid (the declining invitee) for this type.
      return `${actorLabel} declined the invitation`;
    case "invitation_cancelled":
      return `${actorLabel} cancelled ${targetLabel}'s invitation`;
    case "member_left":
      // actorUid === targetUid (the departing member) for this type.
      return `${actorLabel} left the Trip`;
    case "member_removed":
      return `${actorLabel} removed ${targetLabel} from the Trip`;
    default:
      // Structurally unreachable given TripMembershipActivityEvent's
      // own closed union (and the client parser's own exhaustive type
      // validation before any event reaches this module) - fails
      // loudly rather than silently rendering blank/undefined copy if
      // the union is ever extended without updating this function.
      throw new Error(
        `buildTripMembershipActivityRowViewModel: unhandled event type "${(event as {type: string}).type}".`
      );
  }
}

/**
 * Builds one row view-model from a single hydrated activity event.
 * @param {TripMembershipActivityEvent} event The hydrated event.
 * @param {ReadonlyMap<string, PublicProfile>} profiles Resolved public
 *   profiles, keyed by uid - an uid absent from this map (not yet
 *   resolved, or permanently unresolvable) safely falls back to
 *   FALLBACK_LABEL, never a raw uid string.
 * @return {TripMembershipActivityRowViewModel} The row view-model.
 */
export function buildTripMembershipActivityRowViewModel(
  event: TripMembershipActivityEvent,
  profiles: ReadonlyMap<string, PublicProfile>
): TripMembershipActivityRowViewModel {
  const timestampLabel = formatTransactionTimestamp(event.createdAt);

  if (event.type === "history_tracking_started") {
    return {
      id: event.id,
      kind: "system",
      copy: HISTORY_TRACKING_STARTED_COPY,
      timestampLabel,
    };
  }

  const actorLabel = nameFor(event.actorUid, profiles);
  const targetLabel = nameFor(event.targetUid, profiles);

  return {
    id: event.id,
    kind: "event",
    copy: copyForRealEvent(event, actorLabel, targetLabel),
    timestampLabel,
    actorUid: event.actorUid,
    actorNameLabel: actorLabel,
    actorPhotoURL: photoFor(event.actorUid, profiles),
  };
}

/**
 * Builds the complete, ordered list of row view-models for a loaded
 * page of events - never re-sorts; callers (the paginated query) are
 * the sole source of ordering.
 * @param {readonly TripMembershipActivityEvent[]} events The loaded
 *   events, in display order.
 * @param {ReadonlyMap<string, PublicProfile>} profiles Resolved public
 *   profiles, keyed by uid.
 * @return {TripMembershipActivityRowViewModel[]} One row per event.
 */
export function buildTripMembershipActivityRowViewModels(
  events: readonly TripMembershipActivityEvent[],
  profiles: ReadonlyMap<string, PublicProfile>
): TripMembershipActivityRowViewModel[] {
  return events.map((event) => buildTripMembershipActivityRowViewModel(event, profiles));
}

/**
 * Collects the deduplicated, non-null set of uids across every loaded
 * event's actorUid/targetUid - the exact input
 * subscribeToPublicUsersByIdsChunked needs. `history_tracking_started`
 * events contribute nothing (both fields are null).
 * @param {readonly TripMembershipActivityEvent[]} events The loaded
 *   events.
 * @return {string[]} The deduplicated uid list, in first-seen order.
 */
export function collectTripMembershipActivityProfileUids(
  events: readonly TripMembershipActivityEvent[]
): string[] {
  const uids = new Set<string>();
  for (const event of events) {
    if (event.actorUid) {
      uids.add(event.actorUid);
    }
    if (event.targetUid) {
      uids.add(event.targetUid);
    }
  }
  return Array.from(uids);
}
