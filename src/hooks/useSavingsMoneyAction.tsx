// Shared Personal Savings money-action controller (Milestone 3
// Checkpoint 3D).
//
// Checkpoint 3B intentionally kept money actions off the Bucket detail
// screen because the Bucket list owned the only idempotency/
// serialization state, and duplicating that state per-screen would have
// created two independent, competing clientRequestId systems for the
// same trusted write path. This file is that fix: ONE controller,
// mounted ONCE per Buckets route subtree (see
// app/(tabs)/buckets/_layout.tsx's SavingsMoneyActionProvider), exposed
// to both the Bucket list (app/(tabs)/buckets/index.tsx) and the Bucket
// detail screen (app/(tabs)/buckets/[bucketId].tsx) via the
// useSavingsMoneyAction() consumer hook below - whichever screen opens
// the sheet, there is still exactly one in-flight guard, one pending-
// request ref, and one trusted recordSavingsTransaction call site.
//
// This is deliberately NOT a general state-management library: it is a
// single React Context scoped to Personal Savings money actions only,
// holding the same kind of state the pre-3D per-screen dialogs already
// held (visible/bucket/type/amount/note/submitting/error), just with one
// owner instead of two.
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  MAX_TRANSACTION_NOTE_LENGTH,
  generateSavingsClientRequestId,
  recordSavingsTransaction,
} from "../services/firebase/savingsTransactions";
import {
  normalizeTransactionNote,
  resolveAmountMinor,
  resolveMoneyActionClientRequestId,
  type PendingMoneyActionRequest,
} from "../domain/savingsMoneyAction";
import type { Bucket, SavingsTransactionType } from "../types/domain";
import { formatCurrency } from "../../utils/format";
import { useAuth } from "../contexts/AuthContext";

// Never surfaces raw HttpsError/FirebaseError technical text - maps the
// httpsCallable client SDK's "functions/<code>" error codes (see
// functions/src/callables/recordSavingsTransaction.ts for the exact
// codes this callable can throw) to plain user-facing copy. Moved here
// from app/(tabs)/buckets/index.tsx (Checkpoint 3D) - this is now the
// sole caller of recordSavingsTransaction.
function savingsErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null | undefined)?.code;
  switch (code) {
    case "functions/failed-precondition":
      return "That amount isn't allowed right now - it may take the balance below zero, or the bucket's ledger needs attention. Please check the amount and try again.";
    case "functions/permission-denied":
      return "You do not have permission to record this transaction.";
    case "functions/already-exists":
      return "That request could not be completed. Please try again.";
    case "functions/unavailable":
    case "functions/deadline-exceeded":
      return "We couldn't reach the server, so we can't confirm this went through - it's safe to try again.";
    default:
      return "We couldn't record that. Please try again.";
  }
}

export type MoneyActionState = {
  visible: boolean;
  bucket: Bucket | null;
  type: SavingsTransactionType;
  amountText: string;
  // Non-null exactly when a quick-amount chip (e.g. $20/$50/$100) is the
  // active selection - its canonical integer minor-unit value, used
  // directly at submit time, never re-derived from amountText (Checkpoint
  // 3D review follow-up: quick presets must not round-trip through a
  // dollar string). Cleared the moment the user manually edits the
  // amount field - see setAmountText.
  presetAmountMinor: number | null;
  note: string;
  submitting: boolean;
  error: string | null;
};

const CLOSED_STATE: MoneyActionState = {
  visible: false,
  bucket: null,
  type: "contribution",
  amountText: "",
  presetAmountMinor: null,
  note: "",
  submitting: false,
  error: null,
};

type SavingsMoneyActionContextValue = {
  state: MoneyActionState;
  open: (bucket: Bucket, type: SavingsTransactionType) => void;
  close: () => void;
  setType: (type: SavingsTransactionType) => void;
  setAmountText: (text: string) => void;
  setQuickAmount: (amountMinor: number) => void;
  setNote: (note: string) => void;
  submit: () => Promise<void>;
  successMessage: string | null;
  dismissSuccess: () => void;
};

const SavingsMoneyActionContext =
  createContext<SavingsMoneyActionContextValue | undefined>(undefined);

