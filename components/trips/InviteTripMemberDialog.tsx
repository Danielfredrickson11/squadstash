// Invite Member dialog (Checkpoint 6.2) - follows components/balances/
// RecordSettlementDialog.tsx's proven Modal architecture exactly:
// transparent, fade Modal; KeyboardAvoidingView; an absolute-fill
// backdrop Pressable as a SIBLING of the centered card (never its
// parent - the repeated, deliberate fix for the RN-Web focus/
// containment bug already established across this codebase); dismissal
// blocked while submitting; never window.confirm/Alert.alert. Unlike
// that dialog (fully controlled - Trip Detail owns all its state), this
// one is self-contained: it owns the email field, the Terms-prerequisite
// gate, the submit lifecycle, and the trusted createTripInvitation call
// itself - mirroring TripTermsEditor.tsx's own self-owned-state
// convention from Checkpoint 6.3, not RecordSettlementDialog's.
//
// FROZEN INVARIANT (6.2 preflight, carried from the 5A/5C architecture):
// this dialog never writes trips.memberIds, never creates
// tripMembershipAcceptances evidence, and never calls lookupUserByEmail
// - createTripInvitation already resolves email -> uid server-side,
// AFTER confirming owner authorization, specifically to avoid exposing
// an email-enumeration oracle. Calling lookupUserByEmail first (the
// older Buckets pattern) would reintroduce exactly that oracle.
//
// Terms gate (6.2 preflight §4): stricter than the backend on purpose -
// this dialog never attempts createTripInvitation at all unless
// fetchCurrentTripTerms(tripId) first proves current terms exist. No
// Terms-editing UI is duplicated here - "Set Up Trip Terms" navigates to
// the existing Checkpoint 6.3 route instead.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Text, TextInput, useTheme } from "react-native-paper";
import { useRouter } from "expo-router";

import { useAuth } from "../../src/contexts/AuthContext";
import { createTripInvitation } from "../../src/services/firebase/tripInvitations";
import { fetchCurrentTripTerms } from "../../src/services/firebase/tripTerms";
import { radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";

type TermsGateState = "checking" | "ready" | "missing" | "error";

function isLikelyValidEmail(value: string): boolean {
  return value.length > 0 && value.includes("@");
}

// Local error mapper - mirrors expenses/create.tsx's and
// TripTermsEditor.tsx's own per-screen-mapper convention exactly (never
// a shared app-wide abstraction). Re-derived directly from
// functions/src/callables/createTripInvitation.ts's actual source
// (Checkpoint 6.2 preflight §15), never from parsing its human-readable
// message text and never from an invented `details.reason`:
// - invalid-argument: the ONLY non-blank-email cause the backend can
//   produce is the self-invite check (blank tripId never happens here,
//   and blank inviteeEmail is already rejected by this dialog's own
//   isLikelyValidEmail gate before the callable is ever reached) - so
//   this mapping is a deliberate, source-justified deduction, not a
//   guess.
// - failed-precondition: assertTripInvitationAuthorized's only
//   failed-precondition throw site is the archived-Trip check - there
//   is no other failed-precondition condition in this callable.
// - already-exists: the callable throws this for BOTH "already a
//   member" and "an invitation already exists," with no structured
//   `details` distinguishing them - so this uses one truthful generic
//   message rather than guessing which case occurred (preflight §13/§14).
export function inviteTripMemberErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null | undefined)?.code;
  switch (code) {
    case "functions/unauthenticated":
      return "Please sign in and try again.";
    case "functions/invalid-argument":
      return "You can't invite yourself to your own trip.";
    case "functions/permission-denied":
      return "Only the trip owner can invite members.";
    case "functions/failed-precondition":
      return "This trip is archived and can no longer accept new members.";
    case "functions/not-found":
      return "We couldn't find a SquadStash account with that email.";
    case "functions/already-exists":
      return "This person is already a member of this trip, or has already been invited.";
    default:
      return "Something went wrong sending the invitation. Please try again.";
  }
}

