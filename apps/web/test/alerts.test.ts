import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ApplicationSessionSnapshotDto, RunDto } from "../app/lib/pipeline-contracts";
import { AlertController } from "../app/lib/alerts";

const run: RunDto = {
  id: "pipeline-run",
  opportunityKind: "job",
  status: "compiling",
  applicationStatus: "pending",
  generateKeywordMap: false,
  skipReview: false,
  autoSubmit: false,
  queueSequence: 1,
  revision: 1,
  origin: "initial",
  createdAt: 1,
  updatedAt: 2,
  visualAcknowledgementRequired: false,
  attempts: [],
  artifacts: [],
  timeline: [],
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let notifications: NotificationProbe[];
let openedRun: string | undefined;

class NotificationProbe {
  static permission: NotificationPermission = "granted";
  static failCreation = false;
  onclick: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly title: string, readonly options: NotificationOptions) {
    if (NotificationProbe.failCreation) throw new Error("Notification delivery unavailable");
    notifications.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  notifications = [];
  openedRun = undefined;
  NotificationProbe.permission = "granted";
  NotificationProbe.failCreation = false;
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      Notification: NotificationProbe,
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      focus: () => undefined,
      location: { assign: (href: string) => { openedRun = href; } },
    },
  });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("notifies once per pipeline failure across polls and reloads, including a failed retry", () => {
  const controller = new AlertController();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  controller.observeRun(run);
  const failed: RunDto = { ...run, status: "failed", failureCode: "compiling", updatedAt: 3 };
  controller.observeRun(failed);
  expect(notifications).toHaveLength(1);
  notifications[0]!.onclick!();
  expect(openedRun).toBe("/runs/pipeline-run");
  expect(notifications[0]!.closed).toBe(true);

  controller.observeRun({ ...failed, updatedAt: 4, titleOverride: "Edited role" });
  const reloaded = new AlertController();
  reloaded.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  reloaded.observeRun(failed);
  expect(notifications).toHaveLength(1);

  // Retry increments the revision, even when it fails again before the next poll.
  reloaded.observeRun({ ...failed, revision: 2, updatedAt: 5 });
  expect(notifications).toHaveLength(2);
});

test("does not replay an old pipeline failure when notifications are enabled", () => {
  const controller = new AlertController();
  const failed: RunDto = { ...run, status: "failed", failureCode: "compiling" };
  controller.observeRun(failed);
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  controller.observeRun(failed);
  expect(notifications).toHaveLength(0);

  controller.observeRun({ ...failed, revision: 2 });
  expect(notifications).toHaveLength(1);
});

test("notifies on dashboard apply failures without repeating the detail-page alert", () => {
  const controller = new AlertController();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  const applying: RunDto = { ...run, status: "approved", isApplying: true };
  controller.observeRun(applying);
  const failed: RunDto = { ...applying, isApplying: false, applicationFailureGeneration: 1 };
  controller.observeRun(failed);
  expect(notifications).toHaveLength(1);
  const failedSession: ApplicationSessionSnapshotDto = {
    generation: 1, bridgeState: "failed", harnessState: "failed",
    submissionPhase: "not_attempted", createdAt: 1, updatedAt: 2,
    terminalAt: 2, expiresAt: 3, company: null, role: null,
    fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, playwrightCliDiagnostics: [], pendingAction: null,
    error: { code: "model_failed", message: "The model request failed" },
  };
  controller.observeApplication(run.id, failedSession);
  controller.observeRun({ ...failed, applicationStatus: "rejected", updatedAt: 3 });
  expect(notifications).toHaveLength(1);
  notifications[0]!.onclick!();
  expect(openedRun).toBe("/runs/pipeline-run");

  controller.observeApplication(run.id, { ...failedSession, generation: 2 });
  controller.observeRun({ ...failed, applicationFailureGeneration: 2 });
  expect(notifications).toHaveLength(2);
});

test("does not replay historical apply failures or treat lifecycle edits as agent failures", () => {
  const controller = new AlertController();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  const historical: RunDto = { ...run, status: "approved", applicationFailureGeneration: 1 };
  controller.observeRun(historical);
  const reloaded = new AlertController();
  reloaded.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  reloaded.observeRun(historical);
  reloaded.observeRun({ ...run, id: "manual-status", status: "approved", applicationStatus: "failed" });
  expect(notifications).toHaveLength(0);

  reloaded.observeRun({ ...historical, applicationFailureGeneration: 2 });
  expect(notifications).toHaveLength(1);
});


test("does not replay a historical successful submission when its snapshot first loads", () => {
  const controller = new AlertController();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  controller.observeRun({ ...run, status: "approved", applicationStatus: "applied" });
  const submitted: ApplicationSessionSnapshotDto = {
    generation: 1, bridgeState: "closed", harnessState: "closed",
    submissionPhase: "submitted", createdAt: 1, updatedAt: 2, terminalAt: 2, expiresAt: null,
    company: "Example Corp", role: "Software Engineer",
    fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, playwrightCliDiagnostics: [], pendingAction: null, error: null,
  };

  controller.observeApplication(run.id, submitted);

  expect(notifications).toHaveLength(0);
});

