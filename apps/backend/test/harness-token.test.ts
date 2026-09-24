import { describe, expect, test } from "bun:test";
import { resolveBrowserHarnessToken } from "../src/system/harness-token.ts";

describe("browser harness token resolver", () => {
  test("a fresh checkout does not inherit a home token without explicit configuration", () => {
    expect(resolveBrowserHarnessToken({ HOME: "/existing-home" })).toBeUndefined();
  });

  test("uses an explicit token and rejects an empty or short one", () => {
    const token = "environment-token-0123456789abcdef0123456789";
    expect(resolveBrowserHarnessToken({ JOBHUNT_HARNESS_TOKEN: token })).toBe(token);
    for (const invalid of ["", "too-short", "😀".repeat(16)]) {
      expect(() => resolveBrowserHarnessToken({ JOBHUNT_HARNESS_TOKEN: invalid })).toThrow(/at least 32/);
    }
    expect(resolveBrowserHarnessToken({ JOBHUNT_HARNESS_TOKEN: "😀".repeat(32) })).toBe("😀".repeat(32));
  });
});