export function InviteTripMemberDialog({
  visible,
  tripId,
  onClose,
  onSent,
}: {
  visible: boolean;
  tripId: string;
  onClose: () => void;
  onSent: (normalizedEmail: string) => void;
}) {
  const theme = useTheme();
  const colors = useSemanticColors();
  const router = useRouter();
  const { user } = useAuth();

  const [termsGate, setTermsGate] = useState<TermsGateState>("checking");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);

  // Review fix: a request-generation guard. Every terms-gate check
  // (initial open, a later reopen, or a manual Retry) increments this
  // ref and captures its own value as `requestId` - only the call whose
  // requestId still matches the ref's CURRENT value when its promise
  // settles is allowed to call setTermsGate. This makes "the latest
  // request wins" structural: an older, still-in-flight check can never
  // overwrite a newer one's result, no matter which order their
  // promises actually resolve in (open -> close -> reopen -> B resolves
  // -> stale A resolves afterward -> A is a no-op).
  const termsGateRequestRef = useRef(0);

  const checkTermsGate = useCallback(() => {
    const requestId = ++termsGateRequestRef.current;
    setTermsGate("checking");
    fetchCurrentTripTerms(tripId)
      .then((terms) => {
        if (requestId !== termsGateRequestRef.current) return;
        setTermsGate(terms ? "ready" : "missing");
      })
      .catch((e) => {
        console.log("InviteTripMemberDialog terms gate check error:", e);
        if (requestId !== termsGateRequestRef.current) return;
        setTermsGate("error");
      });
  }, [tripId]);

  // Re-runs fresh every time the dialog opens - terms may have been
  // published since the last time it was open, and this must never use
  // a stale cached answer. When the dialog CLOSES, there may be no
  // later checkTermsGate() call to naturally supersede a still-pending
  // request (the component stays mounted, only hidden) - so closing
  // must itself bump the ref, invalidating that request before it can
  // ever resolve into state nobody asked for anymore.
  useEffect(() => {
    if (!visible) {
      termsGateRequestRef.current += 1;
      return;
    }
    setEmail("");
    setSubmitError(null);
    checkTermsGate();
  }, [visible, checkTermsGate]);

  // Unmount-safety: the same bump, so a request still outstanding when
  // this component unmounts entirely can never call setState afterward.
  useEffect(() => {
    return () => {
      termsGateRequestRef.current += 1;
    };
  }, []);

  const guardedClose = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  const onGoSetUpTerms = useCallback(() => {
    onClose();
    router.push({
      pathname: "/(tabs)/trips/[tripId]/terms",
      params: { tripId, mode: "edit" },
    });
  }, [onClose, router, tripId]);

  const onSend = useCallback(async () => {
    if (submitInFlightRef.current) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!isLikelyValidEmail(normalizedEmail)) {
      setSubmitError("Please enter a valid email address.");
      return;
    }
    const ownEmail = user?.email?.trim().toLowerCase();
    if (ownEmail && normalizedEmail === ownEmail) {
      setSubmitError("You can't invite yourself to your own trip.");
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await createTripInvitation(tripId, normalizedEmail);
      onSent(normalizedEmail);
    } catch (e) {
      console.log("createTripInvitation error:", e);
      setSubmitError(inviteTripMemberErrorMessage(e));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }, [email, user, tripId, onSent]);

  let body: React.ReactNode;
  if (termsGate === "checking") {
    body = (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={[styles.loadingText, { color: colors.textMuted }]}>
          Checking Trip Terms…
        </Text>
      </View>
    );
  } else if (termsGate === "error") {
    body = (
      <>
        <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
          We couldn&apos;t check this trip&apos;s Terms safely. Please try again.
        </Text>
        <Pressable
          onPress={checkTermsGate}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          style={styles.inlineRetry}
        >
          <Text style={[styles.inlineRetryText, { color: colors.blue }]}>Try again</Text>
        </Pressable>
      </>
    );
  } else if (termsGate === "missing") {
    body = (
      <>
        <Text style={[styles.dialogBody, { color: colors.textPrimary }]}>
          Trip Terms are required before inviting members.
        </Text>
        <Text style={[styles.dialogBody, { color: colors.textMuted }]}>
          Members must review the current Trip Terms before they can join.
        </Text>
        <Pressable
          onPress={onGoSetUpTerms}
          accessibilityRole="button"
          accessibilityLabel="Set Up Trip Terms"
          style={[styles.confirmBtn, { backgroundColor: colors.mint }]}
        >
          <Text style={[styles.confirmText, { color: colors.onMint }]}>Set Up Trip Terms</Text>
        </Pressable>
      </>
    );
  } else {
    body = (
      <>
        <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>Email address</Text>
        <TextInput
          mode="outlined"
          dense
          placeholder="person@example.com"
          value={email}
          onChangeText={setEmail}
          editable={!submitting}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          accessibilityLabel="Email address"
          style={styles.emailInput}
        />
        {submitError ? (
          <Text style={[styles.errorText, { color: colors.coral }]}>{submitError}</Text>
        ) : null}
      </>
    );
  }

  const showCancelOnly = termsGate === "checking" || termsGate === "error" || termsGate === "missing";

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
          <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>Invite Member</Text>

          {body}

          <View style={styles.dialogActions}>
            <Pressable
              onPress={guardedClose}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={[styles.cancelBtn, { borderColor: colors.border }, submitting && { opacity: 0.5 }]}
            >
              <Text style={[styles.cancelText, { color: colors.textPrimary }]}>Cancel</Text>
            </Pressable>
            {showCancelOnly ? null : (
              <Pressable
                onPress={onSend}
                disabled={submitting}
                accessibilityRole="button"
                accessibilityLabel="Send Invitation"
                style={[
                  styles.confirmBtn,
                  styles.confirmBtnFlex,
                  { backgroundColor: colors.mint },
                  submitting && { opacity: 0.6 },
                ]}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={colors.onMint} />
                ) : (
                  <Text style={[styles.confirmText, { color: colors.onMint }]}>Send Invitation</Text>
                )}
              </Pressable>
            )}
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

  fieldLabel: { fontSize: 12, fontWeight: "700", marginBottom: spacing.xs },
  emailInput: { marginBottom: spacing.xs },
  errorText: { fontSize: 12, fontWeight: "700", marginTop: spacing.xs },

  loadingWrap: { paddingVertical: spacing.md, alignItems: "center", gap: 10 },
  loadingText: { fontSize: 13, fontWeight: "600" },

  inlineRetry: { marginTop: spacing.xs },
  inlineRetryText: { fontSize: 13, fontWeight: "700" },

  dialogActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  cancelBtn: {
    flex: 1,
    height: 46,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { fontSize: 14, fontWeight: "800" },
  confirmBtn: {
    height: 46,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  confirmBtnFlex: { flex: 1 },
  confirmText: { fontSize: 14, fontWeight: "800" },
});