test("notifies when an observed application transitions to submitted", () => {
  const controller = new AlertController();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  controller.observeRun(run);
  const attempting: ApplicationSessionSnapshotDto = {
    generation: 1, bridgeState: "submitting", harnessState: "submitting",
    submissionPhase: "attempting", createdAt: 1, updatedAt: 2, terminalAt: null, expiresAt: null,
    company: "Example Corp", role: "Software Engineer",
    fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, playwrightCliDiagnostics: [], pendingAction: null, error: null,
  };
  controller.observeApplication(run.id, attempting);
  expect(notifications).toHaveLength(0);

  controller.observeApplication(run.id, {
    ...attempting, bridgeState: "submitted", harnessState: "submitted",
    submissionPhase: "submitted", updatedAt: 3, terminalAt: 3,
  });

  expect(notifications.map((notification) => notification.title)).toEqual(["Application submitted"]);
});

test("ignores stale application polls after a newer attention stream update", () => {
  const controller = new AlertController();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  const attention: ApplicationSessionSnapshotDto = {
    generation: 2, bridgeState: "awaiting_human_navigation", harnessState: "awaiting_human_navigation",
    submissionPhase: "not_attempted", createdAt: 1, updatedAt: 4, terminalAt: null, expiresAt: null,
    company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, playwrightCliDiagnostics: [],
    pendingAction: { type: "human_navigation", instruction: "Complete the checkpoint." }, error: null,
  };
  controller.observeApplication(run.id, attention);
  controller.observeApplication(run.id, {
    ...attention, updatedAt: 3, bridgeState: "running", harnessState: "running", pendingAction: null,
  });
  controller.observeApplication(run.id, attention);
  controller.observeRun({ ...run, applicationFailureGeneration: 1 });
  controller.observeApplication(run.id, attention);
  expect(notifications.map((notification) => notification.title)).toEqual(["Application needs attention"]);
});

test("keeps a failed notification pending across reload and permission retry", () => {
  const controller = new AlertController();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  controller.observeRun(run);
  NotificationProbe.failCreation = true;
  controller.observeRun({ ...run, status: "review", updatedAt: 3 });
  expect(notifications).toEqual([]);

  NotificationProbe.failCreation = false;
  const reloaded = new AlertController();
  reloaded.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  reloaded.observeRun({ ...run, status: "review", updatedAt: 3 });
  expect(notifications.map((notification) => notification.title)).toEqual(["Resume ready for review"]);
});

test("retries asynchronous notification errors without reviving superseded alerts", () => {
  const controller = new AlertController();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  controller.observeRun(run);
  controller.observeRun({ ...run, status: "review", updatedAt: 3 });
  notifications[0]!.onerror?.();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  expect(notifications.map((notification) => notification.title)).toEqual([
    "Resume ready for review", "Resume ready for review",
  ]);
  controller.observeRun({ ...run, status: "failed", revision: 2, updatedAt: 4 });
  notifications[1]!.onerror?.();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  expect(notifications.map((notification) => notification.title)).toEqual([
    "Resume ready for review", "Resume ready for review", "Pipeline failed",
  ]);
});

test("a post-submit CAPTCHA notifies once and opens the paused application", () => {
  const controller = new AlertController();
  controller.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  const submitting: ApplicationSessionSnapshotDto = {
    generation: 1, bridgeState: "submitting", harnessState: "submitting",
    submissionPhase: "attempting", createdAt: 1, updatedAt: 2, terminalAt: null, expiresAt: null,
    company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, playwrightCliDiagnostics: [], pendingAction: null, error: null,
  };
  controller.observeApplication(run.id, submitting);
  expect(notifications).toHaveLength(0);

  const captcha: ApplicationSessionSnapshotDto = {
    ...submitting, bridgeState: "awaiting_human_navigation", harnessState: "awaiting_human_navigation",
    updatedAt: 3,
    pendingAction: { type: "human_navigation", instruction: "Complete the CAPTCHA in the open browser, then choose Continue application." },
  };
  controller.observeApplication(run.id, captcha);
  expect(notifications).toHaveLength(1);
  notifications[0]!.onclick!();
  expect(openedRun).toBe("/runs/pipeline-run");
  expect(notifications[0]!.closed).toBe(true);

  controller.observeApplication(run.id, { ...captcha, updatedAt: 4 });
  const reloaded = new AlertController();
  reloaded.configure({ browserNotificationsEnabled: true, soundEnabled: false });
  reloaded.observeApplication(run.id, captcha);
  expect(notifications).toHaveLength(1);
});
