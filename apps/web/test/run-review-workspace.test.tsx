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
    expect(markup).toContain("Iteration 1");
    expect(markup).toContain("Iteration 2");
    expect(markup).toContain("Iteration 3 — Latest");
    expect(markup.match(/Latest/g)).toHaveLength(1);
    expect(markup).toContain('<option value="3" selected="">Iteration 1</option>');
    expect(markup).toContain('<option value="5">Iteration 2</option>');
    expect(markup).toContain('<option value="8">Iteration 3 — Latest</option>');
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
        selection={{ mode: "follow-latest", selectedRevision: 8 }}
      />,
    );
    expect(currentMarkup).toContain("Request edit");
    expect(currentMarkup).toContain("Regenerate");
    expect(currentMarkup).toContain("Approve resume");
    expect(markup).not.toContain("Request edit");
  });
});
