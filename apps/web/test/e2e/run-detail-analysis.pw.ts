import { expect, test, type Page } from "@playwright/test";
import {
  type ApplicationSessionView,
  type ResumeIterationListResponse,
  type RunDto,
} from "@jobhunter/pipeline/contracts";

const runId = "run-detail-analysis-v2";
const jobUrl = "https://jobs.example.test/openings/staff-ai?gh_jid=123&source=viewer";
const analysisArtifactId = "job-analysis-v2";
const extractionArtifactId = "ats-keyword-extraction-v1";
const keywordCoverageArtifactId = "keyword-map-v1";
const resumeArtifactId = "compiled-resume-pdf-v2";
const resumePdfSha256 = "9".repeat(64);
const resumePdf = Buffer.from("%PDF-1.4\n% analysis fixture\n%%EOF\n");

const run: RunDto = {
  id: runId,
  opportunityKind: "job",
  jobUrl,
  status: "approved",
  applicationStatus: "applied",
  queueSequence: 1,
  generateKeywordMap: true,
  skipReview: false,
  autoSubmit: false,
  revision: 2,
  origin: "initial",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  currentPdfSha256: resumePdfSha256,
  visualAcknowledgementRequired: false,
  attempts: [],
  artifacts: [
    {
      id: analysisArtifactId,
      kind: "job-analysis",
      revision: 0,
      attempt: 1,
      sha256: "a".repeat(64),
      bytes: 1_024,
      mediaType: "application/json",
      href: `/v1/runs/${runId}/artifacts/${analysisArtifactId}`,
      public: true,
      createdAt: 1_700_000_000_100,
    },
    {
      id: extractionArtifactId,
      kind: "ats-keyword-extraction",
      revision: 0,
      attempt: 1,
      sha256: "e".repeat(64),
      bytes: 1_024,
      mediaType: "application/json; charset=utf-8",
      href: `/v1/runs/${runId}/artifacts/${extractionArtifactId}`,
      public: true,
      createdAt: 1_700_000_000_090,
    },
    {
      id: keywordCoverageArtifactId,
      kind: "keyword-map",
      revision: 2,
      attempt: 1,
      sha256: "7".repeat(64),
      bytes: 1_024,
      mediaType: "application/json; charset=utf-8",
      href: `/v1/runs/${runId}/artifacts/${keywordCoverageArtifactId}`,
      public: true,
      createdAt: 1_700_000_000_105,
    },
    {
      id: resumeArtifactId,
      kind: "compiled-pdf",
      revision: 2,
      attempt: 1,
      sha256: resumePdfSha256,
      bytes: resumePdf.byteLength,
      mediaType: "application/pdf",
      href: `/v1/runs/${runId}/artifacts/${resumeArtifactId}`,
      public: true,
      createdAt: 1_700_000_000_110,
    },
  ],
  timeline: [],
};

const analysis = {
  schemaVersion: 2,
  id: "analysis-v2",
  jobDescriptionSha256: "b".repeat(64),
  analysisWorkflowSha256: "c".repeat(64),
  baselineSha256: "d".repeat(64),
  target: {
    title: "Staff AI Engineer",
    organization: "Acme Systems",
  },
  jdKeywords: [
    {
      id: "keyword-observability",
      phrase: "Operational observability",
      jdQuote: "Own Operational observability across every production service.",
      evidenceIds: ["evidence-observability"],
    },
    {
      id: "keyword-typescript",
      phrase: "Production TypeScript",
      jdQuote: "Build reliable agent orchestration services with Production TypeScript.",
      evidenceIds: ["evidence-keyword"],
    },
  ],
  exactEdits: [
    {
      id: "edit-bullet",
      kind: "bullet",
      baselineItemId: "bullet-experience-platform-1",
      section: "experience",
      entityId: "experience-platform",
      before: "Built typed deployment services for internal teams.",
      after: "Built Production TypeScript deployment services used by ten internal teams.",
      keywordIds: ["keyword-typescript"],
      evidenceIds: ["evidence-keyword", "evidence-bullet"],
    },
    {
      id: "edit-skill",
      kind: "skill",
      baselineItemId: "skill-languages-typescript",
      category: "Languages",
      evidenceEntityId: "skills",
      before: "TypeScript",
      after: "Production TypeScript",
      keywordIds: ["keyword-typescript"],
      evidenceIds: ["evidence-keyword", "evidence-skill"],
    },
  ],
};

