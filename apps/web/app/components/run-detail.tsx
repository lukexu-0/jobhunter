"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import {
  ResumeDiffSchema,
  type ArtifactDto,
  type ApplicationSessionView,
  type ArtifactKind,
  type AttemptDto,
  type ResumeDiff,
  type ResumeIterationDto,
  type ResumeIterationListResponse,
  type RunDto,
  type RunStatus,
} from "@jobhunter/pipeline/contracts";
import {
  PipelineClientError,
  approveRun,
  editRun,
  artifactHref,
  getRun,
  listResumeIterations,
  readJsonArtifact,
  retryRun,
} from "../lib/pipeline-client";
import { APPLICATION_STATUS_LABELS } from "../lib/application-status";
import {
  reconcileResumeIterationSelection,
  selectResolvedArtifact,
  type ResumeIterationSelection,
} from "../lib/run-detail-artifacts";
import { RunReviewWorkspace } from "./run-review-workspace";
import styles from "../run-detail.module.css";

const POLL_INTERVAL_MS = 2_500;
const MAX_PUBLIC_MESSAGE_LENGTH = 240;
const KEYWORD_MAP_RENDER_SCALE = 3;
const TERMINAL_STATUSES: Partial<Record<RunStatus, true>> = { review: true, approved: true, failed: true };
const REVIEW_STATUSES: Partial<Record<RunStatus, true>> = { review: true, approved: true };

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  analyzing: "Analyzing job",
  tailoring: "Tailoring resume",
  editing: "Applying edits",
  compiling: "Compiling PDF",
  repairing: "Compiling PDF",
  deterministic_qa: "Deterministic QA",
  visual_qa: "Visual QA",
  review: "Ready for review",
  approved: "Approved",
  failed: "Failed",
};

type WorkflowStageKey = RunStatus | "applying" | "applied";

const WORKFLOW_STAGES = [
  { key: "analyzing", label: "Analysis" },
  { key: "tailoring", label: "Tailoring" },
  { key: "editing", label: "Editing" },
  { key: "compiling", label: "Compile" },
  { key: "deterministic_qa", label: "Deterministic QA" },
  { key: "visual_qa", label: "Visual QA" },
  { key: "review", label: "Review" },
  { key: "applying", label: "Applying" },
  { key: "applied", label: "Applied" },
] as const satisfies ReadonlyArray<{ key: WorkflowStageKey; label: string }>;

const VERIFIED_APPLICATION_STATUSES: Partial<Record<RunDto["applicationStatus"], true>> = {
  applied: true,
  rejected: true,
  interview: true,
  accepted: true,
};

const ATTEMPT_TO_STATUS: Record<AttemptDto["stage"], RunStatus> = {
  analysis: "analyzing",
  tailoring: "tailoring",
  edit: "editing",
  compile: "compiling",
  repair: "compiling",
  "deterministic-qa": "deterministic_qa",
  "visual-qa": "visual_qa",
};

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});


type JsonRecord = Record<string, unknown>;
type BusyAction = "retry" | "edit" | "approve";
type DocumentView = "resume" | "keyword-map" | "diff";

const RESUME_TAB_ID = "resume-document-tab";
const RESUME_PANEL_ID = "resume-document-panel";
const KEYWORD_MAP_TAB_ID = "keyword-map-document-tab";
const KEYWORD_MAP_PANEL_ID = "keyword-map-document-panel";
const DIFF_TAB_ID = "resume-diff-document-tab";
const DIFF_PANEL_ID = "resume-diff-document-panel";

interface RunDetailProps {
  readonly runId: string;
}

interface JobIdentity {
  readonly title: string;
  readonly organization?: string;
}

interface OverlayRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

function Icon({ name }: { readonly name: "arrow-left" | "check" | "download" | "fullscreen" | "minus" | "plus" | "refresh" }) {
  const paths: Record<typeof name, ReactNode> = {
    "arrow-left": <path d="m15 18-6-6 6-6M9 12h10" />,
    check: <path d="m5 12 4 4L19 6" />,
    download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />,
    fullscreen: <path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5" />,
    minus: <path d="M5 12h14" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  };

  return (
    <svg aria-hidden="true" className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonRecord => item !== null) : [];
}

function stringValue(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}




function formatDate(timestamp: number): string {
  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}



function publicMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PipelineClientError)) return fallback;
  return error.message.trim().slice(0, MAX_PUBLIC_MESSAGE_LENGTH) || fallback;
}


function selectedPdfArtifact(iteration: ResumeIterationDto | undefined): ArtifactDto | undefined {
  if (!iteration) return undefined;
  return iteration.artifacts.find(
    (artifact) => artifact.public
      && artifact.kind === "compiled-pdf"
      && artifact.sha256 === iteration.pdfSha256,
  );
}

function selectedPageImage(iteration: ResumeIterationDto | undefined): ArtifactDto | undefined {
  return iteration
    ? selectResolvedArtifact(iteration.artifacts, "page-image")
    : undefined;
}

function safeArtifactHref(artifact: ArtifactDto | undefined): string | null {
  if (!artifact) return null;
  try {
    return artifactHref(artifact.href);
  } catch {
    return null;
  }
}

function isDisplayedJsonArtifact(artifact: ArtifactDto): boolean {
  return artifact.public
    && artifact.mediaType.toLowerCase().startsWith("application/json")
    && (
      artifact.kind === "job-analysis"
      || artifact.kind === "ats-keyword-extraction"
      || artifact.kind === "resume-diff"
      || artifact.kind === "visual-qa"
    );
}

