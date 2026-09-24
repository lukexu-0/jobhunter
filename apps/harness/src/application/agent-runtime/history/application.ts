import type { AgentInputItem, CallModelInputFilter } from "@openai/agents-core";
import type { ApplicationModel } from "../../../models/application-model.ts";
import {
  estimateGeminiApplicationRequestTokens,
  GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS,
  type GeminiHistoryCompactor,
} from "../application-compaction.ts";
import {
  MAX_APPLICATION_AGENT_TRANSCRIPT_BYTES,
  MAX_APPLICATION_MODEL_INPUT_BYTES,
  projectApplicationHistory,
} from "../application-history.ts";
import { APPLICATION_AGENT_STEERING_PREFIX } from "../application-agent-steering.ts";
import { assertBoundedTranscript, boundedJson } from "../runner.ts";
import {
  ApplicationAgentFailure,
  type ApplicationAgentRunInput,
  type BrowserApplicationContext,
} from "../contracts/application.ts";

function pruneApplicationTranscript(result: object): void {
  const rawResponses = "rawResponses" in result ? result.rawResponses : undefined;
  if (Array.isArray(rawResponses)) rawResponses.splice(0, rawResponses.length);
  try {
    assertBoundedTranscript(result, MAX_APPLICATION_AGENT_TRANSCRIPT_BYTES);
    return;
  } catch {
    // Raw provider responses are redundant once normalized run items exist.
  }

  const newItems = "newItems" in result ? result.newItems : undefined;
  if (Array.isArray(newItems)) {
    const finalOutput = "finalOutput" in result ? result.finalOutput : undefined;
    let availableBytes = -1;
    try {
      const emptyTranscript = JSON.stringify({ rawResponses: [], newItems: [], finalOutput });
      if (emptyTranscript !== undefined) {
        availableBytes = MAX_APPLICATION_AGENT_TRANSCRIPT_BYTES
          - Buffer.byteLength(emptyTranscript, "utf8");
      }
    } catch {
      // The final output is not recoverable transcript history.
    }
    let retainedBytes = 0;
    let retainedStart = newItems.length;
    if (availableBytes >= 0) {
      for (let index = newItems.length - 1; index >= 0; index -= 1) {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(newItems[index]);
        } catch {
          break;
        }
        if (serialized === undefined) break;
        const itemBytes = Buffer.byteLength(serialized, "utf8")
          + (retainedStart === newItems.length ? 0 : 1);
        if (retainedBytes + itemBytes > availableBytes) break;
        retainedBytes += itemBytes;
        retainedStart = index;
      }
    }
    if (retainedStart > 0) newItems.splice(0, retainedStart);
  }

  try {
    assertBoundedTranscript(result, MAX_APPLICATION_AGENT_TRANSCRIPT_BYTES);
  } catch {
    throw new ApplicationAgentFailure("INVALID_MODEL_OUTPUT");
  }
}

