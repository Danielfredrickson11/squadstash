// Modal for recording a Settlement (Checkpoint 4E.6) - follows
// components/expenses/ReverseExpenseDialog.tsx's proven Modal
// architecture exactly: transparent, fade Modal; KeyboardAvoidingView;
// an absolute-fill backdrop Pressable as a SIBLING of the centered card
// (never its parent - the repeated, deliberate fix for the RN-Web
// focus/containment bug already established across this codebase);
// dismissal blocked while submitting; never window.confirm/Alert.alert.
//
// Presentation + local field-rendering only - Trip Detail
// (app/(tabs)/trips/[tripId]/index.tsx) owns ALL business logic: the
// selected pair, amount/method/note state, the live current-debt
// binding, the idempotency controller, the trusted recordTripSettlement
// call, and every warning/error string shown here. This component never
// reads balances, never resolves profiles, never imports any Settlement
// service/domain function - every string it renders arrives already
// resolved and safe (never a raw uid).
//
// Product semantics (frozen, non-negotiable): a Settlement means "money
// was actually paid OUTSIDE SquadStash and the recipient confirms they
// received it" - SquadStash never moves money. This dialog therefore
// never says "Pay"/"Send money"/"Transfer", collects no fromUid/toUid/
// date/occurredAt/status field, and its copy always frames the payment
// as something that already happened.
import React from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Text, TextInput } from "react-native-paper";

import { radii, spacing, typography, type SemanticColors } from "../../src/theme/tokens";
import { formatCurrency } from "../../utils/format";
import type { SettlementMethod } from "../../src/types/domain";

