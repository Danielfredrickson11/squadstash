// Leave Trip confirmation dialog (Checkpoint 6.7C) - follows
// CancelTripInvitationDialog.tsx's proven Modal architecture exactly:
// transparent, fade Modal; KeyboardAvoidingView; an absolute-fill
// backdrop Pressable as a SIBLING of the centered card; dismissal
// blocked while submitting; never window.confirm/Alert.alert. This
// dialog is self-contained: it owns only its own in-flight/error state
// and the actual trusted leaveTrip call - it never mutates memberIds
// itself, never reads/writes tripMembershipDepartures (fully
// Rules-closed - see firestore.rules), and never uses any client-side
// financial value as authorization. The backend remains the sole
// authority for whether departure succeeds.
//
// 6.7C locked decision: a functions/failed-precondition failure always
// maps to ONE generic, safe message - never parsed from the raw backend
// error text, which could otherwise disclose financial detail (an exact
// amount or balance direction) this dialog must never state.
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

import { leaveTrip } from "../../src/services/firebase/trips";
import { radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";

// Checkpoint 6.7C (frozen copy) - never shown as raw Firebase/HttpsError
// text, always this exact safe message. Deliberately does not attempt
// to distinguish ownership-remains from balance-remains from any other
// backend-internal failed-precondition sub-reason.
export const LEAVE_TRIP_NOT_READY_MESSAGE =
  "This trip isn't ready for you to leave yet. Make sure your Shared Stash ownership is fully cleared and your trip balance is fully settled, then try again.";

function leaveTripErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null | undefined)?.code;
  switch (code) {
    case "functions/permission-denied":
      return "You don't have permission to leave this trip.";
    case "functions/not-found":
      return "This trip could not be found.";
    case "functions/failed-precondition":
      return LEAVE_TRIP_NOT_READY_MESSAGE;
    case "functions/unauthenticated":
      return "You need to be signed in to leave this trip.";
    case "functions/invalid-argument":
      return "Something went wrong with that request. Please try again.";
    case "functions/unavailable":
    case "functions/deadline-exceeded":
      return "We couldn't reach the server, so we can't confirm this went through - it's safe to try again.";
    default:
      return "We couldn't leave this trip. Please try again.";
  }
}

export function LeaveTripDialog({
  visible,
  tripId,
  onClose,
  onLeft,
}: {
  visible: boolean;
  tripId: string;
  onClose: () => void;
  onLeft: () => void;
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
    if (submitInFlightRef.current || !tripId) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await leaveTrip(tripId);
      // A replayed exact-match success (Checkpoint 6.7B1 §7) returns the
      // same result as a first-time success - treated identically here,
      // never as a distinct "already left" case.
      onLeft();
    } catch (e) {
      // Never logs the raw caught error/message - it may carry
      // backend-internal detail (Checkpoint 6.7C locked decision). The
      // safe, mapped message below is the only thing ever surfaced.
      setErrorMessage(leaveTripErrorMessage(e));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }, [tripId, onLeft]);

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
            Leave Trip?
          </Text>

          <Text style={[styles.dialogBody, { color: colors.textPrimary }]}>
            You can only leave once your Shared Stash ownership is fully
            cleared and your trip balance is fully settled.
          </Text>
          <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
            You currently cannot rejoin this trip after leaving.
          </Text>
          <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
            Your past expenses and settlements on this trip stay as they are.
          </Text>
          <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
            Your own My Stash savings for this trip are not affected.
          </Text>

          {errorMessage ? (
            <Text style={[styles.errorText, { color: colors.coral }]}>{errorMessage}</Text>
          ) : null}

          <View style={styles.dialogActions}>
            <Button
              mode="outlined"
              onPress={guardedClose}
              disabled={submitting}
              accessibilityLabel="Stay in Trip"
            >
              Stay in Trip
            </Button>
            <View style={{ width: spacing.sm }} />
            <Button
              mode="contained"
              onPress={onConfirm}
              loading={submitting}
              disabled={submitting}
              accessibilityLabel="Leave Trip"
            >
              Leave Trip
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