const extraction = {
  schemaVersion: 1,
  jobDescriptionSha256: "b".repeat(64),
  keywordExtractionWorkflowSha256: "f".repeat(64),
  keywords: [
    {
      id: "keyword-distributed-tracing",
      phrase: "Distributed tracing",
      jdQuote: "Lead Distributed tracing adoption across the platform.",
    },
    {
      id: "keyword-typescript",
      phrase: "Production TypeScript",
      jdQuote: "Build reliable agent orchestration services with Production TypeScript.",
    },
    {
      id: "keyword-zero-downtime",
      phrase: "Zero-downtime delivery",
      jdQuote: "Create Zero-downtime delivery systems.",
    },
    {
      id: "keyword-observability",
      phrase: "Operational observability",
      jdQuote: "Own Operational observability across every production service.",
    },
  ],
};

const keywordCoverage = {
  schemaVersion: 1,
  pdfSha256: resumePdfSha256,
  keywords: [
    { id: "keyword-distributed-tracing", phrase: "Distributed tracing", found: true },
    { id: "keyword-typescript", phrase: "Production TypeScript", found: true },
    { id: "keyword-zero-downtime", phrase: "Zero-downtime delivery", found: false },
    { id: "keyword-observability", phrase: "Operational observability", found: false },
  ],
};

async function interceptRunDetail(
  page: Page,
  includeExtraction = true,
  listedRun: RunDto = run,
  coverageValue: unknown = keywordCoverage,
): Promise<void> {
  const listedArtifacts = includeExtraction
    ? listedRun.artifacts
    : listedRun.artifacts.filter((artifact) => artifact.kind !== "ats-keyword-extraction");
  const iterationArtifactPath = `/api/pipeline/runs/${runId}/iterations/${listedRun.revision}/artifacts`;
  const iterations: ResumeIterationListResponse = {
    artifactState: "retained",
    iterations: [
      {
        revision: listedRun.revision,
        origin: listedRun.origin,
        status: "approved",
        createdAt: listedRun.updatedAt,
        pdfSha256: resumePdfSha256,
        artifacts: listedArtifacts.map((artifact) => ({
          ...artifact,
          href: `/v1/runs/${runId}/iterations/${listedRun.revision}/artifacts/${artifact.id}`,
        })),
      },
    ],
  };
  const application: ApplicationSessionView = {
    state: "not_started",
    canStart: false,
    canStartAfterApproval: false,
    blockedReason: "legacy_job_url_unavailable",
  };

  await page.route(`**/api/pipeline/runs/${runId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...listedRun, artifacts: listedArtifacts }),
    });
  });
  await page.route(`**/api/pipeline/runs/${runId}/iterations`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(iterations),
    });
  });
  await page.route(`**/api/pipeline/runs/${runId}/application`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(application),
    });
  });
  await page.route(`**${iterationArtifactPath}/${analysisArtifactId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(analysis),
    });
  });
  if (includeExtraction) {
    await page.route(`**${iterationArtifactPath}/${extractionArtifactId}`, async (route) => {
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(extraction),
      });
    });
  }
  await page.route(`**${iterationArtifactPath}/${keywordCoverageArtifactId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(coverageValue),
    });
  });
  await page.route(`**${iterationArtifactPath}/${resumeArtifactId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/pdf",
      body: resumePdf,
    });
  });
}

