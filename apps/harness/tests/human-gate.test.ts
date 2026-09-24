import { describe, expect, test } from "bun:test";
import {
  HumanGate,
  type BrowserGateRuntime,
  type CredentialStorePort,
  type GatePublication,
  type UserInfoStorePort,
} from "../src/application/human-gate";

class Runtime implements BrowserGateRuntime {
  currentUrl = "https://jobs.example/application";
  activated: string[][] = [];
  signIns: Array<Record<string, string | undefined>> = [];
  suppressed = 0;
  signInBarrier: Promise<void> | null = null;

  async getCurrentPageUrl(): Promise<string> {
    return this.currentUrl;
  }
  async suppressPrivateCapture(): Promise<void> {
    this.suppressed += 1;
  }
  async activatePrivateValues(values: readonly string[]): Promise<void> {
    this.activated.push([...values]);
  }
  async signIn(input: Record<string, string | undefined>): Promise<void> {
    this.signIns.push(input);
    if (this.signInBarrier) await this.signInBarrier;
  }
}

class UserInfoStore implements UserInfoStorePort {
  merges: unknown[][] = [];
  async merge(jobUrl: string, questions: readonly unknown[], answers: readonly unknown[]): Promise<readonly unknown[]> {
    this.merges.push([jobUrl, questions, answers]);
    return answers;
  }
}
class CredentialStore implements CredentialStorePort {
  credentials: Array<{ origin: string; username: string; password: string }> = [];
  upserts: Array<{ origin: string; username: string; password: string }> = [];

  async credentialsForOrigin(origin: string) {
    return this.credentials.filter((credential) => credential.origin === origin);
  }

  async upsert(origin: string, username: string, password: string): Promise<void> {
    this.upserts.push({ origin, username, password });
  }
}

function makeGate(options: { autoSubmit?: boolean; defaultCredentials?: readonly [string, string] } = {}) {
  const publications: GatePublication[] = [];
  const userInfoStore = new UserInfoStore();
  const gate = new HumanGate({
    jobUrl: "https://jobs.example/posting/42",
    privateValues: ["ada.private@example.test"],
    userInfoStore,
    ...(options.autoSubmit === undefined ? {} : { autoSubmit: options.autoSubmit }),
    ...(options.defaultCredentials === undefined
      ? {}
      : { defaultCredentials: options.defaultCredentials }),
    publish: async (publication) => {
      publications.push(publication);
    },
  });
  return { gate, publications, userInfoStore };
}

async function flushGateWork(): Promise<void> { for (let index = 0; index < 5; index += 1) { await Promise.resolve(); } }

