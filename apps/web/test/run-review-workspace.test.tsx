import { describe, expect, test } from "bun:test";
import type {
  ApplicationSessionSnapshotDto,
  ResumeIterationDto,
  RunDto,
} from "@jobhunter/pipeline/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  acceptApplicationActionProjection,
  createApplicationCommandLatch,
  isApplicationActionLatchBusy,
  RunReviewWorkspace,
  resumeIterationLabel,
  settleApplicationActionRequest,
} from "../app/components/run-review-workspace";

const PDF_HASH = "a".repeat(64);

function iteration(
  revision: number,
  origin: ResumeIterationDto["origin"],
): ResumeIterationDto {
  return {
    revision,
    origin,
    status: "review",
    createdAt: revision,
    pdfSha256: PDF_HASH,
    artifacts: [],
  };
}

const run: RunDto = {
  id: "run-1",
  status: "review",
  applicationStatus: "pending",
  generateKeywordMap: false,
  autoApply: false,
  queueSequence: 1,
  revision: 8,
  origin: "human-comments",
  createdAt: 1,
  updatedAt: 8,
  currentPdfSha256: PDF_HASH,
  visualAcknowledgementRequired: false,
  attempts: [],
  artifacts: [],
  timeline: [],
};

function reviewSnapshot(
  overrides: Partial<ApplicationSessionSnapshotDto> = {},
): ApplicationSessionSnapshotDto {
  return {
    generation: 4,
    bridgeState: "awaiting_human_review",
    harnessState: "awaiting_human_review",
    submissionPhase: "not_attempted",
    createdAt: 10,
    updatedAt: 20,
    terminalAt: null,
    expiresAt: 100,
    company: "Example Corp",
    role: "Engineer",
    fieldsFilled: [],
    fieldsNeedingHuman: [],
    filesAttached: ["resume.pdf"],
    warnings: [],
    revisionCount: 1,
    pendingAction: { type: "human_review" },
    error: null,
    ...overrides,
  } as ApplicationSessionSnapshotDto;
}