test("prefers durable run identity overrides in the opened-run summary", async ({ page }) => {
  await interceptRunDetail(page, true, {
    ...run,
    titleOverride: "Principal Platform Engineer",
    organizationOverride: "Override Industries",
  });
  await page.goto(`/runs/${runId}`);

  await expect(page.getByRole("heading", { level: 1, name: "Principal Platform Engineer" })).toBeVisible();
  await expect(page.getByText("Override Industries", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Staff AI Engineer" })).toHaveCount(0);
  await expect(page.getByText("Acme Systems", { exact: true })).toHaveCount(0);
});

test("links the canonical job posting directly above run metadata", async ({ page }) => {
  await interceptRunDetail(page);
  await page.goto(`/runs/${runId}`);

  const link = page.getByRole("link", { name: "View job posting", exact: true });
  await expect(link).toHaveAttribute("href", jobUrl);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer");
  expect(await link.evaluate((element) => {
    const metadata = element.nextElementSibling;
    return metadata?.tagName === "DL"
      && metadata.querySelector("dt")?.textContent === "Created";
  })).toBe(true);
});

test("omits the job posting link for a legacy run", async ({ page }) => {
  const { jobUrl: _omitted, ...legacyRun } = run;
  await interceptRunDetail(page, true, legacyRun);
  await page.goto(`/runs/${runId}`);

  await expect(page.getByRole("link", { name: "View job posting", exact: true })).toHaveCount(0);
});

const oldReportHeadings = [
  "Role summary",
  "Requirement evidence",
  "Recruiter risks",
  "Gaps and mitigations",
  "Keyword alignment",
  "Proposed CV content",
  "Business value bullet review",
  "Truthful keyword use",
  "Customization plan",
];

test("shows the minimal summary and phrase-only keyword comparison", async ({ page }) => {
  await interceptRunDetail(page);
  await page.goto(`/runs/${runId}`);

  const title = page.getByRole("heading", { level: 1, name: "Staff AI Engineer" });
  const lifecycleBadge = page
    .getByRole("complementary", { name: "Application summary and keyword comparison" })
    .getByText("Applied", { exact: true });
  await expect(title).toBeVisible();
  await expect(lifecycleBadge).toBeVisible();
  await expect(page.getByText("Acme Systems", { exact: true }).first()).toBeVisible();
  expect(await lifecycleBadge.evaluate((badge, heading) => Boolean(
    badge.compareDocumentPosition(heading as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ), await title.elementHandle())).toBe(true);
  const [badgeColor, lifecycleColor] = await lifecycleBadge.evaluate((badge) => {
    const rootStyles = getComputedStyle(document.documentElement);
    return [
      getComputedStyle(badge).getPropertyValue("--application-badge-color").trim(),
      rootStyles.getPropertyValue("--color-application-applied").trim(),
    ];
  });
  expect(badgeColor).toBe(lifecycleColor);
  await expect(page.getByText("Created", { exact: true })).toBeVisible();
  await expect(page.getByText("Last updated", { exact: true })).toBeVisible();
  for (const removedLabel of [
    "Application details",
    "Application status",
    "Pipeline status",
    "Revision",
    "Revision origin",
    "Current PDF",
    "Visual acknowledgement",
  ]) {
    await expect(page.getByText(removedLabel, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("heading", { name: "Job analysis", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Exact resume edits", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "JD keywords", exact: true })).toHaveCount(0);

  const included = page.getByRole("region", { name: "Keywords included" });
  const notIncluded = page.getByRole("region", { name: "Keywords not included" });
  await expect(included.getByRole("listitem")).toHaveText([
    "Distributed tracing",
    "Production TypeScript",
  ]);
  await expect(notIncluded.getByRole("listitem")).toHaveText([
    "Zero-downtime delivery",
    "Operational observability",
  ]);

  for (const privateDetail of [
    "analysis-v2",
    "keyword-observability",
    "keyword-typescript",
    "keyword-distributed-tracing",
    "keyword-zero-downtime",
    "Own Operational observability across every production service.",
    "Build reliable agent orchestration services with Production TypeScript.",
    "Lead Distributed tracing adoption across the platform.",
    "Create Zero-downtime delivery systems.",
    "evidence-observability",
    "evidence-keyword",
    "evidence-bullet",
    "evidence-skill",
    "Built typed deployment services for internal teams.",
    "Built Production TypeScript deployment services used by ten internal teams.",
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
    "d".repeat(64),
    "e".repeat(64),
    "f".repeat(64),
  ]) {
    await expect(page.getByText(privateDetail, { exact: true })).toHaveCount(0);
  }
  for (const heading of oldReportHeadings) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toHaveCount(0);
  }
});

test("makes no inclusion claim when coverage belongs to another PDF", async ({ page }) => {
  await interceptRunDetail(page, true, run, {
    ...keywordCoverage,
    pdfSha256: "8".repeat(64),
  });
  await page.goto(`/runs/${runId}`);

  const included = page.getByRole("region", { name: "Keywords included" });
  const notIncluded = page.getByRole("region", { name: "Keywords not included" });
  await expect(included).toContainText("Rendered-resume keyword coverage is unavailable.");
  await expect(notIncluded).toContainText("Rendered-resume keyword coverage is unavailable.");
  await expect(included.getByRole("list")).toHaveCount(0);
  await expect(notIncluded.getByRole("list")).toHaveCount(0);
});

test("makes no inclusion claim when keyword extraction is unavailable", async ({ page }) => {
  await interceptRunDetail(page, false);
  await page.goto(`/runs/${runId}`);

  const included = page.getByRole("region", { name: "Keywords included" });
  const notIncluded = page.getByRole("region", { name: "Keywords not included" });
  await expect(included).toContainText("Keyword extraction is unavailable.");
  await expect(notIncluded).toContainText("Keyword extraction is unavailable.");
  await expect(included.getByRole("list")).toHaveCount(0);
  await expect(notIncluded.getByRole("list")).toHaveCount(0);
});
