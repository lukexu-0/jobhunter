import { describe, expect, test } from "bun:test";
import { buildApplicationRevisionCommand } from "../app/lib/application-review-gate";

describe("buildApplicationRevisionCommand", () => {
  test("trims review guidance into the exact revise command", () => {
    expect(buildApplicationRevisionCommand("  Recheck the employment dates.  ")).toEqual({
      success: true,
      command: {
        type: "revise",
        context: "Recheck the employment dates.",
      },
    });
  });

  test("enforces the one through twenty-thousand code-point boundary", () => {
    expect(buildApplicationRevisionCommand("   ")).toEqual({
      success: false,
      message: "Enter revision instructions between 1 and 20,000 characters.",
    });
    expect(buildApplicationRevisionCommand("𐐀".repeat(20_000))).toMatchObject({
      success: true,
    });
    expect(buildApplicationRevisionCommand("𐐀".repeat(20_001))).toEqual({
      success: false,
      message: "Enter revision instructions between 1 and 20,000 characters.",
    });
  });
});
