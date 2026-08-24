import type { CurrencyCode, PersistedTimestamp, ResourceType } from "./common";

export type ActivityType =
  | "contribution_recorded"
  | "withdrawal_recorded"
  | "member_joined"
  | "member_removed"
  | "invitation_accepted"
  | "expense_added"
  | "settlement_recorded"
  | "goal_changed";

// Fields common to every persisted activity/{activityId} document,
// regardless of `type`. Append-only feed, never a financial source of
// truth - the authoritative state always lives in SavingsTransaction/
// Expense/ExpenseSplit/Settlement (and, until Milestone 2B, bucket.balance
// / trip.saved). Client creation stays denied until trusted backend
// operations in Milestone 2C - this checkpoint defines types only.
type ActivityBase = {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  actorUid: string;
  createdAt: PersistedTimestamp;
};

// Every variant carries structured `metadata`, never a pre-rendered
// summary sentence - display text is derived by the UI from `type` +
// `metadata` at render time (frozen Milestone 2A design freeze).
export type ContributionRecordedActivity = ActivityBase & {
  type: "contribution_recorded";
  metadata: {
    transactionId: string;
    amountMinor: number;
    currency: CurrencyCode;
    memberUid: string;
  };
};

export type WithdrawalRecordedActivity = ActivityBase & {
  type: "withdrawal_recorded";
  metadata: {
    transactionId: string;
    amountMinor: number;
    currency: CurrencyCode;
    memberUid: string;
  };
};

export type MemberJoinedActivity = ActivityBase & {
  type: "member_joined";
  metadata: {
    uid: string;
  };
};

export type MemberRemovedActivity = ActivityBase & {
  type: "member_removed";
  metadata: {
    uid: string;
    removedBy: string;
  };
};

export type InvitationAcceptedActivity = ActivityBase & {
  type: "invitation_accepted";
  metadata: {
    invitationId: string;
    uid: string;
  };
};

export type ExpenseAddedActivity = ActivityBase & {
  type: "expense_added";
  metadata: {
    expenseId: string;
    amountMinor: number;
    currency: CurrencyCode;
  };
};

export type SettlementRecordedActivity = ActivityBase & {
  type: "settlement_recorded";
  metadata: {
    settlementId: string;
    amountMinor: number;
    currency: CurrencyCode;
    fromUid: string;
    toUid: string;
  };
};

// Covers a single goal-shaped field change (target, targetDate, saved,
// startDate, endDate, ...) on the resource's Bucket/Trip document -
// structured old/new values, never pre-rendered text.
export type GoalChangedActivity = ActivityBase & {
  type: "goal_changed";
  metadata: {
    field: string;
    oldValue: number | string | PersistedTimestamp | null;
    newValue: number | string | PersistedTimestamp | null;
  };
};

export type ActivityRecord =
  | ContributionRecordedActivity
  | WithdrawalRecordedActivity
  | MemberJoinedActivity
  | MemberRemovedActivity
  | InvitationAcceptedActivity
  | ExpenseAddedActivity
  | SettlementRecordedActivity
  | GoalChangedActivity;
