// In-app confirmation dialog for saving an Expense correction (Checkpoint
// 4D.7), following ReverseExpenseDialog.tsx's/ArchiveConfirmDialog's own
// Modal architecture exactly: a transparent, fade Modal; a backdrop
// Pressable as a SIBLING of the centered card (never its parent); never
// window.confirm/Alert.alert.
//
// Presentation only - the route/controller (expenses/create.tsx) owns
// Trip/old-Expense loading, prefill, the idempotency controllers for both
// the reversal and creation requests, the trusted two-step mutation
// sequence, and navigation. `mode` distinguishes the two frozen copy
// variants (UI preflight §24's "Active vs. already-reversed correction
// mode"):
//   "start"  - the old Expense is still active: confirming will (1)
//              reverse the original, THEN (2) create the corrected
//              replacement - two separate trusted operations, explained
//              plainly, including what happens if step 2 fails after
//              step 1 already succeeded (§25's partial-success recovery).
//   "finish" - the old Expense is already reversed (with no replacement
//              yet, e.g. an earlier attempt was interrupted): confirming
//              will ONLY create the replacement - the copy must never
//              imply the original will be reversed again.
import React from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { ActivityIndicator, Text } from "react-native-paper";

import { radii, spacing, typography, type SemanticColors } from "../../src/theme/tokens";
import { formatCurrency } from "../../utils/format";

export function CorrectExpenseConfirmDialog({
  visible,
  mode,
  expenseDescription,
  expenseAmountMinor,
  submitting,
  submitError,
  onCancel,
  onConfirm,
  colors,
}: {
  visible: boolean;
  mode: "start" | "finish";
  expenseDescription: string;
  expenseAmountMinor: number;
  submitting: boolean;
  submitError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  colors: SemanticColors;
}) {
  // Dismissal is ignored outright while a request is unresolved - the
  // server may have already committed part of the two-step sequence, so
  // closing here must never let a later re-open silently lose track of
  // pending idempotency state (mirrors ReverseExpenseDialog's own
  // guardedCancel exactly).
  const guardedCancel = () => {
    if (submitting) return;
    onCancel();
  };

  const title = mode === "start" ? "Save correction?" : "Finish correction?";
  const confirmLabel = mode === "start" ? "Save correction" : "Finish correction";
  const bodyLines =
    mode === "start"
      ? [
          "This will first reverse the original expense, then create the corrected replacement. The original's history stays intact — nothing is deleted.",
          "If the corrected replacement fails to save after the original is reversed, the original stays reversed and you can retry saving the replacement.",
        ]
      : [
          "The original expense is already reversed. This will create the corrected replacement — the original will not be reversed again.",
        ];

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
          <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>{title}</Text>

          <View style={[styles.summaryWrap, { backgroundColor: colors.surfaceTertiary }]}>
            <Text style={[styles.summaryDescription, { color: colors.textPrimary }]} numberOfLines={2}>
              {expenseDescription}
            </Text>
            <Text style={[styles.summaryAmount, { color: colors.textPrimary }]}>
              {formatCurrency(expenseAmountMinor / 100)}
            </Text>
          </View>

          {bodyLines.map((line, i) => (
            <Text key={i} style={[styles.dialogBody, { color: colors.textMuted }]}>
              {line}
            </Text>
          ))}

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
              accessibilityLabel={confirmLabel}
              style={[styles.confirmBtn, { backgroundColor: colors.mint }, submitting && { opacity: 0.7 }]}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={colors.onMint} />
              ) : (
                <Text style={[styles.confirmText, { color: colors.onMint }]}>{confirmLabel}</Text>
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

  dialogBody: { fontSize: 13, lineHeight: 19, marginBottom: spacing.sm },
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
