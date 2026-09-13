// Single coherent Personal Savings money-action sheet (Milestone 3
// Checkpoint 3D), replacing the previous fragmented +$50 / +$100 /
// Custom Amount / Withdraw controls and separate contribution/
// withdrawal dialog with one focused surface. Purely presentational -
// all state and the trusted recordSavingsTransaction call live in
// useSavingsMoneyAction() (src/hooks/useSavingsMoneyAction.tsx); this
// component only reads that shared state and forwards user input to it,
// matching the project's existing convention of keeping Firebase calls
// out of presentational components (see BucketCard.tsx).
//
// Rendered exactly once (in app/(tabs)/buckets/_layout.tsx and
// app/(tabs)/trips/_layout.tsx), so it overlays correctly regardless of
// which nested screen is currently on top of either Stack.
//
// Checkpoint 3F.3C: re-skinned from a react-native-paper MD3 Dialog
// (lavender surfaces, large default sizing) to a compact bottom sheet
// matching the approved Light Mode language - same visual shell pattern
// as components/navigation/CreateActionSheet.tsx (RN Modal + backdrop
// Pressable + rounded sheet), styled with the shared semantic
// colors/tokens so Dark Mode keeps working unchanged. PRESENTATION ONLY:
// no change to useSavingsMoneyAction's state shape, validation,
// idempotency, error handling, or submit() call - this file only reads
// state and forwards the exact same handler calls as before.
import React from "react";
import { Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Text, useTheme } from "react-native-paper";

