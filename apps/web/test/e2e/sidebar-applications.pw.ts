import { expect, test, type Page, type Route } from "@playwright/test";
import {
  type ApplicationSessionView,
  type ApplicationStatus,
  type ArtifactKind,
  type ResumeIterationListResponse,
  type RunDto,
  type RunStatus,
} from "@jobhunter/pipeline/contracts";

function runFixture(id: string, applicationStatus: ApplicationStatus, status: RunStatus): RunDto {
  return {
    id,
    opportunityKind: "job",
    status,
    applicationStatus,
    revision: 1,
    origin: "initial",
    queueSequence: 1,
    generateKeywordMap: false,
    skipReview: false,
    autoSubmit: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    visualAcknowledgementRequired: false,
    attempts: [],
    artifacts: [],
    timeline: [],
  };
}
function documentViewerFixture(id: string, includeKeywordMap: boolean): RunDto {
  const resumeSha256 = "a".repeat(64);
  const revision = 4;
  return {
    ...runFixture(id, "applied", "review"),
    generateKeywordMap: includeKeywordMap,
    revision,
    currentPdfSha256: resumeSha256,
    artifacts: [
      {
        id: "resume-pdf",
        kind: "compiled-pdf",
        revision,
        attempt: 1,
        sha256: resumeSha256,
        bytes: 1_024,
        mediaType: "application/pdf",
        href: `/v1/runs/${id}/artifacts/resume-pdf`,
        public: true,
        createdAt: 1_700_000_000_100,
      },
      ...(includeKeywordMap ? [{
        id: "keyword-map-pdf",
        kind: "keyword-map-pdf" as const,
        revision,
        attempt: 1,
        sha256: "b".repeat(64),
        bytes: 2_048,
        mediaType: "application/pdf",
        href: `/v1/runs/${id}/artifacts/keyword-map-pdf`,
        public: true,
        createdAt: 1_700_000_000_200,
      }] : []),
    ],
  };
}

const resumeDiffArtifactId = "resume-diff-json";
const resumeDiff = {
  schemaVersion: 1,
  baselineSha256: "c".repeat(64),
  planId: "plan-current",
  sections: [
    {
      id: "experience",
      label: "Experience",
      groups: [
        {
          id: "acme-platform",
          label: "Acme Platform",
          rows: [
            {
              id: "unchanged-bullet",
              kind: "bullet",
              change: "unchanged",
              before: "Owned reliable deployment services.",
              after: "Owned reliable deployment services.",
            },
            {
              id: "edited-bullet",
              kind: "bullet",
              change: "edited",
              before: "Built typed deployment services.",
              after: "Built Production TypeScript deployment services.",
            },
            {
              id: "deleted-bullet",
              kind: "bullet",
              change: "deleted",
              before: "Maintained a retired internal tool.",
              after: null,
            },
            {
              id: "added-bullet",
              kind: "bullet",
              change: "added",
              before: null,
              after: "Added zero-downtime delivery checks.",
            },
          ],
        },
      ],
    },
  ],
};

function diffDocumentViewerFixture(id: string): RunDto {
  const run = documentViewerFixture(id, true);
  return {
    ...run,
    artifacts: [
      ...run.artifacts,
      {
        id: "resume-page-image",
        kind: "page-image",
        revision: run.revision,
        attempt: 1,
        sha256: "d".repeat(64),
        bytes: 1_024,
        mediaType: "image/png",
        href: `/v1/runs/${id}/artifacts/resume-page-image`,
        public: true,
        createdAt: 1_700_000_000_250,
      },
      {
        id: resumeDiffArtifactId,
        kind: "resume-diff" as ArtifactKind,
        revision: run.revision,
        attempt: 1,
        sha256: "c".repeat(64),
        bytes: 4_096,
        mediaType: "application/json; charset=utf-8",
        href: `/v1/runs/${id}/artifacts/${resumeDiffArtifactId}`,
        public: true,
        createdAt: 1_700_000_000_300,
      },
    ],
  };
}

