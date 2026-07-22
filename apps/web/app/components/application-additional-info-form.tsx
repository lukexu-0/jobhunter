"use client";

import {
  useEffect,
  useState,
  type FormEvent,
} from "react";
import type {
  ApplicationAdditionalInfoQuestion,
  ApplicationSessionCommand,
} from "@jobhunter/pipeline/contracts";
import {
  buildAdditionalInfoCommand,
  type AdditionalInfoDraft,
  type AdditionalInfoDrafts,
} from "../lib/application-additional-info";
import styles from "../run-detail.module.css";

interface ApplicationAdditionalInfoFormProps {
  readonly submitting: boolean;
  readonly questions: readonly ApplicationAdditionalInfoQuestion[];
  readonly busy: boolean;
  readonly onSubmit: (command: ApplicationSessionCommand) => Promise<void>;
}

interface ValidationError {
  readonly questionId: string;
  readonly message: string;
}

function answeredValue(
  draft: AdditionalInfoDraft | undefined,
): string | boolean | readonly string[] | undefined {
  return draft?.status === "answered" ? draft.value : undefined;
}

export function ApplicationAdditionalInfoForm({
  questions,
  busy,
  submitting,
  onSubmit,
}: ApplicationAdditionalInfoFormProps) {
  const [drafts, setDrafts] = useState<AdditionalInfoDrafts>({});
  const [validationError, setValidationError] = useState<ValidationError | null>(null);
  const questionSignature = JSON.stringify(questions);
  const formComplete = buildAdditionalInfoCommand(questions, drafts).success;

  useEffect(() => {
    setDrafts({});
    setValidationError(null);
  }, [questionSignature]);

  const updateDraft = (id: string, draft: AdditionalInfoDraft) => {
    setDrafts((current) => ({ ...current, [id]: draft }));
    setValidationError((current) => current?.questionId === id ? null : current);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = buildAdditionalInfoCommand(questions, drafts);
    if (!result.success) {
      setValidationError(result);
      window.requestAnimationFrame(() => {
        document.getElementById(`application-question-${result.questionId}`)?.focus();
      });
      return;
    }
    setValidationError(null);
    await onSubmit(result.command);
  };

  return (
    <form className={styles.applicationAdditionalInfoForm} noValidate onSubmit={(event) => void submit(event)}>
      <div>
        <h3>Additional information needed</h3>
        <p>Provide an answer or explicitly decline each question.</p>
      </div>
      {questions.map((question) => {
        const draft = drafts[question.id];
        const value = answeredValue(draft);
        const declined = draft?.status === "declined";
        const scopeId = `application-question-${question.id}-scope`;
        const errorId = `application-question-${question.id}-error`;
        const hasError = validationError?.questionId === question.id;
        const describedBy = hasError ? `${scopeId} ${errorId}` : scopeId;

        return (
          <fieldset
            aria-describedby={describedBy}
            className={styles.applicationQuestion}
            data-question-id={question.id}
            id={`application-question-${question.id}`}
            key={question.id}
            tabIndex={-1}
          >
            <legend>{question.question}</legend>
            <p className={styles.applicationQuestionScope} id={scopeId}>
              {question.scope === "global"
                ? "Saved for future applications"
                : "Used for this job only"}
            </p>

            {question.answerType === "text" ? (
              <>
                <label className={styles.workspaceField}>
                  <span>Answer</span>
                  <textarea
                    aria-invalid={hasError || undefined}
                    disabled={declined || busy}
                    maxLength={2_000}
                    onChange={(event) => updateDraft(question.id, {
                      status: "answered",
                      value: event.currentTarget.value,
                    })}
                    value={typeof value === "string" ? value : ""}
                  />
                </label>
                <label className={styles.workspaceCheck}>
                  <input
                    checked={declined}
                    disabled={busy}
                    onChange={(event) => updateDraft(
                      question.id,
                      event.currentTarget.checked
                        ? { status: "declined" }
                        : {
                          status: "answered",
                          value: typeof value === "string" ? value : "",
                        },
                    )}
                    type="checkbox"
                  />
                  <span>Decline to answer</span>
                </label>
              </>
            ) : question.answerType === "boolean" ? (
              <div className={styles.applicationQuestionChoices}>
                <label className={styles.workspaceCheck}>
                  <input
                    checked={!declined && value === true}
                    disabled={busy}
                    name={`application-question-${question.id}`}
                    onChange={() => updateDraft(question.id, { status: "answered", value: true })}
                    type="radio"
                  />
                  <span>Yes</span>
                </label>
                <label className={styles.workspaceCheck}>
                  <input
                    checked={!declined && value === false}
                    disabled={busy}
                    name={`application-question-${question.id}`}
                    onChange={() => updateDraft(question.id, { status: "answered", value: false })}
                    type="radio"
                  />
                  <span>No</span>
                </label>
                <label className={styles.workspaceCheck}>
                  <input
                    checked={declined}
                    disabled={busy}
                    name={`application-question-${question.id}`}
                    onChange={() => updateDraft(question.id, { status: "declined" })}
                    type="radio"
                  />
                  <span>Decline to answer</span>
                </label>
              </div>
            ) : question.answerType === "single_select" ? (
              <div className={styles.applicationQuestionChoices}>
                {question.options.map((option) => (
                  <label className={styles.workspaceCheck} key={option.id}>
                    <input
                      checked={!declined && value === option.id}
                      disabled={busy}
                      name={`application-question-${question.id}`}
                      onChange={() => updateDraft(question.id, {
                        status: "answered",
                        value: option.id,
                      })}
                      type="radio"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
                <label className={styles.workspaceCheck}>
                  <input
                    checked={declined}
                    disabled={busy}
                    name={`application-question-${question.id}`}
                    onChange={() => updateDraft(question.id, { status: "declined" })}
                    type="radio"
                  />
                  <span>Decline to answer</span>
                </label>
              </div>
            ) : (
              <div className={styles.applicationQuestionChoices}>
                {question.options.map((option) => {
                  const selected = Array.isArray(value) && value.includes(option.id);
                  return (
                    <label className={styles.workspaceCheck} key={option.id}>
                      <input
                        checked={!declined && selected}
                        disabled={busy}
                        onChange={(event) => {
                          const selectedValues = Array.isArray(value) ? [...value] : [];
                          updateDraft(question.id, {
                            status: "answered",
                            value: event.currentTarget.checked
                              ? [...selectedValues, option.id]
                              : selectedValues.filter((id) => id !== option.id),
                          });
                        }}
                        type="checkbox"
                      />
                      <span>{option.label}</span>
                    </label>
                  );
                })}
                <label className={styles.workspaceCheck}>
                  <input
                    checked={declined}
                    disabled={busy}
                    onChange={(event) => updateDraft(
                      question.id,
                      event.currentTarget.checked
                        ? { status: "declined" }
                        : { status: "answered", value: [] },
                    )}
                    type="checkbox"
                  />
                  <span>Decline to answer</span>
                </label>
              </div>
            )}

            {hasError ? (
              <p className={styles.panelError} id={errorId} role="alert">
                {validationError.message}
              </p>
            ) : null}
          </fieldset>
        );
      })}
      <button className={styles.primaryButton} disabled={busy || !formComplete} type="submit">
        {submitting ? "Answering…" : "Answer questions"}
      </button>
    </form>
  );
}
