// Add Expense form presentation (Checkpoint 4D.3, extended by 4D.4 for
// percentage/custom split strategies), per the frozen docs/audits/
// TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §11-§18/§21. Presentation/
// member-controls/preview ONLY - no Firebase reads/writes, no
// navigation, no idempotency refs. The route/controller
// (expenses/create.tsx) owns Trip loading, the profile subscription, the
// idempotency controller, all strategy-specific parsing/validation, the
// trusted recordTripExpense call, and navigation; this component
// receives everything it needs (including already-validated preview
// data) via props and calls back up through onChange*/onSubmit/onCancel.
import React, { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { AvatarCircle } from "../buckets/AvatarCircle";
import { radii, spacing, type SemanticColors } from "../../src/theme/tokens";
import { formatCurrency } from "../../utils/format";
import { computeCustomSplit, computeEqualSplit, computePercentageSplit } from "../../src/domain/tripExpenseSplits";
import { MAX_EXPENSE_PARTICIPANTS } from "../../src/domain/expenseSubmission";
import { PercentageSplitInputs } from "./PercentageSplitInputs";
import { CustomSplitInputs } from "./CustomSplitInputs";

export type MemberOption = {
  uid: string;
  avatarLabel: string;
  nameLabel: string;
  photoURL?: string;
  isCurrentUser: boolean;
};

export type SplitStrategyValue = "equal" | "percentage" | "custom";

// Real strategy names (§5 of the checkpoint prompt: never "Simple"/
// "Advanced").
const STRATEGY_OPTIONS: { value: SplitStrategyValue; label: string }[] = [
  { value: "equal", label: "Equal" },
  { value: "percentage", label: "Percentage" },
  { value: "custom", label: "Custom" },
];

// Checkpoint 4F.4, per the approved docs/audits/
// TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md: who/what funds this
// Expense - an explicit state the controller owns, never inferred later
// from payerUid (payerUid is always null for "shared_stash", by the
// frozen domain contract, so inferring the reverse would be circular).
export type ExpensePaymentSourceValue = "member_out_of_pocket" | "shared_stash";

const PAYMENT_SOURCE_OPTIONS: { value: ExpensePaymentSourceValue; label: string }[] = [
  { value: "member_out_of_pocket", label: "Paid by a member" },
  { value: "shared_stash", label: "Paid from Shared Stash" },
];

export type AddExpenseFormProps = {
  colors: SemanticColors;
  members: MemberOption[];
  isOverCapacity: boolean;

  description: string;
  onChangeDescription: (value: string) => void;
  descriptionError: string | null;

  amountText: string;
  onChangeAmountText: (value: string) => void;
  amountError: string | null;

  category: string;
  onChangeCategory: (value: string) => void;
  categoryError: string | null;

  // Checkpoint 4F.4: explicit payment-source choice. Omitting both props
  // preserves the exact pre-4F.4 behavior (every existing call site keeps
  // working unchanged): the selector defaults to showing, defaulting to
  // "member_out_of_pocket", and every member-funded control below renders
  // exactly as it always has. Correction mode (expenses/create.tsx) hides
  // the selector entirely via showPaymentSourceSelector={false} - a
  // Shared-Stash Expense cannot be corrected through this checkpoint's
  // backend, so offering the choice there would only lead to a dead end.
  paymentSource?: ExpensePaymentSourceValue;
  onChangePaymentSource?: (value: ExpensePaymentSourceValue) => void;
  showPaymentSourceSelector?: boolean;
  // The Trip's own already-authoritative Shared Stash balance (minor
  // units), if the caller already has it loaded - this component never
  // computes or fetches a balance itself (preflight §5: "do not create a
  // second financial calculation"). null/undefined simply omits the
  // availability line; the backend remains authoritative for
  // insufficient-funds enforcement regardless of what this displays.
  sharedStashAvailableMinor?: number | null;

  // Checkpoint 4D.7A: null represents "not yet explicitly chosen" - used
  // by the correction flow when the original payer is no longer a
  // current Trip member (never auto-resolved to a fallback; §1 of the
  // checkpoint prompt requires an explicit choice). Ordinary Add Expense
  // never passes null here (its own initializedRef effect always
  // defaults payerUid to the signed-in user before this form renders).
  payerUid: string | null;
  onSelectPayer: (uid: string) => void;

  selectedParticipantUids: Set<string>;
  onToggleParticipant: (uid: string) => void;
  onSelectAllParticipants: () => void;
  onClearAllParticipants: () => void;
  participantsError: string | null;

  profileErrorVisible: boolean;
  onRetryProfiles: () => void;

  // Already-validated/parsed values - the form never re-derives these
  // from raw text itself, so its own preview can never disagree with
  // what the controller will actually submit.
  previewAmountMinor: number | null;

  // Checkpoint 4D.4: strategy selection + strategy-specific per-
  // participant state. Raw per-uid text/error maps and formatted
  // aggregate text are all computed/validated by the controller
  // (expenses/create.tsx) - this component only renders them and calls
  // back up on every keystroke/selection.
  splitStrategy: SplitStrategyValue;
  onChangeSplitStrategy: (strategy: SplitStrategyValue) => void;

  percentageValues: Record<string, string>;
  onChangePercentageValue: (uid: string, value: string) => void;
  percentageErrors: Record<string, string>;
  percentageAggregateText: string | null;
  percentageAggregateError: string | null;
  // Pre-validated/canonicalized - null unless every selected
  // participant's percentage parses AND the total is exactly 10000.
  previewPercentageParticipants: { uid: string; percentageBasisPoints: number }[] | null;

  customValues: Record<string, string>;
  onChangeCustomValue: (uid: string, value: string) => void;
  customErrors: Record<string, string>;
  customAggregateText: string | null;
  customAggregateError: string | null;
  // Pre-validated/canonicalized - null unless every selected
  // participant's share parses AND the total exactly matches the
  // Expense amount.
  previewCustomParticipants: { uid: string; amountMinor: number }[] | null;

  submitting: boolean;
  submitError: string | null;
  onSubmit: () => void;
  onCancel: () => void;

  // Checkpoint 4D.7: lets the correction flow (expenses/create.tsx in
  // correction mode) relabel the primary action ("Save correction"/
  // "Finish correction" instead of "Add Expense") without a second,
  // near-duplicate form component - every other control/validation/
  // preview here is identical between ordinary creation and correction.
  // Both default to ordinary Add Expense's existing copy, so every
  // existing call site is unaffected.
  primaryActionLabel?: string;
  primaryActionAccessibilityLabel?: string;
  savingLabel?: string;
};

export function AddExpenseForm({
  colors,
  members,
  isOverCapacity,
  description,
  onChangeDescription,
  descriptionError,
  amountText,
  onChangeAmountText,
  amountError,
  category,
  onChangeCategory,
  categoryError,
  paymentSource = "member_out_of_pocket",
  onChangePaymentSource,
  showPaymentSourceSelector = true,
  sharedStashAvailableMinor,
  payerUid,
  onSelectPayer,
  selectedParticipantUids,
  onToggleParticipant,
  onSelectAllParticipants,
  onClearAllParticipants,
  participantsError,
  profileErrorVisible,
  onRetryProfiles,
  previewAmountMinor,
  splitStrategy,
  onChangeSplitStrategy,
  percentageValues,
  onChangePercentageValue,
  percentageErrors,
  percentageAggregateText,
  percentageAggregateError,
  previewPercentageParticipants,
  customValues,
  onChangeCustomValue,
  customErrors,
  customAggregateText,
  customAggregateError,
  previewCustomParticipants,
  submitting,
  submitError,
  onSubmit,
  onCancel,
  primaryActionLabel = "Add Expense",
  primaryActionAccessibilityLabel = "Add Expense",
  savingLabel = "Saving…",
}: AddExpenseFormProps) {
  const memberByUid = useMemo(() => new Map(members.map((m) => [m.uid, m])), [members]);
  const selectedParticipantList = useMemo(
    () => Array.from(selectedParticipantUids).sort(),
    [selectedParticipantUids]
  );
  const selectedMembers = useMemo(
    () => members.filter((m) => selectedParticipantUids.has(m.uid)),
    [members, selectedParticipantUids]
  );

  // Live split preview (§12/§18/§21) - DISPLAY ONLY, never persisted.
  // Dispatches on splitStrategy, using only ALREADY-VALIDATED data the
  // controller supplied (previewPercentageParticipants/
  // previewCustomParticipants are null unless every selected
  // participant's input parsed AND the aggregate exactly matches) - this
  // component never re-derives validity from raw text itself. Fails
  // closed: an unexpected compute*Split throw simply omits the preview
  // rather than crashing the form or influencing submit eligibility,
  // which the controller decides independently in handleSubmit.
  const preview = useMemo(() => {
    if (previewAmountMinor === null) return null;
    try {
      if (splitStrategy === "equal") {
        if (selectedParticipantList.length === 0) return null;
        return {
          kind: "equal" as const,
          allocations: computeEqualSplit(previewAmountMinor, selectedParticipantList),
        };
      }
      if (splitStrategy === "percentage") {
        if (!previewPercentageParticipants || previewPercentageParticipants.length === 0) return null;
        return {
          kind: "percentage" as const,
          allocations: computePercentageSplit(previewAmountMinor, previewPercentageParticipants),
        };
      }
      if (!previewCustomParticipants || previewCustomParticipants.length === 0) return null;
      return {
        kind: "custom" as const,
        allocations: computeCustomSplit(previewAmountMinor, previewCustomParticipants),
      };
    } catch {
      return null;
    }
  }, [
    splitStrategy,
    previewAmountMinor,
    selectedParticipantList,
    previewPercentageParticipants,
    previewCustomParticipants,
  ]);

  const payerMember = payerUid ? memberByUid.get(payerUid) : undefined;

  return (
    <View>
      <TextInput
        mode="outlined"
        dense
        label="Description"
        placeholder="Cabin rental"
        value={description}
        onChangeText={onChangeDescription}
        editable={!submitting}
        style={styles.field}
      />
      {descriptionError ? (
        <Text style={[styles.errorText, { color: colors.coral }]}>{descriptionError}</Text>
      ) : null}

      <TextInput
        mode="outlined"
        dense
        label="Amount"
        placeholder="0.00"
        value={amountText}
        onChangeText={onChangeAmountText}
        keyboardType="numeric"
        editable={!submitting}
        style={styles.field}
      />
      {amountError ? <Text style={[styles.errorText, { color: colors.coral }]}>{amountError}</Text> : null}

      <TextInput
        mode="outlined"
        dense
        label="Category (optional)"
        placeholder="Food, lodging, transportation…"
        value={category}
        onChangeText={onChangeCategory}
        editable={!submitting}
        style={styles.field}
      />
      {categoryError ? (
        <Text style={[styles.errorText, { color: colors.coral }]}>{categoryError}</Text>
      ) : null}

      {/* Checkpoint 4F.4: explicit payment-source choice, shown ABOVE
          every member-funded control below so it reads as a fork, not an
          afterthought. Hidden entirely in correction mode (§2 of the
          checkpoint prompt: Shared-Stash Expenses can't be corrected
          through this checkpoint's backend). Member-funded stays the
          default - selecting it again is a no-op via onChangePaymentSource
          itself, matching STRATEGY_OPTIONS's own idempotent-select
          convention above. */}
      {showPaymentSourceSelector && onChangePaymentSource ? (
        <>
          <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: spacing.lg }]}>
            Payment source
          </Text>
          <View style={styles.strategyRow} accessibilityRole="radiogroup">
            {PAYMENT_SOURCE_OPTIONS.map(({ value, label }) => {
              const selected = paymentSource === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => onChangePaymentSource(value)}
                  disabled={submitting}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ checked: selected }}
                  style={({ pressed }) => [
                    styles.strategyPill,
                    { borderColor: selected ? colors.blue : colors.border },
                    selected && { backgroundColor: colors.bluePale },
                    pressed && !submitting && { opacity: 0.85 },
                  ]}
                >
                  {selected ? <MaterialCommunityIcons name="check" size={14} color={colors.blue} /> : null}
                  <Text
                    style={[styles.strategyPillText, { color: selected ? colors.blue : colors.textPrimary }]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      {paymentSource === "shared_stash" ? (
        // Checkpoint 4F.4 §4: no payer, no participants, no split
        // strategy are collected or shown - the group fund paid in
        // full, so there is no reimbursement edge to configure or
        // preview. This note is the ONLY Shared-Stash-specific content
        // in the form.
        <View style={[styles.sharedStashNote, { backgroundColor: colors.bluePale }]}>
          <Text style={[styles.sharedStashNoteText, { color: colors.textPrimary }]}>
            Paid from Shared Stash — this amount will be deducted from the Trip balance.
          </Text>
          {sharedStashAvailableMinor != null ? (
            <Text style={[styles.sharedStashBalanceText, { color: colors.textSecondary }]}>
              Available in Shared Stash: {formatCurrency(sharedStashAvailableMinor / 100)}
            </Text>
          ) : null}
        </View>
      ) : (
        <>
          {profileErrorVisible ? (
            <View style={styles.profileErrorRow}>
              <Text style={[styles.profileErrorText, { color: colors.textMuted }]}>
                Some member names couldn’t be loaded.
              </Text>
              <Pressable onPress={onRetryProfiles} accessibilityRole="button" accessibilityLabel="Retry loading member names">
                <Text style={[styles.profileErrorRetryText, { color: colors.blue }]}>Retry</Text>
              </Pressable>
            </View>
          ) : null}

          <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: spacing.lg }]}>
            Paid by
          </Text>
          <View style={[styles.selectorBorder, { borderColor: colors.border }]} accessibilityRole="radiogroup">
            <ScrollView style={styles.selectorScroll} nestedScrollEnabled>
              {members.map((member) => {
                const selected = member.uid === payerUid;
                return (
                  <MemberSelectRow
                    key={member.uid}
                    member={member}
                    colors={colors}
                    selected={selected}
                    disabled={submitting}
                    iconName={selected ? "radiobox-marked" : "radiobox-blank"}
                    role="radio"
                    onPress={() => onSelectPayer(member.uid)}
                  />
                );
              })}
            </ScrollView>
          </View>

          <View style={styles.participantsHeaderRow}>
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
              Participants
            </Text>
            {!isOverCapacity ? (
              <View style={styles.selectorActionsRow}>
                <Pressable
                  onPress={onSelectAllParticipants}
                  disabled={submitting}
                  accessibilityRole="button"
                  accessibilityLabel="Select all participants"
                >
                  <Text style={[styles.selectorActionText, { color: colors.blue }]}>Select all</Text>
                </Pressable>
                <Pressable
                  onPress={onClearAllParticipants}
                  disabled={submitting}
                  accessibilityRole="button"
                  accessibilityLabel="Clear all participants"
                >
                  <Text style={[styles.selectorActionText, { color: colors.blue }]}>Clear</Text>
                </Pressable>
              </View>
            ) : null}
          </View>

          {isOverCapacity ? (
            <>
              <Text style={[styles.capacityNote, { color: colors.textMuted }]}>
                This expense can include up to {MAX_EXPENSE_PARTICIPANTS} people. Choose the members
                sharing this expense.
              </Text>
              <Text style={[styles.capacityCounter, { color: colors.textSecondary }]}>
                {selectedParticipantList.length} of {MAX_EXPENSE_PARTICIPANTS} selected
              </Text>
            </>
          ) : null}

          <View style={[styles.selectorBorder, { borderColor: colors.border }]}>
            <ScrollView style={styles.selectorScroll} nestedScrollEnabled>
              {members.map((member) => {
                const selected = selectedParticipantUids.has(member.uid);
                const atCap =
                  isOverCapacity && !selected && selectedParticipantList.length >= MAX_EXPENSE_PARTICIPANTS;
                return (
                  <MemberSelectRow
                    key={member.uid}
                    member={member}
                    colors={colors}
                    selected={selected}
                    disabled={submitting || atCap}
                    iconName={selected ? "checkbox-marked" : "checkbox-blank-outline"}
                    role="checkbox"
                    onPress={() => onToggleParticipant(member.uid)}
                  />
                );
              })}
            </ScrollView>
          </View>
          {participantsError ? (
            <Text style={[styles.errorText, { color: colors.coral }]}>{participantsError}</Text>
          ) : null}

          {/* Checkpoint 4D.4 §5: strategy selector, after participant
              selection and before the preview. Selection is conveyed by more
              than color - a check icon plus a distinct border/tint.
              Checkpoint 4D.8: accessibilityRole is "radio" (a mutually-
              exclusive single-select group of 3 options), not "button" -
              state is conveyed via accessibilityState.checked, matching the
              same convention now used for MemberSelectRow below. */}
          <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: spacing.lg }]}>
            Split strategy
          </Text>
          <View style={styles.strategyRow} accessibilityRole="radiogroup">
            {STRATEGY_OPTIONS.map(({ value, label }) => {
              const selected = splitStrategy === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => onChangeSplitStrategy(value)}
                  disabled={submitting}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ checked: selected }}
                  style={({ pressed }) => [
                    styles.strategyPill,
                    { borderColor: selected ? colors.blue : colors.border },
                    selected && { backgroundColor: colors.bluePale },
                    pressed && !submitting && { opacity: 0.85 },
                  ]}
                >
                  {selected ? <MaterialCommunityIcons name="check" size={14} color={colors.blue} /> : null}
                  <Text
                    style={[styles.strategyPillText, { color: selected ? colors.blue : colors.textPrimary }]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {splitStrategy === "percentage" ? (
            <PercentageSplitInputs
              colors={colors}
              participants={selectedMembers}
              values={percentageValues}
              errors={percentageErrors}
              onChangeValue={onChangePercentageValue}
              aggregateText={percentageAggregateText}
              aggregateError={percentageAggregateError}
              disabled={submitting}
            />
          ) : splitStrategy === "custom" ? (
            <CustomSplitInputs
              colors={colors}
              participants={selectedMembers}
              values={customValues}
              errors={customErrors}
              onChangeValue={onChangeCustomValue}
              aggregateText={customAggregateText}
              aggregateError={customAggregateError}
              disabled={submitting}
            />
          ) : null}

          {preview && payerMember ? (
            <View style={[styles.previewCard, { backgroundColor: colors.bluePale }]}>
              <Text style={[styles.previewHeadline, { color: colors.textPrimary }]}>
                Paid by {payerMember.nameLabel}
              </Text>
              <Text style={[styles.previewSub, { color: colors.textSecondary }]}>
                {preview.kind === "equal"
                  ? "Split equally between:"
                  : preview.kind === "percentage"
                    ? "Split by percentage:"
                    : "Custom split:"}
              </Text>
              {preview.allocations.map((allocation) => {
                const member = memberByUid.get(allocation.uid);
                const label = member?.nameLabel ?? "Trip member";
                return (
                  <View key={allocation.uid} style={styles.previewRow}>
                    <Text style={[styles.previewName, { color: colors.textPrimary }]} numberOfLines={1}>
                      {label}
                    </Text>
                    {preview.kind === "percentage" && allocation.percentageBasisPoints !== undefined ? (
                      <Text style={[styles.previewPercent, { color: colors.textSecondary }]}>
                        {(allocation.percentageBasisPoints / 100).toFixed(2)}%
                      </Text>
                    ) : null}
                    <Text style={[styles.previewAmount, { color: colors.textPrimary }]}>
                      {formatCurrency(allocation.amountMinor / 100)}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </>
      )}

      {submitError ? <Text style={[styles.errorText, { color: colors.coral }]}>{submitError}</Text> : null}

      <View style={styles.actionsRow}>
        <Pressable
          onPress={onSubmit}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel={primaryActionAccessibilityLabel}
          style={({ pressed }) => [
            styles.primaryActionBtn,
            { backgroundColor: colors.mint },
            (pressed || submitting) && { opacity: 0.85 },
          ]}
        >
          {submitting ? (
            <View style={styles.submittingRow}>
              <ActivityIndicator size="small" color={colors.onMint} />
              <Text style={[styles.primaryActionText, { color: colors.onMint }]}>{savingLabel}</Text>
            </View>
          ) : (
            <Text style={[styles.primaryActionText, { color: colors.onMint }]}>{primaryActionLabel}</Text>
          )}
        </Pressable>
        <Pressable
          onPress={onCancel}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={({ pressed }) => [
            styles.secondaryActionBtn,
            { borderColor: colors.border },
            (pressed || submitting) && { opacity: 0.9 },
          ]}
        >
          <Text style={[styles.secondaryActionText, { color: colors.textPrimary }]}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

// Shared single/multi-select row for BOTH the payer and participant
// lists (§16/§17) - selection is conveyed by more than color (an icon +
// a tinted row background), matching §36's accessibility requirement.
function MemberSelectRow({
  member,
  colors,
  selected,
  disabled,
  iconName,
  role,
  onPress,
}: {
  member: MemberOption;
  colors: SemanticColors;
  selected: boolean;
  disabled: boolean;
  iconName: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  // Checkpoint 4D.8: the payer list is a single-select radio group; the
  // participant list is a multi-select checkbox group - neither is a
  // "button" semantically, and selection is now conveyed to assistive
  // tools via accessibilityState.checked, not just the visual icon/tint.
  role: "radio" | "checkbox";
  onPress: () => void;
}) {
  const label = member.isCurrentUser ? `${member.nameLabel} · You` : member.nameLabel;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      style={({ pressed }) => [
        styles.memberRow,
        selected && { backgroundColor: colors.bluePale },
        (pressed && !disabled) && { opacity: 0.85 },
        disabled && !selected && { opacity: 0.4 },
      ]}
    >
      <AvatarCircle index={0} label={member.avatarLabel} photoURL={member.photoURL} size={28} />
      <Text style={[styles.memberRowText, { color: colors.textPrimary }]} numberOfLines={1}>
        {label}
      </Text>
      <MaterialCommunityIcons
        name={iconName}
        size={18}
        color={selected ? colors.blue : colors.textMuted}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.xs },
  errorText: { fontSize: 12, fontWeight: "700", marginTop: 2, marginBottom: spacing.xs },

  sectionLabel: { fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },

  selectorBorder: {
    marginTop: spacing.xs,
    borderWidth: 1,
    borderRadius: radii.md,
    overflow: "hidden",
  },
  selectorScroll: { maxHeight: 220 },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  memberRowText: { flex: 1, fontSize: 13, fontWeight: "700" },

  participantsHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.lg,
  },
  selectorActionsRow: { flexDirection: "row", gap: spacing.md },
  selectorActionText: { fontSize: 12, fontWeight: "800" },

  capacityNote: { fontSize: 12, fontWeight: "600", marginTop: spacing.xs },
  capacityCounter: { fontSize: 12, fontWeight: "800", marginTop: 2 },

  profileErrorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  profileErrorText: { fontSize: 11, fontWeight: "600", flex: 1, marginRight: spacing.sm },
  profileErrorRetryText: { fontSize: 12, fontWeight: "800" },

  previewCard: {
    marginTop: spacing.lg,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  previewHeadline: { fontSize: 14, fontWeight: "800" },
  previewSub: { fontSize: 12, fontWeight: "600", marginTop: 2, marginBottom: spacing.xs },
  previewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 3,
  },
  previewName: { flex: 1, fontSize: 13, fontWeight: "700", marginRight: spacing.sm },
  previewPercent: { fontSize: 12, fontWeight: "700", marginRight: spacing.sm },
  previewAmount: { fontSize: 13, fontWeight: "800" },

  sharedStashNote: {
    marginTop: spacing.sm,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  sharedStashNoteText: { fontSize: 13, fontWeight: "700", lineHeight: 18 },
  sharedStashBalanceText: { fontSize: 12, fontWeight: "600", marginTop: spacing.xs },

  strategyRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  strategyPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: 38,
    borderWidth: 1.5,
    borderRadius: radii.md,
  },
  strategyPillText: { fontSize: 12, fontWeight: "800" },

  actionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  primaryActionBtn: {
    flex: 1,
    height: 46,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryActionText: { fontSize: 14, fontWeight: "800" },
  submittingRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  secondaryActionBtn: {
    flex: 1,
    height: 46,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryActionText: { fontSize: 14, fontWeight: "800" },
});
