// Characterization/parity tests for functions/src/domain/savingsLedger.ts
// (Checkpoint 4F.5) - the shared pure ledger-interpretation/transition
// primitive extracted from recordSavingsTransaction.ts and
// recordSharedStashExpense.ts's own previously-duplicated logic. No
// Firestore emulator needed - this is pure, synchronous domain math, zero
// I/O, matching tripExpenseSplitsParity.ts's own established convention
// for this package's domain-module tests.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLedgerTransition,
  classifyLedgerInitialization,
  deriveLegacyLedgerInitialization,
  resolveEffectiveCurrency,
} from "../src/domain/savingsLedger";

// =======================================================================
// INITIALIZED STATE (§11 items 1-4: the classification itself is
// resource-agnostic - "Bucket" vs "Trip" is never inspected by this
// primitive, so these cover the same contribution/withdrawal x
// initialized-state matrix both resources rely on identically).
// =======================================================================

describe("classifyLedgerInitialization - initialized state", () => {
  it("1/3. returns the current ledgerBalanceMinor when both fields are present and valid", () => {
    const result = classifyLedgerInitialization({
      ledgerOpeningBalanceMinor: 1000,
      ledgerBalanceMinor: 7500,
    });
    assert.deepEqual(result, { kind: "initialized", currentBalanceMinor: 7500 });
  });

  it("allows a zero current balance", () => {
    const result = classifyLedgerInitialization({
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 0,
    });
    assert.deepEqual(result, { kind: "initialized", currentBalanceMinor: 0 });
  });
});

describe("applyLedgerTransition - against an already-initialized balance (§11 items 2/4)", () => {
  it("2. withdrawal subtracts amountMinor from the current balance", () => {
    assert.deepEqual(applyLedgerTransition(7500, "withdrawal", 2500), {
      ok: true,
      newBalanceMinor: 5000,
    });
  });

  it("4. contribution adds amountMinor to the current balance", () => {
    assert.deepEqual(applyLedgerTransition(7500, "contribution", 2500), {
      ok: true,
      newBalanceMinor: 10000,
    });
  });
});

// =======================================================================
// INVALID INITIALIZED STATE (§11 items 5-8)
// =======================================================================

describe("classifyLedgerInitialization - invalid initialized state", () => {
  it("5. rejects an invalid (non-safe-integer) opening balance", () => {
    assert.deepEqual(
      classifyLedgerInitialization({
        ledgerOpeningBalanceMinor: "not-a-number",
        ledgerBalanceMinor: 1000,
      }),
      { kind: "invalid_initialized_state" }
    );
  });

  it("6. rejects an invalid (non-safe-integer) current balance", () => {
    assert.deepEqual(
      classifyLedgerInitialization({
        ledgerOpeningBalanceMinor: 1000,
        ledgerBalanceMinor: "not-a-number",
      }),
      { kind: "invalid_initialized_state" }
    );
  });

  it("7. rejects a negative persisted ledger value (opening)", () => {
    assert.deepEqual(
      classifyLedgerInitialization({
        ledgerOpeningBalanceMinor: -1,
        ledgerBalanceMinor: 1000,
      }),
      { kind: "invalid_initialized_state" }
    );
  });

  it("7b. rejects a negative persisted ledger value (balance)", () => {
    assert.deepEqual(
      classifyLedgerInitialization({
        ledgerOpeningBalanceMinor: 1000,
        ledgerBalanceMinor: -1,
      }),
      { kind: "invalid_initialized_state" }
    );
  });

  it("8. rejects an unsafe (beyond MAX_SAFE_INTEGER) persisted integer", () => {
    assert.deepEqual(
      classifyLedgerInitialization({
        ledgerOpeningBalanceMinor: Number.MAX_SAFE_INTEGER + 10,
        ledgerBalanceMinor: 1000,
      }),
      { kind: "invalid_initialized_state" }
    );
  });
});

// =======================================================================
// LEGACY STATE (§11 items 9-16)
// =======================================================================

describe("classifyLedgerInitialization - uninitialized signal", () => {
  it("signals uninitialized when neither ledger field is present", () => {
    assert.deepEqual(classifyLedgerInitialization({ balance: 10, saved: 10 }), {
      kind: "uninitialized",
    });
  });
});

