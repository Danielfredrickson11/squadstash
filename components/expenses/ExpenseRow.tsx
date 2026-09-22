// Single-row presentation for one Expense in the Trip Detail summary
// card, the full Expense list route, AND (Checkpoint 4D.5) as the
// navigable entry point into Expense Detail - one shared component, not
// several differently-shaped implementations (per the frozen
// docs/audits/TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §5/§15/§16).
//
// Interactive only when `onPress` is supplied (Checkpoint 4D.5 §26) -
// before Expense Detail existed (4D.2/4D.3/4D.4), every call site omitted
// it and this row rendered as a plain, non-interactive View; now that a
// real detail screen exists, both Expense-history call sites pass
// onPress and this row becomes a real Pressable with a chevron. A caller
// that still omits onPress keeps the original read-only presentation
// unchanged.
//
// Payer identity is passed in ALREADY RESOLVED (never a raw uid) - this
// component does no Firestore reads/subscriptions of its own, matching
// AvatarCircle's own established "pass a safe resolved label" contract
// (src/theme's own callers already resolve uid -> display identity
// themselves, e.g. BucketCard's avatarForUid).
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { AvatarCircle } from "../buckets/AvatarCircle";
import { radii, spacing } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { formatCurrency, formatTransactionTimestamp } from "../../utils/format";
import type { Expense } from "../../src/types/domain";
import { StatusChip } from "./StatusChip";

// Discriminated on how this Expense was paid - never fabricates a
// personal payer for a shared_stash-funded Expense (§15/§21 of the
// checkpoint prompt). For "member", avatarLabel/nameLabel are both
// already-resolved, UID-free display strings (e.g. real initials/name, or
// the frozen "Loading member…"/"Trip member"[ N] fallback copy - never a
// UID or UID-derived string of any kind).
export type ExpenseRowPayer =
  | { kind: "shared_stash" }
  | { kind: "member"; avatarLabel: string; nameLabel: string; photoURL?: string };

export function ExpenseRow({
  expense,
  payer,
  onPress,
}: {
  expense: Expense;
  payer: ExpenseRowPayer;
  onPress?: () => void;
}) {
  const colors = useSemanticColors();

  const isReversed = expense.status === "reversed";
  const isCorrection = !!expense.replacesExpenseId;

  const amountText = formatCurrency(expense.amountMinor / 100);
  const timestampText = formatTransactionTimestamp(expense.occurredAt ?? expense.createdAt);
  const paidLine =
    payer.kind === "shared_stash" ? "Paid from Shared Stash" : `Paid by ${payer.nameLabel}`;

  // Muted, not strikethrough - avoids "unreadable history" while still
  // reading as past-tense/no-longer-counting (§10/§16).
  const primaryColor = isReversed ? colors.textMuted : colors.textPrimary;

  const content = (
    <>
      <View style={styles.leftSlot}>
        {payer.kind === "shared_stash" ? (
          <View style={[styles.sourceBubble, { backgroundColor: colors.bluePale }]}>
            <MaterialCommunityIcons name="account-group-outline" size={14} color={colors.blue} />
          </View>
        ) : (
          <AvatarCircle index={0} label={payer.avatarLabel} photoURL={payer.photoURL} size={32} />
        )}
      </View>

      <View style={styles.centerSlot}>
        <Text numberOfLines={1} style={[styles.description, { color: primaryColor }]}>
          {expense.description}
        </Text>
        <Text numberOfLines={1} style={[styles.metaLine, { color: colors.textMuted }]}>
          {paidLine} · {timestampText}
        </Text>
        {/* Checkpoint 4D.5 §21/§23: "Reversed" and "Correction" are
            INDEPENDENT facts - a reversed correction/replacement shows
            BOTH chips together. "Reversed" is always the primary
            current-state signal; "Correction" stays purely informational
            lineage, never implying the correction currently counts once
            reversed. */}
        {isReversed || isCorrection ? (
          <View style={styles.chipRow}>
            {isReversed ? <StatusChip label="Reversed" tone="neutral" /> : null}
            {isCorrection ? <StatusChip label="Correction" tone="info" /> : null}
          </View>
        ) : null}
      </View>

      <View style={styles.rightSlot}>
        <Text style={[styles.amount, { color: primaryColor }]}>{amountText}</Text>
        {onPress ? (
          <MaterialCommunityIcons name="chevron-right" size={16} color={colors.textMuted} />
        ) : null}
      </View>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`View expense ${expense.description}`}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: colors.border },
          pressed && { opacity: 0.7 },
        ]}
      >
        {content}
      </Pressable>
    );
  }

  return <View style={[styles.row, { borderBottomColor: colors.border }]}>{content}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  leftSlot: { paddingTop: 2 },
  sourceBubble: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  centerSlot: { flex: 1, minWidth: 0 },
  description: { fontSize: 14, fontWeight: "700" },
  metaLine: { fontSize: 12, fontWeight: "500", marginTop: 2 },
  chipRow: { flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs },
  rightSlot: { flexDirection: "row", alignItems: "center", gap: 2, marginLeft: spacing.sm },
  amount: { fontSize: 14, fontWeight: "800" },
});
