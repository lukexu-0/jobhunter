"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
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
  approveRun,
  artifactHref,
  editRun,
  getRun,
  readJsonArtifact,
  regenerateRun,
  retryRun,
} from "../lib/pipeline-client";
import { APPLICATION_STATUS_LABELS } from "../lib/application-status";
import {
  publicArtifacts,
  selectCurrentRevisionArtifact,
  selectReusableJobAnalysis,
} from "../lib/run-detail-artifacts";
import styles from "../run-detail.module.css";

const POLL_INTERVAL_MS = 2_500;
const MAX_EDIT_LENGTH = 8_000;
const MAX_PUBLIC_MESSAGE_LENGTH = 240;
const TERMINAL_STATUSES: Partial<Record<RunStatus, true>> = { review: true, approved: true, failed: true };
const REVIEW_STATUSES: Partial<Record<RunStatus, true>> = { review: true, approved: true };

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  analyzing: "Analyzing job",
  tailoring: "Tailoring resume",
  editing: "Applying edits",
  compiling: "Compiling PDF",
  repairing: "Repairing document",
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
  { status: "repairing", label: "Repair" },
  { status: "deterministic_qa", label: "Deterministic QA" },
  { status: "visual_qa", label: "Visual QA" },
  { status: "review", label: "Review" },
] as const satisfies ReadonlyArray<{ status: RunStatus; label: string }>;

const ATTEMPT_TO_STATUS: Record<AttemptDto["stage"], RunStatus> = {
  analysis: "analyzing",
  tailoring: "tailoring",
  edit: "editing",
  compile: "compiling",
  repair: "repairing",
  "deterministic-qa": "deterministic_qa",
  "visual-qa": "visual_qa",
};

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

type JsonRecord = Record<string, unknown>;
type BusyAction = "approve" | "edit" | "regenerate" | "retry";

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

