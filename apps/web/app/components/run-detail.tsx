"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ResumeDiffSchema,
  type ArtifactDto,
  type ArtifactKind,
  type AttemptDto,
  type ResumeDiff,
  type RunDto,
  type RunStatus,
} from "@jobhunter/pipeline/contracts";
import {
  PipelineClientError,
  artifactHref,
  getRun,
  readJsonArtifact,
  retryRun,
} from "../lib/pipeline-client";
import { APPLICATION_STATUS_LABELS } from "../lib/application-status";
import {
  selectCurrentRevisionArtifact,
  selectReusableJobAnalysis,
} from "../lib/run-detail-artifacts";
import styles from "../run-detail.module.css";

const POLL_INTERVAL_MS = 2_500;
const MAX_PUBLIC_MESSAGE_LENGTH = 240;
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

const WORKFLOW_STAGES = [
  { status: "analyzing", label: "Analysis" },
  { status: "tailoring", label: "Tailoring" },
  { status: "editing", label: "Editing" },
  { status: "compiling", label: "Compile" },
  { status: "deterministic_qa", label: "Deterministic QA" },
  { status: "visual_qa", label: "Visual QA" },
  { status: "review", label: "Review" },
] as const satisfies ReadonlyArray<{ status: RunStatus; label: string }>;

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
type BusyAction = "retry";
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

function Icon({ name }: { readonly name: "arrow-left" | "check" | "download" | "fit" | "minus" | "plus" | "refresh" }) {
  const paths: Record<typeof name, ReactNode> = {
    "arrow-left": <path d="m15 18-6-6 6-6M9 12h10" />,
    check: <path d="m5 12 4 4L19 6" />,
    download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />,
    fit: <path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5" />,
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


function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}


function formatDate(timestamp: number): string {
  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}

function shortHash(value: string | undefined): string {
  return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "Not available";
}


function publicMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PipelineClientError)) return fallback;
  return error.message.trim().slice(0, MAX_PUBLIC_MESSAGE_LENGTH) || fallback;
}


function currentPdfArtifact(run: RunDto | null): ArtifactDto | undefined {
  if (!run || !REVIEW_STATUSES[run.status] || !run.currentPdfSha256) return undefined;
  return run.artifacts.find(
    (artifact) => artifact.public
      && artifact.kind === "compiled-pdf"
      && artifact.revision === run.revision
      && artifact.sha256 === run.currentPdfSha256,
  );
}