function landscapePdfFixture(): Buffer {
  const stream = "BT /F1 24 Tf 72 540 Td (Keyword map fixture) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

const LANDSCAPE_PDF_FIXTURE = landscapePdfFixture();

function resumeIterationFixture(run: RunDto): ResumeIterationListResponse {
  const currentPdf = run.currentPdfSha256
    ? run.artifacts.find(
        (artifact) => artifact.kind === "compiled-pdf"
          && artifact.sha256 === run.currentPdfSha256,
      )
    : undefined;
  if ((run.status !== "review" && run.status !== "approved") || !currentPdf) {
    return { artifactState: "retained", iterations: [] };
  }

  return {
    artifactState: "retained",
    iterations: [{
      revision: run.revision,
      origin: run.origin,
      status: run.status,
      createdAt: currentPdf.createdAt,
      pdfSha256: currentPdf.sha256,
      artifacts: run.artifacts.map((artifact) => ({
        ...artifact,
        href: `/v1/runs/${run.id}/iterations/${run.revision}/artifacts/${artifact.id}`,
      })),
    }],
  };
}

function applicationViewFixture(run: RunDto): ApplicationSessionView {
  if (run.status === "approved") {
    const hasRetainedApprovedPdf = resumeIterationFixture(run).iterations.length === 1;
    return hasRetainedApprovedPdf
      ? {
          state: "not_started",
          canStart: true,
          canStartAfterApproval: false,
        }
      : {
          state: "not_started",
          canStart: false,
          canStartAfterApproval: false,
          blockedReason: "artifacts_pruned",
        };
  }
  return {
    state: "not_started",
    canStart: false,
    canStartAfterApproval: false,
    blockedReason: "resume_not_approved",
  };
}

async function interceptDocumentRun(
  page: Page,
  run: RunDto,
  jsonArtifacts: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const iterationResponse = resumeIterationFixture(run);
  const artifactsById = new Map(
    [
      ...run.artifacts,
      ...iterationResponse.iterations.flatMap((iteration) => iteration.artifacts),
    ].map((artifact) => [artifact.id, artifact] as const),
  );
  await page.route(`**/api/pipeline/runs/${run.id}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(`**/api/pipeline/runs/${run.id}/iterations`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(iterationResponse),
    });
  });
  await page.route(`**/api/pipeline/runs/${run.id}/application`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(applicationViewFixture(run)),
    });
  });
  const fulfillArtifact = async (route: Route): Promise<void> => {
    expect(route.request().method()).toBe("GET");
    const artifactId = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    const artifact = artifactsById.get(artifactId);
    if (!artifact) throw new Error(`Unexpected artifact request: ${artifactId}`);
    if (artifactId === "resume-page-image") {
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
      });
      return;
    }
    if (Object.hasOwn(jsonArtifacts, artifactId)) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(jsonArtifacts[artifactId]),
      });
      return;
    }
    if (artifact.kind !== "compiled-pdf" && artifact.kind !== "keyword-map-pdf") {
      throw new Error(`No fixture for ${artifact.kind} artifact ${artifactId}`);
    }
    await route.fulfill({
      contentType: "application/pdf",
      headers: { "content-disposition": `inline; filename="${artifact.kind}.pdf"` },
      body: LANDSCAPE_PDF_FIXTURE,
    });
  };
  await page.route(`**/api/pipeline/runs/${run.id}/artifacts/*`, fulfillArtifact);
  await page.route(
    `**/api/pipeline/runs/${run.id}/iterations/${run.revision}/artifacts/*`,
    fulfillArtifact,
  );
}


const lifecycleRuns: readonly RunDto[] = [
  runFixture("lifecycle-applied", "applied", "failed"),
  runFixture("lifecycle-rejected", "rejected", "approved"),
  runFixture("lifecycle-interview", "interview", "queued"),
  runFixture("lifecycle-accepted", "accepted", "failed"),
  runFixture("lifecycle-failed", "failed", "review"),
];

async function interceptRuns(page: Page): Promise<void> {
  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: lifecycleRuns }),
    });
  });
}

async function interceptEmptyRuns(page: Page): Promise<void> {
  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    rootScroll: document.documentElement.scrollWidth,
    rootClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
  }));
  expect(widths.rootScroll).toBe(widths.rootClient);
  expect(widths.bodyScroll).toBeLessThanOrEqual(widths.rootClient);
}

async function expectFolderNavigation(
  page: Page,
  width: number,
  currentLabel: "Applications" | "Discovery" | "Events" | "Providers",
): Promise<void> {
  const strip = page.locator("header.app-navigation");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("Primary navigation geometry is unavailable");
  expect(stripBox).toMatchObject({ x: 0, y: 0, width, height: 64 });

  const stripStyle = await strip.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      position: style.position,
      borderRightWidth: style.borderRightWidth,
      borderBottomWidth: style.borderBottomWidth,
    };
  });
  expect(stripStyle).toEqual({
    position: "sticky",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
  });

  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  const links = navigation.getByRole("link");
  await expect(links).toHaveCount(4);
  const linkBoxes = await links.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, width: box.width };
  }));
  expect(Math.max(...linkBoxes.map(({ width: linkWidth }) => linkWidth))
    - Math.min(...linkBoxes.map(({ width: linkWidth }) => linkWidth))).toBeLessThanOrEqual(1);
  expect(linkBoxes[0].x).toBe(0);
  for (let index = 1; index < linkBoxes.length; index += 1) {
    const priorWidth = linkBoxes
      .slice(0, index)
      .reduce((total, { width: linkWidth }) => total + linkWidth, 0);
    expect(Math.abs(linkBoxes[index].x - priorWidth)).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(
    linkBoxes.reduce((total, { width: linkWidth }) => total + linkWidth, 0) - width,
  )).toBeLessThanOrEqual(1);
  const linkStyles = await links.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      clipPath: style.clipPath,
      justifyContent: style.justifyContent,
      whiteSpace: style.whiteSpace,
    };
  }));
  const expectedClipPath = width <= 560
    ? "polygon(8px 0px, calc(100% - 8px) 0px, 100% 100%, 0px 100%)"
    : "polygon(16px 0px, calc(100% - 16px) 0px, 100% 100%, 0px 100%)";
  expect(linkStyles).toEqual(Array.from({ length: 4 }, () => ({
    clipPath: expectedClipPath,
    justifyContent: "center",
    whiteSpace: "nowrap",
  })));

  const current = navigation.getByRole("link", { name: currentLabel });
  const inactive = navigation.locator("a:not([aria-current='page'])");
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(inactive).toHaveCount(3);
  const currentBox = await current.boundingBox();
  const inactiveBoxes = await inactive.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { y: box.y, height: box.height };
  }));
  if (!currentBox) throw new Error("Current primary navigation tab geometry is unavailable");
  for (const inactiveBox of inactiveBoxes) {
    expect(inactiveBox.y - currentBox.y).toBe(8);
    expect(inactiveBox.y + inactiveBox.height).toBe(stripBox.y + stripBox.height);
  }
  expect(currentBox.y + currentBox.height).toBe(stripBox.y + stripBox.height);
}

async function expectFullViewportRunDetail(page: Page, width: number): Promise<void> {
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toHaveCount(0);
  const workspaceBox = await page.locator(".app-shell__workspace").boundingBox();
  const detailBox = await page.getByRole("main").boundingBox();
  if (!workspaceBox || !detailBox) throw new Error("Run detail geometry is unavailable");
  expect(workspaceBox).toMatchObject({ x: 0, width });
  expect(detailBox).toMatchObject({ x: 0, width });
  await expectNoDocumentOverflow(page);
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string): number => {
    const channels = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)]
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const brighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (brighter + 0.05) / (darker + 0.05);
}

function cssRgb(hex: string): string {
  const digits = hex.slice(1);
  const normalized = digits.length === 3
    ? [...digits].map((digit) => digit.repeat(2)).join("")
    : digits;
  return `rgb(${Number.parseInt(normalized.slice(0, 2), 16)}, ${Number.parseInt(normalized.slice(2, 4), 16)}, ${Number.parseInt(normalized.slice(4, 6), 16)})`;
}

test("shows the controlled initializer for an empty dashboard", async ({ page }) => {
  await interceptEmptyRuns(page);
  await page.goto("/");

  const heading = page.getByRole("heading", { name: "Applications" });
  const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
  await expect(initializer).toBeVisible();
  await expect(heading.locator("xpath=..").locator("+ form")).toHaveCount(1);
  await expect(initializer.getByLabel("Job posting URLs")).toHaveAttribute("id", "job-url");
  const options = initializer.getByRole("group", { name: "Run options" });
  await expect(options.getByRole("checkbox", { name: "Skip résumé review", exact: true })).not.toBeChecked();
  await expect(options.getByRole("checkbox", { name: "Auto-submit application", exact: true })).not.toBeChecked();
  await expect(options.getByText(
    "Automatically approves only when automated résumé checks pass, then starts the application.",
    { exact: true },
  )).toBeVisible();
  await expect(options.getByText(
    "Submits only when the application has no blockers.",
    { exact: true },
  )).toBeVisible();
  await expect(initializer.getByText("Generate resume-to-job-description keyword map", { exact: true })).toHaveCount(0);
  await expect(initializer.getByRole("textbox")).toHaveCount(1);
  await expect(initializer.getByRole("button", { name: "Initialize" })).toBeDisabled();
  await expect(page.getByText("No applications yet. Enter a job posting URL above to initialize one.", { exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: /^(New|Close|Create run|Create first application|Cancel)$/ })).toHaveCount(0);
  await expect(page.locator(".run-composer")).toHaveCount(0);
});

test("uses shared request eligibility and remains usable without overflow", async ({ page }) => {
  await interceptEmptyRuns(page);

  for (const width of [1_672, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
    const input = initializer.getByRole("textbox", { name: "Job posting URLs" });
    const initialize = initializer.getByRole("button", { name: "Initialize" });
    await expect(input).toHaveAttribute("type", "text");
    await expect(input).toHaveAttribute("inputmode", "url");
    await expect(input).toHaveAttribute("autocapitalize", "none");
    await expect(input).toHaveAttribute("autocorrect", "off");
    await expect(input).toHaveAttribute("spellcheck", "false");
    await expect(input).toHaveAttribute(
      "placeholder",
      "https://company.com/jobs/role, https://company.com/jobs/another-role",
    );

    for (const invalidUrl of [
      "",
      "   ",
      "example.com/job",
      "ftp://example.com/job",
      "https://user:pass@example.com/job",
      "https://jobs.example.test/valid, not-a-url",
    ]) {
      await input.fill(invalidUrl);
      await expect(initialize).toBeDisabled();
    }
    await input.fill("https://jobs.example.test/roles/123");
    await expect(initialize).toBeEnabled();

    const formBox = await initializer.boundingBox();
    const inputBox = await input.boundingBox();
    const buttonBox = await initialize.boundingBox();
    if (!formBox || !inputBox || !buttonBox) throw new Error("Initializer geometry is unavailable");
    expect(inputBox.x).toBe(formBox.x);
    if (width > 560) {
      expect(buttonBox.x + buttonBox.width).toBe(formBox.x + formBox.width);
      expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(buttonBox.x);
    } else {
      expect(buttonBox.x).toBe(formBox.x);
      expect(buttonBox.width).toBe(formBox.width);
      expect(buttonBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
    }
    await expectNoDocumentOverflow(page);
  }
});


test("posts both selected run options with the canonical URL, disables while pending, and navigates on success", async ({ page }) => {
  const initializedRun = {
    ...runFixture("initialized-run", "applied", "failed"),
    skipReview: true,
    autoSubmit: true,
  };
  let postedBody: string | null = null;
  let pendingPost: Route | undefined;
  const { promise: postStarted, resolve: markPostStarted } = Promise.withResolvers<void>();

  await page.route("**/api/pipeline/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
      return;
    }

    expect(request.method()).toBe("POST");
    expect(request.headers()["content-type"]).toContain("application/json");
    postedBody = request.postData();
    pendingPost = route;
    markPostStarted();
  });
  await interceptDocumentRun(page, initializedRun);
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
  const input = initializer.getByRole("textbox", { name: "Job posting URLs" });
  const initialize = initializer.getByRole("button", { name: "Initialize" });
  const skipReview = initializer.getByRole("checkbox", { name: "Skip résumé review" });
  const autoSubmit = initializer.getByRole("checkbox", { name: "Auto-submit application" });
  await expect(skipReview).not.toBeChecked();
  await expect(autoSubmit).not.toBeChecked();
  await skipReview.check();
  await autoSubmit.check();
  await input.fill("HTTPS://Jobs.Example.Test:443/roles/123?source=ui#description");
  await initialize.click();
  await postStarted;

  expect(postedBody).toBe(JSON.stringify({
    jobUrl: "https://jobs.example.test/roles/123?source=ui",
    generateKeywordMap: true,
    skipReview: true,
    autoSubmit: true,
  }));
  await expect(input).toBeDisabled();
  await expect(skipReview).toBeDisabled();
  await expect(autoSubmit).toBeDisabled();
  await expect(page.getByRole("button", { name: "Initializing…" })).toBeDisabled();

  if (!pendingPost) throw new Error("Initialize request was not intercepted");
  await pendingPost.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify(initializedRun),
  });

  await expect(page).toHaveURL(/\/runs\/initialized-run$/);
  await expect(page.getByRole("heading", { name: "Application", exact: true })).toBeVisible();
});

