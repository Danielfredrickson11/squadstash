// Restrained success feedback for a completed Personal Savings
// contribution/withdrawal (Milestone 3 Checkpoint 3D). A Paper Snackbar
// works on both web and native (unlike Alert.alert - see notifyError's
// existing comment elsewhere in this codebase on why Alert isn't
// reliable on web), auto-dismisses after a few seconds, and is also
// manually dismissible. No celebratory animation - just the same plain
// confirmation text pattern already used across this app's other
// success/error messaging.
//
// Rendered exactly once (see app/(tabs)/buckets/_layout.tsx), reading
// the shared successMessage/dismissSuccess from useSavingsMoneyAction()
// so it works identically regardless of which screen (Bucket list or
// Bucket detail) triggered the transaction.
import React from "react";
import { Snackbar } from "react-native-paper";

import { useSavingsMoneyAction } from "../../src/hooks/useSavingsMoneyAction";

const AUTO_DISMISS_MS = 4000;

export function MoneySuccessSnackbar() {
  const { successMessage, dismissSuccess } = useSavingsMoneyAction();

  return (
    <Snackbar
      visible={successMessage !== null}
      onDismiss={dismissSuccess}
      duration={AUTO_DISMISS_MS}
    >
      {successMessage ?? ""}
    </Snackbar>
  );
}
