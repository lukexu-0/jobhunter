import { describe, expect, test } from "bun:test";
import type { ApplicationSessionSnapshotDto } from "@jobhunter/pipeline/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ApplicationSessionPanel,
  buildApplicationSteerCommand,
  simpleApplicationGateCommand,
} from "../app/components/application-session-panel";
import { buildApplicationCredentialCommand } from "../app/components/application-credentials-form";

function snapshot(
  overrides: Partial<ApplicationSessionSnapshotDto> = {},
): ApplicationSessionSnapshotDto {
  return {
    generation: 2,
    bridgeState: "running",
    harnessState: "running",
    submissionPhase: "not_attempted",
    createdAt: 1,
    updatedAt: 2,
    terminalAt: null,
    expiresAt: 86_400_000,
    company: "Example Corp",
    role: "Staff Engineer",
    fieldsFilled: [
      { label: "Name", fieldType: "text", valuePresent: true, note: "" },
      { label: "Email", fieldType: "text", valuePresent: true, note: "" },
    ],
    fieldsNeedingHuman: [
      { label: "Portfolio URL", fieldType: "text", valuePresent: false, note: "Needs confirmation" },
    ],
    filesAttached: ["resume.pdf"],
    warnings: [],
    revisionCount: 1,
    pendingAction: null,
    error: null,
    ...overrides,
  } as ApplicationSessionSnapshotDto;
}

const callbacks = {
  actionBusy: null,
  steeringState: "idle" as const,
  onCancel: async () => {},
  onClose: async () => {},
  onRetry: async () => {},
  onResume: async () => {},
  onCommand: async () => {},
  onSteer: async () => ({ status: "accepted" as const, current: false as const }),
  onLoadSuggestions: async () => ({ suggestions: [] }),
  onProfessionalize: async () => ({ answer: "Professional answer" }),
};