test("preserves both run options while confirming a duplicate canonical URL", async ({ page }) => {
  const canonicalJobUrl = "https://jobs.example.test/roles/123?source=ui";
  const enteredJobUrl = "HTTPS://Jobs.Example.Test:443/roles/123?source=ui#description";
  const existingRun: RunDto = {
    ...runFixture("existing-duplicate-run", "applied", "failed"),
    jobUrl: canonicalJobUrl,
  };
  const initializedRun = runFixture("duplicate-initialized-run", "applied", "failed");
  const postedPayloads: unknown[] = [];

  await page.route("**/api/pipeline/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [existingRun] }),
      });
      return;
    }

    expect(request.method()).toBe("POST");
    postedPayloads.push(request.postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(initializedRun),
    });
  });
  await interceptDocumentRun(page, initializedRun);
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
  const input = initializer.getByRole("textbox", { name: "Job posting URLs" });
  const initialize = initializer.getByRole("button", { name: "Initialize" });
  const skipReview = initializer.getByRole("checkbox", { name: "Skip résumé review" });
  const autoSubmit = initializer.getByRole("checkbox", { name: "Auto-submit application" });
  const dialog = page.getByRole("dialog", { name: "Initialize duplicate application?" });
  const description =
    "This job posting URL has already been used. Initialize another application anyway?";

  await input.fill(enteredJobUrl);
  await skipReview.check();
  await autoSubmit.check();
  await initialize.click();

  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-labelledby", "duplicate-application-dialog-title");
  await expect(dialog).toHaveAttribute("aria-describedby", "duplicate-application-dialog-description");
  await expect(dialog.getByText(description, { exact: true })).toBeVisible();
  expect(postedPayloads).toHaveLength(0);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(input).toHaveValue(enteredJobUrl);
  await expect(initialize).toBeFocused();
  await expect(skipReview).toBeChecked();
  await expect(autoSubmit).toBeChecked();
  expect(postedPayloads).toHaveLength(0);

  await initialize.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(input).toHaveValue(enteredJobUrl);
  await expect(initialize).toBeFocused();
  await expect(skipReview).toBeChecked();
  await expect(autoSubmit).toBeChecked();
  expect(postedPayloads).toHaveLength(0);

  await initialize.click();
  await dialog.getByRole("button", { name: "Initialize anyway" }).click();

  await expect(page).toHaveURL(/\/runs\/duplicate-initialized-run$/);
  await expect(page.getByRole("heading", { name: "Application", exact: true })).toBeVisible();
  expect(postedPayloads).toEqual([{
    jobUrl: canonicalJobUrl,
    generateKeywordMap: true,
    skipReview: true,
    autoSubmit: true,
  }]);
});

test("confirms duplicate URLs before starting a multi-URL batch", async ({ page }) => {
  const expectedUrls = [
    "https://jobs.example.test/roles/existing",
    "https://jobs.example.test/roles/new",
  ];
  const existingRun: RunDto = {
    ...runFixture("batch-existing-run", "pending", "approved"),
    jobUrl: expectedUrls[0],
  };
  const initializedRuns = new Map<string, RunDto>([
    [expectedUrls[0], runFixture("batch-duplicate-run", "pending", "approved")],
    [expectedUrls[1], runFixture("batch-new-run", "pending", "approved")],
  ]);
  const postedUrls: string[] = [];
  let listRequestCount = 0;

  await page.route("**/api/pipeline/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      listRequestCount += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          runs: listRequestCount === 1
            ? [existingRun]
            : [existingRun, ...initializedRuns.values()],
        }),
      });
      return;
    }

    const body = request.postDataJSON() as {
      jobUrl: string;
      generateKeywordMap: boolean;
    };
    postedUrls.push(body.jobUrl);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(initializedRuns.get(body.jobUrl)),
    });
  });
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
  const input = initializer.getByRole("textbox", { name: "Job posting URLs" });
  await input.fill([
    "HTTPS://Jobs.Example.Test:443/roles/existing#details,",
    "https://jobs.example.test/roles/new",
  ].join(" "));
  await initializer.getByRole("button", { name: "Initialize" }).click();

  const dialog = page.getByRole("dialog", { name: "Initialize duplicate applications?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(
    "One or more job posting URLs have already been used. Initialize these applications anyway?",
    { exact: true },
  )).toBeVisible();
  expect(postedUrls).toEqual([]);

  await dialog.getByRole("button", { name: "Initialize anyway" }).click();
  await expect(page.getByRole("status")).toHaveText("2 applications initialized.");
  expect([...postedUrls].sort()).toEqual([...expectedUrls].sort());
  await expect(input).toHaveValue("");
  await expect(page.locator("tbody tr")).toHaveCount(3);
});

test("initializes mixed comma and whitespace URLs concurrently, stays on the dashboard, and adds every run", async ({ page }) => {
  const expectedUrls = [
    "https://jobs.example.test/roles/alpha",
    "https://jobs.example.test/roles/bravo?source=board",
    "https://jobs.example.test/roles/charlie",
    "https://jobs.example.test/roles/delta",
    "https://jobs.example.test/roles/echo",
    "https://jobs.example.test/roles/foxtrot",
  ];
  const initializedRuns = new Map<string, RunDto>(
    expectedUrls.map((url, index) => [
      url,
      runFixture(`initialized-${index + 1}`, "pending", "approved"),
    ]),
  );
  const existingRun = runFixture("existing-run", "pending", "approved");
  const pendingPosts = new Map<string, Route>();
  const postedUrls: string[] = [];
  let activePosts = 0;
  let maxActivePosts = 0;
  let listRequestCount = 0;
  let pendingInitialList: Route | undefined;
  const { promise: initialListStarted, resolve: markInitialListStarted } = Promise.withResolvers<void>();
  const { promise: firstFiveStarted, resolve: markFirstFiveStarted } = Promise.withResolvers<void>();
  const { promise: allPostsStarted, resolve: markAllPostsStarted } = Promise.withResolvers<void>();

  await page.route("**/api/pipeline/concurrency-check", async (route) => {
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/pipeline/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      listRequestCount += 1;
      if (listRequestCount === 1) {
        pendingInitialList = route;
        markInitialListStarted();
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [existingRun, ...initializedRuns.values()] }),
      });
      return;
    }

    expect(request.method()).toBe("POST");
    expect(request.headers()["content-type"]).toContain("application/json");
    const body = request.postDataJSON() as {
      jobUrl: string;
      generateKeywordMap: boolean;
      skipReview: boolean;
      autoSubmit: boolean;
    };
    expect(body).toMatchObject({
      generateKeywordMap: true,
      skipReview: true,
      autoSubmit: false,
    });
    expect(body.generateKeywordMap).toBe(true);
    expect(expectedUrls).toContain(body.jobUrl);
    expect(pendingPosts.has(body.jobUrl)).toBe(false);
    postedUrls.push(body.jobUrl);
    pendingPosts.set(body.jobUrl, route);
    activePosts += 1;
    maxActivePosts = Math.max(maxActivePosts, activePosts);
    if (postedUrls.length === 5) markFirstFiveStarted();
    if (postedUrls.length === expectedUrls.length) markAllPostsStarted();
  });
  await page.goto("/");
  await initialListStarted;

  const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
  const input = initializer.getByRole("textbox", { name: "Job posting URLs" });
  const initialize = initializer.getByRole("button", { name: "Initialize" });
  const skipReview = initializer.getByRole("checkbox", { name: "Skip résumé review" });
  const autoSubmit = initializer.getByRole("checkbox", { name: "Auto-submit application" });
  await skipReview.check();
  await input.fill([
    " HTTPS://Jobs.Example.Test:443/roles/alpha#overview,",
    "https://jobs.example.test/roles/bravo?source=board",
    "https://jobs.example.test/roles/charlie#apply,\n",
    "https://jobs.example.test/roles/delta\t",
    "https://jobs.example.test/roles/echo,",
    "https://jobs.example.test/roles/foxtrot#details ",
  ].join(" "));
  await initialize.click();
  await firstFiveStarted;

  await page.evaluate(async () => {
    const response = await fetch("/api/pipeline/concurrency-check");
    if (!response.ok) throw new Error("Concurrency checkpoint failed");
  });
  expect(postedUrls).toHaveLength(5);
  expect(activePosts).toBe(5);
  expect(maxActivePosts).toBe(5);
  await expect(input).toBeDisabled();
  await expect(page.getByRole("button", { name: "Initializing…" })).toBeDisabled();

  const firstPending = pendingPosts.entries().next().value;
  if (!firstPending) throw new Error("No initialize request was intercepted");
  const [firstUrl, firstRoute] = firstPending;
  pendingPosts.delete(firstUrl);
  activePosts -= 1;
  await firstRoute.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify(initializedRuns.get(firstUrl)),
  });
  await allPostsStarted;

  expect(activePosts).toBe(5);
  expect(maxActivePosts).toBe(5);
  expect([...postedUrls].sort()).toEqual([...expectedUrls].sort());

  await Promise.all([...pendingPosts].map(async ([url, route]) => {
    pendingPosts.delete(url);
    activePosts -= 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(initializedRuns.get(url)),
    });
  }));

  await expect(page.getByRole("status")).toHaveText("6 applications initialized.");
  await expect(page).toHaveURL(/\/$/);
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await expect(skipReview).not.toBeChecked();
  await expect(autoSubmit).not.toBeChecked();
  await expect(initialize).toBeDisabled();
  await expect(page.locator("tbody tr")).toHaveCount(7);
  for (const run of initializedRuns.values()) {
    await expect(page.locator(`tbody a.application-link[href="/runs/${run.id}"]`)).toBeVisible();
  }
  await expect(page.locator(`tbody a.application-link[href="/runs/${existingRun.id}"]`)).toBeVisible();
  await expect(page.locator(".applications-total")).toHaveText("7");
  await expect(page.getByText("Loading applications…", { exact: true })).toHaveCount(0);
  if (!pendingInitialList) throw new Error("Initial run list request was not intercepted");
  await pendingInitialList.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ runs: [existingRun] }),
  });
  await expect(page.locator("tbody tr")).toHaveCount(7);
});

