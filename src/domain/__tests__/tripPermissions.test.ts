import { isTripOwner } from "../tripPermissions";

describe("isTripOwner", () => {
  it("is true when uid matches ownerId", () => {
    expect(isTripOwner("owner-1", "owner-1")).toBe(true);
  });

  it("is false when uid is a different (normal member) uid", () => {
    expect(isTripOwner("owner-1", "member-2")).toBe(false);
  });

  it("is false when uid is null", () => {
    expect(isTripOwner("owner-1", null)).toBe(false);
  });

  it("is false when uid is undefined", () => {
    expect(isTripOwner("owner-1", undefined)).toBe(false);
  });

  it("is false when ownerId is null", () => {
    expect(isTripOwner(null, "owner-1")).toBe(false);
  });

  it("is false when ownerId is undefined", () => {
    expect(isTripOwner(undefined, "owner-1")).toBe(false);
  });

  it("is false when ownerId is an empty string", () => {
    expect(isTripOwner("", "owner-1")).toBe(false);
  });

  it("is false when uid is an empty string", () => {
    expect(isTripOwner("owner-1", "")).toBe(false);
  });

  it("is false when both are null", () => {
    expect(isTripOwner(null, null)).toBe(false);
  });

  it("is false when both are undefined", () => {
    expect(isTripOwner(undefined, undefined)).toBe(false);
  });

  it("is false when both are empty strings", () => {
    expect(isTripOwner("", "")).toBe(false);
  });
});