describe("deriveLegacyLedgerInitialization - legacy conversion", () => {
  it("9. converts a Bucket-style legacy dollar balance to minor units", () => {
    assert.deepEqual(deriveLegacyLedgerInitialization(12.34), {
      ok: true,
      currentBalanceMinor: 1234,
      initOpeningMinor: 1234,
    });
  });

  it("10. converts a Trip-style legacy dollar balance to minor units", () => {
    assert.deepEqual(deriveLegacyLedgerInitialization(5), {
      ok: true,
      currentBalanceMinor: 500,
      initOpeningMinor: 500,
    });
  });

  it("11. a Trip's missing `saved` field (caller resolves `saved ?? 0`) derives a zero legacy balance", () => {
    // The caller is responsible for the `?? 0` default before calling
    // this (mirroring the original inline `parentData.saved ?? 0`) -
    // this proves the primitive itself correctly handles the resulting
    // zero value.
    assert.deepEqual(deriveLegacyLedgerInitialization(0), {
      ok: true,
      currentBalanceMinor: 0,
      initOpeningMinor: 0,
    });
  });

  it("12. preserves the exact existing Math.round decimal-conversion behavior", () => {
    // 10.005 * 100 = 1000.4999999999999 in floating point -
    // Math.round -> 1000, NOT 1001 - this must match exactly, never a
    // different rounding strategy introduced during extraction.
    assert.equal(deriveLegacyLedgerInitialization(10.005).ok, true);
    const result = deriveLegacyLedgerInitialization(10.005);
    if (result.ok) {
      assert.equal(result.currentBalanceMinor, Math.round(10.005 * 100));
    }
  });

  it("13. rejects an invalid (negative) legacy balance", () => {
    assert.deepEqual(deriveLegacyLedgerInitialization(-5), {
      ok: false,
      reason: "invalid_legacy_value",
    });
  });

  it("14. rejects an invalid (NaN) legacy balance", () => {
    assert.deepEqual(deriveLegacyLedgerInitialization(NaN), {
      ok: false,
      reason: "invalid_legacy_value",
    });
  });

  it("14b. rejects an invalid (Infinity) legacy balance", () => {
    assert.deepEqual(deriveLegacyLedgerInitialization(Infinity), {
      ok: false,
      reason: "invalid_legacy_value",
    });
  });

  it("14c. rejects a non-number legacy balance", () => {
    assert.deepEqual(deriveLegacyLedgerInitialization("12.34"), {
      ok: false,
      reason: "invalid_legacy_value",
    });
  });

  it("15. rejects a legacy value whose minor-unit conversion is unsafe", () => {
    assert.deepEqual(
      deriveLegacyLedgerInitialization(Number.MAX_SAFE_INTEGER),
      { ok: false, reason: "unsafe_legacy_conversion" }
    );
  });

  it("16. returns the SAME value for both currentBalanceMinor and initOpeningMinor on first initialization", () => {
    const result = deriveLegacyLedgerInitialization(100);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.currentBalanceMinor, result.initOpeningMinor);
    }
  });
});

// =======================================================================
// PARTIAL STATE (§11 items 17-18)
// =======================================================================

describe("classifyLedgerInitialization - partial/corrupt state", () => {
  it("17. rejects when only ledgerOpeningBalanceMinor is present", () => {
    assert.deepEqual(
      classifyLedgerInitialization({ ledgerOpeningBalanceMinor: 1000 }),
      { kind: "partial_corrupt" }
    );
  });

  it("18. rejects when only ledgerBalanceMinor is present", () => {
    assert.deepEqual(
      classifyLedgerInitialization({ ledgerBalanceMinor: 1000 }),
      { kind: "partial_corrupt" }
    );
  });
});

// =======================================================================
// CURRENCY (§11 items 19-22)
// =======================================================================

describe("resolveEffectiveCurrency", () => {
  it("19. defaults to USD when the parent's currency field is entirely absent", () => {
    assert.deepEqual(resolveEffectiveCurrency({}, "USD"), {
      ok: true,
      effectiveCurrency: "USD",
    });
  });

  it("20. accepts a request currency matching an explicit parent currency", () => {
    assert.deepEqual(resolveEffectiveCurrency({ currency: "EUR" }, "EUR"), {
      ok: true,
      effectiveCurrency: "EUR",
    });
  });

  it("21. rejects a malformed persisted currency (empty string)", () => {
    assert.deepEqual(resolveEffectiveCurrency({ currency: "" }, "USD"), {
      ok: false,
      reason: "malformed_parent_currency",
    });
  });

  it("21b. rejects a malformed persisted currency (non-string)", () => {
    assert.deepEqual(resolveEffectiveCurrency({ currency: 123 }, "USD"), {
      ok: false,
      reason: "malformed_parent_currency",
    });
  });

  it("22. rejects a request currency that doesn't match the effective currency", () => {
    assert.deepEqual(resolveEffectiveCurrency({ currency: "EUR" }, "USD"), {
      ok: false,
      reason: "currency_mismatch",
      effectiveCurrency: "EUR",
    });
  });

  it("never normalizes, uppercases, trims, or converts currency values", () => {
    assert.deepEqual(resolveEffectiveCurrency({ currency: " usd" }, "USD"), {
      ok: false,
      reason: "currency_mismatch",
      effectiveCurrency: " usd",
    });
  });
});

// =======================================================================
// TRANSITION (§11 items 23-28)
// =======================================================================

