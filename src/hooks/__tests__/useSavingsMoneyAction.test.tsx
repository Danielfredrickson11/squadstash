// Controller-level test for the Checkpoint 3D review follow-up's
// ambiguous-failure/dismiss/retry idempotency guarantee. Exercises the
// real useSavingsMoneyAction() hook (not just the pure
// resolveMoneyActionClientRequestId helper already covered in
// src/domain/__tests__/savingsMoneyAction.test.ts) via react-test-
// renderer, which this project already depends on - no new test
// dependency, and no UI snapshotting/rendering assertions, only
// controller-state/mock-call assertions.
//
// AuthContext and the savingsTransactions service module are mocked so
// this test needs no real Firebase app/network/emulator - the hook only
// ever calls generateSavingsClientRequestId() and
// recordSavingsTransaction() from that module.
import React from "react";
import { act, create } from "react-test-renderer";

import type { Bucket } from "../../types/domain";
import {
  SavingsMoneyActionProvider,
  useSavingsMoneyAction,
} from "../useSavingsMoneyAction";

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ user: { uid: "test-uid" } }),
}));

const mockGenerateSavingsClientRequestId = jest.fn();
const mockRecordSavingsTransaction = jest.fn();

jest.mock("../../services/firebase/savingsTransactions", () => ({
  MAX_TRANSACTION_NOTE_LENGTH: 500,
  generateSavingsClientRequestId: () => mockGenerateSavingsClientRequestId(),
  recordSavingsTransaction: (input: unknown) => mockRecordSavingsTransaction(input),
}));

function makeBucket(overrides: Partial<Bucket> = {}): Bucket {
  return {
    id: "bucket-1",
    name: "Vaca",
    target: 1000,
    balance: 500,
    ownerId: "test-uid",
    memberIds: ["test-uid"],
    ...overrides,
  };
}

type ControllerApi = ReturnType<typeof useSavingsMoneyAction>;

async function renderController(): Promise<{ api: () => ControllerApi }> {
  let latest: ControllerApi | null = null;

  function Harness() {
    latest = useSavingsMoneyAction();
    return null;
  }

  await act(async () => {
    create(
      <SavingsMoneyActionProvider>
        <Harness />
      </SavingsMoneyActionProvider>
    );
  });

  return {
    api: () => {
      if (!latest) throw new Error("Controller not ready");
      return latest;
    },
  };
}

beforeEach(() => {
  mockGenerateSavingsClientRequestId.mockReset();
  mockRecordSavingsTransaction.mockReset();
});

