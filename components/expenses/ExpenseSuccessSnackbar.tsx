// Restrained success feedback for a completed Expense creation
// (Checkpoint 4D.3), mirroring components/buckets/MoneySuccessSnackbar.tsx
// exactly - a Paper Snackbar (works on both web and native, unlike
// Alert.alert), auto-dismisses after a few seconds, also manually
// dismissible. No celebration animation.
//
// Rendered exactly once (see app/(tabs)/trips/_layout.tsx), reading the
// shared successMessage/dismissExpenseSuccess from useExpenseSuccess() so
// it survives the create screen's own unmount once router.replace()
// navigates to the Expense list.
import React from "react";
import { Snackbar } from "react-native-paper";

import { useExpenseSuccess } from "../../src/hooks/useExpenseSuccess";

const AUTO_DISMISS_MS = 4000;

export function ExpenseSuccessSnackbar() {
  const { successMessage, dismissExpenseSuccess } = useExpenseSuccess();

  return (
    <Snackbar
      visible={successMessage !== null}
      onDismiss={dismissExpenseSuccess}
      duration={AUTO_DISMISS_MS}
    >
      {successMessage ?? ""}
    </Snackbar>
  );
}