// Checkpoint 4E.6 §14/§15: a required, explicit choice - no default
// selection - each row is a real accessibilityRole="radio" inside a
// radiogroup container, applying the 4D.8 lesson from day one (never
// accessibilityRole="button" for a method picker).
const SETTLEMENT_METHOD_OPTIONS: { value: SettlementMethod; label: string }[] = [
  { value: "venmo", label: "Venmo" },
  { value: "paypal", label: "PayPal" },
  { value: "zelle", label: "Zelle" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

export function RecordSettlementDialog({
  visible,
  fromNameLabel,
  currentDebtMinor,
  amountText,
  onChangeAmountText,
  method,
  onChangeMethod,
  note,
  onChangeNote,
  submitting,
  submitError,
  overSettlementWarning,
  balanceFreshnessWarning,
  canSubmit,
  verificationMode = false,
  onCancel,
  onConfirm,
  colors,
}: {
  visible: boolean;
  // Already-resolved, safe display name for the debtor (fromUid) - the
  // recipient side is always "you" (only toUid may ever open this
  // dialog), so no separate `to` identity prop is needed.
  fromNameLabel: string;
  // The pair's LATEST current debt, live-bound by Trip Detail to
  // balanceState.balances for this exact direction - never a one-time
  // snapshot captured when the dialog first opened (Checkpoint 4E.6
  // §18).
  currentDebtMinor: number;
  amountText: string;
  onChangeAmountText: (value: string) => void;
  method: SettlementMethod | null;
  onChangeMethod: (method: SettlementMethod) => void;
  note: string;
  onChangeNote: (value: string) => void;
  submitting: boolean;
  submitError: string | null;
  // Checkpoint 4E.6 §20: precomputed, already-safe (real name, never
  // uid) advisory copy - this component never calls
  // assessSettlementAgainstDebt itself.
  overSettlementWarning?: string | null;
  // Checkpoint 4E.6 §19: precomputed copy for "balances are updating/
  // errored/the selected pair disappeared" - this component never reads
  // balanceState itself. Checkpoint 4E.6A: Trip Detail never supplies
  // this alongside verificationMode:true (an exact ambiguous replay is
  // deliberately exempt from ordinary freshness gating).
  balanceFreshnessWarning?: string | null;
  // Whether Trip Detail currently allows a submit attempt at all (stale/
  // updating/error/disappeared-pair all resolve to false, UNLESS
  // verificationMode is true) - independent of `submitting`.
  canSubmit: boolean;
  // Checkpoint 4E.6A: true when the current form exactly matches a
  // retained, previously-AMBIGUOUS (not definitively failed/succeeded)
  // Settlement request - explains why Confirm is reusing the same
  // request id and stays enabled even against a stale/changed/
  // disappeared balance, without any alarming/destructive styling.
  verificationMode?: boolean;
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

  const confirmDisabled = submitting || !canSubmit;
  const confirmLabel = verificationMode ? "Verify settlement" : "Record settlement";

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
          <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>Record settlement</Text>

          <View style={[styles.summaryWrap, { backgroundColor: colors.surfaceTertiary }]}>
            <Text style={[styles.summaryDescription, { color: colors.textPrimary }]} numberOfLines={1}>
              {fromNameLabel} owes you
            </Text>
            <Text style={[styles.summaryAmount, { color: colors.textPrimary }]}>
              {formatCurrency(currentDebtMinor / 100)}
            </Text>
          </View>

          <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
            Record this only after you’ve actually received payment outside SquadStash. It will
            update this trip’s balances.
          </Text>

          {/* Checkpoint 4E.6A §8: explains WHY this is safe to retry
              (same request id => an already-recorded settlement can
              never be duplicated) - restrained, informational styling,
              never alarming/destructive. */}
          {verificationMode ? (
            <Text style={[styles.verificationText, { color: colors.textSecondary }]}>
              We couldn’t confirm the previous attempt. Retrying these exact details uses the same
              request ID, so an already-recorded settlement won’t be duplicated.
            </Text>
          ) : null}

          <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>Amount received</Text>
          <TextInput
            mode="outlined"
            dense
            placeholder="0.00"
            value={amountText}
            onChangeText={onChangeAmountText}
            editable={!submitting}
            keyboardType="numeric"
            style={styles.amountInput}
          />

          <Text style={[styles.fieldLabel, { color: colors.textMuted, marginTop: spacing.sm }]}>
            Payment method
          </Text>
          <View accessibilityRole="radiogroup" style={styles.methodGroup}>
            {SETTLEMENT_METHOD_OPTIONS.map((option) => {
              const checked = method === option.value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => onChangeMethod(option.value)}
                  disabled={submitting}
                  accessibilityRole="radio"
                  accessibilityState={{ checked }}
                  accessibilityLabel={option.label}
                  style={[
                    styles.methodPill,
                    { borderColor: checked ? colors.mintDark : colors.border },
                    checked && { backgroundColor: colors.mintSurface },
                  ]}
                >
                  <Text
                    style={[
                      styles.methodPillText,
                      { color: checked ? colors.mintDark : colors.textPrimary },
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <TextInput
            mode="outlined"
            dense
            label="Note (optional)"
            placeholder="What’s this for?"
            value={note}
            onChangeText={onChangeNote}
            editable={!submitting}
            multiline
            style={styles.noteInput}
          />

          {/* Checkpoint 4E.6 §20: soft, informational only - never a
              submit-blocking error, never a destructive-looking action. */}
          {overSettlementWarning ? (
            <Text style={[styles.warningText, { color: colors.textSecondary }]}>
              {overSettlementWarning}
            </Text>
          ) : null}

          {/* Checkpoint 4E.6 §19: balances are stale/updating/errored, or
              the selected pair disappeared from the latest ready
              snapshot - also informational, paired with canSubmit:false
              disabling Confirm below. */}
          {balanceFreshnessWarning ? (
            <Text style={[styles.warningText, { color: colors.textSecondary }]}>
              {balanceFreshnessWarning}
            </Text>
          ) : null}

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
              disabled={confirmDisabled}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              style={[
                styles.confirmBtn,
                { backgroundColor: colors.mint },
                confirmDisabled && { opacity: 0.6 },
              ]}
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

  dialogBody: { fontSize: 14, lineHeight: 20, marginBottom: spacing.md },

  fieldLabel: { fontSize: 12, fontWeight: "700", marginBottom: spacing.xs },
  amountInput: { marginBottom: spacing.xs },
  noteInput: { minHeight: 44, marginTop: spacing.sm },

  methodGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  methodPill: {
    height: 34,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  methodPillText: { fontSize: 12, fontWeight: "700" },

  warningText: { fontSize: 12, fontWeight: "600", marginTop: spacing.xs, lineHeight: 17 },
  verificationText: { fontSize: 12, fontWeight: "600", lineHeight: 17, marginBottom: spacing.sm },
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
