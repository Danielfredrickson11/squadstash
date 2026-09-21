// Add Expense form presentation (Checkpoint 4D.3), per the frozen
// docs/audits/TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §11-§18/§21.
// Presentation/member-controls/preview ONLY - no Firebase reads/writes,
// no navigation, no idempotency refs. The route/controller
// (expenses/create.tsx) owns Trip loading, the profile subscription, the
// idempotency controller, the trusted recordTripExpense call, and
// navigation; this component receives everything it needs via props and
// calls back up through onChange*/onSubmit/onCancel. Split strategy is
// ALWAYS "equal" in 4D.3 - no percentage/custom selector exists here.
import React, { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { AvatarCircle } from "../buckets/AvatarCircle";
import { radii, spacing, type SemanticColors } from "../../src/theme/tokens";
import { formatCurrency } from "../../utils/format";
import { computeEqualSplit } from "../../src/domain/tripExpenseSplits";
import { MAX_EXPENSE_PARTICIPANTS } from "../../src/domain/expenseSubmission";

export type MemberOption = {
  uid: string;
  avatarLabel: string;
  nameLabel: string;
  photoURL?: string;
  isCurrentUser: boolean;
};

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

  // Live equal-split preview (§21) - DISPLAY ONLY, never persisted. Fails
  // closed: an unexpected computeEqualSplit throw simply omits the
  // preview rather than crashing the form or influencing submit
  // eligibility, which the controller decides independently from
  // already-validated facts.
  const preview = useMemo(() => {
    if (previewAmountMinor === null || selectedParticipantList.length === 0) return null;
    try {
      return computeEqualSplit(previewAmountMinor, selectedParticipantList);
    } catch {
      return null;
    }
  }, [previewAmountMinor, selectedParticipantList]);

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
          Split equally between
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

      {preview && payerMember ? (
        <View style={[styles.previewCard, { backgroundColor: colors.bluePale }]}>
          <Text style={[styles.previewHeadline, { color: colors.textPrimary }]}>
            Paid by {payerMember.nameLabel}
          </Text>
          <Text style={[styles.previewSub, { color: colors.textSecondary }]}>Split equally between:</Text>
          {preview.map((allocation) => {
            const member = memberByUid.get(allocation.uid);
            const label = member?.nameLabel ?? "Trip member";
            return (
              <View key={allocation.uid} style={styles.previewRow}>
                <Text style={[styles.previewName, { color: colors.textPrimary }]} numberOfLines={1}>
                  {label}
                </Text>
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
  previewAmount: { fontSize: 13, fontWeight: "800" },

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
