// Single-row presentation for one Expense in the Trip Detail summary
// card AND the full Expense list route (Checkpoint 4D.2) - one shared
// component, not two differently-shaped implementations (per the frozen
// docs/audits/TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §5/§15/§16).
//
// Read-only in 4D.2 (§5/§27 of the checkpoint prompt): no Pressable, no
// onPress, no accessibilityRole="button" - this is deliberate. Expense
// Detail does not exist until 4D.5; this row must not look or behave like
// an unfinished navigation affordance in the meantime.
//
// Payer identity is passed in ALREADY RESOLVED (never a raw uid) - this
// component does no Firestore reads/subscriptions of its own, matching
// AvatarCircle's own established "pass a safe resolved label" contract
// (src/theme's own callers already resolve uid -> display identity
// themselves, e.g. BucketCard's avatarForUid).
import React from "react";
import { StyleSheet, View } from "react-native";
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

export function ExpenseRow({ expense, payer }: { expense: Expense; payer: ExpenseRowPayer }) {
  const colors = useSemanticColors();

  const isReversed = expense.status === "reversed";
  // Per §17 of the checkpoint prompt: if status is "reversed", "Reversed"
  // is the ONLY chip shown - a reversed replacement never also shows
  // "Correction", even though replacesExpenseId is still set on it.
  const isCorrection = !isReversed && !!expense.replacesExpenseId;

  const amountText = formatCurrency(expense.amountMinor / 100);
  const timestampText = formatTransactionTimestamp(expense.occurredAt ?? expense.createdAt);
  const paidLine =
    payer.kind === "shared_stash" ? "Paid from Shared Stash" : `Paid by ${payer.nameLabel}`;

  // Muted, not strikethrough - avoids "unreadable history" while still
  // reading as past-tense/no-longer-counting (§10/§16).
  const primaryColor = isReversed ? colors.textMuted : colors.textPrimary;

  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
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
        {isReversed ? (
          <View style={styles.chipRow}>
            <StatusChip label="Reversed" tone="neutral" />
          </View>
        ) : isCorrection ? (
          <View style={styles.chipRow}>
            <StatusChip label="Correction" tone="info" />
          </View>
        ) : null}
      </View>

      <Text style={[styles.amount, { color: primaryColor }]}>{amountText}</Text>
    </View>
  );
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
  chipRow: { flexDirection: "row", marginTop: spacing.xs },
  amount: { fontSize: 14, fontWeight: "800", marginLeft: spacing.sm },
});
