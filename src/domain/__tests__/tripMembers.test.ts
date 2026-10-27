import { buildTripMemberViewModels } from "../tripMembers";
import type { PublicProfile } from "../../types/domain";

function profileMap(entries: [string, Partial<PublicProfile>][]): Map<string, PublicProfile> {
  const map = new Map<string, PublicProfile>();
  entries.forEach(([uid, data]) => {
    map.set(uid, { uid, displayName: "", photoURL: "", ...data });
  });
  return map;
}

describe("buildTripMemberViewModels", () => {
  it("1. owner-only Trip: a single view model for the owner, marked isOwner", () => {
    const result = buildTripMemberViewModels("owner-1", [], profileMap([
      ["owner-1", { displayName: "Dana Owner" }],
    ]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      uid: "owner-1",
      nameLabel: "Dana Owner",
      isOwner: true,
    });
  });

  it("2. owner + one member: two view models, correct isOwner flags", () => {
    const result = buildTripMemberViewModels(
      "owner-1",
      ["owner-1", "member-2"],
      profileMap([
        ["owner-1", { displayName: "Dana Owner" }],
        ["member-2", { displayName: "Sam Member" }],
      ])
    );
    expect(result).toHaveLength(2);
    const owner = result.find((m) => m.uid === "owner-1");
    const member = result.find((m) => m.uid === "member-2");
    expect(owner?.isOwner).toBe(true);
    expect(member?.isOwner).toBe(false);
  });

  it("3. correct isOwner: a non-owner uid is never marked isOwner even if listed first", () => {
    const result = buildTripMemberViewModels(
      "owner-1",
      ["member-2", "owner-1"],
      profileMap([
        ["owner-1", { displayName: "Dana Owner" }],
        ["member-2", { displayName: "Sam Member" }],
      ])
    );
    expect(result.filter((m) => m.isOwner)).toHaveLength(1);
    expect(result.find((m) => m.isOwner)?.uid).toBe("owner-1");
  });

  it("4. duplicate uid defensive handling: owner duplicated inside memberIds yields exactly one row", () => {
    const result = buildTripMemberViewModels(
      "owner-1",
      ["owner-1", "owner-1", "member-2"],
      profileMap([
        ["owner-1", { displayName: "Dana Owner" }],
        ["member-2", { displayName: "Sam Member" }],
      ])
    );
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.uid).sort()).toEqual(["member-2", "owner-1"]);
  });

  it("5. public profile resolution: displayName and photoURL both carry through", () => {
    const result = buildTripMemberViewModels(
      "owner-1",
      ["owner-1"],
      profileMap([["owner-1", { displayName: "Dana Owner", photoURL: "https://example.com/a.png" }]])
    );
    expect(result[0]).toMatchObject({
      nameLabel: "Dana Owner",
      photoURL: "https://example.com/a.png",
    });
  });

  it("6. missing profile: a uid with no entry in the profiles map falls back to the deterministic label", () => {
    const result = buildTripMemberViewModels("owner-1", ["owner-1"], profileMap([]));
    expect(result[0]).toMatchObject({
      nameLabel: "Trip member",
      photoURL: undefined,
    });
  });

  it("7. empty display name: a profile that exists but has a blank/whitespace displayName falls back identically to a missing profile", () => {
    const result = buildTripMemberViewModels(
      "owner-1",
      ["owner-1"],
      profileMap([["owner-1", { displayName: "   " }]])
    );
    expect(result[0].nameLabel).toBe("Trip member");
  });

  it("8. missing photo URL: a resolved name with an empty photoURL normalizes to undefined, never a broken image reference", () => {
    const result = buildTripMemberViewModels(
      "owner-1",
      ["owner-1"],
      profileMap([["owner-1", { displayName: "Dana Owner", photoURL: "" }]])
    );
    expect(result[0].photoURL).toBeUndefined();
    expect(result[0].nameLabel).toBe("Dana Owner");
  });

  it("9. deterministic fallback labels: more than one simultaneously-unresolved member is numbered, in canonical member order", () => {
    const result = buildTripMemberViewModels(
      "owner-1",
      ["owner-1", "member-2"],
      profileMap([])
    );
    expect(result[0]).toMatchObject({ uid: "owner-1", nameLabel: "Trip member 1" });
    expect(result[1]).toMatchObject({ uid: "member-2", nameLabel: "Trip member 2" });
  });

  it("9b. a single unresolved member among otherwise-resolved members gets the unnumbered fallback", () => {
    const result = buildTripMemberViewModels(
      "owner-1",
      ["owner-1", "member-2"],
      profileMap([["owner-1", { displayName: "Dana Owner" }]])
    );
    const member = result.find((m) => m.uid === "member-2");
    expect(member?.nameLabel).toBe("Trip member");
  });

  it("10. output contains no financial field of any kind, and no avatarLabel - initials are a UI-layer concern computed from nameLabel, never this domain module's job", () => {
    const result = buildTripMemberViewModels(
      "owner-1",
      ["owner-1", "member-2"],
      profileMap([
        ["owner-1", { displayName: "Dana Owner" }],
        ["member-2", { displayName: "Sam Member" }],
      ])
    );
    result.forEach((member) => {
      expect(Object.keys(member).sort()).toEqual(
        ["isOwner", "nameLabel", "photoURL", "uid"].sort()
      );
    });
  });

  it("an empty profiles map (simulating a failed subscription) still renders every known member via fallback labels, never an empty list", () => {
    const result = buildTripMemberViewModels("owner-1", ["owner-1", "member-2"], profileMap([]));
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.nameLabel.startsWith("Trip member"))).toBe(true);
  });
});