function parseJobIdentity(value: unknown): JobIdentity | null {
  const analysis = asRecord(value);
  if (analysis?.schemaVersion !== 2) return null;
  const target = asRecord(analysis.target);
  const title = stringValue(target, "title");
  if (!title) return null;
  const organization = stringValue(target, "organization");
  return organization ? { title, organization } : { title };
}

function activeWorkflowIndex(
  run: RunDto,
  applicationView: ApplicationSessionView | null,
): number {
  if (run.status === "failed") {
    const lastAttempt = [...run.attempts].sort((left, right) => right.startedAt - left.startedAt)[0];
    return lastAttempt
      ? WORKFLOW_STAGES.findIndex((stage) => stage.key === ATTEMPT_TO_STATUS[lastAttempt.stage])
      : -1;
  }
  if (run.status === "approved") {
    const durableSubmissionVerified = applicationView !== null
      && !("state" in applicationView)
      && applicationView.submissionPhase === "submitted";
    return VERIFIED_APPLICATION_STATUSES[run.applicationStatus] || durableSubmissionVerified
      ? WORKFLOW_STAGES.length
      : WORKFLOW_STAGES.findIndex((stage) => stage.key === "applying");
  }
  const visibleStatus = run.status === "repairing" ? "compiling" : run.status;
  return WORKFLOW_STAGES.findIndex((stage) => stage.key === visibleStatus);
}


function overlayRect(value: unknown): OverlayRect | null {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
  const [topRaw, leftRaw, bottomRaw, rightRaw] = value as [number, number, number, number];
  const maximum = Math.max(...value.map((item) => Math.abs(item as number)));
  const multiplier = maximum <= 1 ? 100 : maximum <= 100 ? 1 : 0.1;
  const top = topRaw * multiplier;
  const left = leftRaw * multiplier;
  const bottom = bottomRaw * multiplier;
  const right = rightRaw * multiplier;
  if (top < 0 || left < 0 || bottom <= top || right <= left || bottom > 100 || right > 100) return null;
  return { top, left, width: right - left, height: bottom - top };
}


function EmptyArtifact({ label }: { readonly label: string }) {
  return <p className={styles.absent}>No {label} artifact is available for this revision.</p>;
}


function ArtifactState({ artifact, error, loading, label, children }: {
  readonly artifact: ArtifactDto | undefined;
  readonly error?: string;
  readonly loading: boolean;
  readonly label: string;
  readonly children: ReactNode;
}) {
  if (!artifact) return <EmptyArtifact label={label} />;
  if (loading) return <p className={styles.absent}>Loading {label}…</p>;
  if (error) return <p className={styles.panelError}>{error}</p>;
  return <>{children}</>;
}






interface AnalysisContentProps {
  readonly value: unknown;
  readonly extraction?: unknown;
  readonly extractionAvailable?: boolean;
}

interface KeywordPhrase {
  readonly id: string;
  readonly phrase: string;
}

function keywordPhrases(value: unknown): KeywordPhrase[] {
  if (!Array.isArray(value)) return [];
  const keywords: KeywordPhrase[] = [];
  for (const candidate of value) {
    const keyword = asRecord(candidate);
    const id = stringValue(keyword, "id");
    const phrase = stringValue(keyword, "phrase");
    if (id && phrase) keywords.push({ id, phrase });
  }
  return keywords;
}

export function AnalysisContent({
  value,
  extraction,
  extractionAvailable = false,
}: AnalysisContentProps) {
  const analysis = asRecord(value);
  if (analysis?.schemaVersion !== 2) {
    return (
      <p className={styles.panelError}>
        Unsupported legacy job-analysis artifact. This view requires schemaVersion 2.
      </p>
    );
  }

  const included = keywordPhrases(analysis.jdKeywords);
  const includedIds = new Set(included.map((keyword) => keyword.id));
  const extractionRecord = asRecord(extraction);
  const hasExtraction = extractionAvailable
    && extractionRecord?.schemaVersion === 1
    && Array.isArray(extractionRecord.keywords);
  const notIncluded = hasExtraction
    ? keywordPhrases(extractionRecord.keywords).filter((keyword) => !includedIds.has(keyword.id))
    : [];

  return (
    <div className={styles.keywordComparison}>
      <section
        aria-labelledby="keywords-included-heading"
        className={styles.keywordBox}
      >
        <h2 id="keywords-included-heading">Keywords included</h2>
        {included.length > 0 ? (
          <ul className={styles.keywordPhraseList}>
            {included.map((keyword) => <li key={keyword.id}>{keyword.phrase}</li>)}
          </ul>
        ) : (
          <p className={styles.keywordEmpty}>No keywords are included.</p>
        )}
      </section>

      <section
        aria-labelledby="keywords-not-included-heading"
        className={styles.keywordBox}
      >
        <h2 id="keywords-not-included-heading">Keywords not included</h2>
        {!hasExtraction ? (
          <p className={styles.keywordEmpty}>Keyword extraction is unavailable.</p>
        ) : notIncluded.length > 0 ? (
          <ul className={styles.keywordPhraseList}>
            {notIncluded.map((keyword) => <li key={keyword.id}>{keyword.phrase}</li>)}
          </ul>
        ) : (
          <p className={styles.keywordEmpty}>All extracted keywords are included.</p>
        )}
      </section>
    </div>
  );
}

