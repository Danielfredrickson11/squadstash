// Per-participant custom dollar-amount input rows for the "custom" split
// strategy (Checkpoint 4D.4 §15/§34). Presentation only - receives
// already-resolved member display data and raw per-uid text/error maps
// from its parent (AddExpenseForm); does no parsing/validation itself.
// An intentional $0 share remains a fully visible, editable row - never
// hidden or specially treated.
import React from "react";
import { StyleSheet, View } from "react-native";
import { Text, TextInput } from "react-native-paper";

import { AvatarCircle } from "../buckets/AvatarCircle";
import { spacing, type SemanticColors } from "../../src/theme/tokens";
import type { MemberOption } from "./AddExpenseForm";

export type CustomSplitInputsProps = {
  colors: SemanticColors;
  participants: MemberOption[];
  values: Record<string, string>;
  errors: Record<string, string>;
  onChangeValue: (uid: string, value: string) => void;
  aggregateText: string | null;
  aggregateError: string | null;
  disabled: boolean;
};

export function CustomSplitInputs({
  colors,
  participants,
  values,
  errors,
  onChangeValue,
  aggregateText,
  aggregateError,
  disabled,
}: CustomSplitInputsProps) {
  return (
    <View style={styles.wrap}>
      {participants.map((member) => (
        <View key={member.uid} style={styles.row}>
          <AvatarCircle index={0} label={member.avatarLabel} photoURL={member.photoURL} size={26} />
          <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
            {member.isCurrentUser ? `${member.nameLabel} · You` : member.nameLabel}
          </Text>
          <View style={styles.inputSlot}>
            <TextInput
              mode="outlined"
              dense
              placeholder="0.00"
              left={<TextInput.Affix text="$" />}
              value={values[member.uid] ?? ""}
              onChangeText={(v) => onChangeValue(member.uid, v)}
              keyboardType="numeric"
              editable={!disabled}
              style={styles.input}
            />
            {errors[member.uid] ? (
              <Text style={[styles.errorText, { color: colors.coral }]}>{errors[member.uid]}</Text>
            ) : null}
          </View>
        </View>
      ))}

      {aggregateError ? (
        <Text style={[styles.aggregateError, { color: colors.coral }]}>{aggregateError}</Text>
      ) : aggregateText ? (
        <Text style={[styles.aggregateText, { color: colors.textSecondary }]}>{aggregateText}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm, gap: spacing.xs },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  name: { flex: 1, fontSize: 13, fontWeight: "700", marginTop: spacing.sm },
  inputSlot: { width: 130 },
  input: { height: 40 },
  errorText: { fontSize: 11, fontWeight: "700", marginTop: 2 },
  aggregateText: { fontSize: 12, fontWeight: "800", marginTop: spacing.xs },
  aggregateError: { fontSize: 12, fontWeight: "800", marginTop: spacing.xs },
});
