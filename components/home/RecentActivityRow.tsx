// Compact, bucket-attributed presentation of one savingsTransaction for
// Home's cross-bucket Recent Activity feed (Milestone 3 Checkpoint 3E,
// visually restyled for the dark signature UI in Checkpoint 3F.2). Home
// aggregates transactions from multiple buckets into one list, so -
// unlike Bucket Detail's TransactionRow (components/buckets/TransactionRow.tsx),
// which is already scoped to a single bucket and never needs to say
// which one - this row must name the bucket. Deliberately omits the
// transaction's note to keep each Home row compact.
//
// Contribution/withdrawal color comes from theme.colors.primary/error,
// which src/theme/appTheme.ts's dark palette already maps to the
// signature mint / muted coral - no color values are hardcoded here.
import React from "react";
import { StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { radii, spacing, typography } from "../../src/theme/tokens";
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
  const tintColor = isContribution ? theme.colors.primary : theme.colors.error;
  // amountMinor is an integer minor-unit value (5000 = $50.00) - dividing
  // by 100 here is display-only conversion for the canonical currency
  // formatter, never a financial calculation feeding back into a write.
  const amountText = `${sign}${formatCurrency(transaction.amountMinor / 100)}`;
  const timestampText = formatTransactionTimestamp(
    transaction.occurredAt ?? transaction.createdAt
  );

  return (
    <View style={styles.row}>
      <View style={[styles.iconBubble, { backgroundColor: `${tintColor}1F` }]}>
        <MaterialCommunityIcons
          name={isContribution ? "plus" : "minus"}
          size={14}
          color={tintColor}
        />
      </View>

      <View style={styles.body}>
        <View style={styles.mainLine}>
          <Text
            style={[styles.label, { color: theme.colors.onSurface }]}
            numberOfLines={1}
          >
            {label} · {bucketName}
          </Text>
          <Text style={[styles.amount, { color: tintColor }]}>{amountText}</Text>
        </View>
        <Text style={[styles.timestamp, { color: theme.colors.onSurfaceVariant }]}>
          {timestampText}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  iconBubble: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  body: { flex: 1, gap: 2 },
  mainLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: spacing.md,
  },
  label: { ...typography.cardTitle, fontSize: 13, flexShrink: 1 },
  amount: { fontSize: 14, fontWeight: "700" },
  timestamp: { ...typography.meta, fontSize: 11 },
});