export function ResumeDiffContent({ diff }: { readonly diff: ResumeDiff }) {
  return (
    <table className={styles.diffTable} aria-label="Canonical and current resume comparison">
      <thead>
        <tr>
          <th scope="col">BEFORE</th>
          <th scope="col">AFTER</th>
        </tr>
      </thead>
      {diff.sections.map((section) => (
        <tbody key={section.id}>
          <tr className={styles.diffSection}>
            <th colSpan={2} scope="rowgroup">{section.label}</th>
          </tr>
          {section.groups.map((group) => (
            <Fragment key={group.id}>
              <tr className={styles.diffGroup}>
                <th colSpan={2} scope="rowgroup">{group.label}</th>
              </tr>
              {group.rows.map((row) => (
                <tr className={`${styles.diffRow} ${styles[`diffRow--${row.change}`]}`} key={row.id}>
                  <td>
                    {row.before === null ? (
                      <span className={styles.diffBlank} aria-label="No canonical line">—</span>
                    ) : row.change === "unchanged" ? (
                      <span>{row.before}</span>
                    ) : (
                      <del>{row.before}</del>
                    )}
                  </td>
                  <td>
                    {row.after === null ? (
                      <span className={styles.diffBlank} aria-label="No current line">—</span>
                    ) : row.change === "unchanged" ? (
                      <span>{row.after}</span>
                    ) : (
                      <mark>{row.after}</mark>
                    )}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      ))}
    </table>
  );
}


function WorkflowProgress({
  applicationView,
  run,
}: {
  readonly applicationView: ApplicationSessionView | null;
  readonly run: RunDto;
}) {
  const activeIndex = activeWorkflowIndex(run, applicationView);
  return (
    <ol className={styles.stageList} aria-label="Workflow progress">
      {WORKFLOW_STAGES.map((stage, index) => {
        const completed = index < activeIndex;
        const current = index === activeIndex;
        return (
          <li className={`${styles.stageItem} ${completed ? styles.stageComplete : ""} ${current ? styles.stageCurrent : ""}`} key={stage.key} aria-current={current ? "step" : undefined}>
            <span className={styles.stageMarker}>{completed ? <Icon name="check" /> : index + 1}</span>
            <span>{stage.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

interface KeywordMapPagesProps {
  readonly href: string;
  readonly onPageCount: (count: number | null) => void;
  readonly title: string;
  readonly zoom: number;
}

function KeywordMapPages({ href, onPageCount, title, zoom }: KeywordMapPagesProps) {
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const [renderState, setRenderState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const pageContainer = pageContainerRef.current;
    if (!pageContainer) return;

    let active = true;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    const renderTasks: RenderTask[] = [];
    pageContainer.replaceChildren();
    onPageCount(null);
    setRenderState("loading");

    void (async () => {
      // PDF.js reads browser DOM globals at module load, so it must load after this client component mounts.
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      if (!active) return;

      loadingTask = pdfjs.getDocument({ url: href });
      const document = await loadingTask.promise;
      if (!active) return;
      onPageCount(document.numPages);

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        if (!active) return;
        const viewport = page.getViewport({ scale: KEYWORD_MAP_RENDER_SCALE });
        const canvas = window.document.createElement("canvas");
        canvas.className = styles.keywordMapPage;
        canvas.height = Math.ceil(viewport.height);
        canvas.width = Math.ceil(viewport.width);
        canvas.setAttribute("aria-label", `Keyword map page ${pageNumber} for ${title}`);
        canvas.setAttribute("role", "img");
        pageContainer.append(canvas);

        const renderTask = page.render({ canvas, viewport });
        renderTasks.push(renderTask);
        await renderTask.promise;
        page.cleanup();
      }

      if (active) setRenderState("ready");
    })().catch(() => {
      if (!active) return;
      pageContainer.replaceChildren();
      onPageCount(null);
      setRenderState("error");
    });

    return () => {
      active = false;
      for (const renderTask of renderTasks) renderTask.cancel();
      pageContainer.replaceChildren();
      if (loadingTask) void loadingTask.destroy().catch(() => undefined);
    };
  }, [href, onPageCount, title]);

  return (
    <>
      {renderState === "loading" ? <p className={styles.absent} role="status">Loading keyword map…</p> : null}
      {renderState === "error" ? <p className={styles.panelError} role="alert">The keyword map preview could not be displayed. Use the download control to open the PDF.</p> : null}
      <div
        aria-label="Keyword map pages"
        className={styles.keywordMapPages}
        hidden={renderState !== "ready"}
        ref={pageContainerRef}
        style={{ justifySelf: zoom > 100 ? "start" : "center", width: `${zoom}%` }}
      />
    </>
  );
}


export function RunDetail({ runId }: RunDetailProps) {
  const [run, setRun] = useState<RunDto | null>(null);
  const [iterationList, setIterationList] = useState<ResumeIterationListResponse | null>(null);
  const [iterationSelection, setIterationSelection] = useState<ResumeIterationSelection>({
    mode: "follow-latest",
    selectedRevision: null,
  });
  const [isLoadingIterations, setIsLoadingIterations] = useState(true);
  const [iterationError, setIterationError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFresh, setIsFresh] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [zoom, setZoom] = useState(100);
  const [zoomInput, setZoomInput] = useState("100");
  const [keywordMapPageCount, setKeywordMapPageCount] = useState<number | null>(null);
  const [isViewerFullscreen, setIsViewerFullscreen] = useState(false);
  const [documentView, setDocumentView] = useState<DocumentView>("resume");
  const [artifactData, setArtifactData] = useState<Record<string, unknown>>({});
  const [artifactErrors, setArtifactErrors] = useState<Record<string, string>>({});
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const [applicationView, setApplicationView] = useState<ApplicationSessionView | null>(null);
  const [applicationStatusRefreshError, setApplicationStatusRefreshError] =
    useState<string | null>(null);
  const [isRefreshingApplicationStatus, setIsRefreshingApplicationStatus] = useState(false);
  const requestVersion = useRef(0);
  const iterationRequestVersion = useRef(0);
  const applicationStatusRefreshVersion = useRef(0);
  const submittedRefreshRunRef = useRef<string | null>(null);
  const resumeTabRef = useRef<HTMLButtonElement>(null);
  const keywordMapTabRef = useRef<HTMLButtonElement>(null);
  const diffTabRef = useRef<HTMLButtonElement>(null);
  const viewerPaneRef = useRef<HTMLElement>(null);

  const loadRun = useCallback(async (initial = false) => {
    const request = ++requestVersion.current;
    if (initial) setIsLoading(true);
    setIsRefreshing(true);
    setIsFresh(false);
    try {
      const nextRun = await getRun(runId);
      if (request !== requestVersion.current) return;
      setRun(nextRun);
      setLoadError(null);
      setIsFresh(true);
    } catch (error) {
      if (request !== requestVersion.current) return;
      if (initial) setRun(null);
      setLoadError(publicMessage(error, "This run could not be loaded. Try again."));
    } finally {
      if (request === requestVersion.current) {
        setIsRefreshing(false);
        if (initial) setIsLoading(false);
      }
    }
  }, [runId]);

  const refreshSubmittedRun = useCallback(async (): Promise<void> => {
    const request = ++applicationStatusRefreshVersion.current;
    setIsRefreshingApplicationStatus(true);
    try {
      const nextRun = await getRun(runId);
      if (request !== applicationStatusRefreshVersion.current) return;
      setRun(nextRun);
      setApplicationStatusRefreshError(null);
      setIsFresh(true);
    } catch (error) {
      if (request !== applicationStatusRefreshVersion.current) return;
      setApplicationStatusRefreshError(publicMessage(
        error,
        "The submitted application status could not be refreshed. Try again.",
      ));
    } finally {
      if (request === applicationStatusRefreshVersion.current) {
        setIsRefreshingApplicationStatus(false);
      }
    }
  }, [runId]);

  const reportApplicationView = useCallback((next: ApplicationSessionView | null): void => {
    setApplicationView(next);
    if (
      next === null
      || "state" in next
      || next.submissionPhase !== "submitted"
      || submittedRefreshRunRef.current === runId
    ) {
      return;
    }
    submittedRefreshRunRef.current = runId;
    void refreshSubmittedRun();
  }, [refreshSubmittedRun, runId]);

  useEffect(() => {
    setRun(null);
    setIterationList(null);
    setIterationSelection({ mode: "follow-latest", selectedRevision: null });
    setIsLoadingIterations(true);
    setIterationError(null);
    setArtifactData({});
    setArtifactErrors({});
    setLoadError(null);
    setActionError(null);
    setBusyAction(null);
    setApplicationView(null);
    setApplicationStatusRefreshError(null);
    setIsRefreshingApplicationStatus(false);
    submittedRefreshRunRef.current = null;
    applicationStatusRefreshVersion.current += 1;
    void loadRun(true);
    return () => {
      requestVersion.current += 1;
      iterationRequestVersion.current += 1;
      applicationStatusRefreshVersion.current += 1;
    };
  }, [loadRun]);

  const isActive = Boolean(run && !TERMINAL_STATUSES[run.status]);
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    let timeout: number | undefined;
    const poll = async () => {
      await loadRun();
      if (!cancelled) timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [isActive, loadRun]);

  const iterationRefreshKey = run ? `${run.revision}:${run.status}` : "none";
  useEffect(() => {
    if (!run) return;
    const request = ++iterationRequestVersion.current;
    setIsLoadingIterations(true);
    void listResumeIterations(runId).then((nextList) => {
      if (request !== iterationRequestVersion.current) return;
      setIterationList(nextList);
      setIterationSelection((previous) =>
        reconcileResumeIterationSelection(previous, nextList.iterations)
      );
      setIterationError(null);
    }).catch((error: unknown) => {
      if (request !== iterationRequestVersion.current) return;
      setIterationError(publicMessage(
        error,
        "Resume iteration history could not be loaded.",
      ));
    }).finally(() => {
      if (request === iterationRequestVersion.current) setIsLoadingIterations(false);
    });
    return () => {
      if (request === iterationRequestVersion.current) {
        iterationRequestVersion.current += 1;
      }
    };
  }, [iterationRefreshKey, runId]);

  const selectedIteration = iterationList?.iterations.find(
    (iteration) => iteration.revision === iterationSelection.selectedRevision,
  );
  const artifactSignature = selectedIteration
    ? `${selectedIteration.revision}:${selectedIteration.pdfSha256}:${selectedIteration.artifacts
        .filter(isDisplayedJsonArtifact)
        .map((artifact) => `${artifact.id}:${artifact.sha256}`)
        .join("|")}`
    : "none";

  useEffect(() => {
    let current = true;
    setArtifactData({});
    setArtifactErrors({});
    if (!selectedIteration) {
      setIsLoadingArtifacts(false);
      return () => { current = false; };
    }
    const jsonArtifacts = selectedIteration.artifacts.filter(isDisplayedJsonArtifact);
    if (!jsonArtifacts.length) {
      setIsLoadingArtifacts(false);
      return () => { current = false; };
    }
    setIsLoadingArtifacts(true);
    void Promise.all(jsonArtifacts.map(async (artifact) => {
      try {
        return { artifact, value: await readJsonArtifact(artifact) } as const;
      } catch (error) {
        return { artifact, error: publicMessage(error, "This artifact could not be read.") } as const;
      }
    })).then((results) => {
      if (!current) return;
      const nextData: Record<string, unknown> = {};
      const nextErrors: Record<string, string> = {};
      for (const result of results) {
        if ("value" in result) nextData[result.artifact.id] = result.value;
        else nextErrors[result.artifact.id] = result.error;
      }
      setArtifactData(nextData);
      setArtifactErrors(nextErrors);
      setIsLoadingArtifacts(false);
    });
    return () => { current = false; };
  }, [artifactSignature]);

  const artifactFor = useCallback((kind: ArtifactKind) => {
    if (!selectedIteration) return undefined;
    return selectResolvedArtifact(selectedIteration.artifacts, kind);
  }, [selectedIteration]);
  const dataFor = useCallback((kind: ArtifactKind): unknown => {
    const artifact = artifactFor(kind);
    return artifact ? artifactData[artifact.id] : undefined;
  }, [artifactData, artifactFor]);
  const errorFor = useCallback((kind: ArtifactKind): string | undefined => {
    const artifact = artifactFor(kind);
    return artifact ? artifactErrors[artifact.id] : undefined;
  }, [artifactErrors, artifactFor]);

  const analysisArtifact = artifactFor("job-analysis");
  const analysis = dataFor("job-analysis");
  const identity = parseJobIdentity(analysis);
  const extractionArtifact = analysisArtifact
    ? artifactFor("ats-keyword-extraction")
    : undefined;
  const extraction = extractionArtifact ? artifactData[extractionArtifact.id] : undefined;
  const extractionError = extractionArtifact ? artifactErrors[extractionArtifact.id] : undefined;
  const pdfArtifact = selectedPdfArtifact(selectedIteration);
  const pageImageArtifact = selectedPageImage(selectedIteration);
  const pdfHref = safeArtifactHref(pdfArtifact);
  const pageImageHref = safeArtifactHref(pageImageArtifact);
  const keywordMapArtifact = artifactFor("keyword-map-pdf");
  const keywordMapHref = safeArtifactHref(keywordMapArtifact);
  const resumeDiffArtifact = artifactFor("resume-diff");
  const parsedResumeDiff = ResumeDiffSchema.safeParse(dataFor("resume-diff"));
  const resumeDiff = parsedResumeDiff.success ? parsedResumeDiff.data : undefined;
  const selectedDocumentView = documentView === "diff" && resumeDiff
    ? "diff"
    : documentView === "keyword-map" && keywordMapHref
      ? "keyword-map"
      : "resume";
  const documentSignature = selectedIteration
    ? `${runId}:${selectedIteration.revision}:${pdfArtifact?.id ?? ""}:${pageImageArtifact?.id ?? ""}:${keywordMapArtifact?.id ?? ""}:${keywordMapHref ?? ""}:${resumeDiffArtifact?.id ?? ""}:${resumeDiffArtifact?.sha256 ?? ""}`
    : "none";
  useEffect(() => {
    setDocumentView("resume");
    setZoom(100);
    setZoomInput("100");
    setKeywordMapPageCount(null);
  }, [documentSignature]);
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsViewerFullscreen(document.fullscreenElement === viewerPaneRef.current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);
  const toggleViewerFullscreen = async () => {
    const viewerPane = viewerPaneRef.current;
    if (!viewerPane) return;
    try {
      if (document.fullscreenElement === viewerPane) {
        await document.exitFullscreen();
      } else {
        await viewerPane.requestFullscreen();
      }
    } catch {
      setIsViewerFullscreen(false);
    }
  };
  const applyZoom = (nextZoom: number) => {
    const normalizedZoom = Math.min(300, Math.max(75, Math.round(nextZoom)));
    setZoom(normalizedZoom);
    setZoomInput(String(normalizedZoom));
  };
  const handleZoomInputChange = (value: string) => {
    setZoomInput(value);
    const nextZoom = Number(value);
    if (value.trim() !== "" && Number.isFinite(nextZoom) && nextZoom >= 75 && nextZoom <= 300) {
      setZoom(Math.round(nextZoom));
    }
  };
  const commitZoomInput = () => {
    const nextZoom = Number(zoomInput);
    applyZoom(zoomInput.trim() !== "" && Number.isFinite(nextZoom) ? nextZoom : zoom);
  };
  const visualValue = dataFor("visual-qa");
  const visualFindings = recordArray(asRecord(visualValue)?.findings);
  const overlays = visualFindings.map((finding, index) => ({ finding, index, rect: overlayRect(finding.bbox) })).filter((item): item is { finding: JsonRecord; index: number; rect: OverlayRect } => item.rect !== null);

  const actionsDisabled = busyAction !== null || isRefreshing || !isFresh;
  const availableDocumentViews: DocumentView[] = ["resume"];
  if (keywordMapHref) availableDocumentViews.push("keyword-map");
  if (resumeDiff) availableDocumentViews.push("diff");

  const focusDocumentTab = (view: DocumentView) => {
    if (view === "resume") resumeTabRef.current?.focus();
    else if (view === "keyword-map") keywordMapTabRef.current?.focus();
    else diffTabRef.current?.focus();
  };

  const handleDocumentTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentView = event.currentTarget.id === RESUME_TAB_ID
      ? "resume"
      : event.currentTarget.id === KEYWORD_MAP_TAB_ID
        ? "keyword-map"
        : "diff";
    const currentIndex = availableDocumentViews.indexOf(currentView);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % availableDocumentViews.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + availableDocumentViews.length) % availableDocumentViews.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = availableDocumentViews.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextView = availableDocumentViews[nextIndex]!;
    setDocumentView(nextView);
    focusDocumentTab(nextView);
  };

  const refreshAfterActionFailure = useCallback(async (request: number) => {
    setIsRefreshing(true);
    setIsFresh(false);
    try {
      const nextRun = await getRun(runId);
      if (request !== requestVersion.current) return;
      setRun(nextRun);
      setLoadError(null);
      setIsFresh(true);
    } catch (error) {
      if (request !== requestVersion.current) return;
      setRun(null);
      setLoadError(publicMessage(error, "The run could not be refreshed after the action failed."));
    } finally {
      if (request === requestVersion.current) setIsRefreshing(false);
    }
  }, [runId]);


  const submitRetry = async () => {
    if (run?.status !== "failed" || actionsDisabled) return;
    const request = ++requestVersion.current;
    setBusyAction("retry");
    setIsFresh(false);
    setActionError(null);
    try {
      const nextRun = await retryRun(runId);
      if (request !== requestVersion.current) return;
      setRun(nextRun);
      setIsFresh(true);
    } catch (error) {
      if (request !== requestVersion.current) return;
      setActionError(publicMessage(error, "The run could not be retried."));
      await refreshAfterActionFailure(request);
      return;
    } finally {
      if (request === requestVersion.current) setBusyAction(null);
    }
  };

  const currentReviewPdfHash = (): string => {
    if (
      run?.status !== "review"
      || !run.currentPdfSha256
      || selectedIteration?.revision !== run.revision
      || selectedIteration.pdfSha256 !== run.currentPdfSha256
      || iterationList?.artifactState !== "retained"
    ) {
      throw new PipelineClientError(
        "Review actions require the current retained resume iteration.",
        "STALE_RUN",
        409,
      );
    }
    return run.currentPdfSha256;
  };

  const submitRunMutation = async (
    action: Exclude<BusyAction, "retry">,
    operation: () => Promise<RunDto>,
  ): Promise<RunDto> => {
    if (actionsDisabled) {
      throw new PipelineClientError(
        "The run state changed; review the latest iteration.",
        "STALE_RUN",
        409,
      );
    }
    const request = ++requestVersion.current;
    setBusyAction(action);
    setIsFresh(false);
    setActionError(null);
    try {
      const nextRun = await operation();
      if (request !== requestVersion.current) {
        throw new PipelineClientError(
          "The run state changed; review the latest iteration.",
          "STALE_RUN",
          409,
        );
      }
      setRun(nextRun);
      setLoadError(null);
      setIsFresh(true);
      return nextRun;
    } catch (error) {
      if (request === requestVersion.current) {
        await refreshAfterActionFailure(request);
      }
      throw error;
    } finally {
      if (request === requestVersion.current) setBusyAction(null);
    }
  };

  const submitEdit = async (comments: string): Promise<RunDto> => {
    const expectedPdfSha256 = currentReviewPdfHash();
    return await submitRunMutation(
      "edit",
      () => editRun(runId, comments, expectedPdfSha256),
    );
  };


  const submitApproval = async (acknowledgeVisualIssues: boolean): Promise<RunDto> => {
    const expectedPdfSha256 = currentReviewPdfHash();
    return await submitRunMutation(
      "approve",
      () => approveRun(runId, expectedPdfSha256, acknowledgeVisualIssues),
    );
  };

  const selectIteration = (revision: number) => {
    const iterations = iterationList?.iterations;
    if (!iterations?.some((iteration) => iteration.revision === revision)) return;
    setIterationSelection({
      mode: revision === iterations.at(-1)?.revision ? "follow-latest" : "pinned",
      selectedRevision: revision,
    });
  };


  if (isLoading && !run) {
    return (
      <main className={styles.detailShell}>
        <header className={styles.topBar}><Link className={styles.backLink} href="/"><Icon name="arrow-left" />Back to applications</Link></header>
        <section className={styles.fullState} aria-live="polite"><p className={styles.eyebrow}>Opened run</p><h1>Loading application</h1><p>Fetching the current pipeline state and public review artifacts…</p></section>
      </main>
    );
  }

  if (!run) {
    return (
      <main className={styles.detailShell}>
        <header className={styles.topBar}><Link className={styles.backLink} href="/"><Icon name="arrow-left" />Back to applications</Link></header>
        <section className={styles.fullState} role="alert"><p className={styles.eyebrow}>Run unavailable</p><h1>This application could not be opened</h1><p>{loadError ?? "The current run state is unavailable."}</p><button className={styles.primaryButton} type="button" disabled={isRefreshing} onClick={() => void loadRun(true)}><Icon name="refresh" />{isRefreshing ? "Reloading…" : "Reload run"}</button></section>
      </main>
    );
  }

  const title = run.titleOverride ?? identity?.title ?? "Application";
  const subtitle = run.organizationOverride ?? identity?.organization ?? "Organization unavailable";

  return (
    <main
      className={styles.detailShell}
      aria-busy={
        isRefreshing
        || isRefreshingApplicationStatus
        || busyAction !== null
        || isLoadingArtifacts
        || isLoadingIterations
      }
    >
      <header className={styles.topBar}>
        <Link className={styles.backLink} href="/"><Icon name="arrow-left" />Back to applications</Link>
        <WorkflowProgress applicationView={applicationView} run={run} />
      </header>
      <div className={styles.topAlerts}>
        {loadError ? <p className={styles.panelError} role="alert">{loadError}</p> : null}
        {applicationStatusRefreshError ? (
          <div className={`${styles.panelError} ${styles.statusRefreshError}`} role="alert">
            <p>{applicationStatusRefreshError}</p>
            <button
              className={styles.secondaryButton}
              disabled={isRefreshingApplicationStatus}
              onClick={() => void refreshSubmittedRun()}
              type="button"
            >
              <Icon name="refresh" />
              {isRefreshingApplicationStatus ? "Refreshing status…" : "Retry status refresh"}
            </button>
          </div>
        ) : null}
      </div>

      <div className={styles.paneGrid}>
        <aside className={`${styles.pane} ${styles.leftPane}`} aria-label="Application summary and keyword comparison">
          <section className={styles.paneSection}>
            <p className={`${styles.applicationBadge} ${styles[`applicationBadge--${run.applicationStatus}`]}`}>
              {APPLICATION_STATUS_LABELS[run.applicationStatus]}
            </p>
            <h1 className={styles.runTitle}>{title}</h1>
            <p className={styles.runSubtitle}>{subtitle}</p>
            {run.jobUrl ? (
              <a
                className={styles.jobPostingLink}
                href={run.jobUrl}
                rel="noreferrer"
                target="_blank"
              >
                View job posting <span aria-hidden="true">↗</span>
              </a>
            ) : null}
            <dl className={styles.metadataGrid}>
              <div><dt>Created</dt><dd>{formatDate(run.createdAt)}</dd></div>
              <div><dt>Last updated</dt><dd>{formatDate(run.updatedAt)}</dd></div>
            </dl>
          </section>
          <section className={styles.paneSection} aria-label="Keyword comparison">
            <ArtifactState artifact={analysisArtifact} error={errorFor("job-analysis")} loading={isLoadingArtifacts} label="job analysis">
              <AnalysisContent
                value={analysis}
                extraction={extraction}
                extractionAvailable={Boolean(extractionArtifact && !extractionError)}
              />
            </ArtifactState>
          </section>
        </aside>

        <section
          aria-label="Document viewer"
          className={`${styles.pane} ${styles.viewerPane}`}
          ref={viewerPaneRef}
        >
          <header className={styles.viewerToolbar}>
            <div className={styles.viewerTabs} role="tablist" aria-label="Document views" aria-orientation="horizontal">
              <button
                aria-controls={RESUME_PANEL_ID}
                aria-selected={selectedDocumentView === "resume"}
                className={styles.viewerTab}
                id={RESUME_TAB_ID}
                onClick={() => setDocumentView("resume")}
                onKeyDown={handleDocumentTabKeyDown}
                ref={resumeTabRef}
                role="tab"
                tabIndex={selectedDocumentView === "resume" ? 0 : -1}
                type="button"
              >
                Resume
              </button>
              {keywordMapHref ? (
                <button
                  aria-controls={KEYWORD_MAP_PANEL_ID}
                  aria-selected={selectedDocumentView === "keyword-map"}
                  className={styles.viewerTab}
                  id={KEYWORD_MAP_TAB_ID}
                  onClick={() => setDocumentView("keyword-map")}
                  onKeyDown={handleDocumentTabKeyDown}
                  ref={keywordMapTabRef}
                  role="tab"
                  tabIndex={selectedDocumentView === "keyword-map" ? 0 : -1}
                  type="button"
                >
                  Keyword map
                </button>
              ) : null}
              {resumeDiff ? (
                <button
                  aria-controls={DIFF_PANEL_ID}
                  aria-selected={selectedDocumentView === "diff"}
                  className={styles.viewerTab}
                  id={DIFF_TAB_ID}
                  onClick={() => setDocumentView("diff")}
                  onKeyDown={handleDocumentTabKeyDown}
                  ref={diffTabRef}
                  role="tab"
                  tabIndex={selectedDocumentView === "diff" ? 0 : -1}
                  type="button"
                >
                  Diff
                </button>
              ) : null}
            </div>
            {selectedDocumentView === "resume" ? (
              <div className={styles.viewerControls} aria-label="Resume view controls">
                <span>Page 1 / 1</span>
                <button type="button" aria-label="Zoom out" disabled={actionsDisabled || zoom <= 75} onClick={() => applyZoom(zoom - 25)}><Icon name="minus" /></button>
                <label className={styles.zoomControl}>
                  <input
                    aria-label="Zoom percentage"
                    disabled={actionsDisabled}
                    inputMode="numeric"
                    max={300}
                    min={75}
                    onBlur={commitZoomInput}
                    onChange={(event) => handleZoomInputChange(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      commitZoomInput();
                      event.currentTarget.blur();
                    }}
                    step={1}
                    type="number"
                    value={zoomInput}
                  />
                  <span aria-hidden="true">%</span>
                </label>
                <button type="button" aria-label="Zoom in" disabled={actionsDisabled || zoom >= 300} onClick={() => applyZoom(zoom + 25)}><Icon name="plus" /></button>
                <button type="button" aria-label={isViewerFullscreen ? "Exit fullscreen" : "Enter fullscreen"} disabled={actionsDisabled} onClick={() => void toggleViewerFullscreen()}><Icon name="fullscreen" /></button>
                {pdfHref && !actionsDisabled ? <a href={pdfHref} aria-label="Download selected PDF" download><Icon name="download" /></a> : null}
              </div>
            ) : selectedDocumentView === "keyword-map" ? (
              <div className={styles.viewerControls} aria-label="Keyword map controls">
                <span>{keywordMapPageCount === null ? "Loading…" : keywordMapPageCount === 1 ? "Page 1 / 1" : `${keywordMapPageCount} pages`}</span>
                <button type="button" aria-label="Zoom out" disabled={actionsDisabled || zoom <= 75} onClick={() => applyZoom(zoom - 25)}><Icon name="minus" /></button>
                <label className={styles.zoomControl}>
                  <input
                    aria-label="Zoom percentage"
                    disabled={actionsDisabled}
                    inputMode="numeric"
                    max={300}
                    min={75}
                    onBlur={commitZoomInput}
                    onChange={(event) => handleZoomInputChange(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      commitZoomInput();
                      event.currentTarget.blur();
                    }}
                    step={1}
                    type="number"
                    value={zoomInput}
                  />
                  <span aria-hidden="true">%</span>
                </label>
                <button type="button" aria-label="Zoom in" disabled={actionsDisabled || zoom >= 300} onClick={() => applyZoom(zoom + 25)}><Icon name="plus" /></button>
                <button type="button" aria-label={isViewerFullscreen ? "Exit fullscreen" : "Enter fullscreen"} disabled={actionsDisabled} onClick={() => void toggleViewerFullscreen()}><Icon name="fullscreen" /></button>
                {!actionsDisabled ? (
                  <a href={keywordMapHref!} aria-label="Download keyword map PDF" download><Icon name="download" /></a>
                ) : (
                  <button type="button" aria-label="Download keyword map PDF" disabled><Icon name="download" /></button>
                )}
              </div>
            ) : null}
          </header>
          <div
            aria-labelledby={RESUME_TAB_ID}
            className={styles.viewerCanvas}
            hidden={selectedDocumentView !== "resume"}
            id={RESUME_PANEL_ID}
            role="tabpanel"
            tabIndex={0}
          >
            {pageImageHref ? (
              <div className={styles.pageFrame} style={{ justifySelf: zoom > 100 ? "start" : "center", width: `${zoom}%` }}>
                <img src={pageImageHref} alt={`Rendered resume page for ${title}`} />
                {overlays.map(({ finding, index, rect }) => (
                  <span
                    aria-hidden="true"
                    className={styles.visualOverlay}
                    key={index}
                    title={stringValue(finding, "description")}
                    style={{ top: `${rect.top}%`, left: `${rect.left}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
                  />
                ))}
              </div>
            ) : pdfHref ? (
              <object className={styles.pdfObject} data={pdfHref} type="application/pdf" aria-label={`Selected resume PDF for ${title}`}>
                <p>The browser could not display this PDF. <a href={pdfHref} download>Download the selected resume</a>.</p>
              </object>
            ) : (
              <div className={styles.viewerEmpty}>
                {run.status === "analyzing" ? (
                  <p>Waiting on analysis</p>
                ) : (
                  <>
                    <p className={styles.eyebrow}>Document unavailable</p>
                    <h3>{
                      selectedIteration
                        ? iterationList?.artifactState === "pruned"
                          ? "Resume files were removed"
                          : "No preview is available for this iteration"
                        : REVIEW_STATUSES[run.status]
                          ? "Loading reviewed resume history"
                          : STATUS_LABELS[run.status]
                    }</h3>
                    <p>{
                      selectedIteration
                        ? iterationList?.artifactState === "pruned"
                          ? "Retention preserved this iteration’s label and PDF hash, but its document files are no longer available."
                          : "The pipeline did not publish a page image or PDF artifact for this iteration."
                        : REVIEW_STATUSES[run.status]
                          ? "The reviewed iteration list is still loading or unavailable."
                          : "A public document will appear only after compilation and quality review complete."
                    }</p>
                  </>
                )}
                {run.status === "failed" ? <button className={styles.primaryButton} type="button" disabled={actionsDisabled} onClick={() => void submitRetry()}><Icon name="refresh" />{busyAction === "retry" ? "Retrying…" : "Retry failed run"}</button> : null}
                {actionError ? <p className={styles.panelError} role="alert">{actionError}</p> : null}
              </div>
            )}
          </div>
          {keywordMapHref ? (
            <div
              aria-labelledby={KEYWORD_MAP_TAB_ID}
              className={`${styles.viewerCanvas} ${styles.keywordMapCanvas}`}
              hidden={selectedDocumentView !== "keyword-map"}
              id={KEYWORD_MAP_PANEL_ID}
              role="tabpanel"
              tabIndex={0}
            >
              {selectedDocumentView === "keyword-map" ? (
                <KeywordMapPages
                  href={keywordMapHref}
                  onPageCount={setKeywordMapPageCount}
                  title={title}
                  zoom={zoom}
                />
              ) : null}
            </div>
          ) : null}
          {resumeDiff ? (
            <div
              aria-labelledby={DIFF_TAB_ID}
              className={`${styles.viewerCanvas} ${styles.diffCanvas}`}
              hidden={selectedDocumentView !== "diff"}
              id={DIFF_PANEL_ID}
              role="tabpanel"
              tabIndex={0}
            >
              <ResumeDiffContent diff={resumeDiff} />
            </div>
          ) : null}
        </section>

        <aside
          className={`${styles.pane} ${styles.rightPane}`}
          aria-label="Review and application workspace"
        >
          <RunReviewWorkspace
            artifactState={iterationList?.artifactState ?? "retained"}
            busyAction={busyAction}
            isLoadingIterations={isLoadingIterations}
            isFresh={isFresh && !isRefreshing}
            iterationError={iterationError}
            iterations={iterationList?.iterations ?? []}
            onApplicationView={reportApplicationView}
            onApprove={submitApproval}
            onEdit={submitEdit}
            onSelectIteration={selectIteration}
            run={run}
            selectedIteration={selectedIteration}
          />
        </aside>
      </div>
    </main>
  );
}
