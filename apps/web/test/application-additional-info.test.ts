import { describe, expect, test } from "bun:test";
import type { ApplicationAdditionalInfoQuestion } from "@jobhunter/pipeline/contracts";
import {
  buildAdditionalInfoCommand,
  type AdditionalInfoDrafts,
} from "../app/lib/application-additional-info";

const questions: readonly ApplicationAdditionalInfoQuestion[] = [
  {
    id: "work_authorization",
    scope: "global",
    question: "Are you authorized to work here?",
    answerType: "boolean",
  },
  {
    id: "portfolio_note",
    scope: "application",
    question: "What should the hiring team know?",
    answerType: "text",
  },
  {
    id: "preferred_location",
    scope: "global",
    question: "Which location do you prefer?",
    answerType: "single_select",
    options: [
      { id: "remote", label: "Remote" },
      { id: "hybrid", label: "Hybrid" },
    ],
  },
  {
    id: "available_days",
    scope: "application",
    question: "Which interview days work?",
    answerType: "multi_select",
    options: [
      { id: "monday", label: "Monday" },
      { id: "friday", label: "Friday" },
    ],
  },
];

function validDrafts(): AdditionalInfoDrafts {
  return {
    work_authorization: { status: "answered", value: true },
    portfolio_note: {
      status: "answered",
      rawValue: "  built systems for regulated teams  ",
      value: "  Please review my systems work.  ",
    },
    preferred_location: { status: "answered", value: "remote" },
    available_days: { status: "answered", value: ["friday", "monday"] },
  };
}

describe("buildAdditionalInfoCommand", () => {
  test("builds one exact typed answer for every projected question", () => {
    expect(buildAdditionalInfoCommand(questions, validDrafts())).toEqual({
      success: true,
      command: {
        type: "provide_additional_info",
        answers: [
          { id: "work_authorization", status: "answered", value: true },
          {
            id: "portfolio_note",
            status: "answered",
            raw_value: "built systems for regulated teams",
            value: "Please review my systems work.",
          },
          { id: "preferred_location", status: "answered", option_id: "remote" },
          {
            id: "available_days",
            status: "answered",
            option_ids: ["friday", "monday"],
          },
        ],
      },
    });
  });

  test("requires an answer or explicit decline for every question", () => {
    const drafts = validDrafts();
    delete drafts.portfolio_note;
    expect(buildAdditionalInfoCommand(questions, drafts)).toEqual({
      success: false,
      questionId: "portfolio_note",
      message: "Answer this question or choose Decline to answer.",
    });

    drafts.portfolio_note = { status: "declined" };
    expect(buildAdditionalInfoCommand(questions, drafts)).toEqual({
      success: true,
      command: {
        type: "provide_additional_info",
        answers: [
          { id: "work_authorization", status: "answered", value: true },
          { id: "portfolio_note", status: "declined" },
          { id: "preferred_location", status: "answered", option_id: "remote" },
          {
            id: "available_days",
            status: "answered",
            option_ids: ["friday", "monday"],
          },
        ],
      },
    });
  });

  test("uses the final text as raw when no assistance froze an earlier draft", () => {
    const drafts = validDrafts();
    drafts.portfolio_note = { status: "answered", value: "  Wrote reliable services.  " };
    const result = buildAdditionalInfoCommand(questions, drafts);
    expect(result).toMatchObject({
      success: true,
      command: {
        answers: expect.arrayContaining([{
          id: "portfolio_note",
          status: "answered",
          raw_value: "Wrote reliable services.",
          value: "Wrote reliable services.",
        }]),
      },
    });
  });

  test("rejects empty raw or final text and option ids outside the projected choices", () => {
    const emptyText = validDrafts();
    emptyText.portfolio_note = {
      status: "answered",
      rawValue: "Raw facts",
      value: "   ",
    };
    expect(buildAdditionalInfoCommand(questions, emptyText)).toMatchObject({
      success: false,
      questionId: "portfolio_note",
    });
    const emptyRawText = validDrafts();
    emptyRawText.portfolio_note = {
      status: "answered",
      rawValue: "   ",
      value: "Professional facts",
    };
    expect(buildAdditionalInfoCommand(questions, emptyRawText)).toMatchObject({
      success: false,
      questionId: "portfolio_note",
    });

    const longRawText = validDrafts();
    longRawText.portfolio_note = {
      status: "answered",
      rawValue: "🙂".repeat(2_001),
      value: "Professional facts",
    };
    expect(buildAdditionalInfoCommand(questions, longRawText)).toMatchObject({
      success: false,
      questionId: "portfolio_note",
    });

    const longFinalText = validDrafts();
    longFinalText.portfolio_note = {
      status: "answered",
      rawValue: "Raw facts",
      value: "🙂".repeat(2_001),
    };
    expect(buildAdditionalInfoCommand(questions, longFinalText)).toMatchObject({
      success: false,
      questionId: "portfolio_note",
    });

    const unknownSingle = validDrafts();
    unknownSingle.preferred_location = { status: "answered", value: "office" };
    expect(buildAdditionalInfoCommand(questions, unknownSingle)).toMatchObject({
      success: false,
      questionId: "preferred_location",
    });

    const duplicateMulti = validDrafts();
    duplicateMulti.available_days = { status: "answered", value: ["monday", "monday"] };
    expect(buildAdditionalInfoCommand(questions, duplicateMulti)).toMatchObject({
      success: false,
      questionId: "available_days",
    });
  });

  test("builds a multi-select answer containing one hundred selected options", () => {
    const options = Array.from({ length: 100 }, (_, index) => ({
      id: `option_${index}`,
      label: `Option ${index}`,
    }));
    const question: ApplicationAdditionalInfoQuestion = {
      id: "work_locations",
      scope: "global",
      question: "Which work locations can you accept?",
      answerType: "multi_select",
      options,
    };

    expect(buildAdditionalInfoCommand([question], {
      work_locations: {
        status: "answered",
        value: options.map(({ id }) => id),
      },
    })).toEqual({
      success: true,
      command: {
        type: "provide_additional_info",
        answers: [{
          id: "work_locations",
          status: "answered",
          option_ids: options.map(({ id }) => id),
        }],
      },
    });

    const tooManyOptions = [
      ...options,
      { id: "option_100", label: "Option 100" },
    ];
    expect(buildAdditionalInfoCommand([{
      ...question,
      options: tooManyOptions,
    }], {
      work_locations: {
        status: "answered",
        value: tooManyOptions.map(({ id }) => id),
      },
    })).toMatchObject({
      success: false,
      questionId: "work_locations",
    });
  });
});
