// Single-row presentation for one persisted Settlement record in the
// Settlement-history section of the Balances card (Checkpoint 4E.7).
// Modeled structurally on components/expenses/ExpenseRow.tsx (avatar +
// description/meta column + amount) and reuses the optional-action
// placement pattern already established by components/balances/
// BalanceRow.tsx's Settle Up action (a compact control on its own line,
// indented past the avatar, as a SIBLING of the accessible summary
// group - never nested inside it). Pure presentation only: no Firebase,
// no mutation service, no navigation. `from`/`to` identity must already
// be resolved by the caller - never a raw uid.
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { AvatarCircle } from "../buckets/AvatarCircle";
import { StatusChip } from "../expenses/StatusChip";
import { radii, spacing } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { formatCurrency } from "../../utils/format";

export type SettlementRowFromMember = {
  avatarLabel: string;
  nameLabel: string;
  photoURL?: string;
};

export type SettlementRowToMember = {
  nameLabel: string;
};

const AVATAR_SIZE = 32;

export function SettlementRow({
  from,
  to,
  amountMinor,
  methodLabel,
  timestampLabel,
  note,
  reversed,
  reversalReason,
  onReverse,
  reverseAccessibilityLabel,
}: {
  from: SettlementRowFromMember;
  to: SettlementRowToMember;
  amountMinor: number;
  methodLabel: string;
  timestampLabel: string;
  note?: string;
  reversed: boolean;
  // Present only when reversed - purely informational, never implying
  // the original financial facts changed (Checkpoint 4E.7 §8).
  reversalReason?: string;
  onReverse?: () => void;
  reverseAccessibilityLabel?: string;
}) {
  const colors = useSemanticColors();
  const amountText = formatCurrency(amountMinor / 100);
  // Muted, not strikethrough - reversal is historical correction, never
  // deletion; history stays legible/auditable (§8).
  const primaryColor = reversed ? colors.textMuted : colors.textPrimary;
  const summaryAccessibilityLabel = `${from.nameLabel} paid ${to.nameLabel} ${amountText} via ${methodLabel} on ${timestampLabel}${reversed ? ", reversed" : ""}`;

  return (
    <View style={[styles.container, { borderBottomColor: colors.border }]}>
      {/* This accessible group covers ONLY the settlement summary - the
          Reverse button below is a SIBLING, never a descendant, so it
          is never swallowed by this group (§13). */}
      <View style={styles.row} accessible accessibilityLabel={summaryAccessibilityLabel}>
        <View style={styles.leftSlot}>
          <AvatarCircle index={0} label={from.avatarLabel} photoURL={from.photoURL} size={AVATAR_SIZE} />
        </View>

        <View style={styles.centerSlot}>
          <Text numberOfLines={1} style={[styles.line, { color: primaryColor }]}>
            <Text style={styles.strong}>{from.nameLabel}</Text> paid {to.nameLabel}
          </Text>
          {/* Checkpoint 4E.7A §5: no numberOfLines cap here - on a
              narrow phone, "<method> · <timestamp>" can otherwise
              truncate the timestamp itself mid-string, which is a real
              audit-readability concern. Only the primary identity line
              above stays one-line/truncated. */}
          <Text style={[styles.metaLine, { color: colors.textMuted }]}>
            {methodLabel} · {timestampLabel}
          </Text>
          {/* Checkpoint 4E.7A §4: notes/reversal reasons are audit/
              history details that may legitimately run up to 500
              characters (the normalized cap enforced server-side/by
              normalizeSettlementNote/normalizeReversalReason) - they
              must wrap and render their COMPLETE supplied text, never
              hidden behind an ellipsis via numberOfLines. */}
          {note ? (
            <Text style={[styles.noteLine, { color: colors.textMuted }]}>{note}</Text>
          ) : null}
          {reversed ? (
            <View style={styles.chipRow}>
              <StatusChip label="Reversed" tone="neutral" />
            </View>
          ) : null}
          {reversed && reversalReason ? (
            <Text style={[styles.reasonLine, { color: colors.textMuted }]}>
              Reversal reason: {reversalReason}
            </Text>
          ) : null}
        </View>

        <View style={styles.rightSlot}>
          <Text style={[styles.amount, { color: primaryColor }]}>{amountText}</Text>
        </View>
      </View>

      {onReverse ? (
        <Pressable
          onPress={onReverse}
          accessibilityRole="button"
          accessibilityLabel={reverseAccessibilityLabel ?? `Reverse settlement from ${from.nameLabel}`}
          style={({ pressed }) => [
            styles.reverseBtn,
            { borderColor: colors.border },
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={[styles.reverseBtnText, { color: colors.textPrimary }]}>Reverse settlement</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  leftSlot: { paddingTop: 2 },
  centerSlot: { flex: 1, minWidth: 0 },
  line: { fontSize: 14, fontWeight: "500" },
  strong: { fontWeight: "700" },
  metaLine: { fontSize: 12, fontWeight: "500", marginTop: 2 },
  noteLine: { fontSize: 12, fontWeight: "500", marginTop: 2 },
  chipRow: { flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs },
  reasonLine: { fontSize: 11, fontWeight: "500", marginTop: 2 },
  rightSlot: { marginLeft: spacing.sm },
  amount: { fontSize: 14, fontWeight: "800" },
  reverseBtn: {
    alignSelf: "flex-start",
    marginTop: spacing.xs,
    marginLeft: AVATAR_SIZE + spacing.sm,
    height: 32,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  reverseBtnText: { fontSize: 12, fontWeight: "700" },
});
