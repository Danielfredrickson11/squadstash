// Single-row presentation for one derived TripBalance pairwise
// obligation in the read-only Balances card (Checkpoint 4E.5), modeled
// structurally on components/expenses/ExpenseRow.tsx's own row shape but
// intentionally NON-INTERACTIVE - no Pressable, no chevron, no Settle Up
// control (that belongs to a later checkpoint; a control that does
// nothing is worse than no control). Pure presentation only: no
// Firebase reads/writes, no navigation, no mutation, no raw uid
// display - `from`/`to` identity must already be resolved by the caller
// (mirrors ExpenseRowPayer's own "pass a safe resolved label" contract
// exactly).
import React from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { AvatarCircle } from "../buckets/AvatarCircle";
import { spacing } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { formatCurrency } from "../../utils/format";

export type BalanceRowFromMember = {
  avatarLabel: string;
  nameLabel: string;
  photoURL?: string;
};

export type BalanceRowToMember = {
  nameLabel: string;
};

export function BalanceRow({
  from,
  to,
  amountMinor,
}: {
  from: BalanceRowFromMember;
  to: BalanceRowToMember;
  amountMinor: number;
}) {
  const colors = useSemanticColors();
  const amountText = formatCurrency(amountMinor / 100);
  // Never exposes a raw uid - from/to are already-resolved display
  // labels by the time they reach this component.
  const accessibilityLabel = `${from.nameLabel} owes ${to.nameLabel} ${amountText}`;

  return (
    <View
      style={[styles.row, { borderBottomColor: colors.border }]}
      accessible
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.leftSlot}>
        <AvatarCircle index={0} label={from.avatarLabel} photoURL={from.photoURL} size={32} />
      </View>

      <View style={styles.centerSlot}>
        <Text numberOfLines={1} style={[styles.line, { color: colors.textPrimary }]}>
          <Text style={styles.strong}>{from.nameLabel}</Text> owes {to.nameLabel}
        </Text>
      </View>

      <View style={styles.rightSlot}>
        <Text style={[styles.amount, { color: colors.textPrimary }]}>{amountText}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  leftSlot: {},
  // Debt is information, not an error state - no coral/red badge here.
  centerSlot: { flex: 1, minWidth: 0 },
  line: { fontSize: 14, fontWeight: "500" },
  strong: { fontWeight: "700" },
  rightSlot: { marginLeft: spacing.sm },
  amount: { fontSize: 14, fontWeight: "800" },
});