describe("RunReviewWorkspace", () => {
  test("numbers displayed iterations independently of internal revisions", () => {
    const iterations = [
      iteration(3, "initial"),
      iteration(5, "machine-regeneration"),
      iteration(8, "human-comments"),
    ];
    expect(iterations.map((_, index) =>
      resumeIterationLabel(index + 1, index === iterations.length - 1)
    )).toEqual([
      "Iteration 1",
      "Iteration 2",
      "Iteration 3 — Latest",
    ]);

    const markup = renderToStaticMarkup(
      <RunReviewWorkspace
        artifactState="pruned"
        busyAction={null}
        isFresh
        isLoadingIterations={false}
        iterationError={null}
        iterations={iterations}
        onApplicationView={() => {}}
        onApprove={async () => ({ ...run, status: "approved" })}
        onEdit={async () => run}
        onSelectIteration={() => {}}
        run={run}
        selectedIteration={iterations[0]}
      />,
    );

    expect(markup).toContain("Displayed resume");
    expect(markup).toContain("Iteration 1");
    expect(markup).toContain("Iteration 2");
    expect(markup).toContain("Iteration 3 — Latest");
    expect(markup.match(/Latest/g)).toHaveLength(1);
    expect(markup).toContain('<option value="3" selected="">Iteration 1</option>');
    expect(markup).toContain('<option value="5">Iteration 2</option>');
    expect(markup).toContain('<option value="8">Iteration 3 — Latest</option>');
    expect(markup).not.toContain("View latest");
    expect(markup).not.toContain("Historical iterations are view-only");
    expect(markup).toContain("Resume files were removed by retention");
    expect(markup).not.toContain("/tmp/");
    expect(markup).not.toContain("sessionId");
    expect(markup).not.toContain("Review workspace");
    expect(markup).not.toContain("Current run");
    expect(markup).not.toContain("Resume review");

    const currentMarkup = renderToStaticMarkup(
      <RunReviewWorkspace
        artifactState="retained"
        busyAction={null}
        isFresh
        isLoadingIterations={false}
        iterationError={null}
        iterations={iterations}
        onApplicationView={() => {}}
        onApprove={async () => ({ ...run, status: "approved" })}
        onEdit={async () => run}
        onSelectIteration={() => {}}
        run={run}
        selectedIteration={iterations[2]}

      />,
    );
    expect(currentMarkup).toContain("Edit instructions");
    expect(currentMarkup).toContain("Request edits");
    expect(currentMarkup).toContain("Approve and apply");
    expect(currentMarkup).not.toContain("Regenerate");
    expect(currentMarkup).not.toContain("View latest");
    expect(markup).not.toContain("Edit instructions");
  });

  test("keeps submit busy until request settlement and a newer submission projection", () => {
    const baseline = reviewSnapshot();
    const latch = createApplicationCommandLatch({ type: "submit" }, baseline);

    expect(settleApplicationActionRequest(latch)).toBeFalse();
    expect(isApplicationActionLatchBusy(latch)).toBeTrue();
    expect(acceptApplicationActionProjection(latch, baseline)).toBeFalse();
    expect(acceptApplicationActionProjection(latch, reviewSnapshot({
      updatedAt: 21,
      revisionCount: 2,
    }))).toBeFalse();
    expect(acceptApplicationActionProjection(latch, reviewSnapshot({
      generation: 5,
      bridgeState: "submitting",
      harnessState: "submitting",
      submissionPhase: "attempting",
      updatedAt: 21,
      pendingAction: null,
    }))).toBeFalse();
    expect(acceptApplicationActionProjection(latch, reviewSnapshot({
      bridgeState: "submitting",
      harnessState: "submitting",
      submissionPhase: "attempting",
      pendingAction: null,
    }))).toBeFalse();
    expect(isApplicationActionLatchBusy(latch)).toBeTrue();

    expect(acceptApplicationActionProjection(latch, reviewSnapshot({
      bridgeState: "submitting",
      harnessState: "submitting",
      submissionPhase: "attempting",
      updatedAt: 22,
      pendingAction: null,
    }))).toBeTrue();
    expect(isApplicationActionLatchBusy(latch)).toBeFalse();
  });

  test("does not release submit when the projection arrives before the POST settles", () => {
    const latch = createApplicationCommandLatch({ type: "submit" }, reviewSnapshot());
    const submitted = reviewSnapshot({
      bridgeState: "submitted",
      harnessState: "submitted",
      submissionPhase: "submitted",
      updatedAt: 21,
      pendingAction: null,
    });

    expect(acceptApplicationActionProjection(latch, submitted)).toBeFalse();
    expect(isApplicationActionLatchBusy(latch)).toBeTrue();
    expect(settleApplicationActionRequest(latch)).toBeTrue();
    expect(isApplicationActionLatchBusy(latch)).toBeFalse();
  });

  test("keeps a failed submit request latched across replay and reconnect", () => {
    const baseline = reviewSnapshot();
    const latch = createApplicationCommandLatch({ type: "submit" }, baseline);

    expect(settleApplicationActionRequest(latch)).toBeFalse();
    expect(acceptApplicationActionProjection(latch, baseline)).toBeFalse();
    expect(acceptApplicationActionProjection(latch, reviewSnapshot({
      updatedAt: 21,
      company: "Reconnected Example Corp",
    }))).toBeFalse();
    expect(isApplicationActionLatchBusy(latch)).toBeTrue();

    expect(acceptApplicationActionProjection(latch, reviewSnapshot({
      bridgeState: "submission_uncertain",
      harnessState: "submission_uncertain",
      submissionPhase: "uncertain",
      updatedAt: 22,
      pendingAction: null,
    }))).toBeTrue();
    expect(isApplicationActionLatchBusy(latch)).toBeFalse();
  });
});