test("keeps successful rows and only failed canonical URLs after a partial initialization", async ({ page }) => {
  const expectedUrls = [
    "https://jobs.example.test/roles/success-one",
    "https://jobs.example.test/roles/unavailable",
    "https://jobs.example.test/roles/success-two?source=board",
    "https://jobs.example.test/roles/restricted",
  ];
  const failedUrls = [expectedUrls[1], expectedUrls[3]];
  const successfulRuns = new Map<string, RunDto>([
    [expectedUrls[0], runFixture("partial-success-1", "pending", "approved")],
    [expectedUrls[2], runFixture("partial-success-2", "pending", "approved")],
  ]);
  const pendingPosts = new Map<string, Route>();
  const postedUrls: string[] = [];
  const firstPublicFailure = `The page does not contain a usable job description. ${"Try another public posting URL. ".repeat(10)}`;
  const laterPublicFailure = "A later public failure must not replace the first.";
  const expectedAlert = `2 of 4 applications initialized. ${firstPublicFailure}`.slice(0, 240);
  let listRequestCount = 0;
  const { promise: allPostsStarted, resolve: markAllPostsStarted } = Promise.withResolvers<void>();

  await page.route("**/api/pipeline/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      listRequestCount += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          runs: listRequestCount === 1 ? [] : [...successfulRuns.values()],
        }),
      });
      return;
    }

    expect(request.method()).toBe("POST");
    const body = request.postDataJSON() as {
      jobUrl: string;
      generateKeywordMap: boolean;
      skipReview: boolean;
      autoSubmit: boolean;
    };
    expect(body).toMatchObject({
      generateKeywordMap: true,
      skipReview: true,
      autoSubmit: true,
    });
    expect(body.generateKeywordMap).toBe(true);
    expect(expectedUrls).toContain(body.jobUrl);
    expect(pendingPosts.has(body.jobUrl)).toBe(false);
    postedUrls.push(body.jobUrl);
    pendingPosts.set(body.jobUrl, route);
    if (postedUrls.length === expectedUrls.length) markAllPostsStarted();
  });
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
  const input = initializer.getByRole("textbox", { name: "Job posting URLs" });
  const skipReview = initializer.getByRole("checkbox", { name: "Skip résumé review" });
  const autoSubmit = initializer.getByRole("checkbox", { name: "Auto-submit application" });
  await skipReview.check();
  await autoSubmit.check();
  await input.fill([
    " HTTPS://Jobs.Example.Test:443/roles/success-one#description,",
    "https://jobs.example.test/roles/unavailable#apply\n",
    "https://jobs.example.test/roles/success-two?source=board#details ",
    "https://jobs.example.test/roles/restricted#requirements",
  ].join(" "));
  await initializer.getByRole("button", { name: "Initialize" }).click();
  await allPostsStarted;

  expect([...postedUrls].sort()).toEqual([...expectedUrls].sort());
  await Promise.all([...pendingPosts].map(async ([url, route]) => {
    const successfulRun = successfulRuns.get(url);
    if (successfulRun) {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(successfulRun),
      });
      return;
    }
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "JOB_DESCRIPTION_UNAVAILABLE",
          message: url === failedUrls[0] ? firstPublicFailure : laterPublicFailure,
        },
      }),
    });
  }));

  const alert = page.locator("#job-url-error");
  await expect(alert).toHaveText(expectedAlert);
  await expect(alert).not.toContainText(laterPublicFailure);
  expect((await alert.textContent())?.length).toBe(240);
  await expect(page).toHaveURL(/\/$/);
  await expect(input).toHaveValue(failedUrls.join(", "));
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAttribute("aria-describedby", "job-url-error");
  await expect(page.getByRole("button", { name: "Initialize" })).toBeEnabled();
  await expect(skipReview).toBeChecked();
  await expect(autoSubmit).toBeChecked();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  for (const run of successfulRuns.values()) {
    await expect(page.locator(`tbody a.application-link[href="/runs/${run.id}"]`)).toBeVisible();
  }
});


test("retains every canonical URL when a multi-URL initialization fails", async ({ page }) => {
  const expectedUrls = [
    "https://jobs.example.test/roles/first",
    "https://jobs.example.test/roles/second",
  ];
  const pendingPosts = new Map<string, Route>();
  const firstPublicFailure = "The first job posting could not be imported.";
  const laterPublicFailure = "The later failure must not replace the first.";
  const { promise: allPostsStarted, resolve: markAllPostsStarted } = Promise.withResolvers<void>();

  await page.route("**/api/pipeline/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
      return;
    }

    const body = request.postDataJSON() as {
      jobUrl: string;
      generateKeywordMap: boolean;
      skipReview: boolean;
      autoSubmit: boolean;
    };
    expect(body).toMatchObject({
      generateKeywordMap: true,
      skipReview: true,
      autoSubmit: false,
    });
    expect(body.generateKeywordMap).toBe(true);
    expect(expectedUrls).toContain(body.jobUrl);
    pendingPosts.set(body.jobUrl, route);
    if (pendingPosts.size === expectedUrls.length) markAllPostsStarted();
  });
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
  const input = initializer.getByRole("textbox", { name: "Job posting URLs" });
  const skipReview = initializer.getByRole("checkbox", { name: "Skip résumé review" });
  const autoSubmit = initializer.getByRole("checkbox", { name: "Auto-submit application" });
  await skipReview.check();
  await input.fill([
    "HTTPS://Jobs.Example.Test:443/roles/first#details,",
    "https://jobs.example.test/roles/second#apply",
  ].join(" "));
  await initializer.getByRole("button", { name: "Initialize" }).click();
  await allPostsStarted;

  await Promise.all([...pendingPosts].map(async ([url, route]) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "JOB_DESCRIPTION_UNAVAILABLE",
          message: url === expectedUrls[0] ? firstPublicFailure : laterPublicFailure,
        },
      }),
    });
  }));

  const alert = page.locator("#job-url-error");
  await expect(alert).toHaveText(`0 of 2 applications initialized. ${firstPublicFailure}`);
  await expect(alert).not.toContainText(laterPublicFailure);
  await expect(input).toHaveValue(expectedUrls.join(", "));
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(initializer.getByRole("button", { name: "Initialize" })).toBeEnabled();
  await expect(skipReview).toBeChecked();
  await expect(autoSubmit).not.toBeChecked();
  await expect(page.locator("tbody a.application-link")).toHaveCount(0);
});

test("disables a batch larger than the newest-run window", async ({ page }) => {
  let postCount = 0;
  await page.route("**/api/pipeline/runs", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
      return;
    }
    postCount += 1;
    await route.fulfill({ status: 500 });
  });
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
  await initializer.getByRole("textbox", { name: "Job posting URLs" }).fill(
    Array.from(
      { length: 101 },
      (_, index) => `https://jobs.example.test/roles/over-limit-${index + 1}`,
    ).join(" "),
  );

  await expect(initializer.getByRole("button", { name: "Initialize" })).toBeDisabled();
  expect(postCount).toBe(0);
});

test("retains the URL and independently selected run options after initialization failures", async ({ page }) => {
  const submittedUrl = "https://jobs.example.test/unavailable#details";
  const retryUrl = "https://jobs.example.test/another-role";
  let postCount = 0;
  await page.route("**/api/pipeline/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
      return;
    }

    expect(request.method()).toBe("POST");
    postCount += 1;
    expect(request.postDataJSON()).toEqual({
      jobUrl: postCount === 1 ? "https://jobs.example.test/unavailable" : retryUrl,
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: postCount === 2,
    });
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "JOB_DESCRIPTION_UNAVAILABLE",
          message: "The page does not contain a usable job description",
        },
      }),
    });
  });
  await page.goto("/");

  const input = page.getByRole("textbox", { name: "Job posting URLs" });
  const skipReview = page.getByRole("checkbox", { name: "Skip résumé review" });
  const autoSubmit = page.getByRole("checkbox", { name: "Auto-submit application" });
  await input.fill(submittedUrl);
  await page.getByRole("button", { name: "Initialize" }).click();

  const alert = page.locator("#job-url-error");
  await expect(alert).toHaveAttribute("id", "job-url-error");
  await expect(alert).toHaveText("The page does not contain a usable job description");
  await expect(input).toHaveValue(submittedUrl);
  await expect(input).toBeEnabled();
  await expect(skipReview).not.toBeChecked();
  await expect(autoSubmit).not.toBeChecked();
  await expect(skipReview).toBeEnabled();
  await expect(autoSubmit).toBeEnabled();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAttribute("aria-describedby", "job-url-error");
  await expect(page.getByRole("button", { name: "Initialize" })).toBeEnabled();

  await autoSubmit.check();
  await expect(alert).toHaveCount(0);
  await input.fill(retryUrl);
  await expect(input).toHaveValue(retryUrl);
  await expect(input).not.toHaveAttribute("aria-invalid");
  await expect(input).not.toHaveAttribute("aria-describedby");
  await expect(page.getByRole("button", { name: "Initialize" })).toBeEnabled();

  await page.getByRole("button", { name: "Initialize" }).click();
  await expect(alert).toHaveText("The page does not contain a usable job description");
  await expect(input).toHaveValue(retryUrl);
  await expect(input).toBeEnabled();
  await expect(skipReview).not.toBeChecked();
  await expect(autoSubmit).toBeChecked();
  await expect(skipReview).toBeEnabled();
  await expect(autoSubmit).toBeEnabled();
  await expect(page.getByRole("button", { name: "Initialize" })).toBeEnabled();
  expect(postCount).toBe(2);
});

