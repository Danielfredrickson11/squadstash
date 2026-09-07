import {
  clampProgress,
  isGoalReached,
  remainingToGoal,
} from "../savingsGoal";

describe("isGoalReached", () => {
  it("is false under target", () => {
    expect(isGoalReached(50, 100)).toBe(false);
  });

  it("is true at exact target", () => {
    expect(isGoalReached(100, 100)).toBe(true);
  });

  it("is true over target", () => {
    expect(isGoalReached(110, 100)).toBe(true);
  });

  it("is false when target is zero", () => {
    expect(isGoalReached(50, 0)).toBe(false);
  });

  it("is false when target is negative", () => {
    expect(isGoalReached(50, -10)).toBe(false);
  });

  it("becomes false again after a withdrawal drops balance back under target", () => {
    // Deterministic from current balance alone - no persisted
    // "completed" flag to reverse (Checkpoint 3D requirement).
    expect(isGoalReached(100, 100)).toBe(true);
    expect(isGoalReached(80, 100)).toBe(false);
  });
});

describe("clampProgress", () => {
  it("computes a fractional progress under target", () => {
    expect(clampProgress(25, 100)).toBe(0.25);
  });

  it("is exactly 1 at target", () => {
    expect(clampProgress(100, 100)).toBe(1);
  });

  it("clamps to 1 over target rather than overflowing", () => {
    expect(clampProgress(150, 100)).toBe(1);
  });

  it("is 0 when target is zero", () => {
    expect(clampProgress(50, 0)).toBe(0);
  });

  it("is 0 when target is negative", () => {
    expect(clampProgress(50, -10)).toBe(0);
  });
});

describe("remainingToGoal", () => {
  it("computes the amount left under target", () => {
    expect(remainingToGoal(25, 100)).toBe(75);
  });

  it("is exactly 0 at target", () => {
    expect(remainingToGoal(100, 100)).toBe(0);
  });

  it("floors at 0 over target, never negative", () => {
    expect(remainingToGoal(150, 100)).toBe(0);
  });
});
