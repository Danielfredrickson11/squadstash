// Trip Terms edit + review + publish flow (Checkpoint 6.3), per the
// approved preflight. Mounted only from the owner-only edit entry point
// on app/(tabs)/trips/[tripId]/terms.tsx - this component owns the
// entire five-field form, client-side trim/validation, the Review step,
// and the actual trusted publishTripTerms call. It never fetches
// current terms itself (the route already did, and passes the result
// in as `initialTerms`) and never decides who may reach it - rendering
// this component is a UX convenience, never a security boundary; the
// trusted publishTripTerms callable remains the sole, backend-enforced
// owner-authorization gate regardless of what reaches this component.
//
// FROZEN INVARIANT (preflight §9/§11): no persistent draft document -
// all five fields live only in this component's own local state until
// Publish succeeds. Publishing always creates a brand-new immutable
// tripTerms version; this component never updates an existing one, and
// never lets the caller choose the actual version number sent to the
// backend - the "Version N will become current" review copy is
// explanatory UI only, computed from the last-known current version,
// and is overwritten by the server's own returned version on success.
import React, { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Text, TextInput, useTheme } from "react-native-paper";

import { publishTripTerms } from "../../src/services/firebase/tripTerms";
import { radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import type { TripTerms } from "../../src/types/domain";

export const MAX_FIELD_LENGTH = 2000;

export const TERMS_FIELD_DEFS = [
  { key: "contributionExpectations", label: "Contribution Expectations" },
  { key: "expenseAllocationExpectations", label: "Expense Allocation Expectations" },
  { key: "sharedStashSpendingAuthority", label: "Shared Stash Spending Authority" },
  { key: "withdrawalExpectations", label: "Withdrawal Expectations" },
  { key: "settlementExpectations", label: "Settlement Expectations" },
] as const;

export type TripTermsFieldKey = (typeof TERMS_FIELD_DEFS)[number]["key"];
export type TripTermsFieldsState = Record<TripTermsFieldKey, string>;

export const EMPTY_TERMS_FIELDS: TripTermsFieldsState = {
  contributionExpectations: "",
  expenseAllocationExpectations: "",
  sharedStashSpendingAuthority: "",
  withdrawalExpectations: "",
  settlementExpectations: "",
};

export function fieldsFromTerms(terms: TripTerms): TripTermsFieldsState {
  return {
    contributionExpectations: terms.contributionExpectations,
    expenseAllocationExpectations: terms.expenseAllocationExpectations,
    sharedStashSpendingAuthority: terms.sharedStashSpendingAuthority,
    withdrawalExpectations: terms.withdrawalExpectations,
    settlementExpectations: terms.settlementExpectations,
  };
}

function trimFields(fields: TripTermsFieldsState): TripTermsFieldsState {
  const result = {} as TripTermsFieldsState;
  for (const { key } of TERMS_FIELD_DEFS) {
    result[key] = fields[key].trim();
  }
  return result;
}

function isFieldValid(value: string): boolean {
  return value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

// Expects already-trimmed fields - the only form this is ever called
// with (see onReview/onPublish below), matching this checkpoint's own
// "trim, then validate the trimmed value" ordering.
function allFieldsValid(fields: TripTermsFieldsState): boolean {
  return TERMS_FIELD_DEFS.every(({ key }) => isFieldValid(fields[key]));
}

// Local error mapper - mirrors expenses/create.tsx's own
// expenseErrorMessage convention exactly (a per-screen mapper, never a
// shared app-wide abstraction). `knownArchived` lets this show the
// specific archived-Trip copy only when the caller already independently
// knows that fact from its own freshly-loaded Trip - never guessed from
// the error code alone, since publishTripTerms.ts returns the same
// failed-precondition code for both an archived Trip and a corrupt
// current-terms pointer.
export function publishTermsErrorMessage(e: unknown, knownArchived: boolean): string {
  const code = (e as { code?: string } | null | undefined)?.code;
  switch (code) {
    case "functions/invalid-argument":
      return "Please fill in every section. Each section can contain up to 2,000 characters.";
    case "functions/permission-denied":
      return "Only the trip owner can publish Trip Terms.";
    case "functions/not-found":
      return "This trip could not be found.";
    case "functions/failed-precondition":
      return knownArchived
        ? "This trip is archived and can no longer publish new terms."
        : "We couldn't load the current Trip Terms safely. Please try again or contact support.";
    default:
      return "Something went wrong publishing Trip Terms. Please try again.";
  }
}

export function TripTermsEditor({
  tripId,
  initialTerms,
  isArchived,
  onCancel,
  onPublished,
}: {
  tripId: string;
  initialTerms: TripTerms | null;
  isArchived: boolean;
  onCancel: () => void;
  onPublished: (result: { id: string; version: number }) => void;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();

  const [mode, setMode] = useState<"edit" | "review">("edit");
  const [fields, setFields] = useState<TripTermsFieldsState>(
    initialTerms ? fieldsFromTerms(initialTerms) : EMPTY_TERMS_FIELDS
  );
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);

  const nextVersion = (initialTerms?.version ?? 0) + 1;

  const onChangeField = useCallback((key: TripTermsFieldKey, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  }, []);

  const canReview = useMemo(() => allFieldsValid(trimFields(fields)), [fields]);

  const onReview = useCallback(() => {
    const trimmed = trimFields(fields);
    if (!allFieldsValid(trimmed)) return;
    setFields(trimmed);
    setPublishError(null);
    setMode("review");
  }, [fields]);

  const onBackToEdit = useCallback(() => {
    setMode("edit");
  }, []);

  const onPublish = useCallback(async () => {
    if (submitInFlightRef.current) return;
    const trimmed = trimFields(fields);
    if (!allFieldsValid(trimmed)) return;

    submitInFlightRef.current = true;
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await publishTripTerms({ tripId, ...trimmed });
      onPublished(result);
    } catch (e) {
      console.log("publishTripTerms error:", e);
      setPublishError(publishTermsErrorMessage(e, isArchived));
    } finally {
      submitInFlightRef.current = false;
      setPublishing(false);
    }
  }, [tripId, fields, isArchived, onPublished]);

  if (mode === "review") {
    return (
      <View style={styles.wrap}>
        <Text style={[styles.reviewNotice, { color: theme.colors.onBackground }]}>
          Publishing creates a new version of the Trip Terms. Version {nextVersion} will become
          the current Trip Terms.
        </Text>

        {TERMS_FIELD_DEFS.map(({ key, label }) => (
          <View
            key={key}
            style={[
              styles.fieldCard,
              { backgroundColor: theme.colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{label}</Text>
            <Text style={[styles.fieldValue, { color: theme.colors.onSurface }]}>
              {fields[key]}
            </Text>
          </View>
        ))}

        {publishError ? (
          <Text style={[styles.errorText, { color: colors.coral }]}>{publishError}</Text>
        ) : null}

        <View style={styles.actionsRow}>
          <Button
            mode="outlined"
            onPress={onBackToEdit}
            disabled={publishing}
            accessibilityLabel="Back"
          >
            Back
          </Button>
          <View style={{ width: spacing.sm }} />
          <Button
            mode="contained"
            buttonColor={theme.colors.primary}
            textColor={theme.colors.onPrimary}
            onPress={onPublish}
            loading={publishing}
            disabled={publishing}
            accessibilityLabel="Publish Terms"
          >
            Publish Terms
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {TERMS_FIELD_DEFS.map(({ key, label }) => {
        const value = fields[key];
        const over = value.length > MAX_FIELD_LENGTH;
        return (
          <View key={key} style={styles.fieldWrap}>
            <TextInput
              mode="outlined"
              label={label}
              value={value}
              onChangeText={(text) => onChangeField(key, text)}
              multiline
              editable={!publishing}
              accessibilityLabel={label}
              style={styles.input}
            />
            <Text
              style={[
                styles.charCount,
                { color: over ? colors.coral : colors.textMuted },
              ]}
            >
              {value.length} / {MAX_FIELD_LENGTH}
            </Text>
          </View>
        );
      })}

      <View style={styles.actionsRow}>
        <Button
          mode="outlined"
          onPress={onCancel}
          disabled={publishing}
          accessibilityLabel="Cancel"
        >
          Cancel
        </Button>
        <View style={{ width: spacing.sm }} />
        <Button
          mode="contained"
          onPress={onReview}
          disabled={!canReview || publishing}
          accessibilityLabel="Review Terms"
        >
          Review Terms
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  fieldWrap: { gap: spacing.xs },
  input: { minHeight: 90 },
  charCount: { fontSize: 11, fontWeight: "600", textAlign: "right" },
  actionsRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: spacing.sm },
  reviewNotice: { ...typography.body, fontWeight: "700" },
  fieldCard: { borderRadius: radii.lg, borderWidth: 1, padding: spacing.md },
  fieldLabel: { ...typography.meta, fontWeight: "700", marginBottom: spacing.xs },
  fieldValue: { ...typography.body },
  errorText: { fontWeight: "700", fontSize: 13 },
});
