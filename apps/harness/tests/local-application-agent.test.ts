import { expect, test } from "bun:test";

import { runApplicationAgent } from "../src/application/agent-runtime/run.ts";
import type { ApplicationAgentDependencies, ApplicationAgentRunInput } from "../src/application/agent-runtime/contracts/application.ts";

const RUN_INPUT: ApplicationAgentRunInput = {
  opportunityKind: "job",
  sessionId: "123e4567-e89b-42d3-a456-426614174000",
  runtimeUrl: "http://127.0.0.1:8765",
  task: "Fill the supplied application with direct candidate data.",
  deadlineMs: 60_000,
  autoSubmit: false,
};

test("runs the application agent locally with its browser guidance", async () => {
  const stopMessage = "stop after reading local instructions";
  let instructions = "";
  const dependencies: ApplicationAgentDependencies = {
    runtimeClient: {
      async action() {
        throw new Error("unexpected runtime action");
      },
    },
    submissionGuard: {
      async markReviewReady() {},
      async claim() {},
      async finalize() {},
    },
    providerFactory() {
      return {
        getModel() {
          throw new Error("the fake runner must not resolve a live model");
        },
      };
    },
    runnerFactory() {
      return {
        async run(agent) {
          instructions = String(agent.instructions);
          throw new Error(stopMessage);
        },
      };
    },
  };

  await expect(runApplicationAgent(
    RUN_INPUT,
    new AbortController().signal,
    dependencies,
  )).rejects.toThrow(stopMessage);

  expect(instructions).toContain(
    "For date fields, use the exact date from supplied or saved answers and format it to match the form's required date format.",
  );
  expect(instructions).toContain(
    "willing or able to relocate to the job location, answer Yes",
  );
});
