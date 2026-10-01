// In-app confirmation dialog for reversing a Settlement (Checkpoint
// 4E.7), following components/expenses/ReverseExpenseDialog.tsx's own
// Modal architecture exactly: transparent, fade Modal; KeyboardAvoidingView;
// a backdrop Pressable as a SIBLING of the centered card (never its
// parent - the same repeated, deliberate RN-Web focus/containment fix
// already established across this codebase); never window.confirm/
// Alert.alert; dismissal blocked while submitting.
//
// Presentation + local field-rendering only - Trip Detail
// (app/(tabs)/trips/[tripId]/index.tsx) owns ALL business logic: the
// selected Settlement id, the reason text, the idempotency controller,
// the trusted reverseTripSettlement call, and the ambiguous-outcome
// reconciliation. Mint (not coral) for the confirm action, matching
// ReverseExpenseDialog's own precedent exactly - reversal, like Expense
// reversal, is a one-way but explicitly NON-destructive state change
// ("Its history will remain — nothing is deleted").
import React from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { Text, TextInput } from "react-native-paper";

import { radii, spacing, typography, type SemanticColors } from "../../src/theme/tokens";
import { formatCurrency } from "../../utils/format";

export function ReverseSettlementDialog({
  visible,
  fromNameLabel,
  toNameLabel,
  amountMinor,
  reasonText,
  onChangeReasonText,
  submitting,
  submitError,
  onCancel,
  onConfirm,
  colors,
}: {
  visible: boolean;
  // Already-resolved, safe display names - never a raw uid.
  fromNameLabel: string;
  toNameLabel: string;
  amountMinor: number;
  reasonText: string;
  onChangeReasonText: (value: string) => void;
  submitting: boolean;
  submitError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  colors: SemanticColors;
}) {
  // Dismissal (backdrop tap, Cancel, hardware back) is ignored outright
  // while a request is still unresolved - mirrors ReverseExpenseDialog's
  // own guardedCancel exactly, so a still-ambiguous request's pending
  // idempotency record is never lost merely because the modal closed.
  const guardedCancel = () => {
    if (submitting) return;
    onCancel();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={guardedCancel}>
      <KeyboardAvoidingView style={styles.dialogRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable
          style={styles.dialogBackdrop}
          onPress={guardedCancel}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={[styles.dialogCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>Reverse settlement?</Text>

          <View style={[styles.summaryWrap, { backgroundColor: colors.surfaceTertiary }]}>
            <Text style={[styles.summaryDescription, { color: colors.textPrimary }]} numberOfLines={1}>
              {fromNameLabel} paid {toNameLabel}
            </Text>
            <Text style={[styles.summaryAmount, { color: colors.textPrimary }]}>
              {formatCurrency(amountMinor / 100)}
            </Text>
          </View>

          <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
            This settlement will stop reducing the trip balance. Its history will remain — nothing
            is deleted.
          </Text>

          {/* Checkpoint 4E.8 §10: a visual `label` alone does not create
              an accessible name for a React Native TextInput - explicit
              accessibilityLabel required (same finding as
              RecordSettlementDialog's amount/note fields). */}
          <TextInput
            mode="outlined"
            dense
            label="Reason (optional)"
            placeholder="What happened?"
            value={reasonText}
            onChangeText={onChangeReasonText}
            editable={!submitting}
            multiline
            accessibilityLabel="Reason (optional)"
            style={styles.reasonInput}
          />

          {submitError ? (
            <Text style={[styles.errorText, { color: colors.coral }]}>{submitError}</Text>
          ) : null}

          <View style={styles.dialogActions}>
            <Pressable
              onPress={guardedCancel}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={[styles.cancelBtn, { borderColor: colors.border }, submitting && { opacity: 0.5 }]}
            >
              <Text style={[styles.cancelText, { color: colors.textPrimary }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Reverse settlement"
              style={[styles.confirmBtn, { backgroundColor: colors.mint }, submitting && { opacity: 0.7 }]}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={colors.onMint} />
              ) : (
                <Text style={[styles.confirmText, { color: colors.onMint }]}>Reverse settlement</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dialogRoot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  dialogBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(9,14,26,0.55)",
  },
  dialogCard: {
    width: "100%",
    maxWidth: 380,
    borderRadius: radii.xl,
    borderWidth: 1,
    padding: spacing.lg,
  },
  dialogTitle: { ...typography.sectionTitle, fontSize: 18, marginBottom: spacing.sm },

  summaryWrap: {
    borderRadius: radii.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  summaryDescription: { fontSize: 14, fontWeight: "700" },
  summaryAmount: { fontSize: 20, fontWeight: "800", marginTop: 2 },

  dialogBody: { fontSize: 14, lineHeight: 20, marginBottom: spacing.md },
  reasonInput: { minHeight: 44 },
  errorText: { fontSize: 12, fontWeight: "700", marginTop: spacing.xs },

  dialogActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  cancelBtn: {
    flex: 1,
    height: 46,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { fontSize: 14, fontWeight: "800" },
  confirmBtn: {
    flex: 1,
    height: 46,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmText: { fontSize: 14, fontWeight: "800" },
});