export function applicationTranscriptAssertion(
  result: unknown,
  modelProvider: ApplicationModel["modelProvider"],
): boolean {
  if (
    !result
    || typeof result !== "object"
    || !("history" in result)
    || !Array.isArray(result.history)
  ) {
    throw new ApplicationAgentFailure("INVALID_MODEL_OUTPUT");
  }
  try {
    assertBoundedTranscript(result, MAX_APPLICATION_AGENT_TRANSCRIPT_BYTES);
  } catch {
    pruneApplicationTranscript(result);
  }
  try {
    projectApplicationHistory(result.history as AgentInputItem[], modelProvider);
    return false;
  } catch {
    return true;
  }
}
export function createApplicationHistory({
  input,
  applicationModel,
  historyCompactor,
  context,
  signal,
}: {
  readonly input: ApplicationAgentRunInput;
  readonly applicationModel: ApplicationModel;
  readonly historyCompactor: GeminiHistoryCompactor | undefined;
  readonly context: BrowserApplicationContext;
  readonly signal: AbortSignal;
}): {
  readonly filter: CallModelInputFilter<BrowserApplicationContext>;
  readonly projectPersistentHistory: (history: readonly AgentInputItem[]) => AgentInputItem[];
} {
  const authoritativeTaskItem: AgentInputItem = {
    role: "user",
    content: [{ type: "input_text", text: input.task }],
  };
  const recoveryNotice: AgentInputItem = {
    role: "user",
    content: [{
      type: "input_text",
      text: "Earlier application history could not be reused. Continue from the authoritative application task and recent validated messages, and take a fresh browser snapshot before acting.",
    }],
  };
  const isAuthoritativeTaskItem = (item: AgentInputItem): boolean => {
    if (
      item === null
      || typeof item !== "object"
      || !("role" in item)
      || item.role !== "user"
      || !("content" in item)
      || !Array.isArray(item.content)
    ) return false;
    return item.content.length === 1
      && item.content[0]?.type === "input_text"
      && item.content[0].text === input.task;
  };
  const pinAuthoritativeTask = (history: readonly AgentInputItem[]): AgentInputItem[] => [
    authoritativeTaskItem,
    ...history.filter((item) => !isAuthoritativeTaskItem(item)),
  ];
  const recoverApplicationHistory = (history: readonly AgentInputItem[]): AgentInputItem[] => {
    context.recoverableFailureObserved = true;
    context.browserSnapshotRequired = true;
    context.playwrightCliCompleted = false;
    delete context.latestScreenshotDataUrl;
    let recovered: AgentInputItem[] = [authoritativeTaskItem, recoveryNotice];
    for (const item of history.slice(-32)) {
      if (item === null || typeof item !== "object") continue;
      const message = item as { type?: unknown; role?: unknown };
      if (
        (message.type !== undefined && message.type !== "message")
        || (message.role !== "user" && message.role !== "assistant")
        || isAuthoritativeTaskItem(item)
      ) continue;
      try {
        recovered = projectApplicationHistory(
          [...recovered, item],
          applicationModel.modelProvider,
        );
      } catch {
        // Keep only recent messages that are valid for this provider.
      }
    }
    return recovered;
  };
  const projectPersistentHistory = (history: readonly AgentInputItem[]): AgentInputItem[] => {
    try {
      return projectApplicationHistory(
        pinAuthoritativeTask(history),
        applicationModel.modelProvider,
      );
    } catch {
      return recoverApplicationHistory(history);
    }
  };

  const filter: CallModelInputFilter<BrowserApplicationContext> = async ({
    agent: filteringAgent,
    modelData,
    context: filterContext,
  }) => {
    const steeringInbox = filterContext?.steeringInbox;
    const steeringBatch = steeringInbox?.snapshot();
    const guidanceInput = steeringBatch?.messages.map((message): AgentInputItem => ({
      role: "user",
      content: [{
        type: "input_text",
        text: `${APPLICATION_AGENT_STEERING_PREFIX}${message}`,
      }],
    })) ?? [];
    const screenshot = filterContext?.latestScreenshotDataUrl;
    const transientImage: AgentInputItem | undefined = screenshot === undefined
      || Buffer.byteLength(screenshot, "utf8") > MAX_APPLICATION_MODEL_INPUT_BYTES
      ? undefined
      : {
        role: "user",
        content: [{ type: "input_image", image: screenshot }],
      };
    const projectWithTransients = (
      history: AgentInputItem[],
      includeScreenshot: boolean,
    ): AgentInputItem[] => {
      let transientInput = history;
      if (guidanceInput.length > 0) {
        const candidateInput = [...transientInput, ...guidanceInput];
        boundedJson(
          candidateInput,
          "application agent model input",
          MAX_APPLICATION_MODEL_INPUT_BYTES,
        );
        transientInput = candidateInput;
      }
      if (!includeScreenshot || transientImage === undefined) return transientInput;
      const candidateInput = [...transientInput, transientImage];
      const transcriptLabel = "application agent model input";
      try {
        boundedJson(
          candidateInput,
          transcriptLabel,
          MAX_APPLICATION_MODEL_INPUT_BYTES,
        );
      } catch (error) {
        if (
          error instanceof Error
          && error.message === `${transcriptLabel} exceeds ${MAX_APPLICATION_MODEL_INPUT_BYTES} bytes`
        ) {
          return transientInput;
        }
        throw error;
      }
      return candidateInput;
    };

    try {
      const persistentInput = projectPersistentHistory(modelData.input);
      let compactedInput = persistentInput;
      if (historyCompactor !== undefined) {
        try {
          compactedInput = projectPersistentHistory(
            await historyCompactor.project(persistentInput),
          );
        } catch {
          compactedInput = recoverApplicationHistory(persistentInput);
        }
      }
      let finalInput = projectWithTransients(compactedInput, true);
      if (historyCompactor !== undefined) {
        const geminiTools = filteringAgent.tools.map((tool, index) => {
          if (tool.type !== "function") {
            throw new Error(`Unsupported Gemini tool type at index ${index}`);
          }
          return {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: tool.strict,
          };
        });
        let contextTokens = estimateGeminiApplicationRequestTokens(
          finalInput,
          modelData.instructions,
          geminiTools,
        );
        if (contextTokens > GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS) {
          try {
            compactedInput = projectPersistentHistory(
              await historyCompactor.project(persistentInput, contextTokens, signal),
            );
          } catch {
            compactedInput = recoverApplicationHistory(persistentInput);
          }
          finalInput = projectWithTransients(compactedInput, true);
          contextTokens = estimateGeminiApplicationRequestTokens(
            finalInput,
            modelData.instructions,
            geminiTools,
          );
          if (
            contextTokens > GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS
            && transientImage !== undefined
          ) {
            finalInput = projectWithTransients(compactedInput, false);
          }
        }
      }
      if (
        steeringInbox !== undefined
        && steeringBatch !== undefined
        && !steeringInbox.commit(steeringBatch)
      ) {
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      }
      return { ...modelData, input: finalInput };
    } catch {
      throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
    }
  };
  return { filter, projectPersistentHistory };
}