test("shows the visible review and application workspace", async ({ page }) => {
  const detailRun: RunDto = {
    ...runFixture("visible-review-workspace", "applied", "failed"),
    revision: 3,
    failureCode: "compiling",
  };
  await interceptDocumentRun(page, detailRun);

  await page.goto("/runs/visible-review-workspace");

  const reviewPane = page.getByRole("complementary", {
    name: "Review and opportunity workspace",
  });
  await expect(reviewPane).toBeVisible();
  await expect(reviewPane.getByRole("heading")).toHaveText(["Displayed resume"]);
  await expect(
    reviewPane.getByText("No reviewed resume iteration is available yet.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry failed run" })).toHaveCount(1);
});

test("shows only waiting copy while analysis is active", async ({ page }) => {
  const detailRun = runFixture("analysis-wait", "pending", "analyzing");
  await interceptDocumentRun(page, detailRun);
  await page.goto("/runs/analysis-wait");

  await expect(page.locator("#resume-document-panel")).toHaveText("Waiting on analysis");
});
test("switches between accessible resume and landscape keyword map tabs", async ({ page }) => {
  const detailRun = documentViewerFixture("document-tabs", true);
  await interceptDocumentRun(page, detailRun);
  await page.setViewportSize({ width: 1_672, height: 941 });
  await page.goto("/runs/document-tabs");

  const viewer = page.getByRole("region", { name: "Document viewer" });
  const tablist = viewer.getByRole("tablist", { name: "Document views" });
  const tabs = tablist.getByRole("tab");
  const resumeTab = tablist.getByRole("tab", { name: "Resume" });
  const keywordMapTab = tablist.getByRole("tab", { name: "Keyword map" });
  const resumePanel = viewer.locator("#resume-document-panel");
  const keywordMapPanel = viewer.locator("#keyword-map-document-panel");

  await expect(tabs).toHaveCount(2);
  await expect(tabs).toHaveText(["Resume", "Keyword map"]);
  await expect(resumeTab).toHaveAttribute("aria-controls", "resume-document-panel");
  await expect(resumeTab).toHaveAttribute("aria-selected", "true");
  await expect(resumeTab).toHaveAttribute("tabindex", "0");
  await expect(keywordMapTab).toHaveAttribute("aria-controls", "keyword-map-document-panel");
  await expect(keywordMapTab).toHaveAttribute("aria-selected", "false");
  await expect(keywordMapTab).toHaveAttribute("tabindex", "-1");
  await expect(resumePanel).toHaveAttribute("role", "tabpanel");
  await expect(resumePanel).toHaveAttribute("aria-labelledby", "resume-document-tab");
  await expect(resumePanel).toBeVisible();
  await expect(keywordMapPanel).toBeHidden();
  await expect(viewer.getByText("Page 1 / 1", { exact: true })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Zoom in" })).toBeVisible();
  await expect(viewer.getByRole("link", { name: "Download selected PDF" })).toBeVisible();

  const [viewerBox, resumeTabBox, keywordMapTabBox, resumePanelBox] = await Promise.all([
    viewer.boundingBox(),
    resumeTab.boundingBox(),
    keywordMapTab.boundingBox(),
    resumePanel.boundingBox(),
  ]);
  if (!viewerBox || !resumeTabBox || !keywordMapTabBox || !resumePanelBox) {
    throw new Error("Document tab-strip geometry is unavailable");
  }
  expect(Math.abs(resumeTabBox.x - viewerBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(resumeTabBox.y - viewerBox.y)).toBeLessThanOrEqual(1);
  expect(Math.abs((resumeTabBox.y + resumeTabBox.height) - resumePanelBox.y)).toBeLessThanOrEqual(1);
  expect(resumeTabBox.height).toBe(51);
  expect(Math.abs(keywordMapTabBox.x - (resumeTabBox.x + resumeTabBox.width))).toBeLessThanOrEqual(1);

  await resumeTab.focus();
  await resumeTab.press("ArrowRight");

  await expect(resumeTab).toHaveAttribute("aria-selected", "false");
  await expect(resumeTab).toHaveAttribute("tabindex", "-1");
  await expect(keywordMapTab).toBeFocused();
  await expect(keywordMapTab).toHaveAttribute("aria-selected", "true");
  await expect(keywordMapTab).toHaveAttribute("tabindex", "0");
  await expect(resumePanel).toBeHidden();
  await expect(keywordMapPanel).toHaveAttribute("role", "tabpanel");
  await expect(keywordMapPanel).toHaveAttribute("aria-labelledby", "keyword-map-document-tab");
  await expect(keywordMapPanel).toBeVisible();
  await expect(viewer.getByText("Page 1 / 1", { exact: true })).toBeVisible();
  const keywordMapZoom = viewer.getByRole("spinbutton", { name: "Zoom percentage" });
  await expect(keywordMapZoom).toHaveValue("100");
  await expect(viewer.getByRole("button", { name: "Zoom in" })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Enter fullscreen" })).toBeVisible();

  const keywordMapDownload = viewer.getByRole("link", { name: "Download keyword map PDF" });
  await expect(keywordMapDownload).toHaveAttribute("href", "/api/pipeline/runs/document-tabs/iterations/4/artifacts/keyword-map-pdf");
  await expect(keywordMapDownload).toHaveAttribute("download", "");
  await expect(keywordMapPanel.locator("object")).toHaveCount(0);
  const keywordMapPage = keywordMapPanel.getByRole("img", { name: "Keyword map page 1" });
  await expect(keywordMapPage).toBeVisible();
  const keywordMapBox = await keywordMapPage.boundingBox();
  if (!keywordMapBox) throw new Error("Keyword map viewer geometry is unavailable");
  expect(keywordMapBox.width).toBeGreaterThan(keywordMapBox.height);
  const keywordMapPixels = await keywordMapPage.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
  expect(keywordMapPixels).toEqual({ width: 2_376, height: 1_836 });

  await viewer.getByRole("button", { name: "Zoom in" }).click();
  await expect(keywordMapZoom).toHaveValue("125");
  await keywordMapTab.press("Home");
  await expect(resumeTab).toBeFocused();
  await expect(resumePanel).toBeVisible();
});

test("enters and exits fullscreen from the resume toolbar", async ({ page }) => {
  const detailRun = documentViewerFixture("resume-fullscreen", false);
  await interceptDocumentRun(page, detailRun);
  await page.goto("/runs/resume-fullscreen");

  const viewer = page.getByRole("region", { name: "Document viewer" });
  await viewer.getByRole("button", { name: "Enter fullscreen" }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("aria-label") ?? null)).toBe("Document viewer");

  await viewer.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test("uses the same compact download control in both document views", async ({ page }) => {
  const detailRun = documentViewerFixture("matching-download-controls", true);
  await interceptDocumentRun(page, detailRun);
  await page.goto("/runs/matching-download-controls");

  const viewer = page.getByRole("region", { name: "Document viewer" });
  const resumeDownload = viewer.getByRole("link", { name: "Download selected PDF" });
  const resumeDownloadBox = await resumeDownload.boundingBox();
  if (!resumeDownloadBox) throw new Error("Resume download geometry is unavailable");

  await viewer.getByRole("tab", { name: "Keyword map" }).click();
  const keywordMapDownload = viewer.getByRole("link", { name: "Download keyword map PDF" });
  await expect(keywordMapDownload).toHaveText("");
  const keywordMapDownloadBox = await keywordMapDownload.boundingBox();
  if (!keywordMapDownloadBox) throw new Error("Keyword map download geometry is unavailable");
  expect(keywordMapDownloadBox.width).toBe(resumeDownloadBox.width);
  expect(keywordMapDownloadBox.height).toBe(resumeDownloadBox.height);
});

test("zooms resume pages to 300% with horizontal scrolling", async ({ page }) => {
  const detailRun = diffDocumentViewerFixture("resume-zoom");
  await interceptDocumentRun(page, detailRun, { [resumeDiffArtifactId]: resumeDiff });
  await page.setViewportSize({ width: 1_672, height: 941 });
  await page.goto("/runs/resume-zoom");

  const viewer = page.getByRole("region", { name: "Document viewer" });
  const resumePanel = viewer.getByRole("tabpanel", { name: "Resume" });
  const zoomIn = viewer.getByRole("button", { name: "Zoom in" });
  const zoomInput = viewer.getByRole("spinbutton", { name: "Zoom percentage" });

  await zoomIn.click();
  await expect(zoomInput).toHaveValue("125");
  await zoomIn.click();
  await expect(zoomInput).toHaveValue("150");
  await expect(zoomIn).toBeEnabled();

  for (const zoom of [175, 200, 225, 250, 275, 300]) {
    await zoomIn.click();
    await expect(zoomInput).toHaveValue(String(zoom));
  }
  await expect(zoomIn).toBeDisabled();
  const resumeImage = resumePanel.getByRole("img", { name: /Rendered resume page/ });
  const [panelBox, imageBox] = await Promise.all([
    resumePanel.boundingBox(),
    resumeImage.boundingBox(),
  ]);
  if (!panelBox || !imageBox) throw new Error("Zoomed resume geometry is unavailable");
  expect(imageBox.x).toBeGreaterThanOrEqual(panelBox.x);

  const overflow = await resumePanel.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
  await resumePanel.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => resumePanel.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
});

test("accepts a typed resume zoom percentage", async ({ page }) => {
  const detailRun = diffDocumentViewerFixture("typed-resume-zoom");
  await interceptDocumentRun(page, detailRun, { [resumeDiffArtifactId]: resumeDiff });
  await page.setViewportSize({ width: 1_672, height: 941 });
  await page.goto("/runs/typed-resume-zoom");

  const viewer = page.getByRole("region", { name: "Document viewer" });
  const resumeImage = viewer.getByRole("img", { name: /Rendered resume page/ });
  const defaultImageBox = await resumeImage.boundingBox();
  if (!defaultImageBox) throw new Error("Default resume geometry is unavailable");

  const zoomInput = viewer.getByRole("spinbutton", { name: "Zoom percentage" });
  await zoomInput.fill("237");
  await zoomInput.press("Enter");
  await expect(zoomInput).toHaveValue("237");
  const typedImageBox = await resumeImage.boundingBox();
  if (!typedImageBox) throw new Error("Typed zoom geometry is unavailable");
  expect(typedImageBox.width / defaultImageBox.width).toBeCloseTo(2.37, 1);
});

test("fills the resume document viewport at the default zoom", async ({ page }) => {
  const detailRun = diffDocumentViewerFixture("resume-default-fit");
  await interceptDocumentRun(page, detailRun, { [resumeDiffArtifactId]: resumeDiff });
  await page.setViewportSize({ width: 1_672, height: 941 });
  await page.goto("/runs/resume-default-fit");

  const viewer = page.getByRole("region", { name: "Document viewer" });
  const resumePanel = viewer.getByRole("tabpanel", { name: "Resume" });
  const resumeImage = resumePanel.getByRole("img", { name: /Rendered resume page/ });
  await expect(viewer.getByRole("spinbutton", { name: "Zoom percentage" })).toHaveValue("100");
  const [panelBox, imageBox] = await Promise.all([
    resumePanel.boundingBox(),
    resumeImage.boundingBox(),
  ]);
  if (!panelBox || !imageBox) throw new Error("Default resume geometry is unavailable");
  expect(imageBox.width / panelBox.width).toBeGreaterThan(0.9);
  expect(imageBox.width).toBeLessThanOrEqual(panelBox.width);
});

test("shows the canonical and current resumes in an accessible diff tab", async ({ page }) => {
  const detailRun = diffDocumentViewerFixture("resume-diff");
  await interceptDocumentRun(page, detailRun, { [resumeDiffArtifactId]: resumeDiff });
  await page.goto("/runs/resume-diff");

  const viewer = page.getByRole("region", { name: "Document viewer" });
  const tablist = viewer.getByRole("tablist", { name: "Document views" });
  const tabs = tablist.getByRole("tab");
  const resumeTab = tablist.getByRole("tab", { name: "Resume" });
  const keywordMapTab = tablist.getByRole("tab", { name: "Keyword map" });
  const diffTab = tablist.getByRole("tab", { name: "Diff" });
  const diffPanel = viewer.locator("#resume-diff-document-panel");

  await expect(tabs).toHaveText(["Resume", "Keyword map", "Diff"]);
  await expect(diffTab).toHaveAttribute("aria-controls", "resume-diff-document-panel");
  await resumeTab.focus();
  await resumeTab.press("End");
  await expect(diffTab).toBeFocused();
  await expect(diffTab).toHaveAttribute("aria-selected", "true");
  await expect(diffPanel).toHaveAttribute("role", "tabpanel");
  await expect(diffPanel).toHaveAttribute("aria-labelledby", "resume-diff-document-tab");
  await expect(diffPanel).toBeVisible();

  const comparison = diffPanel.getByRole("table", { name: "Canonical and current resume comparison" });
  await expect(comparison.getByRole("columnheader")).toHaveText(["BEFORE", "AFTER"]);
  await expect(comparison.getByText("Owned reliable deployment services.", { exact: true })).toHaveCount(2);
  await expect(comparison.locator("del")).toHaveText([
    "Built typed deployment services.",
    "Maintained a retired internal tool.",
  ]);
  await expect(comparison.locator("mark")).toHaveText([
    "Built Production TypeScript deployment services.",
    "Added zero-downtime delivery checks.",
  ]);

  await diffTab.press("ArrowRight");
  await expect(resumeTab).toBeFocused();
  await resumeTab.press("ArrowLeft");
  await expect(diffTab).toBeFocused();
  await diffTab.press("Home");
  await expect(resumeTab).toBeFocused();
  await resumeTab.press("ArrowRight");
  await expect(keywordMapTab).toBeFocused();
});

test("shows only the Resume tab when the revision has no keyword map", async ({ page }) => {
  const detailRun = documentViewerFixture("resume-only", false);
  await interceptDocumentRun(page, detailRun);
  await page.goto("/runs/resume-only");

  const viewer = page.getByRole("region", { name: "Document viewer" });
  const tablist = viewer.getByRole("tablist", { name: "Document views" });
  const resumeTab = tablist.getByRole("tab", { name: "Resume" });

  await expect(tablist.getByRole("tab")).toHaveCount(1);
  await expect(resumeTab).toHaveAttribute("aria-selected", "true");
  await expect(viewer.getByRole("tab", { name: "Keyword map" })).toHaveCount(0);
  await expect(viewer.locator("#keyword-map-document-panel")).toHaveCount(0);
  await expect(viewer.locator("#resume-document-panel")).toBeVisible();
  await expect(viewer.getByRole("link", { name: "Download selected PDF" })).toBeVisible();
});


test("filters by selectable application state and keeps stored Failed display-only", async ({ page }) => {
  await interceptRuns(page);
  await page.goto("/");

  const state = page.getByRole("combobox", { name: "Filter applications by state" });
  await expect(state.locator("option")).toHaveText([
    "All states",
    "Pending",
    "Applied",
    "Rejected",
    "Interview",
    "Accepted",
  ]);
  await expect(state.locator('option[value="failed"]')).toHaveCount(0);

  await state.selectOption("interview");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator('tbody a.application-link[href="/runs/lifecycle-interview"]')).toBeVisible();

  await state.selectOption("all");
  const failedState = page.getByRole("combobox", { name: "Application state for lifecycl…iled" });
  await expect(failedState).toHaveValue("failed");
  await expect(failedState.locator('option[value="failed"]')).toBeDisabled();
});

test("lets the user change application state", async ({ page }) => {
  await interceptRuns(page);
  let requestBody: string | null = null;
  await page.route("**/api/pipeline/runs/lifecycle-applied", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    requestBody = route.request().postData();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...lifecycleRuns[0],
        applicationStatus: "interview",
        updatedAt: 1_700_000_001_000,
      }),
    });
  });
  await page.goto("/");

  const applicationState = page.getByRole("combobox", {
    name: "Application state for lifecycl…lied",
  });
  await expect(applicationState).toHaveValue("applied");

  await applicationState.selectOption("interview");

  expect(requestBody).toBe('{\"applicationStatus\":\"interview\"}');
  await expect(applicationState).toHaveValue("interview");
  await expect(applicationState).toBeEnabled();
});