describe("HumanGate", () => {
  test("navigation stays pending after an unsafe page and resumes only after correction", async () => {
    const { gate, publications } = makeGate();
    const runtime = new Runtime();
    runtime.currentUrl = "chrome://settings";

    const result = gate.requestHumanNavigation(
      "Complete verification for ada.private@example.test",
      runtime,
    );
    await flushGateWork(); expect(gate.pendingKind).toBe("navigation");

    expect(publications.at(-1)).toEqual({
      state: "awaiting_human_navigation",
      event: "human_navigation_required",
      detail: { instruction: "Complete verification for [redacted]" },
    });
    await gate.continueNavigation();
    await flushGateWork();
    expect(gate.pendingKind).toBe("navigation");
    expect(publications.at(-1)).toEqual({
      state: "awaiting_human_navigation",
      event: "human_navigation_required",
      detail: {
        instruction:
          "The current page could not be inspected as a valid application page. Navigate to the application website, then choose Continue.",
      },
    });

    runtime.currentUrl = "https://ats.example/application/42";
    await gate.continueNavigation();
    expect(await result).toMatchObject({
      success: true,
      done: false,
      interrupted: false,
      extractedContent: "Human navigation completed.",
    });
    expect(publications.at(-1)).toEqual({ state: "running", event: null, detail: {} });
    expect(gate.pendingKind).toBeNull();
  });
  test("only one gate is pending and steering interruption releases it", async () => {
    const { gate, publications } = makeGate();
    const runtime = new Runtime();
    const pending = gate.requestHumanNavigation("Complete the checkpoint", runtime);
    await flushGateWork();

    const competing = gate.requestHumanNavigation("Another checkpoint", runtime);
    await expect(competing).rejects.toThrow("A human gate is already pending");
    await expect(gate.submit()).rejects.toMatchObject({
      status: 409,
      code: "command_conflict",
      message: "No matching human gate is pending",
    });

    expect(await gate.interrupt()).toBe(true);
    expect(await pending).toMatchObject({ interrupted: true, done: false });
    expect(publications.at(-1)).toEqual({ state: "running", event: null, detail: {} });
    expect(await gate.interrupt()).toBe(false);
  });
  test("credential mutation is exclusive, shielded, and stored only after browser success", async () => {
    const { gate, publications } = makeGate();
    const runtime = new Runtime();
    const store = new CredentialStore();
    let releaseSignIn!: () => void;
    runtime.signInBarrier = new Promise<void>((resolve) => {
      releaseSignIn = resolve;
    });

    const request = gate.requestSignIn({
      accountAction: "sign_in",
      usernameRef: "email-field",
      passwordRef: "password-field",
      submitRef: "submit-button",
      runtime,
      credentialStore: store,
    });
    await flushGateWork();
    expect(runtime.suppressed).toBe(1);
    expect(gate.pendingKind).toBe("credentials");
    expect(publications.at(-1)).toEqual({
      state: "awaiting_human_navigation",
      event: "credentials_required",
      detail: {},
    });

    const command = gate.signIn("person@example.test", "secret-password");
    await flushGateWork();
    expect(runtime.signIns).toEqual([{
      usernameRef: "email-field",
      passwordRef: "password-field",
      passwordConfirmationRef: undefined,
      submitRef: "submit-button",
      username: "person@example.test",
      password: "secret-password",
    }]);
    expect(store.upserts).toEqual([]);
    expect(await gate.interrupt()).toBe(false);

    releaseSignIn();
    await command;
    expect(store.upserts).toEqual([{
      origin: "https://jobs.example",
      username: "person@example.test",
      password: "secret-password",
    }]);
    expect((await request).metadata).toEqual({ sign_in_status: "attempted" });
    expect(gate.screenshotsSuppressed).toBe(true);
    expect(gate.redactionValues).toEqual(expect.arrayContaining(["person@example.test", "secret-password"]));
  });
  test("additional information is published as one batch and saved with redacted prompts", async () => {
    const { gate, publications, userInfoStore } = makeGate();
    const runtime = new Runtime();
    const questions = [
      {
        id: "availability",
        key: "availability.summer",
        scope: "global",
        question: "When is ada.private@example.test available?",
        answer_type: "text",
      },
      {
        id: "relocation",
        key: "relocation.willing",
        scope: "application",
        question: "Willing to relocate?",
        answer_type: "boolean",
      },
    ] as const;
    const request = gate.requestAdditionalInfo(questions, runtime);
    await flushGateWork();

    expect(gate.pendingKind).toBe("additional_info");
    expect(gate.getPendingTextQuestion("availability")).toEqual(questions[0]);
    expect(publications.at(-1)).toEqual({
      state: "awaiting_additional_info",
      event: "additional_info_required",
      detail: {
        questions,
      },
    });

    const answers = [
      { id: "availability", status: "answered", raw_value: "free june", value: "June 2027" },
      { id: "relocation", status: "answered", value: false },
    ] as const;
    await gate.provideAdditionalInfo(answers);
    const result = await request;
    expect(userInfoStore.merges).toEqual([[
      "https://jobs.example/posting/42",
      [{ ...questions[0], question: "When is [redacted] available?" }, questions[1]],
      answers,
    ]]);
    expect(JSON.parse(result.extractedContent)).toEqual({
      type: "additional_info",
      answers,
    });
    expect(publications.at(-1)).toEqual({
      state: "running",
      event: "additional_info_saved",
      detail: { count: 2 },
    });
    expect(gate.redactionValues).toEqual(expect.arrayContaining(["free june", "June 2027"]));
  });
  test("review revision requires a fresh review and submission grants permission only", async () => {
    const { gate, publications } = makeGate();
    const runtime = new Runtime();
    const review = {
      status: "ready_for_submission",
      job_url: "https://jobs.example/posting/42",
      final_url: "https://jobs.example/application",
      fields_needing_human: [],
      revision_count: 0,
      company: "Example Systems",
    };

    const first = gate.requestHumanReview(review, runtime);
    await flushGateWork();
    expect(gate.pendingKind).toBe("review");
    expect(publications.at(-1)).toEqual({
      state: "awaiting_human_review",
      event: "review_required",
      detail: {},
    });
    await gate.revise("  Correct the incident example.  ");
    expect(await first).toMatchObject({
      extractedContent: "Human revision received. Apply it, re-scan the form, then request review again.",
      longTermMemory: "Correct the incident example.",
      metadata: { revision_count: 1 },
    });
    expect(gate.revisionCount).toBe(1);
    expect(gate.submissionApproved).toBe(false);

    const second = gate.requestHumanReview(review, runtime);
    await flushGateWork();
    await gate.submit();
    const approved = await second;
    expect(JSON.parse(approved.extractedContent)).toEqual({
      status: "ready_for_submission",
      company: "Example Systems",
      role: null,
      job_url: "https://jobs.example/posting/42",
      final_url: "https://jobs.example/application",
      fields_filled: [],
      fields_needing_human: [],
      files_attached: [],
      warnings: [],
      revision_count: 1,
      submit_attempted: false,
    });
    expect(approved.longTermMemory).toBe("You're good to submit.");
    expect(gate.submissionApproved).toBe(true);
    await expect(gate.submit()).rejects.toMatchObject({
      status: 409,
      code: "command_conflict",
    });
  });

  test("automatic review refuses unresolved fields and otherwise approves without a pending gate", async () => {
    const { gate } = makeGate({ autoSubmit: true });
    const runtime = new Runtime();
    const unresolved = {
      job_url: "https://jobs.example/posting/42",
      final_url: "https://jobs.example/application",
      fields_needing_human: [{ label: "Work authorization" }],
      revision_count: 0,
    };
    await expect(gate.requestHumanReview(unresolved, runtime)).rejects.toMatchObject({
      status: 422,
      code: "invalid_request",
      message: "Request is invalid",
    });
    expect(gate.submissionApproved).toBe(false);

    const ready = { ...unresolved, fields_needing_human: [] };
    const approved = await gate.requestHumanReview(ready, runtime);
    expect(JSON.parse(approved.extractedContent)).toEqual({
      status: "ready_for_submission",
      company: null,
      role: null,
      job_url: "https://jobs.example/posting/42",
      final_url: "https://jobs.example/application",
      fields_filled: [],
      fields_needing_human: [],
      files_attached: [],
      warnings: [],
      revision_count: 0,
      submit_attempted: false,
    });
    expect(gate.submissionApproved).toBe(true);
    expect(gate.pendingKind).toBeNull();
  });
  test("saving credentials activates private values without submitting, and cancellation is terminal", async () => {
    const { gate, publications } = makeGate();
    const runtime = new Runtime();
    const store = new CredentialStore();
    const credentials = gate.requestSignIn({
      usernameRef: "email-field",
      passwordRef: "password-field",
      submitRef: "submit-button",
      runtime,
      credentialStore: store,
    });
    await flushGateWork();
    await gate.saveCredentials("created@example.test", "created-password");
    expect(runtime.signIns).toEqual([]);
    expect(runtime.activated).toEqual([["created@example.test", "created-password"]]);
    expect(store.upserts).toEqual([{
      origin: "https://jobs.example",
      username: "created@example.test",
      password: "created-password",
    }]);
    expect((await credentials).metadata).toEqual({ sign_in_status: "saved" });

    const publicationCount = publications.length;
    const navigation = gate.requestHumanNavigation("Finish the last step", runtime);
    await flushGateWork();
    await gate.cancel();
    const cancelled = await navigation;
    expect(cancelled).toMatchObject({ success: false, done: true });
    expect(JSON.parse(cancelled.extractedContent)).toMatchObject({
      status: "cancelled",
      job_url: "https://jobs.example/posting/42",
      final_url: "https://jobs.example/application",
      submit_attempted: false,
    });
    expect(publications).toHaveLength(publicationCount + 1);
    expect(gate.pendingKind).toBeNull();

    const afterCancellation = await gate.requestHumanNavigation("Should not open", runtime);
    expect(afterCancellation).toMatchObject({ success: false, done: true });
    expect(gate.pendingKind).toBeNull();
  });
});
