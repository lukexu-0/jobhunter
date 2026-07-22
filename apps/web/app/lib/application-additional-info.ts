import {
  ApplicationSessionCommandSchema,
  type ApplicationAdditionalInfoQuestion,
  type ApplicationSessionCommand,
} from "@jobhunter/pipeline/contracts";

export type AdditionalInfoDraft =
  | { readonly status: "declined" }
  | {
    readonly status: "answered";
    readonly value: string | boolean | readonly string[];
  };

export type AdditionalInfoDrafts = Record<string, AdditionalInfoDraft | undefined>;

type AdditionalInfoCommand = Extract<
  ApplicationSessionCommand,
  { readonly type: "provide_additional_info" }
>;

export type AdditionalInfoBuildResult =
  | { readonly success: true; readonly command: AdditionalInfoCommand }
  | {
    readonly success: false;
    readonly questionId: string;
    readonly message: string;
  };

function failure(questionId: string, message: string): AdditionalInfoBuildResult {
  return { success: false, questionId, message };
}

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export function buildAdditionalInfoCommand(
  questions: readonly ApplicationAdditionalInfoQuestion[],
  drafts: Readonly<AdditionalInfoDrafts>,
): AdditionalInfoBuildResult {
  const answers: unknown[] = [];

  for (const question of questions) {
    const draft = drafts[question.id];
    if (!draft) {
      return failure(
        question.id,
        "Answer this question or choose Decline to answer.",
      );
    }
    if (draft.status === "declined") {
      answers.push({ id: question.id, status: "declined" });
      continue;
    }

    switch (question.answerType) {
      case "text": {
        if (typeof draft.value !== "string") {
          return failure(question.id, "Enter an answer between 1 and 2,000 characters.");
        }
        const value = draft.value.trim();
        if (!hasCodePointLength(value, 1, 2_000)) {
          return failure(question.id, "Enter an answer between 1 and 2,000 characters.");
        }
        answers.push({ id: question.id, status: "answered", value });
        break;
      }
      case "boolean":
        if (typeof draft.value !== "boolean") {
          return failure(question.id, "Choose Yes, No, or Decline to answer.");
        }
        answers.push({ id: question.id, status: "answered", value: draft.value });
        break;
      case "single_select": {
        if (
          typeof draft.value !== "string"
          || !question.options.some((option) => option.id === draft.value)
        ) {
          return failure(question.id, "Choose one listed option or Decline to answer.");
        }
        answers.push({ id: question.id, status: "answered", option_id: draft.value });
        break;
      }
      case "multi_select": {
        if (!Array.isArray(draft.value)) {
          return failure(question.id, "Choose at least one listed option or Decline to answer.");
        }
        const values = [...draft.value];
        const available = new Set(question.options.map((option) => option.id));
        if (
          values.length < 1
          || values.length > 20
          || new Set(values).size !== values.length
          || values.some((value) => typeof value !== "string" || !available.has(value))
        ) {
          return failure(question.id, "Choose at least one listed option or Decline to answer.");
        }
        answers.push({ id: question.id, status: "answered", option_ids: values });
        break;
      }
    }
  }

  const parsed = ApplicationSessionCommandSchema.safeParse({
    type: "provide_additional_info",
    answers,
  });
  if (!parsed.success || parsed.data.type !== "provide_additional_info") {
    return failure(
      questions[0]?.id ?? "additional_info",
      "Review the additional information answers and try again.",
    );
  }
  return { success: true, command: parsed.data };
}