function Icon({ name }: { readonly name: "arrow-left" | "check" | "download" | "edit" | "fit" | "minus" | "plus" | "refresh" }) {
  const paths: Record<typeof name, ReactNode> = {
    "arrow-left": <path d="m15 18-6-6 6-6M9 12h10" />,
    check: <path d="m5 12 4 4L19 6" />,
    download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />,
    edit: <path d="M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4" />,
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

function numberValue(record: JsonRecord | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function shortRunId(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
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
  return WORKFLOW_STAGES.findIndex((stage) => stage.status === run.status);
}

function formatDuration(attempt: AttemptDto): string {
  const end = attempt.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - attempt.startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
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

function Panel({ title, meta, children, open = false }: { readonly title: string; readonly meta?: string; readonly children: ReactNode; readonly open?: boolean }) {
  return (
    <details className={styles.reviewPanel} open={open}>
      <summary>
        <span>{title}</span>
        {meta ? <span className={styles.panelMeta}>{meta}</span> : null}
      </summary>
      <div className={styles.panelBody}>{children}</div>
    </details>
  );
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

function AnalysisContent({ value }: { readonly value: unknown }) {
  const analysis = asRecord(value);
  const target = asRecord(analysis?.target);
  const keywords = recordArray(analysis?.prioritizedKeywords);
  const guidance = recordArray(analysis?.guidance);
  if (!analysis) return <p className={styles.panelError}>The analysis artifact has an unexpected shape.</p>;

  return (
    <div className={styles.artifactSections}>
      <dl className={styles.compactFacts}>
        <div><dt>Target</dt><dd>{stringValue(target, "title") ?? "Not reported"}</dd></div>
        <div><dt>Organization</dt><dd>{stringValue(target, "organization") ?? "Not reported"}</dd></div>
        <div><dt>Analysis ID</dt><dd><code>{stringValue(analysis, "id") ?? "Not reported"}</code></dd></div>
      </dl>
      <section>
        <h4>Prioritized job signals ({keywords.length})</h4>
        {keywords.length ? (
          <ul className={styles.findingList}>
            {keywords.map((keyword, index) => (
              <li key={`${stringValue(keyword, "keyword") ?? "keyword"}-${index}`}>
                <div className={styles.findingHeading}>
                  <strong>{stringValue(keyword, "keyword") ?? "Unlabeled keyword"}</strong>
                  <span>{stringValue(keyword, "priority") ?? "Priority not reported"}</span>
                </div>
                <blockquote>{stringValue(keyword, "jdQuote") ?? "Source quote not reported"}</blockquote>
                <EvidenceIds value={keyword.evidenceIds} />
              </li>
            ))}
          </ul>
        ) : <p className={styles.absent}>No prioritized job signals were reported.</p>}
      </section>
      <section>
        <h4>Tailoring guidance ({guidance.length})</h4>
        {guidance.length ? (
          <ul className={styles.findingList}>
            {guidance.map((item, index) => (
              <li key={index}>
                <p>{stringValue(item, "guidance") ?? "Guidance text not reported"}</p>
                <EvidenceIds value={item.evidenceIds} />
              </li>
            ))}
          </ul>
        ) : <p className={styles.absent}>No tailoring guidance was reported.</p>}
      </section>
    </div>
  );
}

function ChangeItems({ items, kind }: { readonly items: JsonRecord[]; readonly kind: "decision" | "skill" | "omission" }) {
  if (!items.length) return <p className={styles.absent}>No {kind === "skill" ? "skill changes" : `${kind}s`} were reported.</p>;
  return (
    <ul className={styles.changeList}>
      {items.map((item, index) => {
        const title = stringValue(item, "text")
          ?? stringValue(item, "skill")
          ?? stringValue(item, "baselineItemId")
          ?? stringValue(item, "entityId")
          ?? `${humanize(kind)} ${index + 1}`;
        const action = stringValue(item, "action") ?? (kind === "omission" ? "omit" : "change");
        return (
          <li key={`${stringValue(item, "id") ?? title}-${index}`}>
            <div className={styles.findingHeading}>
              <strong>{title}</strong>
              <span>{humanize(action)}</span>
            </div>
            {stringValue(item, "category") ? <p className={styles.mutedLine}>{stringValue(item, "category")}</p> : null}
            <p>{stringValue(item, "rationale") ?? "Rationale not reported"}</p>
            <EvidenceIds value={item.evidenceIds} />
          </li>
        );
      })}
    </ul>
  );
}

function ChangesContent({ value }: { readonly value: unknown }) {
  const summary = asRecord(value);
  if (!summary) return <p className={styles.panelError}>The change summary has an unexpected shape.</p>;
  const decisions = recordArray(summary.decisions);
  const skills = recordArray(summary.skillDecisions);
  const omissions = recordArray(summary.omissions);
  return (
    <div className={styles.artifactSections}>
      <p className={styles.artifactIntro}>Plan <code>{stringValue(summary, "planId") ?? "not reported"}</code>. Every change below includes the public evidence citations supplied by the pipeline.</p>
      <section><h4>Resume changes ({decisions.length})</h4><ChangeItems items={decisions} kind="decision" /></section>
      <section><h4>Skill changes ({skills.length})</h4><ChangeItems items={skills} kind="skill" /></section>
      <section><h4>Omissions ({omissions.length})</h4><ChangeItems items={omissions} kind="omission" /></section>
    </div>
  );
}

function DeterministicQaContent({ value }: { readonly value: unknown }) {
  const report = asRecord(value);
  if (!report) return <p className={styles.panelError}>The deterministic QA report has an unexpected shape.</p>;
  const checks = recordArray(report.checks);
  const warnings = stringArray(report.warnings);
  const passed = report.pass === true;
  return (
    <div className={styles.artifactSections}>
      <p className={`${styles.reportStatus} ${passed ? styles.reportStatusPass : styles.reportStatusFail}`}>
        {passed ? "All deterministic checks passed" : "One or more deterministic checks failed"}
      </p>
      {checks.length ? (
        <ul className={styles.checkList}>
          {checks.map((check, index) => (
            <li key={`${stringValue(check, "id") ?? "check"}-${index}`}>
              <span className={stringValue(check, "status") === "pass" ? styles.checkPass : styles.checkFail}>
                {stringValue(check, "status") === "pass" ? "Pass" : "Fail"}
              </span>
              <div><strong>{humanize(stringValue(check, "id") ?? "Unnamed check")}</strong><p>{stringValue(check, "detail") ?? "No detail reported"}</p></div>
            </li>
          ))}
        </ul>
      ) : <p className={styles.absent}>No deterministic checks were reported.</p>}
      {warnings.length ? <section><h4>Warnings ({warnings.length})</h4><ul className={styles.simpleList}>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></section> : null}
    </div>
  );
}

function VisualQaContent({ value }: { readonly value: unknown }) {
  const report = asRecord(value);
  if (!report) return <p className={styles.panelError}>The visual QA report has an unexpected shape.</p>;
  const findings = recordArray(report.findings);
  const status = stringValue(report, "status") ?? "unknown";
  return (
    <div className={styles.artifactSections}>
      <p className={`${styles.reportStatus} ${status === "pass" ? styles.reportStatusPass : styles.reportStatusWarn}`}>{humanize(status)}</p>
      <p>{stringValue(report, "summary") ?? "No visual summary was reported."}</p>
      {findings.length ? (
        <ul className={styles.findingList}>
          {findings.map((finding, index) => {
            const bbox = Array.isArray(finding.bbox) ? finding.bbox : null;
            return (
              <li key={index}>
                <div className={styles.findingHeading}>
                  <strong>{humanize(stringValue(finding, "severity") ?? "Finding")}</strong>
                  <span>Page {numberValue(finding, "page") ?? "not reported"}</span>
                </div>
                <p>{stringValue(finding, "description") ?? "Description not reported"}</p>
                {bbox ? <code className={styles.bbox}>Overlay: [{bbox.join(", ")}]</code> : <span className={styles.absentInline}>No overlay coordinates</span>}
              </li>
            );
          })}
        </ul>
      ) : <p className={styles.absent}>No visual findings were reported.</p>}
    </div>
  );
}

function DispositionsContent({ value, ledgerValue }: { readonly value: unknown; readonly ledgerValue: unknown }) {
  const direct = recordArray(asRecord(value)?.commentDispositions);
  const ledgerComments = recordArray(asRecord(ledgerValue)?.comments);
  const dispositions = direct.length
    ? direct.map((item) => {
        const commentIndex = numberValue(item, "commentIndex");
        const ledgerComment = ledgerComments.find((comment) => numberValue(comment, "index") === commentIndex);
        return { disposition: item, comment: stringValue(ledgerComment ?? null, "text") };
      })
    : ledgerComments.map((item) => ({ disposition: asRecord(item.disposition) ?? {}, comment: stringValue(item, "text") }));
  if (!dispositions.length) return <p className={styles.absent}>No edit dispositions are available for this revision.</p>;
  return (
    <ol className={styles.dispositionList}>
      {dispositions.map(({ disposition, comment }, index) => (
        <li key={`${numberValue(disposition, "commentIndex") ?? index}-${index}`}>
          <div className={styles.findingHeading}>
            <strong>Comment {(numberValue(disposition, "commentIndex") ?? index) + 1}</strong>
            <span>{humanize(stringValue(disposition, "status") ?? "Not reported")}</span>
          </div>
          {comment ? <blockquote>{comment}</blockquote> : null}
          <p>{stringValue(disposition, "rationale") ?? "Rationale not reported"}</p>
          <EvidenceIds value={disposition.evidenceIds} />
        </li>
      ))}
    </ol>
  );
}

function LedgerContent({ value }: { readonly value: unknown }) {
  const ledger = asRecord(value);
  if (!ledger) return <p className={styles.panelError}>The evidence ledger has an unexpected shape.</p>;
  const context = asRecord(ledger.context);
  const analysis = asRecord(ledger.analysis);
  const plan = asRecord(ledger.plan);
  const sourceHashes = asRecord(context?.sourceHashes);
  const bindings = asRecord(ledger.entityBindings);
  const citations = recordArray(ledger.citations);
  const comments = recordArray(ledger.comments);
  const repairs = recordArray(ledger.repairs);
  return (
    <div className={styles.artifactSections}>
      <dl className={styles.compactFacts}>
        <div><dt>Version</dt><dd>{numberValue(ledger, "version") ?? "Not reported"}</dd></div>
        <div><dt>Analysis</dt><dd><code>{stringValue(analysis, "id") ?? "Not reported"}</code></dd></div>
        <div><dt>Analysis SHA</dt><dd><code>{shortHash(stringValue(analysis, "sha256"))}</code></dd></div>
        <div><dt>Job description</dt><dd><code>{shortHash(stringValue(analysis, "jobDescriptionSha256"))}</code></dd></div>
        <div><dt>Plan</dt><dd><code>{stringValue(plan, "id") ?? "Not reported"}</code></dd></div>
        <div><dt>Manifest</dt><dd><code>{shortHash(stringValue(context, "manifestSha256"))}</code></dd></div>
        <div><dt>Baseline</dt><dd><code>{shortHash(stringValue(context, "baselineSha256"))}</code></dd></div>
      </dl>
      <section>
        <h4>Source hashes ({sourceHashes ? Object.keys(sourceHashes).length : 0})</h4>
        {sourceHashes && Object.keys(sourceHashes).length ? <dl className={styles.hashList}>{Object.entries(sourceHashes).map(([key, hash]) => <div key={key}><dt>{key}</dt><dd><code>{shortHash(typeof hash === "string" ? hash : undefined)}</code></dd></div>)}</dl> : <p className={styles.absent}>No source hashes were reported.</p>}
      </section>
      <section>
        <h4>Entity bindings ({bindings ? Object.keys(bindings).length : 0})</h4>
        {bindings && Object.keys(bindings).length ? <dl className={styles.hashList}>{Object.entries(bindings).map(([key, entity]) => <div key={key}><dt>{key}</dt><dd><code>{typeof entity === "string" ? entity : "Not reported"}</code></dd></div>)}</dl> : <p className={styles.absent}>No entity bindings were reported.</p>}
      </section>
      <section>
        <h4>Citations ({citations.length})</h4>
        {citations.length ? (
          <ul className={styles.citationList}>
            {citations.map((citation, index) => (
              <li key={`${stringValue(citation, "evidenceId") ?? "citation"}-${index}`}>
                <strong>{stringValue(citation, "evidenceId") ?? "Unlabeled evidence"}</strong>
                <dl>
                  <div><dt>Source</dt><dd>{stringValue(citation, "sourceId") ?? "Not reported"}</dd></div>
                  <div><dt>Version</dt><dd>{stringValue(citation, "sourceVersionId") ?? "Not reported"}</dd></div>
                  <div><dt>Entity</dt><dd>{stringValue(citation, "entityId") ?? "Not reported"}</dd></div>
                  <div><dt>Artifact hash</dt><dd><code>{shortHash(stringValue(citation, "sha256"))}</code></dd></div>
                </dl>
                {stringArray(citation.caveats).length ? <ul className={styles.simpleList}>{stringArray(citation.caveats).map((caveat, caveatIndex) => <li key={caveatIndex}>{caveat}</li>)}</ul> : null}
              </li>
            ))}
          </ul>
        ) : <p className={styles.absent}>No evidence citations were reported.</p>}
      </section>
      <p className={styles.artifactIntro}>{comments.length} comment record{comments.length === 1 ? "" : "s"}; {repairs.length} repair record{repairs.length === 1 ? "" : "s"}.</p>
    </div>
  );
}

function RepairContent({ value }: { readonly value: unknown }) {
  const report = asRecord(value);
  if (!report) return <p className={styles.panelError}>The repair report has an unexpected shape.</p>;
  const changes = recordArray(report.changes);
  const diagnostics = stringArray(report.remainingDiagnostics);
  return (
    <div className={styles.artifactSections}>
      <p className={`${styles.reportStatus} ${stringValue(report, "status") === "repaired" ? styles.reportStatusPass : styles.reportStatusFail}`}>
        {humanize(stringValue(report, "status") ?? "Status not reported")}
      </p>
      <section>
        <h4>Repair changes ({changes.length})</h4>
        {changes.length ? <ul className={styles.findingList}>{changes.map((change, index) => <li key={index}><div className={styles.findingHeading}><strong>{stringValue(change, "summary") ?? "Summary not reported"}</strong><span>{humanize(stringValue(change, "category") ?? "Change")}</span></div></li>)}</ul> : <p className={styles.absent}>No repair changes were reported.</p>}
      </section>
      <section>
        <h4>Remaining diagnostics ({diagnostics.length})</h4>
        {diagnostics.length ? <ul className={styles.simpleList}>{diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul> : <p className={styles.absent}>No remaining diagnostics were reported.</p>}
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
            const current = index === activeIndex && run.status !== "failed";
            const failed = index === activeIndex && run.status === "failed";
            return (
              <li className={`${styles.stageItem} ${completed ? styles.stageComplete : ""} ${current ? styles.stageCurrent : ""} ${failed ? styles.stageFailed : ""}`} key={stage.status} aria-current={current ? "step" : undefined}>
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

function Timeline({ events }: { readonly events: TimelineEvent[] }) {
  if (!events.length) return <p className={styles.absent}>No timeline events have been recorded.</p>;
  return (
    <ol className={styles.timelineList}>
      {[...events].sort((left, right) => left.at - right.at || left.id - right.id).map((event) => {
        const details = Object.entries(event.detail ?? {}).filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]));
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

function AttemptHistory({ attempts }: { readonly attempts: AttemptDto[] }) {
  if (!attempts.length) return <p className={styles.absent}>No stage attempts have started.</p>;
  return (
    <ol className={styles.attemptList}>
      {[...attempts].sort((left, right) => left.startedAt - right.startedAt).map((attempt) => (
        <li key={attempt.id}>
          <div className={styles.findingHeading}>
            <strong>{humanize(attempt.stage)} · attempt {attempt.attempt}</strong>
            <span>{humanize(attempt.state)}</span>
          </div>
          <time dateTime={new Date(attempt.startedAt).toISOString()}>{formatDate(attempt.startedAt)} · {formatDuration(attempt)}</time>
          <p>{attempt.toolCalls} tool call{attempt.toolCalls === 1 ? "" : "s"} · {attempt.compileCalls} compile call{attempt.compileCalls === 1 ? "" : "s"}</p>
          {attempt.outcome ? <p>Outcome: {humanize(attempt.outcome)}</p> : null}
        </li>
      ))}
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
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [comments, setComments] = useState("");
  const [acknowledgeVisualIssues, setAcknowledgeVisualIssues] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [artifactData, setArtifactData] = useState<Record<string, unknown>>({});
  const [artifactErrors, setArtifactErrors] = useState<Record<string, string>>({});
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const requestVersion = useRef(0);
  const commentsRef = useRef<HTMLTextAreaElement>(null);

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
    setActionNotice(null);
    setComments("");
    setAcknowledgeVisualIssues(false);
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
    ? `${run.id}:${run.revision}:${run.currentPdfSha256 ?? "none"}:${run.artifacts.map((artifact) => `${artifact.id}:${artifact.sha256}`).join("|")}`
    : "none";

  useEffect(() => {
    let current = true;
    setArtifactData({});
    setArtifactErrors({});
    if (!run || !REVIEW_STATUSES[run.status]) {
      setIsLoadingArtifacts(false);
      return () => { current = false; };
    }
    const jsonArtifacts = run.artifacts.filter((artifact) => artifact.public && artifact.mediaType.toLowerCase().startsWith("application/json"));
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

  useEffect(() => {
    setComments("");
  }, [run?.id, run?.revision]);

  useEffect(() => {
    setAcknowledgeVisualIssues(false);
  }, [run?.id, run?.revision, run?.currentPdfSha256]);

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
  const downloadableArtifacts = publicArtifacts(run?.artifacts ?? []);

  const attempts = run?.attempts ?? [];
  const totalToolCalls = attempts.reduce((total, attempt) => total + attempt.toolCalls, 0);
  const totalCompileCalls = attempts.reduce((total, attempt) => total + attempt.compileCalls, 0);
  const canReview = Boolean(run?.status === "review" && run.currentPdfSha256 && pdfArtifact);
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

  const performAction = async (action: BusyAction, operation: (hash: string) => Promise<RunDto>, success: string) => {
    const hash = run?.currentPdfSha256;
    if (!hash || actionsDisabled) return;
    const request = ++requestVersion.current;
    setBusyAction(action);
    setIsFresh(false);
    setActionError(null);
    setActionNotice(null);
    try {
      const nextRun = await operation(hash);
      if (request !== requestVersion.current) return;
      setRun(nextRun);
      setIsFresh(true);
      setActionNotice(success);
      if (action === "edit") setComments("");
    } catch (error) {
      if (request !== requestVersion.current) return;
      setActionError(publicMessage(error, "The action could not be completed."));
      await refreshAfterActionFailure(request);
      return;
    } finally {
      if (request === requestVersion.current) setBusyAction(null);
    }
  };

  const submitEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = comments.trim();
    if (!value || !canReview) return;
    void performAction("edit", (hash) => editRun(runId, value, hash), "Comments sent to the edit agent. A new revision is now processing.");
  };

  const submitApproval = () => {
    if (!canReview || (run?.visualAcknowledgementRequired && !acknowledgeVisualIssues)) return;
    void performAction(
      "approve",
      (hash) => approveRun(runId, hash, acknowledgeVisualIssues),
      "The current revision was approved.",
    );
  };

  const submitRegeneration = () => {
    if (!canReview) return;
    void performAction("regenerate", (hash) => regenerateRun(runId, hash), "Layout regeneration started for a new revision.");
  };

  const submitRetry = async () => {
    if (run?.status !== "failed" || actionsDisabled) return;
    const request = ++requestVersion.current;
    setBusyAction("retry");
    setIsFresh(false);
    setActionError(null);
    setActionNotice(null);
    try {
      const nextRun = await retryRun(runId);
      if (request !== requestVersion.current) return;
      setRun(nextRun);
      setIsFresh(true);
      setActionNotice("The failed run was queued for another attempt.");
    } catch (error) {
      if (request !== requestVersion.current) return;
      setActionError(publicMessage(error, "The run could not be retried."));
      await refreshAfterActionFailure(request);
      return;
    } finally {
      if (request === requestVersion.current) setBusyAction(null);
    }
  };

  const focusEditComments = () => {
    commentsRef.current?.scrollIntoView({ block: "center" });
    commentsRef.current?.focus({ preventScroll: true });
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

  const title = identity?.title ?? `Run ${shortRunId(run.id)}`;
  const subtitle = identity?.organization ?? `Revision ${run.revision} · ${humanize(run.origin)}`;

  return (
    <main className={styles.detailShell} aria-busy={isRefreshing || busyAction !== null || isLoadingArtifacts}>
      <header className={styles.topBar}>
        <Link className={styles.backLink} href="/"><Icon name="arrow-left" />Back to applications</Link>
        <div className={styles.topActions}>
          {pdfHref && !actionsDisabled ? <a className={styles.secondaryButton} href={pdfHref} download><Icon name="download" />Download resume</a> : <button className={styles.secondaryButton} type="button" disabled><Icon name="download" />Download resume</button>}
          <button className={styles.secondaryButton} type="button" disabled={!canReview || actionsDisabled} onClick={focusEditComments}><Icon name="edit" />Send back for edits</button>
          <details className={styles.overflowMenu}>
            <summary aria-label="More run actions">•••</summary>
            <div>
              <button type="button" disabled={isRefreshing || busyAction !== null} onClick={() => void loadRun()}><Icon name="refresh" />Refresh current state</button>
              <a href="#public-artifacts">Public artifact downloads</a>
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
              <div><dt>Run ID</dt><dd title={run.id}>{shortRunId(run.id)}</dd></div>
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

          <section className={styles.paneSection} aria-labelledby="attempt-summary-heading">
            <div className={styles.sectionHeading}><h2 id="attempt-summary-heading">Attempt totals</h2><span>{attempts.length} attempts</span></div>
            <dl className={styles.countGrid}>
              <div><dt>Tool calls</dt><dd>{NUMBER_FORMATTER.format(totalToolCalls)}</dd></div>
              <div><dt>Compile calls</dt><dd>{NUMBER_FORMATTER.format(totalCompileCalls)}</dd></div>
            </dl>
            <AttemptHistory attempts={attempts} />
          </section>

          <section className={styles.paneSection} aria-labelledby="timeline-heading">
            <div className={styles.sectionHeading}><h2 id="timeline-heading">Run timeline</h2><span>{run.timeline.length} events</span></div>
            <Timeline events={run.timeline} />
          </section>

          <section className={styles.paneSection} aria-labelledby="analysis-heading">
            <div className={styles.sectionHeading}><h2 id="analysis-heading">Job analysis</h2>{analysisArtifact ? <span>Revision {analysisArtifact.revision}</span> : null}</div>
            <ArtifactState artifact={analysisArtifact} error={errorFor("job-analysis")} loading={isLoadingArtifacts} label="job analysis">
              <AnalysisContent value={analysis} />
            </ArtifactState>
          </section>
        </aside>

        <section className={`${styles.pane} ${styles.viewerPane}`} aria-labelledby="document-heading">
          <header className={styles.viewerToolbar}>
            <div><p className={styles.eyebrow}>Current document</p><h2 id="document-heading">resume-revision-{run.revision}.pdf</h2></div>
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
              </div>
            )}
          </div>
        </section>

        <aside className={`${styles.pane} ${styles.rightPane}`} aria-label="Review controls and artifact findings">
          <section className={styles.paneSection}>
            <div className={styles.sectionHeading}><h2>Review actions</h2><span>Revision {run.revision}</span></div>
            {run.status === "review" ? (
              <>
                <form className={styles.editForm} onSubmit={submitEdit}>
                  <label htmlFor="edit-comments">Edit comments</label>
                  <p id="edit-comments-help">Request evidence-grounded content changes from the edit agent. Comments cannot directly alter the PDF.</p>
                  <textarea
                    id="edit-comments"
                    ref={commentsRef}
                    value={comments}
                    rows={7}
                    minLength={1}
                    maxLength={MAX_EDIT_LENGTH}
                    required
                    disabled={actionsDisabled}
                    aria-describedby="edit-comments-help edit-comments-count"
                    onChange={(event) => { setComments(event.target.value); setActionError(null); }}
                  />
                  <div className={styles.textareaFooter}><span id="edit-comments-count">{NUMBER_FORMATTER.format(comments.length)} / {NUMBER_FORMATTER.format(MAX_EDIT_LENGTH)}</span></div>
                  <button className={styles.primaryButton} type="submit" disabled={!canReview || actionsDisabled || !comments.trim()}><Icon name="edit" />{busyAction === "edit" ? "Sending…" : "Send to edit agent"}</button>
                </form>
                <div className={styles.actionDivider}><span>Layout or approval</span></div>
                <div className={styles.reviewActions}>
                  <button className={styles.secondaryButton} type="button" disabled={!canReview || actionsDisabled} onClick={submitRegeneration}><Icon name="refresh" />{busyAction === "regenerate" ? "Regenerating…" : "Regenerate for layout"}</button>
                  {run.visualAcknowledgementRequired ? (
                    <label className={styles.acknowledgement}>
                      <input type="checkbox" checked={acknowledgeVisualIssues} disabled={actionsDisabled} onChange={(event) => setAcknowledgeVisualIssues(event.target.checked)} />
                      <span><strong>Acknowledge visual findings</strong><small>I reviewed the visual issues or uncertainty reported below and approve this revision with that acknowledgement.</small></span>
                    </label>
                  ) : null}
                  <button className={styles.primaryButton} type="button" disabled={!canReview || actionsDisabled || Boolean(run.visualAcknowledgementRequired && !acknowledgeVisualIssues)} onClick={submitApproval}><Icon name="check" />{busyAction === "approve" ? "Approving…" : "Approve current revision"}</button>
                </div>
              </>
            ) : run.status === "approved" ? (
              <div className={styles.approvedState}><Icon name="check" /><div><strong>Revision approved</strong><p>This revision is locked as approved. Public artifacts remain available below.</p></div></div>
            ) : run.status === "failed" ? (
              <div className={styles.failedState}><strong>Pipeline failed{run.failureCode ? ` during ${humanize(run.failureCode)}` : ""}</strong><p>The failed run has no public review document. Retry creates a fresh attempt from the current public run state.</p><button className={styles.primaryButton} type="button" disabled={actionsDisabled} onClick={() => void submitRetry()}><Icon name="refresh" />{busyAction === "retry" ? "Retrying…" : "Retry failed run"}</button></div>
            ) : (
              <div className={styles.processingState}><span className={styles.activityDot} /><div><strong>{STATUS_LABELS[run.status]}</strong><p>Review actions stay unavailable until the current revision reaches review with a verified PDF.</p></div></div>
            )}
            <div className={styles.feedback} aria-live="polite">
              {actionError ? <p className={styles.panelError}>{actionError}</p> : null}
              {actionNotice ? <p className={styles.panelSuccess}>{actionNotice}</p> : null}
              {isRefreshing ? <p>Refreshing the current run state…</p> : null}
            </div>
          </section>

          <Panel title="Visual QA" meta={`${visualFindings.length} findings`} open={run.visualAcknowledgementRequired}>
            <ArtifactState artifact={artifactFor("visual-qa")} error={errorFor("visual-qa")} loading={isLoadingArtifacts} label="visual QA">
              <VisualQaContent value={visualValue} />
            </ArtifactState>
          </Panel>

          <Panel title="Deterministic QA">
            <ArtifactState artifact={artifactFor("deterministic-qa")} error={errorFor("deterministic-qa")} loading={isLoadingArtifacts} label="deterministic QA">
              <DeterministicQaContent value={dataFor("deterministic-qa")} />
            </ArtifactState>
          </Panel>

          <Panel title="Source-cited changes">
            <ArtifactState artifact={artifactFor("change-summary")} error={errorFor("change-summary")} loading={isLoadingArtifacts} label="change summary">
              <ChangesContent value={dataFor("change-summary")} />
            </ArtifactState>
          </Panel>

          <Panel title="Evidence ledger">
            <ArtifactState artifact={artifactFor("evidence-ledger")} error={errorFor("evidence-ledger")} loading={isLoadingArtifacts} label="evidence ledger">
              <LedgerContent value={dataFor("evidence-ledger")} />
            </ArtifactState>
          </Panel>

          <Panel title="Edit dispositions">
            <DispositionsContent value={dataFor("edit-report") ?? dataFor("change-summary")} ledgerValue={dataFor("evidence-ledger")} />
          </Panel>

          <Panel title="Repair report">
            <ArtifactState artifact={artifactFor("repair-report")} error={errorFor("repair-report")} loading={isLoadingArtifacts} label="repair report">
              <RepairContent value={dataFor("repair-report")} />
            </ArtifactState>
          </Panel>

          <section className={styles.paneSection} id="public-artifacts" aria-labelledby="public-artifacts-heading">
            <div className={styles.sectionHeading}><h2 id="public-artifacts-heading">Public artifacts</h2><span>{downloadableArtifacts.length} files</span></div>
            {downloadableArtifacts.length ? (
              <ul className={styles.artifactDownloads}>
                {[...downloadableArtifacts].sort((left, right) => left.kind.localeCompare(right.kind) || right.revision - left.revision).map((artifact) => {
                  const href = safeArtifactHref(artifact);
                  return (
                    <li key={artifact.id}>
                      <div><strong>{humanize(artifact.kind)}</strong><span>Revision {artifact.revision} · Attempt {artifact.attempt} · {NUMBER_FORMATTER.format(artifact.bytes)} bytes</span></div>
                      {href ? <a href={href} download aria-label={`Download ${humanize(artifact.kind)}, revision ${artifact.revision}`}><Icon name="download" /></a> : <span className={styles.unavailableDownload}>Unavailable</span>}
                    </li>
                  );
                })}
              </ul>
            ) : <p className={styles.absent}>No public artifacts are available. Artifacts are published only for review or approved revisions.</p>}
          </section>
        </aside>
      </div>
    </main>
  );
}
