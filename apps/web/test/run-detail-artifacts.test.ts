import { describe, expect, test } from "bun:test";
import type { ArtifactDto, ResumeIterationDto } from "../app/lib/pipeline-contracts";
import {
  publicArtifacts,
  reconcileResumeIterationSelection,
  selectCurrentRevisionArtifact,
  selectReusableJobAnalysis,
  type ResumeIterationSelection,
} from "../app/lib/run-detail-artifacts";

const sha256 = "a".repeat(64);

function artifact(overrides: Partial<ArtifactDto> = {}): ArtifactDto {
  return {
    id: "artifact-1",
    kind: "visual-qa",
    revision: 2,
    attempt: 1,
    sha256,
    bytes: 13,
    mediaType: "application/json",
    href: "/v1/runs/run-1/artifacts/artifact-1",
    public: true,
    createdAt: 3,
    ...overrides,
  };
}

function iteration(revision: number): ResumeIterationDto {
  return {
    revision,
    origin: revision === 1 ? "initial" : "human-comments",
    status: "review",
    createdAt: revision,
    pdfSha256: sha256,
    artifacts: [],
  };
}

describe("run-detail artifact selection", () => {
  test("revision-scoped evidence refuses prior-revision and private artifacts", () => {
    const prior = artifact({ id: "prior", revision: 1, attempt: 9, createdAt: 90 });
    const privateCurrent = artifact({ id: "private-current", public: false, attempt: 3, createdAt: 30 });
    const publicCurrent = artifact({ id: "public-current", attempt: 2, createdAt: 20 });

    expect(selectCurrentRevisionArtifact([prior, privateCurrent, publicCurrent], 2, "visual-qa")).toEqual(publicCurrent);
    expect(selectCurrentRevisionArtifact([prior, privateCurrent], 2, "visual-qa")).toBeUndefined();
  });

  test("reusable job analysis selects the latest public available analysis", () => {
    const older = artifact({ id: "older-analysis", kind: "job-analysis", revision: 0, attempt: 4, createdAt: 40 });
    const latestPrivate = artifact({ id: "private-analysis", kind: "job-analysis", revision: 3, public: false, createdAt: 100 });
    const latestPublic = artifact({ id: "latest-analysis", kind: "job-analysis", revision: 2, attempt: 1, createdAt: 50 });

    expect(selectReusableJobAnalysis([older, latestPrivate, latestPublic])).toEqual(latestPublic);
  });

  test("public downloads reject private entries", () => {
    const visible = artifact({ id: "visible" });
    const privateArtifact = artifact({ id: "private", public: false });

    expect(publicArtifacts([privateArtifact, visible])).toEqual([visible]);
  });

  test("follows new reviewed iterations while preserving an explicit pinned revision", () => {
    const initial = reconcileResumeIterationSelection(
      { mode: "follow-latest", selectedRevision: null },
      [iteration(3), iteration(5)],
    );
    expect(initial).toEqual({ mode: "follow-latest", selectedRevision: 5 });
    expect(reconcileResumeIterationSelection(initial, [
      iteration(3),
      iteration(5),
      iteration(8),
    ])).toEqual({ mode: "follow-latest", selectedRevision: 8 });

    const pinned: ResumeIterationSelection = { mode: "pinned", selectedRevision: 3 };
    expect(reconcileResumeIterationSelection(pinned, [
      iteration(3),
      iteration(5),
      iteration(8),
    ])).toEqual(pinned);
    expect(reconcileResumeIterationSelection(pinned, [iteration(5), iteration(8)]))
      .toEqual({ mode: "follow-latest", selectedRevision: 8 });
    expect(reconcileResumeIterationSelection(pinned, []))
      .toEqual({ mode: "follow-latest", selectedRevision: null });
  });
});