export function SavingsMoneyActionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const [state, setState] = useState<MoneyActionState>(CLOSED_STATE);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Retains the clientRequestId (plus the exact facts it was generated
  // for) across a failed/ambiguous submit, so a retry of the exact same
  // logical request reuses the same idempotency key instead of creating
  // a second logical transaction - see resolveMoneyActionClientRequestId.
  // A ref, not state: it must survive across a submit/retry cycle
  // without itself triggering a re-render.
  const pendingRef = useRef<PendingMoneyActionRequest | null>(null);
  // Synchronous serialization guard: state.submitting alone can't
  // prevent a second tap from racing past it before React re-renders.
  // Checked/set synchronously before any await; state.submitting remains
  // solely responsible for the visible loading/disabled UI. Because this
  // one controller is shared by both the Bucket list and Bucket detail
  // screens, this guard now also serializes across BOTH entry points,
  // not just within a single screen.
  const inFlightRef = useRef(false);

  const open = useCallback((bucket: Bucket, type: SavingsTransactionType) => {
    if (inFlightRef.current) return;
    setState({
      visible: true,
      bucket,
      type,
      amountText: "",
      presetAmountMinor: null,
      note: "",
      submitting: false,
      error: null,
    });
  }, []);

  // The user-facing cancel/dismiss path - Cancel button, backdrop tap,
  // hardware back, or any other Dialog dismissal. Ignored outright while
  // a submission is still unresolved (inFlightRef.current): the server
  // may have already succeeded, so clearing the pending request here
  // would let a later resubmission generate a fresh id and create a
  // duplicate transaction, defeating the whole point of the idempotency
  // key (mirrors the pre-existing createBucket cancellation pattern in
  // app/(tabs)/buckets/index.tsx).
  //
  // Checkpoint 3D review follow-up: pendingRef is deliberately NEVER
  // cleared here, including after the in-flight request has already
  // resolved with an AMBIGUOUS failure (unavailable/deadline-exceeded -
  // the backend may have actually processed it). Dismissing the sheet is
  // just a UI-visibility action, not a definitive outcome; only a
  // confirmed success (see submit()'s try-block) is allowed to retire
  // the pending record. If the user later reopens and resubmits the
  // EXACT SAME facts, resolveMoneyActionClientRequestId (called from
  // submit()) will still find this preserved record and correctly reuse
  // the same clientRequestId - if they instead submit different facts
  // (a different Bucket/type/amount/note), that same comparison
  // naturally supersedes this stale record with a fresh one, so nothing
  // is lost by never clearing it here.
  const close = useCallback(() => {
    if (inFlightRef.current) return;
    setState(CLOSED_STATE);
  }, []);

  const setType = useCallback((type: SavingsTransactionType) => {
    setState((s) => (s.submitting ? s : { ...s, type, error: null }));
  }, []);

  // Manually editing the amount field always clears any active preset
  // selection - the typed text becomes authoritative again (see
  // resolveAmountMinor), matching the checkpoint's explicit contract.
  const setAmountText = useCallback((text: string) => {
    setState((s) =>
      s.submitting ? s : { ...s, amountText: text, presetAmountMinor: null, error: null }
    );
  }, []);

  // Quick-amount chips (e.g. $20/$50/$100 - see MoneyActionSheet.tsx)
  // carry their canonical integer minor-unit value directly. amountText
  // is populated only for display/editability in the TextInput; the
  // financial value actually submitted is presetAmountMinor itself
  // (resolveAmountMinor uses it as-is), never re-derived by parsing that
  // display text back through parseDollarsToMinorUnits - no floating-
  // point dollar round trip establishes the submitted value.
  const setQuickAmount = useCallback((amountMinor: number) => {
    setState((s) =>
      s.submitting
        ? s
        : {
            ...s,
            amountText: (amountMinor / 100).toFixed(2),
            presetAmountMinor: amountMinor,
            error: null,
          }
    );
  }, []);

  const setNote = useCallback((note: string) => {
    setState((s) => (s.submitting ? s : { ...s, note }));
  }, []);

  const dismissSuccess = useCallback(() => setSuccessMessage(null), []);

  const submit = useCallback(async () => {
    const uid = user?.uid;
    if (!uid) return;
    // Serializes submissions synchronously, checked/set before any await
    // so a double tap cannot start a second competing call - see
    // inFlightRef's declaration above.
    if (inFlightRef.current) return;

    const bucket = state.bucket;
    if (!bucket) return;

    const amountMinor = resolveAmountMinor(state.amountText, state.presetAmountMinor);
    if (amountMinor === null) {
      setState((s) => ({
        ...s,
        error: "Enter a valid amount greater than 0, with at most 2 decimal places.",
      }));
      return;
    }

    const note = normalizeTransactionNote(state.note);
    if (note !== undefined && note.length > MAX_TRANSACTION_NOTE_LENGTH) {
      setState((s) => ({
        ...s,
        error: `Note must be ${MAX_TRANSACTION_NOTE_LENGTH} characters or fewer.`,
      }));
      return;
    }

    // Non-authoritative client-side hint only - the trusted backend is
    // the sole authority on whether a withdrawal is actually valid (see
    // recordSavingsTransactionCore's own non-negative-balance check).
    // bucket.balance is a dollar-denominated DISPLAY cache, so this
    // Math.round conversion is solely for this UI comparison, never fed
    // into the actual write (amountMinor above is independently derived
    // from the user's typed amount).
    if (state.type === "withdrawal") {
      const currentBalanceMinor = Math.round(bucket.balance * 100);
      if (amountMinor > currentBalanceMinor) {
        setState((s) => ({
          ...s,
          error: `You can withdraw up to ${formatCurrency(bucket.balance)} from this bucket.`,
        }));
        return;
      }
    }

    const facts = {
      resourceId: bucket.id,
      memberUid: uid,
      type: state.type,
      amountMinor,
      note,
    };

    // A different Bucket, action type, amount, or note than whatever is
    // currently pending is a genuinely new logical request and must not
    // reuse an old id - resolveMoneyActionClientRequestId compares every
    // field above (see its own contract) and only reuses the pending id
    // when all of them still match exactly.
    const clientRequestId = resolveMoneyActionClientRequestId(
      pendingRef,
      facts,
      generateSavingsClientRequestId
    );

    inFlightRef.current = true;
    setState((s) => ({ ...s, submitting: true, error: null }));

    try {
      await recordSavingsTransaction({
        resourceType: "bucket",
        resourceId: bucket.id,
        memberUid: uid,
        type: state.type,
        amountMinor,
        currency: bucket.currency ?? "USD",
        note,
        clientRequestId,
      });
      // Success clears the pending record - a later submission is a new
      // logical request and must get a new id.
      pendingRef.current = null;

      const verb = state.type === "contribution" ? "Added" : "Withdrew";
      const preposition = state.type === "contribution" ? "to" : "from";
      const bucketName = bucket.name?.trim() ? bucket.name.trim() : "Untitled";
      setSuccessMessage(
        `${verb} ${formatCurrency(amountMinor / 100)} ${preposition} ${bucketName}`
      );

      setState(CLOSED_STATE);
    } catch (e) {
      console.error("Failed to record savings transaction:", e);
      // already-exists is a DEFINITIVE, non-ambiguous outcome (Checkpoint
      // 3D idempotency reconciliation): recordSavingsTransactionCore
      // throws it synchronously, inside the same atomic Firestore
      // transaction that would otherwise perform the write, upon reading
      // an ALREADY-COMMITTED document at this exact clientRequestId whose
      // stored facts do not match the current request (see
      // storedFactsMatch in functions/src/callables/
      // recordSavingsTransaction.ts). There is no possibility the current
      // request's write actually happened - it provably did not, and
      // retrying with the SAME id can only ever fail identically forever,
      // since that id is permanently associated with a different logical
      // request's facts. Retiring the pending record here lets a
      // subsequent legitimate retry mint a fresh id instead of repeating
      // a guaranteed-doomed request.
      //
      // Every OTHER failure (unavailable, deadline-exceeded, or any
      // other/unknown error) is deliberately left retaining the pending
      // id: the server may have actually completed the write before the
      // response was lost, so retrying this exact submission must reuse
      // the same clientRequestId (see resolveMoneyActionClientRequestId).
      if ((e as { code?: string } | null | undefined)?.code === "functions/already-exists") {
        pendingRef.current = null;
      }
      setState((s) => ({ ...s, submitting: false, error: savingsErrorMessage(e) }));
    } finally {
      inFlightRef.current = false;
    }
  }, [
    user?.uid,
    state.bucket,
    state.type,
    state.amountText,
    state.presetAmountMinor,
    state.note,
  ]);

  const value = useMemo<SavingsMoneyActionContextValue>(
    () => ({
      state,
      open,
      close,
      setType,
      setAmountText,
      setQuickAmount,
      setNote,
      submit,
      successMessage,
      dismissSuccess,
    }),
    [state, open, close, setType, setAmountText, setQuickAmount, setNote, submit, successMessage, dismissSuccess]
  );

  return (
    <SavingsMoneyActionContext.Provider value={value}>
      {children}
    </SavingsMoneyActionContext.Provider>
  );
}

export function useSavingsMoneyAction(): SavingsMoneyActionContextValue {
  const ctx = useContext(SavingsMoneyActionContext);
  if (!ctx) {
    throw new Error(
      "useSavingsMoneyAction must be used inside <SavingsMoneyActionProvider />"
    );
  }
  return ctx;
}