test("retains application state when an update fails", async ({ page }) => {
  await interceptRuns(page);
  await page.route("**/api/pipeline/runs/lifecycle-applied", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "RUN_CONFLICT", message: "The application status changed." },
      }),
    });
  });
  await page.goto("/");

  const applicationState = page.getByRole("combobox", {
    name: "Application state for lifecycl…lied",
  });
  await expect(applicationState).toHaveValue("applied");

  await applicationState.selectOption("interview");

  await expect(applicationState).toHaveValue("applied");
  await expect(applicationState).toBeEnabled();
  await expect(page.getByRole("alert", { name: "Application state update error" })).toContainText("Application state could not be updated. Try again.");
});

test("shows application lifecycle and pipeline progress separately without legacy metadata", async ({ page }) => {
  const detailRun = runFixture("lifecycle-detail", "rejected", "review");
  await interceptDocumentRun(page, detailRun);
  await page.goto("/runs/lifecycle-detail");

  const applicationSummary = page.getByRole("complementary", { name: "Application summary and keyword comparison" });
  const workflow = page.getByRole("list", { name: "Workflow progress" });

  await expect(applicationSummary.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(workflow.getByRole("listitem").filter({ hasText: "Review" })).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("complementary", { name: "Run metadata and history" })).toHaveCount(0);
  await expect(page.getByText("Pipeline status", { exact: true })).toHaveCount(0);
});

