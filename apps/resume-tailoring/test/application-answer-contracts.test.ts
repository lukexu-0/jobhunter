import { describe, expect, test } from "bun:test";
import {
  ApplicationAnswerSuggestionsResponseSchema,
  ApplicationProfessionalizeRequestSchema,
  ApplicationProfessionalizeResponseSchema,
  ApplicationSessionCommandSchema,
} from "../src/contracts/index.ts";

describe("application answer public contracts", () => {
  test("requires distinct trimmed raw and final values for answered text commands", () => {
    expect(ApplicationSessionCommandSchema.parse({
      type: "provide_additional_info",
      answers: [{
        id: "experience",
        status: "answered",
        raw_value: "  built distributed systems  ",
        value: "  I built reliable distributed systems.  ",
      }],
    })).toEqual({
      type: "provide_additional_info",
      answers: [{
        id: "experience",
        status: "answered",
        raw_value: "built distributed systems",
        value: "I built reliable distributed systems.",
      }],
    });

    for (const answer of [
      { id: "experience", status: "answered", value: "final only" },
      { id: "experience", status: "answered", raw_value: "raw only" },
      { id: "experience", status: "answered", raw_value: "x", value: "y", extra: true },
      { id: "experience", status: "answered", raw_value: "", value: "answer" },
      { id: "experience", status: "answered", raw_value: "x".repeat(2_001), value: "answer" },
    ]) {
      expect(ApplicationSessionCommandSchema.safeParse({
        type: "provide_additional_info",
        answers: [answer],
      }).success).toBe(false);
    }
  });

  test("keeps boolean, select, multiselect, and declined answer shapes unchanged", () => {
    expect(ApplicationSessionCommandSchema.parse({
      type: "provide_additional_info",
      answers: [
        { id: "sponsorship", status: "answered", value: false },
        { id: "referral", status: "answered", option_id: "company_site" },
        { id: "work_setting", status: "answered", option_ids: ["remote", "onsite"] },
        { id: "salary", status: "declined" },
      ],
    })).toEqual({
      type: "provide_additional_info",
      answers: [
        { id: "sponsorship", status: "answered", value: false },
        { id: "referral", status: "answered", option_id: "company_site" },
        { id: "work_setting", status: "answered", option_ids: ["remote", "onsite"] },
        { id: "salary", status: "declined" },
      ],
    });
  });

  test("strictly validates bounded suggestion and professionalization DTOs by Unicode code point", () => {
    expect(ApplicationAnswerSuggestionsResponseSchema.parse({
      suggestions: [{
        question: "  What impact did you have?  ",
        answer: "  Improved reliability by using existing team evidence.  ",
      }],
    })).toEqual({
      suggestions: [{
        question: "What impact did you have?",
        answer: "Improved reliability by using existing team evidence.",
      }],
    });
    expect(ApplicationProfessionalizeRequestSchema.parse({
      promptId: "default",
      draft: "  loose facts  ",
      instruction: "  make it shorter  ",
    })).toEqual({
      promptId: "default",
      draft: "loose facts",
      instruction: "make it shorter",
    });
    expect(ApplicationProfessionalizeResponseSchema.parse({ answer: "  Final answer.  " }))
      .toEqual({ answer: "Final answer." });

    const twoThousandCodePoints = "😀".repeat(2_000);
    expect(ApplicationProfessionalizeRequestSchema.safeParse({
      promptId: "default",
      draft: twoThousandCodePoints,
    }).success).toBe(true);
    expect(ApplicationProfessionalizeRequestSchema.safeParse({
      promptId: "default",
      draft: `${twoThousandCodePoints}😀`,
    }).success).toBe(false);
    expect(ApplicationAnswerSuggestionsResponseSchema.safeParse({
      suggestions: Array.from({ length: 6 }, () => ({ question: "Question", answer: "Answer" })),
    }).success).toBe(false);
    expect(ApplicationProfessionalizeRequestSchema.safeParse({
      promptId: "custom",
      draft: "draft",
    }).success).toBe(false);
    expect(ApplicationProfessionalizeResponseSchema.safeParse({
      answer: "answer",
      rawValue: "private",
    }).success).toBe(false);
  });
});
