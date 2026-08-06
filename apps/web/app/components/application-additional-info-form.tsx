"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Settings } from "lucide-react";
import type {
  ApplicationAdditionalInfoQuestion,
  ApplicationAnswerSuggestion,
  ApplicationAnswerSuggestionsResponse,
  ApplicationProfessionalizeRequest,
  ApplicationProfessionalizeResponse,
  ApplicationSessionCommand,
} from "@jobhunter/pipeline/contracts";
import {
  buildAdditionalInfoCommand,
  type AdditionalInfoDraft,
  type AdditionalInfoDrafts,
} from "../lib/application-additional-info";
import { clipTextToCodePoints } from "../lib/application-text";
import { PipelineClientError } from "../lib/pipeline-client";
import styles from "../run-detail.module.css";

interface ApplicationAdditionalInfoFormProps {
  readonly submitting: boolean;
  readonly continuing: boolean;
  readonly questions: readonly ApplicationAdditionalInfoQuestion[];
  readonly busy: boolean;
  readonly steeringDisabled: boolean;
  readonly onLoadSuggestions: (
    questionId: string,
    signal: AbortSignal,
  ) => Promise<ApplicationAnswerSuggestionsResponse>;
  readonly onProfessionalize: (
    questionId: string,
    request: ApplicationProfessionalizeRequest,
    signal: AbortSignal,
  ) => Promise<ApplicationProfessionalizeResponse>;
  readonly onContinue: () => Promise<void>;
  readonly onSteerAndContinue: (
    command: ApplicationSessionCommand,
  ) => Promise<void>;
  readonly onSubmit: (command: ApplicationSessionCommand) => Promise<void>;
}

interface ValidationError {
  readonly questionId: string;
  readonly message: string;
}

interface AnswerToolState {
  readonly error: string | null;
  readonly instruction: string;
  readonly modelAction: "professionalize" | "revise" | null;
  readonly settingsOpen: boolean;
  readonly showRevision: boolean;
  readonly sourcesOpen: boolean;
  readonly suggestions: readonly ApplicationAnswerSuggestion[];
  readonly suggestionsState: "idle" | "loading" | "loaded";
  readonly status: string | null;
}

interface AnswerToolRequest {
  readonly controller: AbortController | null;
  readonly sequence: number;
}

const EMPTY_ANSWER_TOOL_STATE: AnswerToolState = {
  error: null,
  instruction: "",
  modelAction: null,
  settingsOpen: false,
  showRevision: false,
  sourcesOpen: false,
  suggestions: [],
  suggestionsState: "idle",
  status: null,
};

function answerToolErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PipelineClientError)) return fallback;
  return error.message.trim().slice(0, 240) || fallback;
}

function answeredValue(
  draft: AdditionalInfoDraft | undefined,
): string | boolean | readonly string[] | undefined {
  return draft?.status === "answered" ? draft.value : undefined;
}

