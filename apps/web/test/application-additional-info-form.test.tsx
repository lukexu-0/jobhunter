import { describe, expect, test } from "bun:test";
import type { ApplicationAdditionalInfoQuestion } from "@jobhunter/pipeline/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationAdditionalInfoForm } from "../app/components/application-additional-info-form";

const questions: readonly ApplicationAdditionalInfoQuestion[] = [
  {
    id: "work_authorization",
    scope: "global",
    question: "Are you authorized to work here?",
    answerType: "boolean",
  },
  {
    id: "motivation",
    scope: "application",
    question: "Why are you interested in this role?",
    answerType: "text",
  },
];

const callbacks = {
  onContinue: async () => {},
  onLoadSuggestions: async () => ({ suggestions: [] }),
  onProfessionalize: async () => ({ answer: "Professional answer" }),
  onSteerAndContinue: async () => {},
  onSubmit: async () => {},
};

function buttonOpeningTag(markup: string, label: string): string {
  const labelIndex = markup.indexOf(`>${label}</button>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);
  return markup.slice(markup.lastIndexOf("<button", labelIndex), labelIndex);
}

describe("ApplicationAdditionalInfoForm", () => {
  test("offers Continue without requiring answers and explains that answers are not saved", () => {
    const markup = renderToStaticMarkup(
      <ApplicationAdditionalInfoForm
        {...callbacks}
        busy={false}
        continuing={false}
        questions={questions}
        steeringDisabled={false}
        submitting={false}
      />,
    );

    expect(markup).toContain("without saving answers");
    expect(buttonOpeningTag(markup, "Continue")).not.toContain("disabled");
    expect(buttonOpeningTag(markup, "Answer questions")).toContain("disabled");
  });

  test("shows Continuing… and disables Continue while its command is busy", () => {
    const markup = renderToStaticMarkup(
      <ApplicationAdditionalInfoForm
        {...callbacks}
        busy
        continuing
        questions={questions}
        steeringDisabled={false}
        submitting={false}
      />,
    );

    expect(buttonOpeningTag(markup, "Continuing…")).toContain("disabled");
  });
});