test("removes primary navigation and gives run details the full viewport", async ({ page }) => {
  const detailRun = runFixture("lifecycle-detail", "rejected", "failed");
  await interceptDocumentRun(page, detailRun);

  for (const width of [1_672, 320]) {
    await page.setViewportSize({ width, height: 941 });
    await page.goto("/runs/lifecycle-detail");

    await expectFullViewportRunDetail(page, width);
  }
});

test("hides internal run and attempt metadata from the viewer", async ({ page }) => {
  const detailRun: RunDto = {
    ...runFixture("run-id-must-be-hidden", "rejected", "failed"),
    revision: 3,
    failureCode: "compiling",
    attempts: [
      {
        id: "attempt-id-must-be-hidden",
        stage: "compile",
        revision: 3,
        attempt: 2,
        state: "failed",
        toolCalls: 7,
        compileCalls: 3,
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_000,
        outcome: "compile failed",
      },
    ],
    timeline: [
      {
        id: 1,
        type: "run.failed",
        status: "failed",
        revision: 3,
        at: 1_700_000_001_000,
        detail: {
          runId: "run-id-must-be-hidden",
          reason: "compile failed",
        },
      },
      {
        id: 2,
        type: "attempt.finished",
        status: "failed",
        revision: 3,
        at: 1_700_000_001_001,
        detail: {
          attemptId: "attempt-id-must-be-hidden",
          toolCount: 7,
          compileCount: 3,
        },
      },
    ],
  };
  await interceptDocumentRun(page, detailRun);

  await page.goto("/runs/run-id-must-be-hidden");
  await expect(page.getByRole("complementary", { name: "Application summary and keyword comparison" })).toBeVisible();
  await expect(page.getByText("Application details", { exact: true })).toHaveCount(0);

  await expect(page.getByText("run-id-must-be-hidden", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Run ID", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Attempt totals", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Tool calls", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Compile calls", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Compile · attempt 2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Attempt.Finished", { exact: true })).toHaveCount(0);
  await expect(page.getByText("attempt-id-must-be-hidden", { exact: false })).toHaveCount(0);
  await expect(page.getByText("ToolCount", { exact: true })).toHaveCount(0);
  await expect(page.getByText("CompileCount", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Current document", { exact: true })).toHaveCount(0);
  await expect(page.getByText("resume-revision-3.pdf", { exact: true })).toHaveCount(0);
});

test("uses the simplified opened-run header workflow layout", async ({ page }) => {
  const detailRun: RunDto = {
    ...runFixture("workflow-visual", "applied", "failed"),
    revision: 3,
    failureCode: "compiling",
    attempts: [
      {
        id: "compile-attempt",
        stage: "compile",
        revision: 3,
        attempt: 1,
        state: "failed",
        toolCalls: 0,
        compileCalls: 1,
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_000,
      },
    ],
  };
  await interceptDocumentRun(page, detailRun);

  await page.goto("/runs/workflow-visual");

  const pageHeader = page.getByRole("main").locator(":scope > header");
  await expect(pageHeader.getByRole("link", { name: "Back to opportunities" })).toBeVisible();

  const workflow = pageHeader.getByRole("list");
  const stages = workflow.getByRole("listitem");
  await expect(stages).toHaveText([
    /Analysis$/,
    /Tailoring$/,
    /Editing$/,
    /Compile$/,
    /Deterministic QA$/,
    /Visual QA$/,
    /Review$/,
    /Applying$/,
    /Applied$/,
  ]);

  await expect(page.getByText(/Workflow stage · revision 3/)).toBeHidden();
  await expect(
    pageHeader
      .getByRole("link", { name: "Download resume" })
      .or(pageHeader.getByRole("button", { name: "Download resume" })),
  ).toHaveCount(0);
  await expect(pageHeader.getByRole("button", { name: "More run actions" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Run timeline" })).toHaveCount(0);

  const completed = await stages.nth(2).evaluate((element) => {
    const marker = element.firstElementChild;
    if (!marker) throw new Error("Completed stage marker is missing");
    const connectorStyle = getComputedStyle(element, "::after");
    const markerStyle = getComputedStyle(marker);
    return {
      connectorColor: connectorStyle.backgroundColor,
      connectorHeight: connectorStyle.height,
      markerBackground: markerStyle.backgroundColor,
      markerBorder: markerStyle.borderColor,
    };
  });
  expect(completed).toEqual({
    connectorColor: "rgb(134, 215, 157)",
    connectorHeight: "4px",
    markerBackground: "rgb(134, 215, 157)",
    markerBorder: "rgb(134, 215, 157)",
  });

  const reviewLineDelta = await stages.evaluateAll((elements) => {
    const visualQa = elements[5];
    const reviewMarker = elements[6]?.firstElementChild;
    if (!visualQa || !reviewMarker) throw new Error("Review connector geometry is unavailable");
    const visualQaBox = visualQa.getBoundingClientRect();
    const connectorStyle = getComputedStyle(visualQa, "::after");
    const reviewMarkerBox = reviewMarker.getBoundingClientRect();
    const connectorEnd = visualQaBox.left
      + Number.parseFloat(connectorStyle.left)
      + Number.parseFloat(connectorStyle.width);
    const reviewCenter = reviewMarkerBox.left + reviewMarkerBox.width / 2;
    return Math.abs(connectorEnd - reviewCenter);
  });
  expect(reviewLineDelta).toBeLessThanOrEqual(1);
});


test("keeps dashboard snapshots visible while revalidating between Applications and Providers", async ({ page }) => {
  const stableRuns = Array.from(
    { length: 7 },
    (_, index) => runFixture(`stable-${index}`, "applied", "approved"),
  );
  let holdRunRefresh = false;
  let holdAuthRefresh = false;
  let releaseRunRefresh = () => {};
  let releaseAuthRefresh = () => {};
  let markRunRefreshStarted = () => {};
  let markAuthRefreshStarted = () => {};
  let markRunRefreshCompleted = () => {};
  let markAuthRefreshCompleted = () => {};
  const runRefreshRelease = new Promise<void>((resolve) => {
    releaseRunRefresh = resolve;
  });
  const authRefreshRelease = new Promise<void>((resolve) => {
    releaseAuthRefresh = resolve;
  });
  const runRefreshStarted = new Promise<void>((resolve) => {
    markRunRefreshStarted = resolve;
  });
  const authRefreshStarted = new Promise<void>((resolve) => {
    markAuthRefreshStarted = resolve;
  });
  const runRefreshCompleted = new Promise<void>((resolve) => {
    markRunRefreshCompleted = resolve;
  });
  const authRefreshCompleted = new Promise<void>((resolve) => {
    markAuthRefreshCompleted = resolve;
  });

  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    const shouldHold = holdRunRefresh;
    if (shouldHold) {
      markRunRefreshStarted();
      await runRefreshRelease;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: stableRuns }),
    });
    if (shouldHold) markRunRefreshCompleted();
  });
  await page.route("**/api/pipeline/auth", async (route) => {
    expect(route.request().method()).toBe("GET");
    const shouldHold = holdAuthRefresh;
    if (shouldHold) {
      markAuthRefreshStarted();
      await authRefreshRelease;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          { provider: "openai-codex", state: "connected", identity: { email: "codex@example.com" } },
          { provider: "indeed", state: "disconnected" },
        ],
      }),
    });
    if (shouldHold) markAuthRefreshCompleted();
  });
  await page.goto("/");

  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  const applicationCount = page.getByRole("region", { name: "Application count" }).locator("p").first();
  await expect(primaryNavigation.getByRole("link")).toHaveText(["Applications", "Discovery", "Events", "Providers"]);
  await expect(applicationCount).toHaveText("7");

  await primaryNavigation.getByRole("link", { name: "Providers" }).click();
  await expect(page).toHaveURL(/\/providers$/);
  const providerBadges = page.locator(".status-badge");
  await expect(providerBadges).toHaveText(["connected", "disconnected"]);
  await expect(page.locator(".provider-row")).toHaveCount(2);
  await expect(page.getByText("Google Antigravity", { exact: true })).toHaveCount(0);

  holdRunRefresh = true;
  await primaryNavigation.getByRole("link", { name: "Applications" }).click();
  await runRefreshStarted;
  await expect(applicationCount).toHaveText("7");
  await expect(page.getByText("Loading applications…")).toHaveCount(0);
  releaseRunRefresh();
  await runRefreshCompleted;

  holdAuthRefresh = true;
  await primaryNavigation.getByRole("link", { name: "Providers" }).click();
  await authRefreshStarted;
  await expect(providerBadges).toHaveText(["connected", "disconnected"]);
  await expect(providerBadges.filter({ hasText: "Checking" })).toHaveCount(0);
  releaseAuthRefresh();
  await authRefreshCompleted;
});

