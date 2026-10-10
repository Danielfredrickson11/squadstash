export * from "./common";
export * from "./user";
export * from "./bucket";
export * from "./trip";
export * from "./membership";
export * from "./invitation";
// Checkpoint 5A: Trip-specific terms/invitation/acceptance architecture.
// Deliberately separate from (and not built on top of) the generic,
// unused Membership/Invitation types above - see
// docs/audits/TRIP_WALLET_MILESTONE_PREFLIGHT_2026-10-06.md's Checkpoint
// 5A report for why those were judged not to fit this model.
export * from "./tripTerms";
export * from "./tripInvitation";
export * from "./tripMembershipAcceptance";
// Checkpoint 5B.1: the trusted per-member Shared-Stash ownership cache
// schema - see docs/audits/TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_
// 2026-10-08.md §12. TripOwnershipModelState itself lives on ./trip
// (it's a field ON Trip, not its own collection).
export * from "./tripMemberOwnership";
export * from "./savingsTransaction";
export * from "./expense";
export * from "./settlement";
export * from "./activity";
