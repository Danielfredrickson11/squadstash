// Remove Member confirmation dialog (Checkpoint 6.7C) - follows
// CancelTripInvitationDialog.tsx's proven Modal architecture exactly:
// transparent, fade Modal; KeyboardAvoidingView; an absolute-fill
// backdrop Pressable as a SIBLING of the centered card; dismissal
// blocked while submitting; never window.confirm/Alert.alert. This
// dialog is self-contained: it owns only its own in-flight/error state
// and the actual trusted removeTripMember call - it never mutates
// memberIds itself, never reads/writes tripMembershipDepartures (fully
// Rules-closed - see firestore.rules), and never discloses the target
// member's exact Shared Stash ownership or social balance amount or
// direction. The backend remains the sole authority for whether
// removal succeeds.
//
// 6.7C locked decision: a functions/failed-precondition failure always
// maps to ONE generic, safe message - never parsed from the raw backend
// error text.
import React, { useCallback, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Button, Text, useTheme } from "react-native-paper";

import { removeTripMember } from "../../src/services/firebase/trips";
import { radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";

// Checkpoint 6.7C (frozen copy) - never shown as raw Firebase/HttpsError
// text, always this exact safe message. Deliberately does not attempt
// to distinguish ownership-remains from balance-remains from any other
// backend-internal failed-precondition sub-reason.
export const REMOVE_MEMBER_NOT_READY_MESSAGE =
  "This member can't be removed yet. Make sure their Shared Stash ownership is fully cleared and their trip balance is fully settled, then try again.";

function removeTripMemberErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null | undefined)?.code;
  switch (code) {
    case "functions/permission-denied":
      return "Only the trip owner can remove a member.";
    case "functions/not-found":
      return "This trip could not be found.";
    case "functions/failed-precondition":
      return REMOVE_MEMBER_NOT_READY_MESSAGE;
    case "functions/unauthenticated":
      return "You need to be signed in to remove a member.";
    case "functions/invalid-argument":
      return "Something went wrong with that request. Please try again.";
    case "functions/unavailable":
    case "functions/deadline-exceeded":
      return "We couldn't reach the server, so we can't confirm this went through - it's safe to try again.";
    default:
      return "We couldn't remove this member. Please try again.";
  }
}

export function RemoveTripMemberDialog({
  visible,
  tripId,
  targetUid,
  targetNameLabel,
  onClose,
  onRemoved,
}: {
  visible: boolean;
  tripId: string;
  targetUid: string | null;
  targetNameLabel: string;
  onClose: () => void;
  onRemoved: (targetUid: string) => void;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);

  const guardedClose = useCallback(() => {
    if (submitting) return;
    setErrorMessage(null);
    onClose();
  }, [submitting, onClose]);

  const onConfirm = useCallback(async () => {
    if (submitInFlightRef.current || !tripId || !targetUid) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await removeTripMember(tripId, targetUid);
      // A replayed exact-match success (Checkpoint 6.7B1 §7) returns the
      // same result as a first-time success - treated identically here.
      onRemoved(targetUid);
    } catch (e) {
      // Never logs the raw caught error/message - it may carry
      // backend-internal detail (Checkpoint 6.7C locked decision). The
      // safe, mapped message below is the only thing ever surfaced.
      setErrorMessage(removeTripMemberErrorMessage(e));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }, [tripId, targetUid, onRemoved]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={guardedClose}>
      <KeyboardAvoidingView
        style={styles.dialogRoot}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          style={styles.dialogBackdrop}
          onPress={guardedClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View
          style={[
            styles.dialogCard,
            { backgroundColor: theme.colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>
            Remove {targetNameLabel}?
          </Text>

          <Text style={[styles.dialogBody, { color: colors.textPrimary }]}>
            They can only be removed once their Shared Stash ownership is
            fully cleared and their trip balance is fully settled.
          </Text>
          <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
            They currently cannot rejoin this trip after being removed.
          </Text>

          {errorMessage ? (
            <Text style={[styles.errorText, { color: colors.coral }]}>{errorMessage}</Text>
          ) : null}

          <View style={styles.dialogActions}>
            <Button
              mode="outlined"
              onPress={guardedClose}
              disabled={submitting}
              accessibilityLabel="Keep Member"
            >
              Keep Member
            </Button>
            <View style={{ width: spacing.sm }} />
            <Button
              mode="contained"
              onPress={onConfirm}
              loading={submitting}
              disabled={submitting}
              accessibilityLabel="Remove Member"
            >
              Remove Member
            </Button>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dialogRoot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  dialogBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(9,14,26,0.55)",
  },
  dialogCard: {
    width: "100%",
    maxWidth: 380,
    borderRadius: radii.xl,
    borderWidth: 1,
    padding: spacing.lg,
  },
  dialogTitle: { ...typography.sectionTitle, fontSize: 18, marginBottom: spacing.sm },
  dialogBody: { fontSize: 14, lineHeight: 20, marginBottom: spacing.sm },
  errorText: { fontSize: 12, fontWeight: "700", marginTop: spacing.xs },
  dialogActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: spacing.lg,
  },
});
