// Single-row presentation for one derived TripBalance pairwise
// obligation in the read-only Balances card (Checkpoint 4E.5, extended
// 4E.6 with an OPTIONAL Settle Up action), modeled structurally on
// components/expenses/ExpenseRow.tsx's own row shape. Pure presentation
// only: no Firebase reads/writes, no navigation, no mutation, no raw uid
// display - `from`/`to` identity must already be resolved by the caller
// (mirrors ExpenseRowPayer's own "pass a safe resolved label" contract
// exactly). This component does NOT decide authorization - Trip Detail
// decides whether a given row receives `onSettleUp` at all (Checkpoint
// 4E.6 §4/§5); when omitted, the row's read-only behavior is byte-for-
// byte unchanged from 4E.5.
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { AvatarCircle } from "../buckets/AvatarCircle";
import { radii, spacing } from "../../src/theme/tokens";
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
  onSettleUp,
  settleUpAccessibilityLabel,
}: {
  from: BalanceRowFromMember;
  to: BalanceRowToMember;
  amountMinor: number;
  // Checkpoint 4E.6 §4: optional - when omitted, no action renders and
  // this row is exactly the 4E.5 read-only row.
  onSettleUp?: () => void;
  settleUpAccessibilityLabel?: string;
}) {
  const colors = useSemanticColors();
  const amountText = formatCurrency(amountMinor / 100);
  // Never exposes a raw uid - from/to are already-resolved display
  // labels by the time they reach this component.
  const debtAccessibilityLabel = `${from.nameLabel} owes ${to.nameLabel} ${amountText}`;

  return (
    <View style={[styles.container, { borderBottomColor: colors.border }]}>
      {/* Checkpoint 4E.6 §9: this accessible group covers ONLY the debt
          text/avatar/amount - the Settle Up button below is a SIBLING,
          never a descendant, so it is never swallowed by this group and
          remains its own independently-focusable
          accessibilityRole="button". When onSettleUp is omitted, this is
          the entire row, unchanged from 4E.5. */}
      <View style={styles.row} accessible accessibilityLabel={debtAccessibilityLabel}>
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

      {/* Checkpoint 4E.6 §8: a compact action beneath the main debt row,
          indented to align with the name/amount content area (past the
          avatar), rather than cramming a third element onto one narrow
          horizontal line. Existing mint "primary action" visual
          language, not a new color - debt is information, never an
          error state, so no coral/red badge here either. */}
      {onSettleUp ? (
        <Pressable
          onPress={onSettleUp}
          accessibilityRole="button"
          accessibilityLabel={settleUpAccessibilityLabel ?? `Settle up with ${from.nameLabel}`}
          style={({ pressed }) => [
            styles.settleUpBtn,
            { backgroundColor: colors.mint },
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={[styles.settleUpText, { color: colors.onMint }]}>Settle Up</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const AVATAR_SIZE = 32;

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  leftSlot: {},
  centerSlot: { flex: 1, minWidth: 0 },
  line: { fontSize: 14, fontWeight: "500" },
  strong: { fontWeight: "700" },
  rightSlot: { marginLeft: spacing.sm },
  amount: { fontSize: 14, fontWeight: "800" },
  settleUpBtn: {
    alignSelf: "flex-start",
    marginTop: spacing.xs,
    marginLeft: AVATAR_SIZE + spacing.sm,
    height: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  settleUpText: { fontSize: 12, fontWeight: "800" },
});
