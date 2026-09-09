// Compact, bucket-attributed presentation of one savingsTransaction for
// Home's cross-bucket Recent Activity feed (Milestone 3 Checkpoint 3E).
// Home aggregates transactions from multiple buckets into one list, so -
// unlike Bucket Detail's TransactionRow (components/buckets/TransactionRow.tsx),
// which is already scoped to a single bucket and never needs to say
// which one - this row must name the bucket. Deliberately omits the
// transaction's note to keep each Home row compact; the note remains
// visible on the Bucket Detail Activity list, which this component does
// not replace or redesign.
import React from "react";
import { StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

import type { SavingsTransaction } from "../../src/types/domain";
import { formatCurrency, formatTransactionTimestamp } from "../../utils/format";

export function RecentActivityRow({
  transaction,
  bucketName,
}: {
  transaction: SavingsTransaction;
  bucketName: string;
}) {
  const theme = useTheme();

  const isContribution = transaction.type === "contribution";
  const label = isContribution ? "Contribution" : "Withdrawal";
  const sign = isContribution ? "+" : "-";
  const amountColor = isContribution ? theme.colors.primary : theme.colors.error;
  // amountMinor is an integer minor-unit value (5000 = $50.00) - dividing
  // by 100 here is display-only conversion for the canonical currency
  // formatter, never a financial calculation feeding back into a write.
  const amountText = `${sign}${formatCurrency(transaction.amountMinor / 100)}`;
  const timestampText = formatTransactionTimestamp(
    transaction.occurredAt ?? transaction.createdAt
  );

  return (
    <View style={[styles.row, { borderBottomColor: theme.colors.outlineVariant }]}>
      <View style={styles.mainLine}>
        <Text
          style={[styles.label, { color: theme.colors.onSurface }]}
          numberOfLines={1}
        >
          {label} · {bucketName}
        </Text>
        <Text style={[styles.amount, { color: amountColor }]}>{amountText}</Text>
      </View>
      <Text style={[styles.timestamp, { color: theme.colors.onSurfaceVariant }]}>
        {timestampText}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  mainLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
  },
  label: { fontSize: 14, fontWeight: "700", flexShrink: 1 },
  amount: { fontSize: 15, fontWeight: "800" },
  timestamp: { fontSize: 12 },
});
