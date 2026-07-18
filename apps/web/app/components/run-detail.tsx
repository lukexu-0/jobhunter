"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ArtifactDto,
  ArtifactKind,
  AttemptDto,
  RunDto,
  RunStatus,
  TimelineEvent,
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
    && (artifact.kind === "job-analysis" || artifact.kind === "visual-qa");
}

function parseJobIdentity(value: unknown): JobIdentity | null {
  const target = asRecord(asRecord(value)?.target);
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

function EvidenceIds({ value }: { readonly value: unknown }) {
  const ids = stringArray(value);
  if (ids.length === 0) return <span className={styles.absentInline}>No evidence citations reported</span>;
  return (
    <span className={styles.evidenceList} aria-label="Evidence citations">
      {ids.map((id) => <code key={id}>{id}</code>)}
    </span>
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


const ATS_REVIEW_FIELDS = [
  { key: "parseableSingleColumnStructure", label: "Parseable single-column structure" },
  { key: "standardSectionHeaders", label: "Standard section headers" },
  { key: "selectableUtf8Text", label: "Selectable UTF-8 text" },
  { key: "truthfulKeywordUse", label: "Truthful keyword use" },
  { key: "noHiddenTextOrKeywordStuffing", label: "No hidden text or keyword stuffing" },
  { key: "noUnsupportedSkillsOrMetrics", label: "No unsupported skills or metrics" },
] as const;

function AnalysisFacts({ rows }: {
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }>;
}) {
  return (
    <dl className={styles.compactFacts}>
      {rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
    </dl>
  );
}

function EvidenceTextItems({ value, emptyLabel, compact = false }: {
  readonly value: unknown;
  readonly emptyLabel: string;
  readonly compact?: boolean;
}) {
  const items = recordArray(value);
  if (!items.length) return <p className={styles.absent}>No {emptyLabel} were reported.</p>;
  return (
    <ul className={compact ? styles.simpleList : styles.findingList}>
      {items.map((item, index) => {
        const text = stringValue(item, "text") ?? `Item ${index + 1} text not reported`;
        return (
          <li key={`${text}-${index}`}>
            <p>{text}</p>
            <EvidenceIds value={item.evidenceIds} />
          </li>
        );
      })}
    </ul>
  );
}

function ReviewFindings({ value, fields, detailKey, detailLabel }: {
  readonly value: unknown;
  readonly fields: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  readonly detailKey: string;
  readonly detailLabel: string;
}) {
  const review = asRecord(value);
  return (
    <ul className={styles.findingList}>
      {fields.map(({ key, label }) => {
        const finding = asRecord(review?.[key]);
        return (
          <li key={key}>
            <div className={styles.findingHeading}>
              <strong>{label}</strong>
              <span>{humanize(stringValue(finding, "status") ?? "Status not reported")}</span>
            </div>
            <AnalysisFacts rows={[
              { label: detailLabel, value: stringValue(finding, detailKey) ?? "Not reported" },
            ]} />
            <EvidenceIds value={finding?.evidenceIds} />
          </li>
        );
      })}
    </ul>
  );
}

export function AnalysisContent({ value }: { readonly value: unknown }) {
  const analysis = asRecord(value);
  if (!analysis) return <p className={styles.panelError}>The analysis artifact has an unexpected shape.</p>;

  const roleSummary = asRecord(analysis.roleSummary);
  const requirements = recordArray(analysis.requirementEvidence);
  const recruiterRisks = recordArray(analysis.recruiterRisks);
  const gaps = recordArray(analysis.gapsAndMitigations);
  const keywords = recordArray(analysis.keywordAlignment);
  const proposedContent = asRecord(analysis.proposedCvContent);
  const reorderedExperience = recordArray(proposedContent?.reorderedExperience);
  const bulletReviews = recordArray(analysis.businessValueBulletReview);
  const customizationPlan = recordArray(analysis.customizationPlan);

  return (
    <div className={styles.artifactSections}>
      <AnalysisFacts rows={[
        { label: "Analysis ID", value: <code>{stringValue(analysis, "id") ?? "Not reported"}</code> },
        { label: "Job description SHA-256", value: <code>{stringValue(analysis, "jobDescriptionSha256") ?? "Not reported"}</code> },
        { label: "Analysis workflow SHA-256", value: <code>{stringValue(analysis, "analysisWorkflowSha256") ?? "Not reported"}</code> },
      ]} />

      <section>
        <h4>Role summary</h4>
        <AnalysisFacts rows={[
          { label: "Company", value: stringValue(roleSummary, "company") ?? "Not reported" },
          { label: "Role", value: stringValue(roleSummary, "role") ?? "Not reported" },
          { label: "Archetype", value: stringValue(roleSummary, "archetype") ?? "Not reported" },
          { label: "Domain", value: humanize(stringValue(roleSummary, "domain") ?? "Not reported") },
          { label: "Function", value: humanize(stringValue(roleSummary, "function") ?? "Not reported") },
          { label: "Seniority", value: stringValue(roleSummary, "seniority") ?? "Not reported" },
          { label: "Work model", value: humanize(stringValue(roleSummary, "workModel") ?? "Not reported") },
          { label: "Team size", value: stringValue(roleSummary, "teamSize") ?? "Not reported" },
          { label: "TL;DR", value: stringValue(roleSummary, "tldr") ?? "Not reported" },
        ]} />
      </section>

      <section>
        <h4>Requirement evidence ({requirements.length})</h4>
        {requirements.length ? (
          <ul className={styles.findingList}>
            {requirements.map((item, index) => {
              const requirement = stringValue(item, "requirement") ?? `Requirement ${index + 1}`;
              const sourceLines = stringArray(item.cvSourceLines);
              return (
                <li key={`${requirement}-${index}`}>
                  <div className={styles.findingHeading}>
                    <strong>{requirement}</strong>
                    <span>{humanize(stringValue(item, "priority") ?? "Priority not reported")}</span>
                  </div>
                  <AnalysisFacts rows={[
                    { label: "Match status", value: humanize(stringValue(item, "matchStatus") ?? "Not reported") },
                    { label: "Exact CV evidence", value: stringValue(item, "exactCvEvidence") ?? "Not reported" },
                    {
                      label: "CV source lines",
                      value: sourceLines.length
                        ? <ul className={styles.simpleList}>{sourceLines.map((line, lineIndex) => <li key={`${line}-${lineIndex}`}>{line}</li>)}</ul>
                        : "Not reported",
                    },
                  ]} />
                  <EvidenceIds value={item.evidenceIds} />
                </li>
              );
            })}
          </ul>
        ) : <p className={styles.absent}>No requirement evidence was reported.</p>}
      </section>

      <section>
        <h4>Recruiter risks ({recruiterRisks.length})</h4>
        {recruiterRisks.length ? (
          <ul className={styles.findingList}>
            {recruiterRisks.map((item, index) => {
              const doubt = stringValue(item, "potentialDoubt") ?? `Recruiter risk ${index + 1}`;
              return (
                <li key={`${doubt}-${index}`}>
                  <div className={styles.findingHeading}><strong>{doubt}</strong><span>Risk {index + 1}</span></div>
                  <AnalysisFacts rows={[
                    { label: "CV or report evidence", value: stringValue(item, "evidenceFromCvOrReport") ?? "Not reported" },
                    { label: "Candidate-facing fix", value: stringValue(item, "candidateFacingFix") ?? "Not reported" },
                  ]} />
                  <EvidenceIds value={item.evidenceIds} />
                </li>
              );
            })}
          </ul>
        ) : <p className={styles.absent}>No recruiter risks were reported.</p>}
      </section>

      <section>
        <h4>Gaps and mitigations ({gaps.length})</h4>
        {gaps.length ? (
          <ul className={styles.findingList}>
            {gaps.map((item, index) => {
              const gap = stringValue(item, "gap") ?? `Gap ${index + 1}`;
              return (
                <li key={`${gap}-${index}`}>
                  <div className={styles.findingHeading}>
                    <strong>{gap}</strong>
                    <span>{humanize(stringValue(item, "classification") ?? "Classification not reported")}</span>
                  </div>
                  <AnalysisFacts rows={[
                    { label: "Adjacent experience", value: stringValue(item, "adjacentExperience") ?? "Not reported" },
                    { label: "Portfolio proof", value: stringValue(item, "portfolioProof") ?? "Not reported" },
                    { label: "Concrete mitigation", value: stringValue(item, "concreteMitigation") ?? "Not reported" },
                  ]} />
                  <EvidenceIds value={item.evidenceIds} />
                </li>
              );
            })}
          </ul>
        ) : <p className={styles.absent}>No gaps or mitigations were reported.</p>}
      </section>

      <section>
        <h4>Keyword alignment ({keywords.length})</h4>
        {keywords.length ? (
          <ul className={styles.findingList}>
            {keywords.map((item, index) => {
              const vocabulary = stringValue(item, "jdVocabulary") ?? `Keyword ${index + 1}`;
              return (
                <li key={`${vocabulary}-${index}`}>
                  <div className={styles.findingHeading}>
                    <strong>{vocabulary}</strong>
                    <span>{stringArray(item.placements).join(", ") || "Placements not reported"}</span>
                  </div>
                  <blockquote>{stringValue(item, "jdQuote") ?? "Job-description quote not reported"}</blockquote>
                  <AnalysisFacts rows={[
                    { label: "Current truthful CV wording", value: stringValue(item, "currentTruthfulCvWording") ?? "Not reported" },
                    { label: "Recommended reformulation", value: stringValue(item, "recommendedReformulation") ?? "Not reported" },
                  ]} />
                  <EvidenceIds value={item.evidenceIds} />
                </li>
              );
            })}
          </ul>
        ) : <p className={styles.absent}>No keyword alignment was reported.</p>}
      </section>

      <section>
        <h4>Proposed CV content</h4>
        <section>
          <h5>Technical skills ({recordArray(proposedContent?.technicalSkills).length})</h5>
          <EvidenceTextItems value={proposedContent?.technicalSkills} emptyLabel="technical skills" />
        </section>
        <section>
          <h5>Reordered experience ({reorderedExperience.length})</h5>
          {reorderedExperience.length ? (
            <ul className={styles.findingList}>
              {reorderedExperience.map((item, index) => {
                const roleOrCompany = stringValue(item, "roleOrCompany") ?? `Experience ${index + 1}`;
                return (
                  <li key={`${roleOrCompany}-${index}`}>
                    <div className={styles.findingHeading}>
                      <strong>{roleOrCompany}</strong>
                      <span>{recordArray(item.bullets).length} bullets</span>
                    </div>
                    <EvidenceTextItems value={item.bullets} emptyLabel="experience bullets" compact />
                  </li>
                );
              })}
            </ul>
          ) : <p className={styles.absent}>No reordered experience was reported.</p>}
        </section>
        <section>
          <h5>Selected projects ({recordArray(proposedContent?.selectedProjects).length})</h5>
          <EvidenceTextItems value={proposedContent?.selectedProjects} emptyLabel="selected projects" />
        </section>
      </section>

      <section>
        <h4>Business value bullet review ({bulletReviews.length})</h4>
        {bulletReviews.length ? (
          <ul className={styles.findingList}>
            {bulletReviews.map((item, index) => {
              const scope = stringValue(item, "systemOrScope") ?? `Bullet ${index + 1}`;
              return (
                <li key={`${scope}-${index}`}>
                  <div className={styles.findingHeading}>
                    <strong>{scope}</strong>
                    <span>{humanize(stringValue(item, "action") ?? "Action not reported")}</span>
                  </div>
                  <AnalysisFacts rows={[
                    { label: "Current bullet", value: stringValue(item, "currentBullet") ?? "Not reported" },
                    { label: "Proposed bullet", value: stringValue(item, "proposedBullet") ?? "Not reported" },
                    { label: "Tool or approach", value: stringValue(item, "toolOrApproach") ?? "Not reported" },
                    { label: "Outcome or proof", value: stringValue(item, "outcomeOrProof") ?? "Not reported" },
                  ]} />
                  <EvidenceIds value={item.evidenceIds} />
                </li>
              );
            })}
          </ul>
        ) : <p className={styles.absent}>No business value bullet review was reported.</p>}
      </section>


      <section>
        <h4>ATS and truthfulness review</h4>
        <ReviewFindings
          value={analysis.atsAndTruthfulnessReview}
          fields={ATS_REVIEW_FIELDS}
          detailKey="requiredAction"
          detailLabel="Required action"
        />
      </section>

      <section>
        <h4>Customization plan ({customizationPlan.length})</h4>
        {customizationPlan.length ? (
          <ul className={styles.findingList}>
            {customizationPlan.map((item, index) => {
              const section = stringValue(item, "section") ?? `Plan item ${index + 1}`;
              return (
                <li key={`${section}-${index}`}>
                  <div className={styles.findingHeading}>
                    <strong>{section}</strong>
                    <span>{stringValue(item, "currentStatus") ?? "Status not reported"}</span>
                  </div>
                  <AnalysisFacts rows={[
                    { label: "Proposed change", value: stringValue(item, "proposedChange") ?? "Not reported" },
                    { label: "Why", value: stringValue(item, "why") ?? "Not reported" },
                  ]} />
                  <EvidenceIds value={item.evidenceIds} />
                </li>
              );
            })}
          </ul>
        ) : <p className={styles.absent}>No customization plan was reported.</p>}
      </section>

    </div>
  );
}


function StatusBand({ run }: { readonly run: RunDto }) {
  const activeIndex = activeWorkflowIndex(run);
  return (
    <section className={styles.workflowBand} aria-labelledby="workflow-heading">
      <div className={styles.workflowProgress}>
        <p className={styles.eyebrow} id="workflow-heading">Workflow stage · revision {run.revision}</p>
        <ol className={styles.stageList}>
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
      </div>
      <div className={styles.statusField}>
        <span className={styles.eyebrow}>Status</span>
        <strong className={`${styles.statusValue} ${run.status === "failed" ? styles.statusValueFailed : ""}`}>{STATUS_LABELS[run.status]}</strong>
      </div>
    </section>
  );
}

function Timeline({ events, runId }: { readonly events: TimelineEvent[]; readonly runId: string }) {
  if (!events.length) return <p className={styles.absent}>No timeline events have been recorded.</p>;
  return (
    <ol className={styles.timelineList}>
      {[...events].sort((left, right) => left.at - right.at || left.id - right.id).map((event) => {
        const details = Object.entries(event.detail ?? {}).filter((entry): entry is [string, string | number | boolean] => {
          const [key, value] = entry;
          const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
          return ["string", "number", "boolean"].includes(typeof value)
            && !normalizedKey.endsWith("runid")
            && value !== runId;
        });
        return (
          <li key={event.id}>
            <time dateTime={new Date(event.at).toISOString()}>{formatDate(event.at)}</time>
            <strong>{humanize(event.type)}</strong>
            <span>{STATUS_LABELS[event.status]} · Revision {event.revision}</span>
            {details.length ? <dl>{details.map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{String(value)}</dd></div>)}</dl> : null}
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
  const [artifactData, setArtifactData] = useState<Record<string, unknown>>({});
  const [artifactErrors, setArtifactErrors] = useState<Record<string, string>>({});
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const requestVersion = useRef(0);

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
  const visualValue = dataFor("visual-qa");
  const visualFindings = recordArray(asRecord(visualValue)?.findings);
  const overlays = visualFindings.map((finding, index) => ({ finding, index, rect: overlayRect(finding.bbox) })).filter((item): item is { finding: JsonRecord; index: number; rect: OverlayRect } => item.rect !== null);

  const actionsDisabled = busyAction !== null || isRefreshing || !isFresh;

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
  const timelineEvents = run.timeline.filter((event) => !event.type.toLowerCase().startsWith("attempt."));

  return (
    <main className={styles.detailShell} aria-busy={isRefreshing || busyAction !== null || isLoadingArtifacts}>
      <header className={styles.topBar}>
        <Link className={styles.backLink} href="/"><Icon name="arrow-left" />Back to applications</Link>
        <div className={styles.topActions}>
          {pdfHref && !actionsDisabled ? <a className={styles.secondaryButton} href={pdfHref} download><Icon name="download" />Download resume</a> : <button className={styles.secondaryButton} type="button" disabled><Icon name="download" />Download resume</button>}
          <details className={styles.overflowMenu}>
            <summary aria-label="More run actions">•••</summary>
            <div>
              <button type="button" disabled={isRefreshing || busyAction !== null} onClick={() => void loadRun()}><Icon name="refresh" />Refresh current state</button>
            </div>
          </details>
        </div>
      </header>

      <StatusBand run={run} />

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



          <section className={styles.paneSection} aria-labelledby="timeline-heading">
            <div className={styles.sectionHeading}><h2 id="timeline-heading">Run timeline</h2><span>{timelineEvents.length} event{timelineEvents.length === 1 ? "" : "s"}</span></div>
            <Timeline events={timelineEvents} runId={run.id} />
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
            <div className={styles.viewerControls} aria-label="Document view controls">
              <span>Page 1 / 1</span>
              <button type="button" aria-label="Zoom out" disabled={actionsDisabled || zoom <= 75} onClick={() => setZoom((value) => Math.max(75, value - 25))}><Icon name="minus" /></button>
              <output aria-live="polite">{zoom}%</output>
              <button type="button" aria-label="Zoom in" disabled={actionsDisabled || zoom >= 150} onClick={() => setZoom((value) => Math.min(150, value + 25))}><Icon name="plus" /></button>
              <button type="button" aria-label="Fit page" disabled={actionsDisabled} onClick={() => setZoom(100)}><Icon name="fit" /></button>
              {pdfHref && !actionsDisabled ? <a href={pdfHref} aria-label="Download current PDF" download><Icon name="download" /></a> : null}
            </div>
          </header>
          <div className={styles.viewerCanvas}>
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
        </section>

        <aside className={`${styles.pane} ${styles.rightPane}`} aria-label="Reserved review workspace" />
      </div>
    </main>
  );
}
