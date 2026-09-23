// In-app confirmation dialog for reversing an Expense (Checkpoint 4D.6),
// following app/(tabs)/trips/[tripId]/index.tsx's own ArchiveConfirmDialog
// Modal architecture exactly: a transparent, fade Modal; a backdrop
// Pressable as a SIBLING of the centered card (never its parent - the
// same repeated, deliberate fix for an RN-Web focus/containment bug
// already established by MoneyActionSheet.tsx/BucketGridCard.tsx/
// ArchiveConfirmDialog itself); never window.confirm/Alert.alert.
//
// Presentation + local text-field state only - the route/controller
// (expenses/[expenseId].tsx) owns Trip loading, the idempotency
// controller, the trusted reverseTripExpense call, and live
// reconciliation. Mint (not coral) for the confirm action, matching
// ArchiveConfirmDialog's own precedent exactly: reversal, like archive,
// is a one-way state change but an explicitly NON-destructive one
// ("Its history will remain — nothing is deleted") - coral stays
// reserved for genuine destructive/error states per this app's frozen
// Light Mode palette convention.
import React from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { Text, TextInput } from "react-native-paper";

import { radii, spacing, typography, type SemanticColors } from "../../src/theme/tokens";
import { formatCurrency } from "../../utils/format";

export function ReverseExpenseDialog({
  visible,
  expenseDescription,
  expenseAmountMinor,
  reasonText,
  onChangeReasonText,
  submitting,
  submitError,
  onCancel,
  onConfirm,
  colors,
}: {
  visible: boolean;
  expenseDescription: string;
  expenseAmountMinor: number;
  reasonText: string;
  onChangeReasonText: (value: string) => void;
  submitting: boolean;
  submitError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  colors: SemanticColors;
}) {
  // Dismissal (backdrop tap, Cancel, hardware back) is ignored outright
  // while a request is still unresolved - the server may have already
  // committed, so closing here must never let a later re-open silently
  // lose track of the pending idempotency state (mirrors
  // useSavingsMoneyAction's own close() guard exactly).
  const guardedCancel = () => {
    if (submitting) return;
    onCancel();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={guardedCancel}>
      <KeyboardAvoidingView
        style={styles.dialogRoot}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          style={styles.dialogBackdrop}
          onPress={guardedCancel}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={[styles.dialogCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>Reverse expense?</Text>

          <View style={[styles.summaryWrap, { backgroundColor: colors.surfaceTertiary }]}>
            <Text style={[styles.summaryDescription, { color: colors.textPrimary }]} numberOfLines={2}>
              {expenseDescription}
            </Text>
            <Text style={[styles.summaryAmount, { color: colors.textPrimary }]}>
              {formatCurrency(expenseAmountMinor / 100)}
            </Text>
          </View>

          <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
            This expense will stop counting toward balances. Its history will remain — nothing is
            deleted.
          </Text>

          <TextInput
            mode="outlined"
            dense
            label="Reason (optional)"
            placeholder="What happened?"
            value={reasonText}
            onChangeText={onChangeReasonText}
            editable={!submitting}
            multiline
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
              accessibilityLabel="Reverse expense"
              style={[styles.confirmBtn, { backgroundColor: colors.mint }, submitting && { opacity: 0.7 }]}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={colors.onMint} />
              ) : (
                <Text style={[styles.confirmText, { color: colors.onMint }]}>Reverse expense</Text>
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