function buttonOpeningTag(markup: string, label: string): string {
  const labelIndex = markup.indexOf(`>${label}</button>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);
  return markup.slice(markup.lastIndexOf("<button", labelIndex), labelIndex);
}

describe("ApplicationSessionPanel", () => {
  test("renders projected progress and only state-valid lifecycle controls", () => {
    const running = renderToStaticMarkup(
      <ApplicationSessionPanel {...callbacks} snapshot={snapshot()} />,
    );
    for (const omitted of [
      "Company",
      "Example Corp",
      "Role",
      "Staff Engineer",
      "Created",
      "Updated",
      "Browser expires",
      "Application revisions",
      "Fields filled",
      "Fields needing you",
      "Portfolio URL",
      "Needs confirmation",
      "Files attached",
      "resume.pdf",
      "Warnings",
      "None reported",
    ]) {
      expect(running).not.toContain(omitted);
    }
    expect(running).toContain("Cancel application");
    expect(running).not.toContain("Retry applying");
    expect(running).toContain('role="status"');

    const reserved = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "reserved",
          harnessState: null,
          expiresAt: null,
        })}
      />,
    );
    expect(reserved).toContain("Start applying");
    expect(reserved).toContain("Cancel application");
    expect(reserved).not.toContain("Steer the agent");

    const lost = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "lost",
          harnessState: null,
          terminalAt: 3,
          expiresAt: null,
          warnings: ["Verify whether the application was submitted before retrying."],
        })}
      />,
    );
    expect(lost).toContain("Retry applying");
    expect(lost).toContain("verify whether the application was submitted");
    expect(lost).not.toContain("Cancel application");
    expect(lost).not.toContain("Steer the agent");

    const submitting = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "submitting",
          harnessState: "submitting",
          submissionPhase: "attempting",
        })}
      />,
    );
    expect(submitting).toContain("Submitting application");
    expect(submitting).not.toContain("Cancel application");
    expect(submitting).not.toContain("Retry applying");
    expect(submitting).not.toContain("Close browser");
    expect(submitting).not.toContain("Steer the agent");

    const submitted = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "submitted",
          harnessState: "submitted",
          submissionPhase: "submitted",
        })}
      />,
    );
    expect(submitted).toContain("Application submitted");
    expect(submitted).toContain("Close browser");
    expect(submitted).toContain("stays open until");
    expect(submitted).not.toContain("Cancel application");
    expect(submitted).not.toContain("Retry applying");
    expect(submitted).not.toContain("Steer the agent");

    const uncertain = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "submission_uncertain",
          harnessState: "submission_uncertain",
          submissionPhase: "uncertain",
          warnings: [
            "The application submission could not be verified. Check the headed browser if it is still available, then close this session.",
          ],
        })}
      />,
    );
    expect(uncertain).toContain("Submission could not be verified");
    expect(uncertain).toContain("Close browser");
    expect(uncertain).not.toContain("Cancel application");
    expect(uncertain).not.toContain("Retry applying");
    expect(uncertain).not.toContain("Steer the agent");

    const closedSubmitted = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "closed",
          harnessState: "closed",
          submissionPhase: "submitted",
          terminalAt: 3,
          expiresAt: null,
        })}
      />,
    );
    expect(closedSubmitted).not.toContain("Retry applying");
    expect(closedSubmitted).not.toContain("Close browser");
    expect(closedSubmitted).not.toContain("Steer the agent");
  });

  test("renders actionable warnings in one accessible alert only when present", () => {
    const firstWarning = "Confirm the public salary range.";
    const secondWarning = "Review the relocation answer before submitting.";
    const running = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({ warnings: [firstWarning, secondWarning] })}
      />,
    );
    expect(running.match(/aria-label="Application warnings"/g)).toHaveLength(1);
    expect(running.match(/role="alert"/g)).toHaveLength(1);
    expect(running.split(firstWarning)).toHaveLength(2);
    expect(running.split(secondWarning)).toHaveLength(2);
    expect(running.indexOf(firstWarning)).toBeLessThan(running.indexOf(secondWarning));
    expect(running).not.toContain(">Warnings<");
    expect(running).not.toContain("None reported");

    const withoutWarnings = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({ warnings: [] })}
      />,
    );
    expect(withoutWarnings).not.toContain('aria-label="Application warnings"');
  });

  test("renders accessible steering while the application agent is running or gated", () => {
    const running = renderToStaticMarkup(
      <ApplicationSessionPanel {...callbacks} snapshot={snapshot()} />,
    );
    const formStart = running.indexOf("<form");
    const formOpeningTag = running.slice(formStart, running.indexOf(">", formStart) + 1);
    const textboxStart = running.indexOf("<textarea");
    const textboxOpeningTag = running.slice(
      textboxStart,
      running.indexOf(">", textboxStart) + 1,
    );
    expect(formOpeningTag).toContain('aria-label="Steer the agent"');
    expect(textboxOpeningTag).toContain('aria-label="Steer the agent"');
    expect(running).not.toContain("Guide the application agent");
    expect(running).not.toContain("Operator guidance");
    expect(running).not.toContain("Delivered once before the next agent step.");
    expect(running).not.toContain("not saved to your profile or application facts");
    expect(running).toContain("Send guidance");
    expect(running).toContain('aria-live="polite"');
    expect(running.indexOf("Steer the agent"))
      .toBeLessThan(running.indexOf("Applying"));

    const waiting = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "awaiting_human_navigation",
          harnessState: "awaiting_human_navigation",
          pendingAction: {
            type: "human_navigation",
            instruction: "Complete the checkpoint.",
          },
        })}
      />,
    );
    expect(waiting).toContain("Steer the agent");
    expect(waiting).toContain("Send guidance");
    expect(waiting).not.toContain("Steer and continue");
    expect(waiting).toContain('title="Retry current action"');

    const ambiguous = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        steeringState="ambiguous"
        snapshot={snapshot()}
      />,
    );
    expect(ambiguous).toContain("Guidance delivery could not be confirmed");
    expect(ambiguous).toContain('disabled=""');
    expect(ambiguous).toContain("Cancel application");
  });

  test("builds trimmed steering commands with Unicode-scalar bounds", () => {
    expect(buildApplicationSteerCommand(
      "\u001c\u001d  Check the public salary field.  \u001e\u001f",
    )).toEqual({
      success: true,
      command: {
        type: "steer",
        message: "Check the public salary field.",
      },
    });
    expect(buildApplicationSteerCommand("\ufeffKeep the byte-order mark\ufeff"))
      .toEqual({
        success: true,
        command: {
          type: "steer",
          message: "\ufeffKeep the byte-order mark\ufeff",
        },
      });
    expect(buildApplicationSteerCommand("\u{1f642}".repeat(8_000)).success)
      .toBeTrue();
    for (const invalid of [
      "",
      "\u001c\u001d\u001e\u001f",
      "\u{1f642}".repeat(8_001),
      "contains\u0000nul",
      "\ud800",
      "\udfff",
    ]) {
      expect(buildApplicationSteerCommand(invalid)).toEqual({
        success: false,
        message: "Enter guidance between 1 and 8,000 Unicode characters without null characters.",
      });
    }
  });

  test("renders navigation and keeps legacy origin snapshots non-actionable", () => {
    const navigation = {
      type: "human_navigation",
      instruction: "Complete the account sign-in, then return here.",
    } as const;
    expect(simpleApplicationGateCommand(navigation)).toEqual({ type: "continue" });
    const navigationMarkup = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "awaiting_human_navigation",
          harnessState: "awaiting_human_navigation",
          pendingAction: navigation,
        })}
      />,
    );
    expect(navigationMarkup).toContain(navigation.instruction);
    expect(navigationMarkup).toContain("Continue application");

    const origin = {
      type: "origin_approval",
      origin: "https://apply.example.com",
    } as const;
    const originMarkup = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "awaiting_origin_approval",
          harnessState: "awaiting_origin_approval",
          pendingAction: origin,
        })}
      />,
    );
    expect(originMarkup).toContain("https://apply.example.com");
    expect(originMarkup).toContain("Restart required");
    expect(originMarkup).not.toContain("Approve origin");
    expect(originMarkup).not.toContain("Steer the agent");
  });

  test("builds strict credential commands with trimmed usernames and exact passwords", () => {
    expect(buildApplicationCredentialCommand(
      "sign_in",
      "  applicant@example.test  ",
      "  exact password  ",
    )).toEqual({
      success: true,
      command: {
        type: "sign_in",
        username: "applicant@example.test",
        password: "  exact password  ",
      },
    });
    expect(buildApplicationCredentialCommand(
      "sign_in",
      "\u001c\u001dapplicant@example.test\u001e\u001f",
      "password",
    )).toEqual({
      success: true,
      command: {
        type: "sign_in",
        username: "applicant@example.test",
        password: "password",
      },
    });
    expect(buildApplicationCredentialCommand(
      "save_credentials",
      "\ufeffaccount-name\ufeff",
      "password",
    )).toEqual({
      success: true,
      command: {
        type: "save_credentials",
        username: "\ufeffaccount-name\ufeff",
        password: "password",
      },
    });
    expect(buildApplicationCredentialCommand(
      "save_credentials",
      "account-name",
      "password",
    )).toEqual({
      success: true,
      command: {
        type: "save_credentials",
        username: "account-name",
        password: "password",
      },
    });
    expect(buildApplicationCredentialCommand(
      "sign_in",
      "\u{1f642}".repeat(320),
      "\u{1f642}".repeat(4_096),
    ).success).toBeTrue();
    expect(buildApplicationCredentialCommand(
      "sign_in",
      "\u{1f642}".repeat(321),
      "password",
    )).toEqual({
      success: false,
      field: "username",
      message: "Enter a username or email between 1 and 320 characters.",
    });
    expect(buildApplicationCredentialCommand(
      "sign_in",
      "\u001c",
      "password",
    )).toEqual({
      success: false,
      field: "username",
      message: "Enter a username or email between 1 and 320 characters.",
    });
    expect(buildApplicationCredentialCommand(
      "sign_in",
      "\ud800",
      "password",
    )).toEqual({
      success: false,
      field: "username",
      message: "Enter a username or email between 1 and 320 characters.",
    });
    expect(buildApplicationCredentialCommand(
      "sign_in",
      "account\u0000name",
      "password",
    )).toEqual({
      success: false,
      field: "username",
      message: "Enter a username or email between 1 and 320 characters.",
    });
    expect(buildApplicationCredentialCommand(
      "save_credentials",
      "account-name",
      "\udfff",
    )).toEqual({
      success: false,
      field: "password",
      message: "Enter a password between 1 and 4,096 characters.",
    });
    expect(buildApplicationCredentialCommand(
      "save_credentials",
      "account-name",
      "pass\u0000word",
    )).toEqual({
      success: false,
      field: "password",
      message: "Enter a password between 1 and 4,096 characters.",
    });
    expect(buildApplicationCredentialCommand(
      "save_credentials",
      "account-name",
      "\u{1f642}".repeat(4_097),
    )).toEqual({
      success: false,
      field: "password",
      message: "Enter a password between 1 and 4,096 characters.",
    });
  });
  test("renders accessible credential actions with optional steering", () => {
    const markup = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "awaiting_human_navigation",
          harnessState: "awaiting_human_navigation",
          pendingAction: { type: "credentials" },
        })}
      />,
    );
    const formStart = markup.indexOf('<form aria-labelledby="application-credentials-heading"');
    const formEnd = markup.indexOf("</form>", formStart);
    const formMarkup = markup.slice(formStart, formEnd);
    const normalizedMarkup = markup.toLowerCase();

    expect(markup).toContain("Credentials needed");
    expect(markup).toContain("Username or email");
    expect(markup).toContain("Password");
    expect(normalizedMarkup.match(/autocomplete="off"/g)).toHaveLength(2);
    expect(normalizedMarkup).toContain('autocomplete="new-password"');
    expect(normalizedMarkup).not.toContain('autocomplete="current-password"');
    expect(normalizedMarkup).not.toContain('autocomplete="username"');
    expect(normalizedMarkup).toContain('type="password"');
    expect(markup).toContain("Sign in with credentials");
    expect(markup).not.toContain("Steer and sign in");
    expect(markup).not.toContain("Steer and save credentials");
    expect(markup).toContain("Save credentials");
    expect(markup).toContain("private local credential file");
    expect(formMarkup.match(/<button/g)).toHaveLength(2);
    expect(formMarkup).not.toContain("Continue application");

    const busyMarkup = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        actionBusy="sign_in"
        snapshot={snapshot({
          bridgeState: "awaiting_human_navigation",
          harnessState: "awaiting_human_navigation",
          pendingAction: { type: "credentials" },
        })}
      />,
    );
    const cancelLabel = busyMarkup.indexOf("Cancel application");
    const cancelMarkup = busyMarkup.slice(
      busyMarkup.lastIndexOf("<button", cancelLabel),
      cancelLabel,
    );
    expect(busyMarkup).toContain("Signing in\u2026");
    expect(busyMarkup).toContain("disabled");
    expect(cancelMarkup).not.toContain("disabled");
  });

  test("renders every additional-information question as an accessible choice group", () => {
    const markup = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "awaiting_additional_info",
          harnessState: "awaiting_additional_info",
          pendingAction: {
            type: "additional_info",
            questions: [
              {
                id: "motivation",
                scope: "application",
                question: "Why are you interested in this role?",
                answerType: "text",
              },
              {
                id: "authorized",
                scope: "global",
                question: "Are you authorized to work here?",
                answerType: "boolean",
              },
              {
                id: "location",
                scope: "global",
                question: "Where do you want to work?",
                answerType: "single_select",
                options: [
                  { id: "remote", label: "Remote" },
                  { id: "hybrid", label: "Hybrid" },
                ],
              },
              {
                id: "days",
                scope: "application",
                question: "Which interview days work?",
                answerType: "multi_select",
                options: [
                  { id: "monday", label: "Monday" },
                  { id: "friday", label: "Friday" },
                ],
              },
            ],
          },
        })}
      />,
    );

    expect(markup.match(/<fieldset/g)).toHaveLength(4);
    expect(markup).toContain("Why are you interested in this role?");
    expect(markup).toContain("Saved for future applications");
    expect(markup).toContain("Used for this job only");
    expect(markup).toContain("Yes");
    expect(markup).toContain("No");
    expect(markup).toContain("Remote");
    expect(markup).toContain("Monday");
    expect(markup.match(/Decline to answer/g)).toHaveLength(4);
    expect(buttonOpeningTag(markup, "Answer questions")).toContain("disabled");
    expect(markup).not.toContain("Steer and answer questions");
    expect(markup).toContain("Professionalize");
    expect(markup).toContain('aria-label="Professionalize settings"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Previous answers");
    expect(markup).toContain("without saving answers");
    expect(buttonOpeningTag(markup, "Continue")).not.toContain("disabled");

    const continuingMarkup = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        actionBusy="continue_without_additional_info"
        snapshot={snapshot({
          bridgeState: "awaiting_additional_info",
          harnessState: "awaiting_additional_info",
          pendingAction: {
            type: "additional_info",
            questions: [{
              id: "motivation",
              scope: "application",
              question: "Why are you interested in this role?",
              answerType: "text",
            }],
          },
        })}
      />,
    );
    expect(buttonOpeningTag(continuingMarkup, "Continuing…")).toContain("disabled");
  });

  test("renders transient revision guidance and the submission confirmation", () => {
    const markup = renderToStaticMarkup(
      <ApplicationSessionPanel
        {...callbacks}
        snapshot={snapshot({
          bridgeState: "awaiting_human_review",
          harnessState: "awaiting_human_review",
          pendingAction: { type: "human_review" },
        })}
      />,
    );

    expect(markup).toContain("Review the application");
    expect(markup).toContain("Request application revision");
    expect(markup).not.toContain("Steer and request revision");
    expect(markup).toContain("Approve and submit");
    expect(markup).toContain("Submit this application?");
    expect(markup).toContain("This action is irreversible.");
    expect(markup).toContain("not saved as profile facts");
    expect(markup).toContain("Cancel application");
    expect(markup).not.toContain("Ready for human submit");
  });
});
