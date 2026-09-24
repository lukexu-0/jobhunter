import { describe, expect, test } from "bun:test";
import { isApplicationSessionOpen } from "../app/lib/application-session-state";

describe("application session projection", () => {
  test("uses the non-ended session projection with legacy activity fallback", () => {
    expect(isApplicationSessionOpen({ isApplicationSessionOpen: true, isApplying: false })).toBeTrue();
    expect(isApplicationSessionOpen({ isApplicationSessionOpen: false, isApplying: true })).toBeFalse();
    expect(isApplicationSessionOpen({ isApplying: true })).toBeTrue();
    expect(isApplicationSessionOpen({})).toBeFalse();
  });

});
