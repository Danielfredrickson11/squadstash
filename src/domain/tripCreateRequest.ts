// Pure, client-side Trip Create idempotency decision helper (Checkpoint
// 5B.5B). No Firestore, no UI, no framework imports - extracted from
// app/(tabs)/trips/create.tsx so the one subtle piece of logic this
// checkpoint depends on (deciding whether a retry's form facts are
// identical to the last prepared attempt) is directly unit-testable
// without rendering the screen.
//
// Why this matters: the deployed createTrip Cloud Function treats
// clientRequestId as the Trip's own document id and compares a replay's
// incoming facts against the document's IMMUTABLE creationRequest
// snapshot (functions/src/callables/createTrip.ts). imageUrl is part of
// that immutable snapshot, but it is derived client-side via a Wikipedia
// lookup that is not guaranteed to return the same result twice. If the
// screen blindly re-ran that lookup on every Save press, a retry after
// an AMBIGUOUS network failure (the first attempt may have actually
// succeeded server-side, with only the response lost) could present a
// different imageUrl than the original attempt - which the backend would
// then correctly reject as changed original facts, surfacing a confusing
// "already-exists" failure for what the user experiences as "I just
// pressed Save again." Comparing the canonical form facts (never
// imageUrl itself, which is derived FROM them) against the last prepared
// attempt is what tells the screen it is safe to reuse the exact prior
// imageUrl instead of re-running the lookup.
export type TripCreateFacts = {
  title: string;
  location: string | null;
  target: number;
  tripStartDate: string;
  tripEndDate: string | null;
};

export type PreparedTripCreateRequest = TripCreateFacts & {
  clientRequestId: string;
  imageUrl: string;
};

/**
 * True if `next`'s canonical form facts are identical to the facts of
 * the last prepared attempt (`prior`) - never compares imageUrl itself,
 * clientRequestId, or anything else; only the facts a user edit could
 * actually change. `prior === null` (no attempt has been prepared yet
 * for this mounted screen) always returns false.
 */
export function tripCreateFactsUnchanged(
  prior: PreparedTripCreateRequest | null,
  next: TripCreateFacts
): boolean {
  if (prior === null) {
    return false;
  }
  return (
    prior.title === next.title &&
    prior.location === next.location &&
    prior.target === next.target &&
    prior.tripStartDate === next.tripStartDate &&
    prior.tripEndDate === next.tripEndDate
  );
}
