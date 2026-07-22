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
    portfolio_note: { status: "answered", value: "  Please review my systems work.  " },
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

  test("rejects empty text and option ids outside the projected choices", () => {
    const emptyText = validDrafts();
    emptyText.portfolio_note = { status: "answered", value: "   " };
    expect(buildAdditionalInfoCommand(questions, emptyText)).toMatchObject({
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
});
