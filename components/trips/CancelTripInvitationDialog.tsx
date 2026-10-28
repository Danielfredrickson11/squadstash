// Cancel Invitation confirmation dialog (Checkpoint 6.5) - follows
// InviteTripMemberDialog.tsx's proven Modal architecture exactly:
// transparent, fade Modal; KeyboardAvoidingView; an absolute-fill
// backdrop Pressable as a SIBLING of the centered card; dismissal
// blocked while submitting; never window.confirm/Alert.alert. This
// dialog is self-contained: it owns only its own in-flight/error state
// and the actual trusted cancelTripInvitation call - it never fetches
// the invitation list itself, never touches membership/financial state,
// and never implements any re-invite workaround.
//
// FROZEN INVARIANT (6.5 preflight §4/§14): cancellation remains a
// direct Firestore write, gated entirely by firestore.rules (owner-only,
// pending -> cancelled, locked field diff) - this dialog never attempts
// to compensate for or second-guess a Rules rejection. A
// "permission-denied" result means the invitation's state already
// changed underneath the owner (most plausibly: the invitee accepted it
// first, Checkpoint 6.5's own approved cancel-vs-accept race analysis) -
// the only safe response is to close and let the parent re-fetch
// authoritative state, never to retry the same write or infer what
// actually happened from the error text.
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

import { cancelTripInvitation } from "../../src/services/firebase/tripInvitations";
import { radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import type { TripInvitation } from "../../src/types/domain";

// Checkpoint 6.5 preflight §14 (frozen copy) - never shown as raw
// Firestore error text, always this exact safe message.
export const CANCEL_STATE_CHANGED_MESSAGE =
  "This invitation has already changed. Refreshing its latest status.";

export function CancelTripInvitationDialog({
  visible,
  tripId,
  invitation,
  onClose,
  onCancelled,
  onStateChanged,
}: {
  visible: boolean;
  tripId: string;
  invitation: TripInvitation | null;
  onClose: () => void;
  onCancelled: () => void;
  onStateChanged: (message: string) => void;
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
    if (submitInFlightRef.current || !invitation) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await cancelTripInvitation(tripId, invitation.inviteeUid);
      onCancelled();
    } catch (e) {
      console.log("cancelTripInvitation error:", e);
      const code = (e as { code?: string } | null | undefined)?.code;
      if (code === "permission-denied") {
        // The invitation's state already changed underneath the owner -
        // never leave this confirmation open against stale state, and
        // never retry the write ourselves. Hand the safe message to the
        // parent, which closes this dialog and re-fetches.
        onStateChanged(CANCEL_STATE_CHANGED_MESSAGE);
        return;
      }
      setErrorMessage("Something went wrong cancelling the invitation. Please try again.");
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }, [tripId, invitation, onCancelled, onStateChanged]);

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
            Cancel Invitation?
          </Text>

          <Text style={[styles.dialogBody, { color: colors.textPrimary }]}>
            Cancel the invitation to {invitation?.inviteeEmail ?? ""}?
          </Text>
          <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
            They will no longer be able to accept this invitation.
          </Text>
          <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
            You currently cannot re-invite this person to this trip.
          </Text>

          {errorMessage ? (
            <Text style={[styles.errorText, { color: colors.coral }]}>{errorMessage}</Text>
          ) : null}

          <View style={styles.dialogActions}>
            <Button
              mode="outlined"
              onPress={guardedClose}
              disabled={submitting}
              accessibilityLabel="Keep Invitation"
            >
              Keep Invitation
            </Button>
            <View style={{ width: spacing.sm }} />
            <Button
              mode="contained"
              onPress={onConfirm}
              loading={submitting}
              disabled={submitting}
              accessibilityLabel="Cancel Invitation"
            >
              Cancel Invitation
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