import { MAX_TRANSACTION_NOTE_LENGTH } from "../../src/services/firebase/savingsTransactions";
import { resolveAmountMinor } from "../../src/domain/savingsMoneyAction";
import { useSavingsMoneyAction } from "../../src/hooks/useSavingsMoneyAction";
import { radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { formatCurrency } from "../../utils/format";

// Canonical integer minor-unit values (Checkpoint 3D review follow-up) -
// $20.00 / $50.00 / $100.00 as amountMinor directly, never as a dollar
// number later re-parsed through a string round trip. formatCurrency is
// used only to render each chip's display label.
const QUICK_AMOUNTS_MINOR = [2000, 5000, 10000];

export function MoneyActionSheet() {
  const theme = useTheme();
  const colors = useSemanticColors();
  const { state, close, setType, setAmountText, setQuickAmount, setNote, submit } =
    useSavingsMoneyAction();

  // Checkpoint 3F.3C: displayTitle/displaySubtitle are optional, purely
  // presentational overrides (see useSavingsMoneyAction.tsx) - when a
  // caller doesn't pass them (every ordinary Bucket call site today),
  // this falls back to the Bucket's own stored name exactly as before.
  const fallbackName = state.bucket?.name?.trim() ? state.bucket.name.trim() : "Untitled";
  const resourceLabel = state.displayTitle ?? fallbackName;
  const resourceSubLabel = state.displaySubtitle ?? null;

  const title = state.type === "contribution" ? "Add Money" : "Withdraw Money";
  const submitLabel = state.type === "contribution" ? "Add" : "Withdraw";

  // A lightweight pre-check only, so the submit button is disabled for
  // the common "blank or malformed amount" case - the authoritative
  // validation (including the note-length and withdrawal-balance checks)
  // happens in submit() itself and surfaces via state.error either way.
  // Mirrors submit()'s own amount resolution exactly: a selected preset
  // is always valid on its own terms and never re-parsed from text.
  const amountLooksValid =
    resolveAmountMinor(state.amountText, state.presetAmountMinor) !== null;

  return (
    <Modal visible={state.visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close">
        <View
          style={[styles.sheet, { backgroundColor: theme.colors.surface, borderColor: colors.border }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]} numberOfLines={1}>
              {resourceLabel}
              {resourceSubLabel ? ` · ${resourceSubLabel}` : ""}
            </Text>
          </View>

          <View style={styles.typeRow}>
            <Pressable
              onPress={() => setType("contribution")}
              disabled={state.submitting}
              style={[
                styles.typeChip,
                { borderColor: colors.border },
                state.type === "contribution" && {
                  backgroundColor: colors.mint,
                  borderColor: colors.mint,
                },
              ]}
            >
              <Text
                style={[
                  styles.typeChipText,
                  { color: state.type === "contribution" ? colors.onMint : colors.textPrimary },
                ]}
              >
                Add Money
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setType("withdrawal")}
              disabled={state.submitting}
              style={[
                styles.typeChip,
                { borderColor: colors.border },
                state.type === "withdrawal" && {
                  backgroundColor: colors.slatePale,
                  borderColor: colors.borderStrong,
                },
              ]}
            >
              <Text style={[styles.typeChipText, { color: colors.textPrimary }]}>Withdraw</Text>
            </Pressable>
          </View>

          <Text style={[styles.label, { color: colors.textMuted }]}>Quick amount</Text>
          <View style={styles.quickRow}>
            {QUICK_AMOUNTS_MINOR.map((amountMinor) => {
              const selected = state.presetAmountMinor === amountMinor;
              return (
                <Pressable
                  key={amountMinor}
                  onPress={() => setQuickAmount(amountMinor)}
                  disabled={state.submitting}
                  accessibilityLabel={`Set amount to ${formatCurrency(amountMinor / 100)}`}
                  style={[
                    styles.quickChip,
                    { borderColor: colors.border },
                    selected && { backgroundColor: colors.mintSurface, borderColor: colors.mintDark },
                  ]}
                >
                  <Text
                    style={[
                      styles.quickChipText,
                      { color: selected ? colors.mintText : colors.textPrimary },
                    ]}
                  >
                    {formatCurrency(amountMinor / 100)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <TextInput
            value={state.amountText}
            onChangeText={setAmountText}
            placeholder="0.00"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
            editable={!state.submitting}
            style={[
              styles.input,
              styles.amountInput,
              { color: colors.textPrimary, borderColor: colors.border, backgroundColor: theme.colors.background },
            ]}
          />

          <TextInput
            value={state.note}
            onChangeText={setNote}
            placeholder="Note (optional)"
            placeholderTextColor={colors.textMuted}
            editable={!state.submitting}
            maxLength={MAX_TRANSACTION_NOTE_LENGTH}
            style={[
              styles.input,
              { color: colors.textPrimary, borderColor: colors.border, backgroundColor: theme.colors.background },
            ]}
          />

          {state.error ? (
            <Text style={[styles.errorText, { color: colors.coral }]}>{state.error}</Text>
          ) : null}

          <View style={styles.actionsRow}>
            <Pressable
              onPress={close}
              disabled={state.submitting}
              style={[styles.cancelBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.cancelBtnText, { color: colors.textPrimary }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={state.submitting || !amountLooksValid}
              style={[
                styles.submitBtn,
                { backgroundColor: colors.mint },
                (state.submitting || !amountLooksValid) && { opacity: 0.5 },
              ]}
            >
              <MaterialCommunityIcons
                name={state.type === "contribution" ? "plus" : "minus"}
                size={16}
                color={colors.onMint}
                style={{ marginRight: 4 }}
              />
              <Text style={[styles.submitBtnText, { color: colors.onMint }]}>
                {state.submitting ? "Saving…" : submitLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(9,14,26,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  headerRow: { marginBottom: spacing.md },
  title: { ...typography.sectionTitle, fontSize: 18 },
  subtitle: { ...typography.meta, marginTop: 2 },

  typeRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  typeChip: {
    flex: 1,
    height: 40,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  typeChipText: { fontSize: 13, fontWeight: "800" },

  label: { ...typography.meta, marginBottom: spacing.xs },
  quickRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  quickChip: {
    flex: 1,
    height: 36,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  quickChipText: { fontSize: 12, fontWeight: "700" },

  input: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    marginBottom: spacing.sm,
  },
  amountInput: { fontSize: 18, fontWeight: "800" },

  errorText: { fontSize: 12, fontWeight: "700", marginTop: 2, marginBottom: spacing.xs },

  actionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  cancelBtn: {
    flex: 1,
    height: 46,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtnText: { fontSize: 14, fontWeight: "800" },
  submitBtn: {
    flex: 2,
    height: 46,
    borderRadius: radii.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnText: { fontSize: 14, fontWeight: "800" },
});
