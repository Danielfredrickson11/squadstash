// Single-row presentation for one savingsTransactions ledger entry
// (Milestone 3 Checkpoint 3C). Purely presentational - reads only the
// already-mapped, canonical SavingsTransaction fields it needs and never
// touches Firestore itself. Deliberately shows only type/amount/
// timestamp/note: no document id, clientRequestId, recordedBy, or
// memberUid is rendered (see the checkpoint's field-exposure limits).
//
// Checkpoint 4F.4A: the "Contribution"/"Withdrawal" label itself is now
// resolved via resolveSavingsTransactionLabel (src/domain/
// savingsTransactionAttribution.ts) rather than a bare type check inline
// - when the transaction carries linkedExpenseId (Shared-Stash Expense
// activity), it renders as "Spent on <description>"/"Refunded from
// <description>" (or a safe institutional fallback) instead, and NEVER
// as personal member attribution. No Bucket transaction carries
// linkedExpenseId today (Expenses are Trip-only), so every existing call
// site's rendering is completely unchanged.
import React from "react";
import { StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

import { resolveSavingsTransactionLabel } from "../../src/domain/savingsTransactionAttribution";
import type { SavingsTransaction } from "../../src/types/domain";
import { formatCurrency, formatTransactionTimestamp } from "../../utils/format";

export function TransactionRow({
  transaction,
  // Checkpoint 4F.4A: the linked Expense's own description, when this
  // transaction carries a linkedExpenseId - resolved by the CALLER
  // (never fetched here), matching this component's own existing "no
  // Firestore reads" discipline. Every existing call site omits this
  // (undefined), so ordinary personal contribution/withdrawal rendering
  // is completely unchanged - this prop only ever affects a transaction
  // that actually carries linkedExpenseId, which no Bucket transaction
  // ever does today.
  linkedExpenseDescription,
}: {
  transaction: SavingsTransaction;
  linkedExpenseDescription?: string | null;
}) {
  const theme = useTheme();

  const isContribution = transaction.type === "contribution";
  const label = resolveSavingsTransactionLabel(transaction, linkedExpenseDescription);
  const sign = isContribution ? "+" : "-";
  const amountColor = isContribution ? theme.colors.primary : theme.colors.error;
  // amountMinor is an integer minor-unit value (5000 = $50.00) - dividing
  // by 100 here is display-only conversion for the canonical currency
  // formatter, never a financial calculation feeding back into a write.
  const amountText = `${sign}${formatCurrency(transaction.amountMinor / 100)}`;
  // occurredAt is only ever set when a caller explicitly chose a date (no
  // current UI does); createdAt is always present and is what the
  // history query itself orders by, so it's the correct fallback rather
  // than a fabricated value.
  const timestampText = formatTransactionTimestamp(
    transaction.occurredAt ?? transaction.createdAt
  );
  const note = transaction.note?.trim();

  return (
    <View style={[styles.row, { borderBottomColor: theme.colors.outlineVariant }]}>
      <View style={styles.mainLine}>
        <Text style={[styles.typeLabel, { color: theme.colors.onSurface }]}>{label}</Text>
        <Text style={[styles.amount, { color: amountColor }]}>{amountText}</Text>
      </View>
      <Text style={[styles.timestamp, { color: theme.colors.onSurfaceVariant }]}>
        {timestampText}
      </Text>
      {note ? (
        <Text style={[styles.note, { color: theme.colors.onSurfaceVariant }]}>{note}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  mainLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
  },
  typeLabel: { fontSize: 15, fontWeight: "700" },
  amount: { fontSize: 16, fontWeight: "800" },
  timestamp: { fontSize: 12 },
  note: { fontSize: 13 },
});