describe("applyLedgerTransition", () => {
  it("23. a contribution adds to the current balance", () => {
    assert.deepEqual(applyLedgerTransition(1000, "contribution", 500), {
      ok: true,
      newBalanceMinor: 1500,
    });
  });

  it("24. a withdrawal subtracts from the current balance", () => {
    assert.deepEqual(applyLedgerTransition(1000, "withdrawal", 500), {
      ok: true,
      newBalanceMinor: 500,
    });
  });

  it("25. an exact-zero resulting balance is allowed", () => {
    assert.deepEqual(applyLedgerTransition(500, "withdrawal", 500), {
      ok: true,
      newBalanceMinor: 0,
    });
  });

  it("26. a withdrawal exceeding the current balance is rejected as insufficient funds", () => {
    assert.deepEqual(applyLedgerTransition(500, "withdrawal", 501), {
      ok: false,
      reason: "insufficient_funds",
    });
  });

  it("27. a contribution producing an unsafe (overflow) result is rejected", () => {
    assert.deepEqual(
      applyLedgerTransition(Number.MAX_SAFE_INTEGER, "contribution", 1),
      { ok: false, reason: "unsafe_result" }
    );
  });

  it("28. negative/unsafe result behavior is identical regardless of starting balance shape", () => {
    // A withdrawal driving the balance negative is always
    // "insufficient_funds", never conflated with "unsafe_result".
    assert.deepEqual(applyLedgerTransition(0, "withdrawal", 1), {
      ok: false,
      reason: "insufficient_funds",
    });
  });
});

// =======================================================================
// HISTORY GUARD DESIGN (§11 items 29-31) - the guard itself requires a
// live Firestore read and therefore cannot be exercised by this pure
// module's own tests; these prove the SIGNAL this module emits for the
// caller to act on, which is the testable half of the design described
// in savingsLedger.ts's own module comment (§6 of this checkpoint).
// =======================================================================

describe("classifyLedgerInitialization - history guard signal (§11 items 29-31)", () => {
  it("29/30. signals \"uninitialized\" (requiring the caller's own history check) whenever neither ledger field is present, regardless of any other persisted data", () => {
    assert.deepEqual(classifyLedgerInitialization({}), { kind: "uninitialized" });
    assert.deepEqual(
      classifyLedgerInitialization({ saved: 50, memberIds: ["a", "b"] }),
      { kind: "uninitialized" }
    );
  });

  it("31. an already-initialized state never signals \"uninitialized\" - the caller never needs to run the history query in this case", () => {
    const result = classifyLedgerInitialization({
      ledgerOpeningBalanceMinor: 100,
      ledgerBalanceMinor: 100,
    });
    assert.notEqual(result.kind, "uninitialized");
  });
});

// =======================================================================
// PARITY (Checkpoint 4F.5 §13, optional but included): for equivalent
// Trip ledger starting states, an ordinary recordSavingsTransaction-style
// withdrawal and a Shared-Stash-Expense-style withdrawal derive the exact
// same starting-balance interpretation and resulting balance through this
// one shared primitive - proving the reason this extraction exists.
// =======================================================================

describe("parity: ordinary withdrawal vs Shared-Stash Expense withdrawal share identical ledger semantics", () => {
  it("both derive the same legacy-initialized starting balance and the same resulting balance for an equivalent Trip", () => {
    const tripData = { saved: 100 }; // legacy, uninitialized - $100.00

    const ordinaryInit = classifyLedgerInitialization(tripData);
    const sharedStashInit = classifyLedgerInitialization(tripData);
    assert.deepEqual(ordinaryInit, sharedStashInit);
    assert.equal(ordinaryInit.kind, "uninitialized");

    const legacyOrdinary = deriveLegacyLedgerInitialization(tripData.saved ?? 0);
    const legacySharedStash = deriveLegacyLedgerInitialization(tripData.saved ?? 0);
    assert.deepEqual(legacyOrdinary, legacySharedStash);
    assert.equal(legacyOrdinary.ok, true);

    if (legacyOrdinary.ok && legacySharedStash.ok) {
      // Ordinary recordSavingsTransaction withdrawal of $20.
      const ordinaryTransition = applyLedgerTransition(
        legacyOrdinary.currentBalanceMinor,
        "withdrawal",
        2000
      );
      // Shared-Stash Expense withdrawal of $20 - always "withdrawal" too.
      const sharedStashTransition = applyLedgerTransition(
        legacySharedStash.currentBalanceMinor,
        "withdrawal",
        2000
      );
      assert.deepEqual(ordinaryTransition, sharedStashTransition);
      assert.deepEqual(ordinaryTransition, { ok: true, newBalanceMinor: 8000 });
      assert.equal(legacyOrdinary.initOpeningMinor, legacySharedStash.initOpeningMinor);
    }
  });

  it("both reject an already-initialized Trip's corrupt ledger state identically", () => {
    const corruptTrip = { ledgerOpeningBalanceMinor: 1000 }; // partial
    const a = classifyLedgerInitialization(corruptTrip);
    const b = classifyLedgerInitialization(corruptTrip);
    assert.deepEqual(a, b);
    assert.deepEqual(a, { kind: "partial_corrupt" });
  });
});