export function ApplicationAdditionalInfoForm({
  questions,
  busy,
  continuing,
  submitting,
  steeringDisabled,
  onLoadSuggestions,
  onContinue,
  onProfessionalize,
  onSteerAndContinue,
  onSubmit,
}: ApplicationAdditionalInfoFormProps) {
  const [drafts, setDrafts] = useState<AdditionalInfoDrafts>({});
  const [validationError, setValidationError] = useState<ValidationError | null>(null);
  const [answerTools, setAnswerTools] = useState<
    Record<string, AnswerToolState | undefined>
  >({});
  const answerToolRequests = useRef<Record<string, AnswerToolRequest | undefined>>({});
  const formComplete = buildAdditionalInfoCommand(questions, drafts).success;
  const answerToolBusy = Object.values(answerTools).some((toolState) =>
    toolState !== undefined
    && (toolState.modelAction !== null || toolState.suggestionsState === "loading")
  );

  const patchAnswerTools = (
    id: string,
    patch: Partial<AnswerToolState>,
  ) => {
    setAnswerTools((current) => ({
      ...current,
      [id]: {
        ...EMPTY_ANSWER_TOOL_STATE,
        ...current[id],
        ...patch,
      },
    }));
  };

  const requestIsCurrent = (id: string, sequence: number): boolean =>
    answerToolRequests.current[id]?.sequence === sequence;

  const beginAnswerToolRequest = (
    id: string,
  ): { readonly controller: AbortController; readonly sequence: number } => {
    const previous = answerToolRequests.current[id];
    previous?.controller?.abort();
    const request = {
      controller: new AbortController(),
      sequence: (previous?.sequence ?? 0) + 1,
    };
    answerToolRequests.current[id] = request;
    return request;
  };

  const cancelAnswerToolRequest = (id: string) => {
    const previous = answerToolRequests.current[id];
    previous?.controller?.abort();
    answerToolRequests.current[id] = {
      controller: null,
      sequence: (previous?.sequence ?? 0) + 1,
    };
  };

  useEffect(() => () => {
    for (const request of Object.values(answerToolRequests.current)) {
      request?.controller?.abort();
    }
    answerToolRequests.current = {};
  }, []);

  const freezeRawDraft = (id: string) => {
    setDrafts((current) => {
      const existing = current[id];
      if (
        existing?.status !== "answered"
        || typeof existing.value !== "string"
        || existing.rawValue !== undefined
        || existing.value.trim().length === 0
      ) {
        return current;
      }
      return {
        ...current,
        [id]: { ...existing, rawValue: existing.value },
      };
    });
  };

  const updateDraft = (id: string, draft: AdditionalInfoDraft) => {
    setDrafts((current) => ({ ...current, [id]: draft }));
    setValidationError((current) => current?.questionId === id ? null : current);
  };

  const updateTextStatusDraft = (id: string, draft: AdditionalInfoDraft) => {
    cancelAnswerToolRequest(id);
    updateDraft(id, draft);
    setAnswerTools((current) => {
      const existing = current[id];
      return {
        ...current,
        [id]: {
          ...EMPTY_ANSWER_TOOL_STATE,
          ...existing,
          error: null,
          modelAction: null,
          sourcesOpen: existing?.suggestionsState === "loading"
            ? false
            : existing?.sourcesOpen ?? false,
          status: null,
          suggestionsState: existing?.suggestionsState === "loading"
            ? "idle"
            : existing?.suggestionsState ?? "idle",
        },
      };
    });
  };

  const updateTextDraft = (id: string, value: string) => {
    cancelAnswerToolRequest(id);
    setDrafts((current) => {
      const existing = current[id];
      const rawValue = existing?.status === "answered"
        && typeof existing.value === "string"
        ? existing.rawValue
        : undefined;
      return {
        ...current,
        [id]: {
          status: "answered",
          ...(rawValue === undefined ? {} : { rawValue }),
          value,
        },
      };
    });
    setValidationError((current) => current?.questionId === id ? null : current);
    setAnswerTools((current) => {
      const existing = current[id];
      return {
        ...current,
        [id]: {
          ...EMPTY_ANSWER_TOOL_STATE,
          ...existing,
          error: null,
          modelAction: null,
          status: null,
          suggestionsState: existing?.suggestionsState === "loading"
            ? "idle"
            : existing?.suggestionsState ?? "idle",
          sourcesOpen: existing?.suggestionsState === "loading"
            ? false
            : existing?.sourcesOpen ?? false,
        },
      };
    });
  };

  const loadSuggestions = async (id: string) => {
    const currentTools = answerTools[id] ?? EMPTY_ANSWER_TOOL_STATE;
    if (currentTools.sourcesOpen) {
      patchAnswerTools(id, { sourcesOpen: false, status: null });
      return;
    }
    freezeRawDraft(id);
    if (currentTools.suggestionsState === "loaded") {
      patchAnswerTools(id, {
        sourcesOpen: true,
        status: "Previous answers opened.",
      });
      return;
    }
    const request = beginAnswerToolRequest(id);
    patchAnswerTools(id, {
      error: null,
      modelAction: null,
      sourcesOpen: true,
      suggestionsState: "loading",
      status: "Loading previous answers…",
    });
    try {
      const response = await onLoadSuggestions(id, request.controller.signal);
      if (!requestIsCurrent(id, request.sequence)) return;
      patchAnswerTools(id, {
        suggestions: response.suggestions,
        suggestionsState: "loaded",
        status: response.suggestions.length > 0
          ? "Previous answers ready."
          : "Previous answer search complete.",
      });
    } catch (error) {
      if (!requestIsCurrent(id, request.sequence)) return;
      patchAnswerTools(id, {
        error: answerToolErrorMessage(
          error,
          "Previous answers could not be loaded.",
        ),
        sourcesOpen: false,
        suggestionsState: "idle",
        status: null,
      });
    } finally {
      if (requestIsCurrent(id, request.sequence)) {
        answerToolRequests.current[id] = {
          controller: null,
          sequence: request.sequence,
        };
      }
    }
  };

  const professionalize = async (
    id: string,
    instruction: string | undefined,
    modelAction: "professionalize" | "revise",
  ) => {
    const draft = drafts[id];
    const value = draft?.status === "answered" && typeof draft.value === "string"
      ? draft.value.trim()
      : "";
    if (value.length === 0) {
      patchAnswerTools(id, {
        error: "Enter loose thoughts before professionalizing.",
        status: null,
      });
      return;
    }
    const normalizedInstruction = instruction?.trim();
    if (modelAction === "revise" && !normalizedInstruction) {
      patchAnswerTools(id, {
        error: "Describe the change you want.",
        status: null,
      });
      return;
    }
    freezeRawDraft(id);
    const request = beginAnswerToolRequest(id);
    patchAnswerTools(id, {
      error: null,
      modelAction,
      sourcesOpen: false,
      suggestionsState: answerTools[id]?.suggestionsState === "loading"
        ? "idle"
        : answerTools[id]?.suggestionsState ?? "idle",
      status: modelAction === "revise"
        ? "Applying your edit specification…"
        : "Professionalizing answer…",
    });
    try {
      const response = await onProfessionalize(
        id,
        {
          promptId: "default",
          draft: value,
          ...(normalizedInstruction ? { instruction: normalizedInstruction } : {}),
        },
        request.controller.signal,
      );
      if (!requestIsCurrent(id, request.sequence)) return;
      setDrafts((current) => {
        const existing = current[id];
        if (existing?.status !== "answered" || typeof existing.value !== "string") {
          return current;
        }
        return {
          ...current,
          [id]: {
            status: "answered",
            rawValue: existing.rawValue ?? value,
            value: response.answer,
          },
        };
      });
      patchAnswerTools(id, {
        instruction: "",
        showRevision: true,
        status: "Professional answer ready. You can edit it or request another change.",
      });
    } catch (error) {
      if (!requestIsCurrent(id, request.sequence)) return;
      patchAnswerTools(id, {
        error: answerToolErrorMessage(
          error,
          modelAction === "revise"
            ? "The suggested edit could not be applied."
            : "The answer could not be professionalized.",
        ),
        status: null,
      });
    } finally {
      if (requestIsCurrent(id, request.sequence)) {
        answerToolRequests.current[id] = {
          controller: null,
          sequence: request.sequence,
        };
        patchAnswerTools(id, { modelAction: null });
      }
    }
  };

  const useSuggestion = (id: string, suggestion: ApplicationAnswerSuggestion) => {
    cancelAnswerToolRequest(id);
    setDrafts((current) => {
      const existing = current[id];
      const rawValue = existing?.status === "answered"
        && typeof existing.value === "string"
        ? existing.rawValue
          ?? (existing.value.trim().length > 0 ? existing.value : suggestion.answer)
        : suggestion.answer;
      return {
        ...current,
        [id]: {
          status: "answered",
          rawValue,
          value: suggestion.answer,
        },
      };
    });
    setValidationError((current) => current?.questionId === id ? null : current);
    patchAnswerTools(id, {
      error: null,
      modelAction: null,
      showRevision: false,
      sourcesOpen: false,
      status: "Previous answer copied. You can edit it before submitting.",
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const steerAndContinue =
      submitter?.getAttribute("value") === "steer_and_continue";
    const result = buildAdditionalInfoCommand(questions, drafts);
    if (!result.success) {
      setValidationError(result);
      window.requestAnimationFrame(() => {
        document.getElementById(`application-question-${result.questionId}`)?.focus();
      });
      return;
    }
    setValidationError(null);
    await (steerAndContinue
      ? onSteerAndContinue(result.command)
      : onSubmit(result.command));
  };

  return (
    <form className={styles.applicationAdditionalInfoForm} noValidate onSubmit={(event) => void submit(event)}>
      <div>
        <h3>Additional information needed</h3>
        <p>
          Provide an answer or explicitly decline each question. Continue attempts
          progress without saving answers.
        </p>
      </div>
      {questions.map((question) => {
        const draft = drafts[question.id];
        const value = answeredValue(draft);
        const declined = draft?.status === "declined";
        const scopeId = `application-question-${question.id}-scope`;
        const errorId = `application-question-${question.id}-error`;
        const hasError = validationError?.questionId === question.id;
        const describedBy = hasError ? `${scopeId} ${errorId}` : scopeId;
        const toolState = answerTools[question.id] ?? EMPTY_ANSWER_TOOL_STATE;
        const answerToolStatusId = `application-question-${question.id}-answer-tool-status`;
        const answerToolErrorId = `application-question-${question.id}-answer-tool-error`;
        const settingsId = `application-question-${question.id}-professionalize-settings`;
        const sourcesId = `application-question-${question.id}-previous-answers`;
        const textValue = typeof value === "string" ? value : "";
        const answerDescribedBy = [
          hasError ? errorId : null,
          toolState.error ? answerToolErrorId : null,
        ].filter((id): id is string => id !== null).join(" ") || undefined;

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
                    aria-describedby={answerDescribedBy}
                    aria-invalid={hasError || undefined}
                    disabled={declined || busy}
                    onChange={(event) => updateTextDraft(
                      question.id,
                      clipTextToCodePoints(event.currentTarget.value, 2_000),
                    )}
                    value={textValue}
                  />
                </label>

                <div className={styles.applicationAnswerTools}>
                  <div className={styles.applicationAnswerToolActions}>
                    <div className={styles.applicationProfessionalizeActions}>
                      <button
                        className={styles.secondaryButton}
                        disabled={
                          busy
                          || declined
                          || toolState.modelAction !== null
                          || textValue.trim().length === 0
                        }
                        onClick={() => void professionalize(
                          question.id,
                          undefined,
                          "professionalize",
                        )}
                        type="button"
                      >
                        {toolState.modelAction === "professionalize"
                          ? "Professionalizing…"
                          : "Professionalize"}
                      </button>
                      <button
                        aria-controls={settingsId}
                        aria-expanded={toolState.settingsOpen}
                        aria-label="Professionalize settings"
                        className={`${styles.secondaryButton} ${styles.applicationSettingsButton}`}
                        disabled={busy || declined}
                        onClick={() => patchAnswerTools(question.id, {
                          settingsOpen: !toolState.settingsOpen,
                        })}
                        type="button"
                      >
                        <Settings aria-hidden="true" className={styles.icon} strokeWidth={1.7} />
                      </button>
                    </div>
                    <button
                      aria-controls={sourcesId}
                      aria-expanded={toolState.sourcesOpen}
                      className={styles.secondaryButton}
                      disabled={
                        busy
                        || declined
                        || toolState.suggestionsState === "loading"
                      }
                      onClick={() => void loadSuggestions(question.id)}
                      type="button"
                    >
                      {toolState.suggestionsState === "loading"
                        ? "Loading previous answers…"
                        : toolState.sourcesOpen
                          ? "Hide previous answers"
                          : "Previous answers"}
                    </button>
                  </div>

                  {toolState.settingsOpen ? (
                    <div
                      aria-label="Professionalize prompt"
                      className={styles.applicationAnswerToolPanel}
                      id={settingsId}
                      role="group"
                    >
                      <p className={styles.applicationAnswerToolLabel}>Prompt</p>
                      <label className={styles.workspaceCheck}>
                        <input
                          aria-describedby={`${settingsId}-description`}
                          checked
                          disabled={busy}
                          name={`${settingsId}-prompt`}
                          readOnly
                          type="radio"
                        />
                        <span>Default</span>
                      </label>
                      <p id={`${settingsId}-description`}>
                        Default Sol turns loose thoughts into a concise professional answer without adding facts.
                      </p>
                    </div>
                  ) : null}

                  {toolState.sourcesOpen ? (
                    <div
                      aria-label="Previous answers"
                      className={styles.applicationAnswerToolPanel}
                      id={sourcesId}
                      role="region"
                    >
                      {toolState.suggestionsState === "loaded"
                        && toolState.suggestions.length === 0 ? (
                          <p>
                            No previous answers are available. Draft an answer here to save it after submission.
                          </p>
                        ) : null}
                      {toolState.suggestions.length > 0 ? (
                        <ul className={styles.applicationAnswerSources}>
                          {toolState.suggestions.map((suggestion, index) => (
                            <li key={`${suggestion.question}:${index}`}>
                              <p className={styles.applicationAnswerSourceQuestion}>
                                {suggestion.question}
                              </p>
                              <p>{suggestion.answer}</p>
                              <button
                                aria-label={`Use answer: ${suggestion.answer}`}
                                disabled={busy}
                                className={styles.secondaryButton}
                                onClick={() => useSuggestion(question.id, suggestion)}
                                type="button"
                              >
                                Use answer
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {toolState.showRevision ? (
                    <div className={styles.applicationAnswerRevision}>
                      <label className={styles.workspaceField}>
                        <span>Edit specification</span>
                        <input
                          disabled={busy || declined || toolState.modelAction !== null}
                          onChange={(event) => patchAnswerTools(question.id, {
                            error: null,
                            instruction: clipTextToCodePoints(
                              event.currentTarget.value,
                              1_000,
                            ),
                            status: null,
                          })}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            if (
                              busy
                              || declined
                              || toolState.modelAction !== null
                              || toolState.instruction.trim().length === 0
                              || event.repeat
                              || event.nativeEvent.isComposing
                            ) {
                              return;
                            }
                            void professionalize(
                              question.id,
                              toolState.instruction,
                              "revise",
                            );
                          }}
                          value={toolState.instruction}
                        />
                      </label>
                      <button
                        className={styles.secondaryButton}
                        disabled={
                          busy
                          || declined
                          || toolState.modelAction !== null
                          || toolState.instruction.trim().length === 0
                        }
                        onClick={() => void professionalize(
                          question.id,
                          toolState.instruction,
                          "revise",
                        )}
                        type="button"
                      >
                        {toolState.modelAction === "revise"
                          ? "Applying suggestion…"
                          : "Apply suggestion"}
                      </button>
                    </div>
                  ) : null}

                  {toolState.status ? (
                    <p
                      aria-atomic="true"
                      aria-live="polite"
                      className={styles.applicationAnswerToolStatus}
                      id={answerToolStatusId}
                      role="status"
                    >
                      {toolState.status}
                    </p>
                  ) : null}
                  {toolState.error ? (
                    <p
                      className={styles.panelError}
                      id={answerToolErrorId}
                      role="alert"
                    >
                      {toolState.error}
                    </p>
                  ) : null}
                </div>

                <label className={styles.workspaceCheck}>
                  <input
                    checked={declined}
                    disabled={busy}
                    onChange={(event) => updateTextStatusDraft(
                      question.id,
                      event.currentTarget.checked
                        ? { status: "declined" }
                        : { status: "answered", value: textValue },
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
      <button
        className={styles.primaryButton}
        disabled={busy || answerToolBusy || !formComplete}
        type="submit"
      >
        {submitting ? "Answering…" : "Answer questions"}
      </button>
      <button
        className={styles.secondaryButton}
        disabled={busy || answerToolBusy}
        onClick={() => void onContinue()}
        type="button"
      >
        {continuing ? "Continuing…" : "Continue"}
      </button>
      <button
        className={styles.secondaryButton}
        disabled={busy || answerToolBusy || !formComplete || steeringDisabled}
        name="question_action"
        type="submit"
        value="steer_and_continue"
      >
        Steer and answer questions
      </button>
    </form>
  );
}