describe("useSavingsMoneyAction - ambiguous failure + dismiss idempotency", () => {
  it("reuses the same clientRequestId after an ambiguous failure, close(), and an exact-fact retry", async () => {
    mockGenerateSavingsClientRequestId.mockReturnValueOnce("id-first");
    mockRecordSavingsTransaction.mockRejectedValueOnce({ code: "functions/unavailable" });

    const { api } = await renderController();
    const bucket = makeBucket();

    await act(async () => {
      api().open(bucket, "contribution");
    });
    await act(async () => {
      api().setAmountText("50.00");
    });
    await act(async () => {
      await api().submit();
    });

    expect(mockRecordSavingsTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordSavingsTransaction.mock.calls[0][0].clientRequestId).toBe("id-first");
    expect(api().state.error).not.toBeNull();

    // The sheet is dismissed after the ambiguous failure - this must NOT
    // erase the retained idempotency record (see close()'s comment in
    // src/hooks/useSavingsMoneyAction.tsx).
    await act(async () => {
      api().close();
    });
    expect(api().state.visible).toBe(false);

    // Reopen and re-enter the EXACT SAME transaction facts.
    await act(async () => {
      api().open(bucket, "contribution");
    });
    await act(async () => {
      api().setAmountText("50.00");
    });

    mockRecordSavingsTransaction.mockResolvedValueOnce({
      transactionId: "id-first",
      balanceMinor: 10000,
    });

    await act(async () => {
      await api().submit();
    });

    expect(mockRecordSavingsTransaction).toHaveBeenCalledTimes(2);
    // The retry MUST reuse clientRequestId X ("id-first") - the id
    // generator must NOT have been invoked a second time.
    expect(mockGenerateSavingsClientRequestId).toHaveBeenCalledTimes(1);
    expect(mockRecordSavingsTransaction.mock.calls[1][0].clientRequestId).toBe("id-first");
  });

  it("retires the pending id on a definitive already-exists rejection, so an immediate retry with the SAME facts gets a fresh id", async () => {
    // already-exists is thrown synchronously inside the backend's atomic
    // transaction, before any write, upon finding a DIFFERENT stored
    // request already durably committed under this exact
    // clientRequestId (see functions/src/callables/
    // recordSavingsTransaction.ts's storedFactsMatch). Unlike
    // unavailable/deadline-exceeded, this is not ambiguous: retrying
    // with the same id can only ever fail identically forever, so the
    // pending record must be retired to let a fresh id be minted.
    mockGenerateSavingsClientRequestId
      .mockReturnValueOnce("id-x")
      .mockReturnValueOnce("id-y");
    mockRecordSavingsTransaction.mockRejectedValueOnce({ code: "functions/already-exists" });

    const { api } = await renderController();
    const bucket = makeBucket();

    await act(async () => {
      api().open(bucket, "contribution");
    });
    await act(async () => {
      api().setAmountText("50.00");
    });
    await act(async () => {
      await api().submit();
    });

    expect(mockRecordSavingsTransaction.mock.calls[0][0].clientRequestId).toBe("id-x");
    expect(api().state.error).not.toBeNull();

    // Retry with the EXACT SAME facts - no close/reopen needed; even an
    // immediate resubmit must not reuse the now-unusable id.
    mockRecordSavingsTransaction.mockResolvedValueOnce({
      transactionId: "id-y",
      balanceMinor: 5000,
    });

    await act(async () => {
      await api().submit();
    });

    expect(mockGenerateSavingsClientRequestId).toHaveBeenCalledTimes(2);
    expect(mockRecordSavingsTransaction.mock.calls[1][0].clientRequestId).toBe("id-y");
  });

  it("generates a fresh clientRequestId when the retried amount differs", async () => {
    mockGenerateSavingsClientRequestId
      .mockReturnValueOnce("id-a")
      .mockReturnValueOnce("id-b");
    mockRecordSavingsTransaction.mockRejectedValueOnce({ code: "functions/unavailable" });

    const { api } = await renderController();
    const bucket = makeBucket();

    await act(async () => {
      api().open(bucket, "contribution");
    });
    await act(async () => {
      api().setAmountText("50.00");
    });
    await act(async () => {
      await api().submit();
    });

    await act(async () => {
      api().close();
    });
    await act(async () => {
      api().open(bucket, "contribution");
    });
    await act(async () => {
      api().setAmountText("75.00"); // a different logical request
    });

    mockRecordSavingsTransaction.mockResolvedValueOnce({
      transactionId: "id-b",
      balanceMinor: 10000,
    });

    await act(async () => {
      await api().submit();
    });

    expect(mockGenerateSavingsClientRequestId).toHaveBeenCalledTimes(2);
    expect(mockRecordSavingsTransaction.mock.calls[1][0].clientRequestId).toBe("id-b");
  });

  it("generates a fresh clientRequestId when the retried Bucket differs", async () => {
    mockGenerateSavingsClientRequestId
      .mockReturnValueOnce("id-a")
      .mockReturnValueOnce("id-b");
    mockRecordSavingsTransaction.mockRejectedValueOnce({ code: "functions/unavailable" });

    const { api } = await renderController();
    const bucketA = makeBucket({ id: "bucket-a" });
    const bucketB = makeBucket({ id: "bucket-b" });

    await act(async () => {
      api().open(bucketA, "contribution");
    });
    await act(async () => {
      api().setAmountText("50.00");
    });
    await act(async () => {
      await api().submit();
    });

    await act(async () => {
      api().close();
    });
    await act(async () => {
      api().open(bucketB, "contribution");
    });
    await act(async () => {
      api().setAmountText("50.00");
    });

    mockRecordSavingsTransaction.mockResolvedValueOnce({
      transactionId: "id-b",
      balanceMinor: 5000,
    });

    await act(async () => {
      await api().submit();
    });

    expect(mockGenerateSavingsClientRequestId).toHaveBeenCalledTimes(2);
    expect(mockRecordSavingsTransaction.mock.calls[1][0].clientRequestId).toBe("id-b");
  });

  it("uses the preset amountMinor directly for a quick-amount chip, never re-parsing amountText", async () => {
    mockGenerateSavingsClientRequestId.mockReturnValueOnce("id-quick");
    mockRecordSavingsTransaction.mockResolvedValueOnce({
      transactionId: "id-quick",
      balanceMinor: 5500,
    });

    const { api } = await renderController();
    const bucket = makeBucket();

    await act(async () => {
      api().open(bucket, "contribution");
    });
    await act(async () => {
      api().setQuickAmount(5000); // the $50.00 preset
    });
    expect(api().state.presetAmountMinor).toBe(5000);

    await act(async () => {
      await api().submit();
    });

    expect(mockRecordSavingsTransaction.mock.calls[0][0].amountMinor).toBe(5000);
  });
});
