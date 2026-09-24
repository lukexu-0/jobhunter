import { describe, expect, test } from "bun:test";
import type { ResumeIterationDto, RunDto } from "../app/lib/pipeline-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { RunReviewWorkspace } from "../app/components/run-review-workspace";

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
  opportunityKind: "job",
  status: "review",
  applicationStatus: "pending",
  generateKeywordMap: false,
  skipReview: false,
  autoSubmit: false,
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
    expect(markup).toContain("Historical document files are unavailable");
    expect(markup).not.toContain("removed by retention");
    expect(markup).not.toContain("Resume files were removed by retention");
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
    expect(currentMarkup).toContain("Approve");
    expect(currentMarkup).not.toContain("Approve and apply");
    expect(currentMarkup).not.toContain("Regenerate");
    expect(currentMarkup).not.toContain("View latest");
    expect(markup).not.toContain("Edit instructions");
  });

});
