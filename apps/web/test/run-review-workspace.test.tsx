import { describe, expect, test } from "bun:test";
import type { ResumeIterationDto, RunDto } from "@jobhunter/pipeline/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RunReviewWorkspace,
  resumeIterationLabel,
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
  queueSequence: 1,
  revision: 3,
  origin: "human-comments",
  createdAt: 1,
  updatedAt: 3,
  currentPdfSha256: PDF_HASH,
  visualAcknowledgementRequired: false,
  attempts: [],
  artifacts: [],
  timeline: [],
};

describe("RunReviewWorkspace", () => {
  test("labels semantic origins and explains pinned pruned history", () => {
    const iterations = [
      iteration(1, "initial"),
      iteration(2, "machine-regeneration"),
      iteration(3, "human-comments"),
    ];
    expect(iterations.map(resumeIterationLabel)).toEqual([
      "Iteration 1 — Initial",
      "Iteration 2 — Regenerated",
      "Iteration 3 — Requested edit",
    ]);

    const markup = renderToStaticMarkup(
      <RunReviewWorkspace
        artifactState="pruned"
        busyAction={null}
        isFresh
        isLoadingIterations={false}
        iterationError={null}
        iterations={iterations}
        onApprove={async () => ({ ...run, status: "approved" })}
        onEdit={async () => run}
        onRegenerate={async () => run}
        onSelectIteration={() => {}}
        onViewLatest={() => {}}
        run={run}
        selectedIteration={iterations[0]}
        selection={{ mode: "pinned", selectedRevision: 1 }}
      />,
    );

    expect(markup).toContain("Resume iteration");
    expect(markup).toContain("Iteration 1 — Initial");
    expect(markup).toContain("Iteration 2 — Regenerated");
    expect(markup).toContain("Iteration 3 — Requested edit");
    expect(markup).toContain("View latest");
    expect(markup).toContain("Historical iterations are view-only");
    expect(markup).toContain("Resume files were removed by retention");
    expect(markup).not.toContain("/tmp/");
    expect(markup).not.toContain("sessionId");

    const currentMarkup = renderToStaticMarkup(
      <RunReviewWorkspace
        artifactState="retained"
        busyAction={null}
        isFresh
        isLoadingIterations={false}
        iterationError={null}
        iterations={iterations}
        onApprove={async () => ({ ...run, status: "approved" })}
        onEdit={async () => run}
        onRegenerate={async () => run}
        onSelectIteration={() => {}}
        onViewLatest={() => {}}
        run={run}
        selectedIteration={iterations[2]}
        selection={{ mode: "follow-latest", selectedRevision: 3 }}
      />,
    );
    expect(currentMarkup).toContain("Request edit");
    expect(currentMarkup).toContain("Regenerate");
    expect(currentMarkup).toContain("Approve resume");
    expect(markup).not.toContain("Request edit");
  });
});
