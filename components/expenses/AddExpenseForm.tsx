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

  payerUid: string;
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

  const payerMember = memberByUid.get(payerUid);

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
      <View style={[styles.selectorBorder, { borderColor: colors.border }]}>
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
          than color - a check icon plus a distinct border/tint. */}
      <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: spacing.lg }]}>
        Split strategy
      </Text>
      <View style={styles.strategyRow}>
        {STRATEGY_OPTIONS.map(({ value, label }) => {
          const selected = splitStrategy === value;
          return (
            <Pressable
              key={value}
              onPress={() => onChangeSplitStrategy(value)}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
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

      {submitError ? <Text style={[styles.errorText, { color: colors.coral }]}>{submitError}</Text> : null}

      <View style={styles.actionsRow}>
        <Pressable
          onPress={onSubmit}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel="Add Expense"
          style={({ pressed }) => [
            styles.primaryActionBtn,
            { backgroundColor: colors.mint },
            (pressed || submitting) && { opacity: 0.85 },
          ]}
        >
          {submitting ? (
            <View style={styles.submittingRow}>
              <ActivityIndicator size="small" color={colors.onMint} />
              <Text style={[styles.primaryActionText, { color: colors.onMint }]}>Saving…</Text>
            </View>
          ) : (
            <Text style={[styles.primaryActionText, { color: colors.onMint }]}>Add Expense</Text>
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
  onPress,
}: {
  member: MemberOption;
  colors: SemanticColors;
  selected: boolean;
  disabled: boolean;
  iconName: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  onPress: () => void;
}) {
  const label = member.isCurrentUser ? `${member.nameLabel} · You` : member.nameLabel;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
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