test("uses full-width physical folder tabs at desktop and narrow widths", async ({ page }) => {
  await interceptRuns(page);

  for (const width of [1_672, 320]) {
    await page.setViewportSize({ width, height: 941 });
    await page.goto("/");

    await expectFolderNavigation(page, width, "Applications");
    const shellWorkspaceBox = await page.locator(".app-shell__workspace").boundingBox();
    const workspaceBox = await page.locator(".workspace").boundingBox();
    if (!shellWorkspaceBox || !workspaceBox) {
      throw new Error("Application workspace geometry is unavailable");
    }
    expect(shellWorkspaceBox).toMatchObject({ x: 0, y: 64, width });
    expect(workspaceBox).toMatchObject({ x: 0, width });
    await expect(page.getByText("Resume tailoring", { exact: true })).toHaveCount(0);
    await expectNoDocumentOverflow(page);
  }

  await page.goto("/events/upcoming");
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "Events" }),
  ).toHaveAttribute("aria-current", "page");

  await page.goto("/providers/settings");
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "Providers" }),
  ).toHaveAttribute("aria-current", "page");
});

test("uses folder navigation and local scrollers on narrow displays", async ({ page }) => {
  test.setTimeout(60_000);
  await interceptRuns(page);
  const detailRun = runFixture("lifecycle-detail", "rejected", "failed");
  await interceptDocumentRun(page, detailRun);
  await page.route("**/api/pipeline/auth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          { provider: "openai-codex", state: "disconnected" },
          { provider: "indeed", state: "connected", identity: { email: "indeed@example.com" } },
        ],
      }),
    });
  });

  for (const width of [768, 375, 320, 300, 280]) {
    await page.setViewportSize({ width, height: 900 });

    await page.goto("/");
    await expectFolderNavigation(page, width, "Applications");
    await expectNoDocumentOverflow(page);
    const tableScroller = page.locator(".applications-table-scroll");
    expect(await tableScroller.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    expect(await tableScroller.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
      await tableScroller.evaluate((element) => element.clientWidth),
    );

    await page.goto("/providers");
    await expectFolderNavigation(page, width, "Providers");
    await expectNoDocumentOverflow(page);
    const providerRows = page.locator(".provider-row");
    await expect(providerRows).toHaveCount(2);
    await expect(providerRows).toContainText(["OpenAI Codex", "Indeed Jobs"]);
    await expect(providerRows.locator(".status-badge")).toHaveText(["disconnected", "connected"]);
    await expect(providerRows.nth(0).getByRole("button", { name: "Connect OpenAI Codex" })).toBeEnabled();
    await expect(providerRows.nth(1).getByRole("button", { name: "Logout Indeed Jobs" })).toBeEnabled();
    for (const providerRow of await providerRows.all()) {
      expect(await providerRow.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/))).toHaveLength(1);
      const providerRowBox = await providerRow.boundingBox();
      const providerWorkspaceBox = await page.locator(".workspace").boundingBox();
      if (!providerRowBox || !providerWorkspaceBox) throw new Error("Provider layout geometry is unavailable");
      expect(providerRowBox.x + providerRowBox.width).toBeLessThanOrEqual(providerWorkspaceBox.x + providerWorkspaceBox.width);
    }

    await page.goto("/runs/lifecycle-detail");
    await expectFullViewportRunDetail(page, width);
    const stageList = page.locator('[class*="stageList"]').first();
    const viewerCanvas = page.locator('[class*="viewerCanvas"]').first();
    expect(await stageList.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    expect(await viewerCanvas.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    if (width <= 320) {
      const viewerControls = page.locator('[class*="viewerControls"]').first();
      expect(await viewerControls.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    }
  }
});

test("uses the original dark palette across surfaces and states", async ({ page }) => {
  const expectedColors = {
    white: "#fff",
    "--color-canvas": "#050606",
    "--color-surface": "#090b0b",
    "--color-surface-raised": "#111413",
    "--color-surface-hover": "#171b1a",
    "--color-border": "#252a28",
    "--color-border-strong": "#4b5450",
    "--color-text": "#eef1ec",
    "--color-muted": "#a4ada7",
    "--color-faint": "#757e79",
    "--color-accent": "#d2f34c",
    "--color-accent-hover": "#e1ff68",
    "--color-good": "#86d79d",
    "--color-info": "#83c6ef",
    "--color-warning": "#ebca73",
    "--color-danger": "#ef8a82",
    "--color-focus": "#d2f34c",
    "--color-application-applied": "#c2a7ef",
    "--color-application-rejected": "#e8ad73",
    "--color-application-interview": "#79cae8",
    "--color-application-accepted": "#79cf92",
    "--color-application-failed": "#ef8179",
  } as const;
  const { white: expectedStatusText, ...expectedRootColors } = expectedColors;
  await page.setViewportSize({ width: 1_672, height: 941 });
  await interceptRuns(page);
  await page.goto("/");
  await expect(page.locator(".application-status-control")).toHaveCount(5);

  const rootStyle = await page.evaluate((tokens) => {
    const style = getComputedStyle(document.documentElement);
    return {
      colorScheme: style.colorScheme,
      tokens: Object.fromEntries(tokens.map((token) => [token, style.getPropertyValue(token).trim()])),
    };
  }, Object.keys(expectedRootColors));
  expect(rootStyle.colorScheme).toBe("dark");
  expect(rootStyle.tokens).toEqual(expectedRootColors);

  expect(await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(cssRgb(expectedColors["--color-canvas"]));
  expect(await page.locator(".app-navigation").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(cssRgb(expectedColors["--color-surface"]));
  const applicationsLink = page.getByRole("link", { name: "Applications" });
  expect(await applicationsLink.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(cssRgb(expectedColors["--color-canvas"]));
  expect(await page.locator(".search-control").evaluate((element) => getComputedStyle(element).borderColor)).toBe(cssRgb(expectedColors["--color-border-strong"]));

  await applicationsLink.focus();
  expect(await applicationsLink.evaluate((element) => getComputedStyle(element).outlineColor)).toBe(cssRgb(expectedColors["--color-focus"]));

  for (const status of ["applied", "rejected", "interview", "accepted", "failed"] as const) {
    const token = `--color-application-${status}` as keyof typeof expectedColors;
    const control = page.locator(`.application-status-control--${status}`);
    const style = await control.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        statusColor: computed.getPropertyValue("--application-status-color").trim(),
        color: computed.color,
        borderColor: computed.borderColor,
        backgroundColor: computed.backgroundColor,
      };
    });
    expect(style).toEqual({
      statusColor: expectedColors[token],
      color: cssRgb(expectedStatusText),
      borderColor: cssRgb(expectedColors[token]),
      backgroundColor: cssRgb(expectedColors["--color-surface"]),
    });
  }

  const foregroundTokens = [
    "--color-text",
    "--color-muted",
    "--color-faint",
    "--color-accent",
    "--color-accent-hover",
    "--color-good",
    "--color-info",
    "--color-warning",
    "--color-danger",
    "--color-focus",
    "--color-application-applied",
    "--color-application-rejected",
    "--color-application-interview",
    "--color-application-accepted",
    "--color-application-failed",
  ] as const;
  for (const token of foregroundTokens) {
    expect(contrastRatio(expectedColors[token], expectedColors["--color-canvas"])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(expectedColors[token], expectedColors["--color-surface"])).toBeGreaterThanOrEqual(4.5);
  }
});

test("uses route-workspace breakpoints for detail panes", async ({ page }) => {
  const detailRun = runFixture("lifecycle-detail", "rejected", "failed");
  await interceptDocumentRun(page, detailRun);

  await page.setViewportSize({ width: 1_672, height: 941 });
  await page.goto("/runs/lifecycle-detail");
  const wideGeometry = await page.locator(".app-shell__workspace").evaluate((workspace) => ({
    width: workspace.getBoundingClientRect().width,
    rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(wideGeometry.width / wideGeometry.rootFontSize).toBeGreaterThan(78);
  expect(await page.locator('[class*="paneGrid"]').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/))).toHaveLength(3);

  await page.setViewportSize({ width: 1_248, height: 941 });
  await page.goto("/runs/lifecycle-detail");
  const narrowGeometry = await page.locator(".app-shell__workspace").evaluate((workspace) => ({
    width: workspace.getBoundingClientRect().width,
    rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(narrowGeometry.width / narrowGeometry.rootFontSize).toBeLessThanOrEqual(78);
  expect(await page.locator('[class*="paneGrid"]').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/))).toHaveLength(1);
});
