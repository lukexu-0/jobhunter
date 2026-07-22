import { describe, expect, test } from "bun:test";
import type { ApplicationSessionSnapshotDto } from "@jobhunter/pipeline/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ApplicationSessionPanel,
  simpleApplicationGateCommand,
} from "../app/components/application-session-panel";

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
    warnings: ["Review the highlighted field"],
    revisionCount: 1,
    pendingAction: null,
    error: null,
    ...overrides,
  } as ApplicationSessionSnapshotDto;
}

const callbacks = {
  actionBusy: null,
  onCancel: async () => {},
  onClose: async () => {},
  onRetry: async () => {},
  onResume: async () => {},
  onCommand: async () => {},
};

describe("ApplicationSessionPanel", () => {
  test("renders projected progress and only state-valid lifecycle controls", () => {
    const running = renderToStaticMarkup(
      <ApplicationSessionPanel {...callbacks} snapshot={snapshot()} />,
    );
    expect(running).toContain("Example Corp");
    expect(running).toContain("Staff Engineer");
    expect(running).toContain("Portfolio URL");
    expect(running).toContain("resume.pdf");
    expect(running).toContain("Review the highlighted field");
    expect(running).toContain("Application revisions");
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
  });

  test("renders navigation and exact canonical origin gates", () => {
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
    expect(simpleApplicationGateCommand(origin)).toEqual({
      type: "approve_origin",
      origin: "https://apply.example.com",
    });
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
    expect(originMarkup).toContain("Approve origin");
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
    expect(markup).toContain('disabled="" type="submit">Answer questions');
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
    expect(markup).toContain("Approve and submit");
    expect(markup).toContain("Submit this application?");
    expect(markup).toContain("This action is irreversible.");
    expect(markup).toContain("not saved as profile facts");
    expect(markup).toContain("Cancel application");
    expect(markup).not.toContain("Ready for human submit");
  });
});
