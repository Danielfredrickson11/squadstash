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
// Rendered exactly once (in app/(tabs)/buckets/_layout.tsx), so it
// overlays correctly regardless of whether the Bucket list or Bucket
// detail screen is currently on top of the nested Stack.
import React from "react";
import { StyleSheet, View } from "react-native";
import { Button, Chip, Dialog, Portal, Text, TextInput, useTheme } from "react-native-paper";

import { MAX_TRANSACTION_NOTE_LENGTH } from "../../src/services/firebase/savingsTransactions";
import { resolveAmountMinor } from "../../src/domain/savingsMoneyAction";
import { useSavingsMoneyAction } from "../../src/hooks/useSavingsMoneyAction";
import { formatCurrency } from "../../utils/format";

// Canonical integer minor-unit values (Checkpoint 3D review follow-up) -
// $20.00 / $50.00 / $100.00 as amountMinor directly, never as a dollar
// number later re-parsed through a string round trip. formatCurrency is
// used only to render each chip's display label.
const QUICK_AMOUNTS_MINOR = [2000, 5000, 10000];

export function MoneyActionSheet() {
  const theme = useTheme();
  const { state, close, setType, setAmountText, setQuickAmount, setNote, submit } =
    useSavingsMoneyAction();

  const bucketName = state.bucket?.name?.trim() ? state.bucket.name.trim() : "Untitled";
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
    <Portal>
      <Dialog visible={state.visible} onDismiss={close}>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Content>
          <Text style={{ marginBottom: 12, color: theme.colors.onSurfaceVariant }}>
            Bucket: <Text style={{ fontWeight: "800", color: theme.colors.onSurface }}>{bucketName}</Text>
          </Text>

          <View style={styles.typeRow}>
            <Chip
              selected={state.type === "contribution"}
              onPress={() => setType("contribution")}
              disabled={state.submitting}
            >
              Add Money
            </Chip>
            <Chip
              selected={state.type === "withdrawal"}
              onPress={() => setType("withdrawal")}
              disabled={state.submitting}
            >
              Withdraw
            </Chip>
          </View>

          <Text style={[styles.label, { color: theme.colors.onSurfaceVariant }]}>
            Quick amount
          </Text>
          <View style={styles.quickRow}>
            {QUICK_AMOUNTS_MINOR.map((amountMinor) => (
              <Chip
                key={amountMinor}
                selected={state.presetAmountMinor === amountMinor}
                onPress={() => setQuickAmount(amountMinor)}
                disabled={state.submitting}
                accessibilityLabel={`Set amount to ${formatCurrency(amountMinor / 100)}`}
              >
                {formatCurrency(amountMinor / 100)}
              </Chip>
            ))}
          </View>

          <TextInput
            label="Amount"
            value={state.amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            disabled={state.submitting}
            style={{ marginTop: 4, marginBottom: 12 }}
          />

          <TextInput
            label="Note (optional)"
            value={state.note}
            onChangeText={setNote}
            multiline
            maxLength={MAX_TRANSACTION_NOTE_LENGTH}
            disabled={state.submitting}
            style={{ marginBottom: 8 }}
          />

          {state.error ? (
            <Text style={{ color: theme.colors.error, marginTop: 4 }}>{state.error}</Text>
          ) : null}
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={close} disabled={state.submitting}>
            Cancel
          </Button>
          <Button
            mode="contained"
            onPress={submit}
            loading={state.submitting}
            disabled={state.submitting || !amountLooksValid}
          >
            {submitLabel}
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  typeRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  quickRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: "700", marginBottom: 6 },
});