function currentPageImage(run: RunDto | null): ArtifactDto | undefined {
  if (!run || !REVIEW_STATUSES[run.status]) return undefined;
  return selectCurrentRevisionArtifact(run.artifacts, run.revision, "page-image");
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
    && (artifact.kind === "job-analysis" || artifact.kind === "resume-diff" || artifact.kind === "visual-qa");
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

function activeWorkflowIndex(run: RunDto): number {
  if (run.status === "approved") return WORKFLOW_STAGES.length;
  if (run.status === "failed") {
    const lastAttempt = [...run.attempts].sort((left, right) => right.startedAt - left.startedAt)[0];
    return lastAttempt ? WORKFLOW_STAGES.findIndex((stage) => stage.status === ATTEMPT_TO_STATUS[lastAttempt.stage]) : -1;
  }
  const visibleStatus = run.status === "repairing" ? "compiling" : run.status;
  return WORKFLOW_STAGES.findIndex((stage) => stage.status === visibleStatus);
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

function IdentifierList({ value, ariaLabel, emptyLabel }: {
  readonly value: unknown;
  readonly ariaLabel: string;
  readonly emptyLabel: string;
}) {
  const ids = stringArray(value);
  if (ids.length === 0) return <span className={styles.absentInline}>{emptyLabel}</span>;
  return (
    <span className={styles.evidenceList} aria-label={ariaLabel}>
      {ids.map((id) => <code key={id}>{id}</code>)}
    </span>
  );
}

function EvidenceIds({ value }: { readonly value: unknown }) {
  return (
    <IdentifierList
      value={value}
      ariaLabel="Evidence IDs"
      emptyLabel="No evidence IDs reported"
    />
  );
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



function AnalysisFacts({ rows }: {
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }>;
}) {
  return (
    <dl className={styles.compactFacts}>
      {rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
    </dl>
  );
}



export function AnalysisContent({ value }: { readonly value: unknown }) {
  const analysis = asRecord(value);
  if (analysis?.schemaVersion !== 2) {
    return (
      <p className={styles.panelError}>
        Unsupported legacy job-analysis artifact. This view requires schemaVersion 2.
      </p>
    );
  }

  const target = asRecord(analysis.target);
  const keywords = recordArray(analysis.jdKeywords);
  const exactEdits = recordArray(analysis.exactEdits);

  return (
    <div className={styles.artifactSections}>
      <AnalysisFacts rows={[
        { label: "Schema version", value: <code>2</code> },
        { label: "Analysis ID", value: <code>{stringValue(analysis, "id") ?? "Not reported"}</code> },
        { label: "Target title", value: stringValue(target, "title") ?? "Not reported" },
        { label: "Organization", value: stringValue(target, "organization") ?? "Not reported" },
        { label: "Job description SHA-256", value: <code>{stringValue(analysis, "jobDescriptionSha256") ?? "Not reported"}</code> },
        { label: "Analysis workflow SHA-256", value: <code>{stringValue(analysis, "analysisWorkflowSha256") ?? "Not reported"}</code> },
        { label: "Baseline SHA-256", value: <code>{stringValue(analysis, "baselineSha256") ?? "Not reported"}</code> },
      ]} />

      <section>
        <h4>JD keywords</h4>
        {keywords.length ? (
          <ul className={styles.findingList}>
            {keywords.map((item, index) => {
              const id = stringValue(item, "id") ?? `Keyword ${index + 1}`;
              const phrase = stringValue(item, "phrase") ?? `Keyword ${index + 1}`;
              return (
                <li key={`${id}-${index}`}>
                  <div className={styles.findingHeading}>
                    <strong>{phrase}</strong>
                    <span>{id}</span>
                  </div>
                  <blockquote>{stringValue(item, "jdQuote") ?? "Exact JD quote not reported"}</blockquote>
                  <AnalysisFacts rows={[
                    { label: "Evidence IDs", value: <EvidenceIds value={item.evidenceIds} /> },
                  ]} />
                </li>
              );
            })}
          </ul>
        ) : <p className={styles.absent}>No evidence-backed JD keywords were identified.</p>}
      </section>

      <section>
        <h4>Exact resume edits</h4>
        {exactEdits.length ? (
          <ul className={styles.findingList}>
            {exactEdits.map((item, index) => {
              const id = stringValue(item, "id") ?? `Edit ${index + 1}`;
              const kind = stringValue(item, "kind");
              const skillEdit = kind === "skill";
              const ownerLabel = skillEdit ? "Category" : "Entity";
              const owner = stringValue(item, skillEdit ? "category" : "entityId") ?? "Not reported";
              return (
                <li key={`${id}-${index}`}>
                  <div className={styles.findingHeading}>
                    <strong>{id}</strong>
                    <span>{kind ? humanize(kind) : "Kind not reported"}</span>
                  </div>
                  <AnalysisFacts rows={[
                    { label: ownerLabel, value: owner },
                    { label: "Baseline item ID", value: <code>{stringValue(item, "baselineItemId") ?? "Not reported"}</code> },
                    { label: "Before", value: stringValue(item, "before") ?? "Not reported" },
                    { label: "After", value: stringValue(item, "after") ?? "Not reported" },
                    {
                      label: "Keyword IDs",
                      value: (
                        <IdentifierList
                          value={item.keywordIds}
                          ariaLabel="Linked keyword IDs"
                          emptyLabel="No linked keyword IDs reported"
                        />
                      ),
                    },
                    { label: "Evidence IDs", value: <EvidenceIds value={item.evidenceIds} /> },
                  ]} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.absent}>
            No exact resume edits were requested; all baseline items are retained.
          </p>
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

function WorkflowProgress({ run }: { readonly run: RunDto }) {
  const activeIndex = activeWorkflowIndex(run);
  return (
    <ol className={styles.stageList} aria-label="Workflow progress">
      {WORKFLOW_STAGES.map((stage, index) => {
        const completed = run.status === "approved" || index < activeIndex;
        const current = index === activeIndex;
        return (
          <li className={`${styles.stageItem} ${completed ? styles.stageComplete : ""} ${current ? styles.stageCurrent : ""}`} key={stage.status} aria-current={current ? "step" : undefined}>
            <span className={styles.stageMarker}>{completed ? <Icon name="check" /> : index + 1}</span>
            <span>{stage.label}</span>
          </li>
        );
      })}
    </ol>
  );
}


export function RunDetail({ runId }: RunDetailProps) {
  const [run, setRun] = useState<RunDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFresh, setIsFresh] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [zoom, setZoom] = useState(100);
  const [documentView, setDocumentView] = useState<DocumentView>("resume");
  const [artifactData, setArtifactData] = useState<Record<string, unknown>>({});
  const [artifactErrors, setArtifactErrors] = useState<Record<string, string>>({});
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const requestVersion = useRef(0);
  const resumeTabRef = useRef<HTMLButtonElement>(null);
  const keywordMapTabRef = useRef<HTMLButtonElement>(null);
  const diffTabRef = useRef<HTMLButtonElement>(null);

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
      setRun(null);
      setLoadError(publicMessage(error, "This run could not be loaded. Try again."));
    } finally {
      if (request === requestVersion.current) {
        setIsRefreshing(false);
        if (initial) setIsLoading(false);
      }
    }
  }, [runId]);

  useEffect(() => {
    setRun(null);
    setArtifactData({});
    setArtifactErrors({});
    setLoadError(null);
    setActionError(null);
    setBusyAction(null);
    void loadRun(true);
    return () => {
      requestVersion.current += 1;
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

  const artifactSignature = run
    ? `${run.id}:${run.status}:${run.revision}:${run.artifacts.filter(isDisplayedJsonArtifact).map((artifact) => `${artifact.id}:${artifact.sha256}`).join("|")}`
    : "none";

  useEffect(() => {
    let current = true;
    setArtifactData({});
    setArtifactErrors({});
    if (!run || !REVIEW_STATUSES[run.status]) {
      setIsLoadingArtifacts(false);
      return () => { current = false; };
    }
    const jsonArtifacts = run.artifacts.filter(isDisplayedJsonArtifact);
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
  }, [artifactSignature, run]);


  const artifactFor = useCallback((kind: ArtifactKind) => {
    if (!run) return undefined;
    return kind === "job-analysis"
      ? selectReusableJobAnalysis(run.artifacts)
      : selectCurrentRevisionArtifact(run.artifacts, run.revision, kind);
  }, [run]);
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
  const pdfArtifact = currentPdfArtifact(run);
  const pageImageArtifact = currentPageImage(run);
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
  const documentSignature = run
    ? `${run.id}:${run.revision}:${pdfArtifact?.id ?? ""}:${pageImageArtifact?.id ?? ""}:${keywordMapArtifact?.id ?? ""}:${keywordMapHref ?? ""}:${resumeDiffArtifact?.id ?? ""}:${resumeDiffArtifact?.sha256 ?? ""}`
    : "none";
  useEffect(() => {
    setDocumentView("resume");
    setZoom(100);
  }, [documentSignature]);
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

  const title = identity?.title ?? "Application";
  const subtitle = identity?.organization ?? `Revision ${run.revision} · ${humanize(run.origin)}`;

  return (
    <main className={styles.detailShell} aria-busy={isRefreshing || busyAction !== null || isLoadingArtifacts}>
      <header className={styles.topBar}>
        <Link className={styles.backLink} href="/"><Icon name="arrow-left" />Back to applications</Link>
        <WorkflowProgress run={run} />
      </header>

      <div className={styles.paneGrid}>
        <aside className={`${styles.pane} ${styles.leftPane}`} aria-label="Run metadata and history">
          <section className={styles.paneSection}>
            <p className={styles.eyebrow}>Application details</p>
            <h1 className={styles.runTitle}>{title}</h1>
            <p className={styles.runSubtitle}>{subtitle}</p>
            <dl className={styles.metadataGrid}>
              <div><dt>Application status</dt><dd>{APPLICATION_STATUS_LABELS[run.applicationStatus]}</dd></div>
              <div><dt>Pipeline status</dt><dd>{STATUS_LABELS[run.status]}</dd></div>
              <div><dt>Revision</dt><dd>{run.revision}</dd></div>
              <div><dt>Revision origin</dt><dd>{humanize(run.origin)}</dd></div>
              <div><dt>Created</dt><dd>{formatDate(run.createdAt)}</dd></div>
              <div><dt>Last updated</dt><dd>{formatDate(run.updatedAt)}</dd></div>
              <div><dt>Current PDF</dt><dd><code>{shortHash(run.currentPdfSha256)}</code></dd></div>
              <div><dt>Visual acknowledgement</dt><dd>{run.visualAcknowledgementRequired ? "Required" : "Not required"}</dd></div>
            </dl>
          </section>




          <section className={styles.paneSection} aria-labelledby="analysis-heading">
            <div className={styles.sectionHeading}><h2 id="analysis-heading">Job analysis</h2>{analysisArtifact ? <span>Revision {analysisArtifact.revision}</span> : null}</div>
            <ArtifactState artifact={analysisArtifact} error={errorFor("job-analysis")} loading={isLoadingArtifacts} label="job analysis">
              <AnalysisContent value={analysis} />
            </ArtifactState>
          </section>
        </aside>

        <section className={`${styles.pane} ${styles.viewerPane}`} aria-label="Document viewer">
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
                <button type="button" aria-label="Zoom out" disabled={actionsDisabled || zoom <= 75} onClick={() => setZoom((value) => Math.max(75, value - 25))}><Icon name="minus" /></button>
                <output aria-live="polite">{zoom}%</output>
                <button type="button" aria-label="Zoom in" disabled={actionsDisabled || zoom >= 150} onClick={() => setZoom((value) => Math.min(150, value + 25))}><Icon name="plus" /></button>
                <button type="button" aria-label="Fit page" disabled={actionsDisabled} onClick={() => setZoom(100)}><Icon name="fit" /></button>
                {pdfHref && !actionsDisabled ? <a href={pdfHref} aria-label="Download current PDF" download><Icon name="download" /></a> : null}
              </div>
            ) : selectedDocumentView === "keyword-map" ? (
              <div className={styles.viewerControls} aria-label="Keyword map controls">
                {!actionsDisabled ? (
                  <a className={styles.viewerDownload} href={keywordMapHref!} aria-label="Download keyword map PDF" download><Icon name="download" /><span>Download keyword map</span></a>
                ) : (
                  <button className={styles.viewerDownload} type="button" disabled><Icon name="download" /><span>Download keyword map</span></button>
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
              <div className={styles.pageFrame} style={{ width: `${zoom * 0.64}%` }}>
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
              <object className={styles.pdfObject} data={pdfHref} type="application/pdf" aria-label={`Current resume PDF for ${title}`}>
                <p>The browser could not display this PDF. <a href={pdfHref}>Download the current resume</a>.</p>
              </object>
            ) : (
              <div className={styles.viewerEmpty}>
                <p className={styles.eyebrow}>Document unavailable</p>
                <h3>{REVIEW_STATUSES[run.status] ? "No current preview is available" : STATUS_LABELS[run.status]}</h3>
                <p>{REVIEW_STATUSES[run.status] ? "The pipeline did not publish a current page image or PDF artifact." : "A public document will appear only after compilation and quality review complete."}</p>
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
              <object className={`${styles.pdfObject} ${styles.keywordMapObject}`} data={keywordMapHref} type="application/pdf" aria-label={`Keyword map PDF for ${title}`}>
                <p>The browser could not display this PDF. <a href={keywordMapHref} download>Download the keyword map</a>.</p>
              </object>
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

        <aside className={`${styles.pane} ${styles.rightPane}`} aria-label="Reserved review workspace" />
      </div>
    </main>
  );
}
