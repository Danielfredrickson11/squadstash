// Tests for the shared Functions-side composite-id delimiter guard
// (Checkpoint 5B.1, extracted from createTripInvitation.ts - see
// src/domain/tripCompositeId.ts's own header comment for the full
// reasoning). Pure logic, no Firestore emulator needed.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {HttpsError} from "firebase-functions/v2/https";
import {ID_DELIMITER, assertNoDelimiter} from "../src/domain/tripCompositeId";

describe("ID_DELIMITER", () => {
  it("is the underscore character", () => {
    assert.equal(ID_DELIMITER, "_");
  });
});

describe("assertNoDelimiter", () => {
  it("does not throw for a delimiter-free value", () => {
    assert.doesNotThrow(() => assertNoDelimiter("abc123", "tripId"));
  });

  it("does not throw for an empty string", () => {
    assert.doesNotThrow(() => assertNoDelimiter("", "tripId"));
  });

  it("throws HttpsError(\"internal\") when the value contains the delimiter", () => {
    assert.throws(
      () => assertNoDelimiter("abc_123", "tripId"),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError, "expected an HttpsError");
        assert.equal((err as HttpsError).code, "internal");
        return true;
      }
    );
  });

  it("includes the given label in the thrown error message", () => {
    assert.throws(
      () => assertNoDelimiter("a_b", "inviteeUid"),
      (err: unknown) => {
        assert.ok((err as HttpsError).message.includes("inviteeUid"));
        return true;
      }
    );
  });
});
