import { describe, expect, test } from "bun:test";
import {
  ApplicationAgentSteerRequestSchema,
  ApplicationSessionCommandSchema,
} from "../src/contracts/index.ts";

describe("application steering contracts", () => {
  test("normalizes Python-compatible edge whitespace in both strict request shapes", () => {
    const rawMessage = "\u001c\u0085  Keep the response concise. \u001f";
    const normalizedMessage = "Keep the response concise.";

    expect(ApplicationSessionCommandSchema.parse({
      type: "steer",
      message: rawMessage,
    })).toEqual({ type: "steer", message: normalizedMessage });
    expect(ApplicationAgentSteerRequestSchema.parse({ message: rawMessage }))
      .toEqual({ message: normalizedMessage });
  });

  test("accepts 1 to 8,000 Unicode scalar values and rejects NUL, lone surrogates, and extras", () => {
    const maximum = "😀".repeat(8_000);
    expect(ApplicationSessionCommandSchema.parse({
      type: "steer",
      message: maximum,
    })).toEqual({ type: "steer", message: maximum });
    expect(ApplicationAgentSteerRequestSchema.parse({ message: maximum }))
      .toEqual({ message: maximum });

    for (const body of [
      { message: "" },
      { message: " \u001c\u0085 " },
      { message: "😀".repeat(8_001) },
      { message: "before\u0000after" },
      { message: "before\ud800after" },
      { message: "before\udfffafter" },
      { message: "valid", extra: true },
    ]) {
      expect(ApplicationAgentSteerRequestSchema.safeParse(body).success).toBeFalse();
      expect(ApplicationSessionCommandSchema.safeParse({
        type: "steer",
        ...body,
      }).success).toBeFalse();
    }
  });
});
