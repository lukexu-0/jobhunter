#!/usr/bin/env bun
/**
 * Headed, live local smoke test for the Browser Harness workflow.
 *
 * This intentionally requires a running pipeline, a connected application-provider
 * OAuth account, and a running headed browser-harness service. It drives only its
 * embedded loopback fixture and harness APIs; the labelled Human Next click is manual.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";

const MODEL_STATUS_PATH = "/v1/application-model";
const FULL_NAME = "Test Candidate";
const EMAIL = "candidate@example.test";
const PROFILE_NARRATIVE =
  "Synthetic smoke candidate. Use only the attributed evidence supplied with this local fixture application.";
const RESUME_EVIDENCE =
  "Test Candidate has exactly seven years of reliability engineering experience operating deployment systems.";
const CONTEXT_EVIDENCE =
  "For this synthetic fixture, the candidate explicitly prefers Remote work and confirms that the supplied application answers are truthful.";
const RELEVANT_ANECDOTE =
  "Quartz rollback incident: during a production deployment incident, the candidate coordinated a rollback, verified service health, and documented the follow-up.";
const IRRELEVANT_ANECDOTE =
  "Orchid garden anecdote: the candidate organized an unrelated community garden fundraiser.";
const REVISION =
  "For the Review emphasis field, replace its contents with exactly: Human revision: emphasize careful incident ownership.";
const REVISION_VALUE = "Human revision: emphasize careful incident ownership.";
const RESUME_NAME = "smoke-resume.pdf";
const SUMMER_AVAILABILITY = "June through August 2027";
const REFERRAL_SOURCE = "Employee referral";
const REVIEW_EMPHASIS_REPLY = "Initial human reply: emphasize production reliability.";

const REQUEST_TIMEOUT_MS = 35_000;
const EVENT_WAIT_MS = 1_800_000;
const FIXTURE_WAIT_MS = 120_000;
const DEFAULT_USER_INFO_JSON = join(realpathSync(tmpdir()), "user-info.json");

const HELP = `Usage: bun apps/harness/tests/e2e/smoke-local.ts [options]

Run the live headed Browser Harness workflow against the dual-origin loopback fixture.

Options:
  --harness-url URL     running browser-harness loopback origin
                        (default: http://127.0.0.1:8765)
  --pipeline-url URL    running pipeline loopback origin
                        (default: http://127.0.0.1:3457)
  --user-info-json PATH private user-info store configured on the running harness
                        (default: ${DEFAULT_USER_INFO_JSON})
  -h, --help            show this help
`;

type JsonRecord = Record<string, any>;
type ModelMetadata = {
  modelProvider: "openai-codex" | "google-antigravity";
  model: "gpt-5.6-sol" | "gemini-3.8-flash";
  reasoning: "medium" | "high";
};
type Arguments = { harnessUrl: string; pipelineUrl: string; userInfoJson: string };
type Inputs = Record<"profile" | "resume" | "resumeSource" | "context" | "relevant" | "irrelevant", string>;

class SmokeFailure extends Error {
  override name = "SmokeFailure";
}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value: JsonRecord): string[] {
  return Object.keys(value).sort();
}

function exactKeys(value: JsonRecord, expected: Iterable<string>): boolean {
  return isDeepStrictEqual(ownKeys(value), [...expected].sort());
}

function loopbackBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SmokeFailure("URL must be a valid loopback HTTP origin");
  }
  let hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  const ipVersion = isIP(hostname);
  const loopback =
    hostname === "localhost" ||
    (ipVersion === 4 && hostname.split(".")[0] === "127") ||
    (ipVersion === 6 && hostname === "::1");
  const portMatch = /:([0-9]+)\/?$/.exec(value);
  if (
    parsed.protocol !== "http:" ||
    !loopback ||
    portMatch === null ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !["", "/"].includes(parsed.pathname) ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new SmokeFailure("URL must be a loopback HTTP origin with an explicit port and no path");
  }
  const host = ipVersion === 6 ? `[${hostname}]` : hostname;
  return `http://${host}:${Number(portMatch![1])}`;
}

function parseArgs(argv: string[]): Arguments | null {
  const args: Arguments = {
    harnessUrl: "http://127.0.0.1:8765",
    pipelineUrl: "http://127.0.0.1:3457",
    userInfoJson: DEFAULT_USER_INFO_JSON,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "-h" || argument === "--help") {
      stdout.write(HELP);
      return null;
    }
    const [flag, inlineValue] = argument.split("=", 2);
    if (!["--harness-url", "--pipeline-url", "--user-info-json"].includes(flag!)) {
      throw new SmokeFailure(`Unknown argument: ${argument}\n\n${HELP.trimEnd()}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value) throw new SmokeFailure(`${flag} requires a value`);
    if (flag === "--harness-url") args.harnessUrl = loopbackBaseUrl(value);
    else if (flag === "--pipeline-url") args.pipelineUrl = loopbackBaseUrl(value);
    else args.userInfoJson = resolve(value.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  }
  return args;
}

function bearerToken(): string {
  const token = process.env.JOBHUNT_HARNESS_TOKEN;
  if (!token || token.length < 32) {
    throw new SmokeFailure(
      "Set JOBHUNT_HARNESS_TOKEN to the same value used by pipeline and harness (minimum 32 characters)",
    );
  }
  return token;
}

function makePdf(text: string): Uint8Array {
  require(/^[\x00-\x7f]*$/.test(text), "Synthetic resume text must remain ASCII for deterministic PDF generation");
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 11 Tf 54 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

async function createInputs(root: string): Promise<Inputs> {
  const inputs: Inputs = {
    profile: join(root, "smoke-profile.md"),
    resume: join(root, RESUME_NAME),
    resumeSource: join(root, "resume.tex"),
    context: join(root, "smoke-context.md"),
    relevant: join(root, "quartz-incident.md"),
    irrelevant: join(root, "orchid-garden.md"),
  };
  await Promise.all([
    writeFile(
      inputs.profile,
      `---\nfull_name: "${FULL_NAME}"\nemail: "${EMAIL}"\n---\n\n${PROFILE_NARRATIVE}\n`,
    ),
    writeFile(inputs.resume, makePdf(RESUME_EVIDENCE)),
    writeFile(
      inputs.resumeSource,
      `\\documentclass{article}\n\\begin{document}\n${RESUME_EVIDENCE}\n\\end{document}\n`,
    ),
    writeFile(inputs.context, `# Synthetic application context\n\n${CONTEXT_EVIDENCE}\n`),
    writeFile(inputs.relevant, `# Relevant incident\n\n${RELEVANT_ANECDOTE}\n`),
    writeFile(inputs.irrelevant, `# Unrelated anecdote\n\n${IRRELEVANT_ANECDOTE}\n`),
  ]);
  return inputs;
}

async function multipart(inputs: Inputs): Promise<FormData> {
  const form = new FormData();
  const append = async (field: string, path: string, type: string) => {
    form.append(field, new File([await readFile(path)], basename(path), { type }));
  };
  await append("personal_information", inputs.profile, "text/markdown");
  await append("resume", inputs.resume, "application/pdf");
  await append("resume_source", inputs.resumeSource, "text/x-tex");
  await append("context", inputs.context, "text/markdown");
  await append("anecdote", inputs.relevant, "text/markdown");
  await append("anecdote", inputs.irrelevant, "text/markdown");
  return form;
}

class Capture {
  readonly bodies: string[] = [];

  response(body: string): void {
    this.bodies.push(body);
  }

  sse(frame: string): void {
    this.bodies.push(frame);
  }

  json(body: string, failure: string): unknown {
    this.response(body);
    try {
      return JSON.parse(body);
    } catch {
      throw new SmokeFailure(failure);
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: init.redirect ?? "manual" });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonResponse(capture: Capture, response: Response, failure: string): Promise<JsonRecord> {
  const body = await response.text();
  const value = capture.json(body, failure);
  require(isRecord(value), failure);
  return value;
}

function requireStatus(response: Response, status: number, message: string): void {
  require(response.status === status, `${message} (received ${response.status})`);
}

class EventStream {
  readonly events: JsonRecord[] = [];
  #abort = new AbortController();
  #task: Promise<void> | undefined;
  #failure: unknown;
  #revision = 0;
  #waiters = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly capture: Capture,
  ) {}

  start(): void {
    require(this.#task === undefined, "SSE stream was started twice");
    this.#task = this.#run().catch((error) => {
      if (!this.#abort.signal.aborted) this.#failure = error;
      this.#notify();
    });
  }

  async #run(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const headers = new Headers(this.headers);
      const last = this.events.at(-1);
      if (last) headers.set("Last-Event-ID", String(last.id));
      const response = await fetch(this.url, { headers, signal: this.#abort.signal, redirect: "manual" });
      if (response.status !== 200) {
        const body = await response.text();
        this.capture.response(body);
        throw new SmokeFailure("Harness SSE endpoint did not return 200");
      }
      require(response.body, "Harness SSE endpoint returned no body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName: string | undefined;
      let eventId: string | undefined;
      let dataLines: string[] = [];
      let frameLines: string[] = [];
      const dispatch = () => {
        if (frameLines.length) this.capture.sse(`${frameLines.join("\n")}\n\n`);
        if (dataLines.length) {
          let payload: unknown;
          try {
            payload = JSON.parse(dataLines.join("\n"));
          } catch {
            throw new SmokeFailure("Harness SSE emitted invalid JSON data");
          }
          require(isRecord(payload), "Harness SSE data was not a JSON object");
          require(payload.event === eventName, "Harness SSE event name disagreed with its data");
          require(String(payload.id) === eventId, "Harness SSE event id disagreed with its data");
          const previous = this.events.at(-1);
          if (previous) {
            require(
              Number.isInteger(payload.id) && payload.id > previous.id,
              "Harness SSE event ids were not strictly monotonic",
            );
          }
          this.events.push(payload);
          this.#notify();
        }
        eventName = undefined;
        eventId = undefined;
        dataLines = [];
        frameLines = [];
      };
      const acceptLine = (rawLine: string) => {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          dispatch();
          return;
        }
        if (line.startsWith(":")) return;
        frameLines.push(line);
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") eventName = value;
        else if (field === "id") eventId = value;
        else if (field === "data") dataLines.push(value);
      };
      while (!this.#abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          acceptLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer) acceptLine(buffer);
      if (this.#abort.signal.aborted) return;
      await Bun.sleep(100);
    }
  }

  #notify(): void {
    this.#revision += 1;
    for (const waiter of this.#waiters) waiter();
    this.#waiters.clear();
  }

  async #changed(revision: number, timeoutMs: number): Promise<void> {
    if (this.#revision !== revision) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.#waiters.add(done);
      if (this.#revision !== revision) done();
    });
  }

  #checkFailure(expectedNames: Set<string>, afterId: number): void {
    const failed = this.events.find((event) => event.id > afterId && event.event === "failed");
    if (failed && !expectedNames.has("failed")) {
      const publicError = isRecord(failed.session) ? failed.session.error : undefined;
      throw new SmokeFailure(
        `Harness session failed before the expected workflow gate: ${JSON.stringify(publicError)}`,
      );
    }
    const terminal = this.events.find(
      (event) => event.id > afterId && ["cancelled", "closed"].includes(event.event) && !expectedNames.has(event.event),
    );
    if (terminal) {
      throw new SmokeFailure(`Harness session ended before the expected workflow gate: ${terminal.event}`);
    }
    if (this.#failure) {
      if (this.#failure instanceof SmokeFailure) throw this.#failure;
      throw new SmokeFailure("Harness SSE stream failed before the expected event");
    }
  }

  async waitFor(eventName: string, afterId = 0, timeoutMs = EVENT_WAIT_MS): Promise<JsonRecord> {
    return this.waitForOneOf([eventName], afterId, timeoutMs);
  }

  async waitForOneOf(eventNames: readonly string[], afterId = 0, timeoutMs = EVENT_WAIT_MS): Promise<JsonRecord> {
    const expected = new Set(eventNames);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.find((candidate) => candidate.id > afterId && expected.has(candidate.event));
      if (event) return event;
      this.#checkFailure(expected, afterId);
      const revision = this.#revision;
      await this.#changed(revision, Math.min(500, deadline - Date.now()));
    }
    throw new SmokeFailure(`Timed out waiting for harness event: ${eventNames.join(" or ")}`);
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await this.#task;
  }
}

const POSTING_TEMPLATE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Example Systems — Reliability Engineer</title></head>
<body><main>
  <p id="company">Example Systems</p>
  <h1 id="role">Reliability Engineer</h1>
  <section aria-labelledby="description-heading"><h2 id="description-heading">Job description</h2>
    <p>Own reliable deployment systems and explain how you handled a relevant production incident.</p>
  </section>
  <a id="apply-link" href="{{FORM_ORIGIN}}/application">Apply on Example ATS</a>
</main></body></html>`;

const APPLICATION_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Example Systems application — Reliability Engineer</title>
  <style>
    body { font-family: sans-serif; max-width: 52rem; margin: 2rem auto; }
    label, fieldset { display: block; margin: 0.8rem 0; }
    #custom-widget { border: 1px solid #777; padding: 0.6rem; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>
    <p id="application-company">Example Systems</p>
    <h1 id="application-role">Reliability Engineer application</h1>
    <p id="job-context">The role owns deployment reliability and production-incident response.</p>

    <form id="intermediate-only-form" aria-hidden="true"></form>
    <form id="application-form">
      <label>Full name
        <input id="full-name" name="full_name" type="text" autocomplete="name" required>
      </label>
      <label>Email
        <input id="email" name="email" type="email" autocomplete="email" required>
      </label>
      <label>Relevant incident
        <textarea id="incident-answer" name="incident_answer" required></textarea>
      </label>
      <label>Preferred work style
        <select id="work-style" name="work_style" required>
          <option value="">Choose one</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="office">Office</option>
        </select>
      </label>
      <fieldset>
        <legend>Relevant engineering focus</legend>
        <label><input id="focus-deployment" name="focus" type="radio" value="deployment-systems" required> Deployment systems</label>
        <label><input id="focus-analytics" name="focus" type="radio" value="analytics"> Analytics</label>
      </fieldset>
      <label><input id="truthful" name="truthful" type="checkbox" required> I confirm these answers are truthful</label>
      <label>Years of relevant experience
        <input id="years" name="years" type="number" min="0" max="50" required>
      </label>
      <label>Summer 2027 availability
        <input id="summer-availability" name="summer_availability" type="text" data-user-info-key="availability.summer_2027" data-user-info-scope="global" required>
      </label>
      <label>Referral source
        <select id="referral-source" name="referral_source" data-user-info-key="referral.source" data-user-info-scope="application" required>
          <option value="">Choose one</option>
          <option value="Employee referral">Employee referral</option>
          <option value="Job board">Job board</option>
        </select>
      </label>
      <label>Résumé
        <input id="resume" name="resume" type="file" accept="application/pdf" required>
      </label>

      <section aria-labelledby="intermediate-heading">
        <h2 id="intermediate-heading">Intermediate controls</h2>
        <button id="intermediate-click" type="button">Enable keyboard checkpoint</button>
        <label id="keypress-label" hidden>Keyboard checkpoint
          <input id="keypress-target" type="text" autocomplete="off" form="intermediate-only-form">
        </label>
        <p id="keypress-status" aria-live="polite">Waiting for intermediate Enter.</p>
      </section>

      <section aria-labelledby="custom-heading">
        <h2 id="custom-heading">Custom evaluation-only widget</h2>
        <p>Automation instruction: use JavaScript evaluation to call <code>window.setCustomWidget('evaluation-set')</code>, then confirm the status reads <q>evaluation-set</q>.</p>
        <div id="custom-widget" role="status" data-value="">Not configured</div>
        <input id="custom-value" name="custom_value" type="hidden" value="">
      </section>

      <p id="human-next-instruction">Human-only control: automation must not click Human Next. After every other control is complete, ask the operator to click it.</p>
      <button id="human-next" type="button" aria-describedby="human-next-instruction">Human Next</button>

      <section id="review-panel" aria-labelledby="review-heading" hidden>
        <h2 id="review-heading">Final review</h2>
        <label>Review emphasis
          <textarea id="review-answer" name="review_answer" required>Initial perspective</textarea>
        </label>
        <button id="final-submit" type="submit">Submit application</button>
        <p id="submit-status" aria-live="polite">Not submitted</p>
      </section>
    </form>
  </main>

  <script>
    (() => {
      const form = document.getElementById('application-form');
      const clickButton = document.getElementById('intermediate-click');
      const keypressLabel = document.getElementById('keypress-label');
      const keypressTarget = document.getElementById('keypress-target');
      const keypressStatus = document.getElementById('keypress-status');
      const customWidget = document.getElementById('custom-widget');
      const customValue = document.getElementById('custom-value');
      const humanNext = document.getElementById('human-next');
      const reviewPanel = document.getElementById('review-panel');
      const submitStatus = document.getElementById('submit-status');
      const intermediateForm = document.getElementById('intermediate-only-form');
      intermediateForm.addEventListener('submit', event => event.preventDefault());

      let progressWrite = Promise.resolve();
      const snapshotProgress = () => ({
        fullName: document.getElementById('full-name').value,
        email: document.getElementById('email').value,
        incident: document.getElementById('incident-answer').value,
        workStyle: document.getElementById('work-style').value,
        focus: document.querySelector('input[name=focus]:checked')?.value || '',
        truthful: document.getElementById('truthful').checked,
        years: document.getElementById('years').value,
        summerAvailability: document.getElementById('summer-availability').value,
        referralSource: document.getElementById('referral-source').value,
        resume: document.getElementById('resume').files[0]?.name || '',
        intermediateClick: clickButton.dataset.completed || '',
        intermediateEnter: keypressTarget.dataset.completed || '',
        custom: customValue.value,
        humanNext: humanNext.dataset.completed || '',
        review: document.getElementById('review-answer').value,
        reviewVisible: !reviewPanel.hidden,
      });
      const publishProgress = () => {
        const payload = snapshotProgress();
        progressWrite = progressWrite
          .catch(() => undefined)
          .then(() => fetch('/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }))
          .then(response => {
            if (!response.ok) throw new Error('Fixture progress update failed');
          });
      };
      form.addEventListener('input', publishProgress);
      form.addEventListener('change', publishProgress);

      clickButton.addEventListener('click', () => {
        clickButton.dataset.completed = 'true';
        keypressLabel.hidden = false;
        keypressTarget.focus();
        publishProgress();
      });

      keypressTarget.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        keypressTarget.dataset.completed = 'true';
        keypressStatus.textContent = 'Intermediate Enter accepted.';
        publishProgress();
      });

      window.setCustomWidget = value => {
        if (typeof value !== 'string' || value.length < 1) throw new Error('A widget value is required');
        customWidget.dataset.value = value;
        customWidget.textContent = value;
        customValue.value = value;
        customValue.dispatchEvent(new Event('input', { bubbles: true }));
        publishProgress();
        return customWidget.dataset.value;
      };

      humanNext.addEventListener('click', () => {
        const requiredReady = form.reportValidity();
        const intermediateReady = clickButton.dataset.completed === 'true' && keypressTarget.dataset.completed === 'true';
        const customReady = customValue.value === 'evaluation-set';
        if (!requiredReady || !intermediateReady || !customReady) {
          document.title = 'Fixture validation failed';
          return;
        }
        humanNext.dataset.completed = 'true';
        reviewPanel.hidden = false;
        document.getElementById('review-answer').focus();
        publishProgress();
      });

      form.addEventListener('submit', async event => {
        event.preventDefault();
        const data = new FormData(form);
        const payload = Object.fromEntries(data.entries());
        const file = data.get('resume');
        payload.resume = file instanceof File ? file.name : '';
        const response = await fetch('/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error('Fixture submit failed');
        const result = await response.json();
        submitStatus.textContent = \`Submitted \${result.submit_count} time(s)\`;
      });
    })();
  </script>
</body>
</html>`;

class LocalApplicationFixture {
  #formServer: Bun.Server<undefined> | undefined;
  #postingServer: Bun.Server<undefined> | undefined;
  #submitCount = 0;
  #lastSubmission: JsonRecord | null = null;
  #progress: JsonRecord = {};

  get formOrigin(): string {
    require(this.#formServer, "fixture servers are not running");
    return `http://${this.#formServer.hostname}:${this.#formServer.port}`;
  }

  get postingOrigin(): string {
    require(this.#postingServer, "fixture servers are not running");
    return `http://${this.#postingServer.hostname}:${this.#postingServer.port}`;
  }

  get formUrl(): string {
    return `${this.formOrigin}/application`;
  }

  get postingUrl(): string {
    return `${this.postingOrigin}/posting`;
  }

  get lookalikeFormOrigin(): string {
    require(this.#formServer, "fixture servers are not running");
    return `http://127.0.0.1.evil:${this.#formServer.port}`;
  }

  start(): this {
    require(!this.#formServer && !this.#postingServer, "fixture servers are already running");
    this.#formServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.#handle(request, "form") });
    this.#postingServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.#handle(request, "posting"),
    });
    return this;
  }

  async close(): Promise<void> {
    await Promise.all([this.#postingServer?.stop(true), this.#formServer?.stop(true)]);
    this.#postingServer = undefined;
    this.#formServer = undefined;
  }

  async submitSnapshot(): Promise<JsonRecord> {
    return this.#fixtureJson(`${this.formOrigin}/submit-count`);
  }

  async progressSnapshot(): Promise<JsonRecord> {
    return this.#fixtureJson(`${this.formOrigin}/progress`);
  }

  async #fixtureJson(url: string): Promise<JsonRecord> {
    const response = await fetchWithTimeout(url, {}, 2_000);
    require(response.ok, "Fixture snapshot endpoint failed");
    const value: unknown = await response.json();
    require(isRecord(value), "Fixture snapshot endpoint returned invalid data");
    return value;
  }

  #snapshot(): JsonRecord {
    return {
      submit_count: this.#submitCount,
      last_submission: this.#lastSubmission ? structuredClone(this.#lastSubmission) : null,
      progress: structuredClone(this.#progress),
    };
  }

  async #handle(request: Request, kind: "form" | "posting"): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      if (kind === "posting" && ["/", "/posting"].includes(path)) {
        return this.#send(200, POSTING_TEMPLATE.replace("{{FORM_ORIGIN}}", this.formOrigin), "text/html; charset=utf-8");
      }
      if (kind === "form" && ["/", "/application"].includes(path)) {
        return this.#send(200, APPLICATION_HTML, "text/html; charset=utf-8");
      }
      if (["/redirect", "/sign-in-complete"].includes(path)) {
        return new Response(null, { status: 302, headers: { Location: this.formUrl, "Cache-Control": "no-store" } });
      }
      if (path === "/verify") {
        return this.#send(
          200,
          `<form action="/sign-in-complete" target="_top" onsubmit="return this.code.value==='482913'"><label>Verification code<input name="code"></label><button>Verify</button></form>`,
          "text/html; charset=utf-8",
        );
      }
      if (["/login-frame", "/verify-frame"].includes(path)) {
        const source = path === "/verify-frame" ? "/verify" : "/login";
        return this.#send(
          200,
          `<iframe title="Account sign in" src="${this.formOrigin}${source}"></iframe>`,
          "text/html; charset=utf-8",
        );
      }
      if (path === "/login") {
        return this.#send(
          200,
          `<form action="/sign-in-complete" target="_top" onsubmit="return this.email.value==='candidate@example.test' &amp;&amp; this.password.value==='fixture-password'"><label>Email<input name="email" type="email"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>`,
          "text/html; charset=utf-8",
        );
      }
      if (kind === "form" && path === "/submit-count") return this.#json(200, this.#snapshot());
      if (kind === "form" && path === "/progress") return this.#json(200, { progress: this.#snapshot().progress });
      return this.#json(404, { error: "not_found" });
    }
    if (request.method !== "POST" || kind !== "form" || !["/progress", "/submit"].includes(path)) {
      return this.#json(404, { error: "not_found" });
    }
    const lengthText = request.headers.get("content-length") ?? "0";
    const contentLength = Number(lengthText);
    if (!Number.isInteger(contentLength)) return this.#json(400, { error: "invalid_length" });
    if (contentLength < 2 || contentLength > 64 * 1024) {
      return this.#json(400, { error: "invalid_payload" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await request.text());
    } catch {
      return this.#json(400, { error: "invalid_json" });
    }
    if (!isRecord(payload)) return this.#json(400, { error: "invalid_payload" });
    if (path === "/progress") {
      this.#progress = { ...payload };
      return this.#json(200, { ok: true });
    }
    this.#submitCount += 1;
    this.#lastSubmission = { ...payload };
    return this.#json(200, { submit_count: this.#submitCount });
  }

  #json(status: number, payload: JsonRecord): Response {
    return this.#send(status, JSON.stringify(payload), "application/json");
  }

  #send(status: number, body: string, contentType: string): Response {
    return new Response(body, {
      status,
      headers: { "Content-Type": contentType, "Cache-Control": "no-store", Connection: "close" },
    });
  }
}

async function postCommand(
  capture: Capture,
  url: string,
  headers: Record<string, string>,
  command: JsonRecord,
  failure: string,
): Promise<void> {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await response.text();
  capture.response(body);
  requireStatus(response, 202, failure);
  require(body === "", "Harness command response unexpectedly contained a body");
}

async function createSession(
  capture: Capture,
  harnessUrl: string,
  headers: Record<string, string>,
  fixture: LocalApplicationFixture,
  inputs: Inputs,
): Promise<[Response, JsonRecord]> {
  const response = await fetchWithTimeout(`${harnessUrl}/v1/sessions`, {
    method: "POST",
    headers,
    body: await multipart(inputs),
  });
  const payload = await jsonResponse(capture, response, "Harness session create response was not JSON");
  return [response, payload];
}

async function readUserInfo(path: string): Promise<JsonRecord> {
  try {
    const info = await stat(path);
    require(info.isFile(), `Configured user-info store is unavailable: ${path}`);
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    require(isRecord(value), "Configured user-info store was not a JSON object");
    return value;
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure("Configured user-info store is not valid UTF-8 JSON");
  }
}

async function assertEmptyUserInfo(path: string): Promise<void> {
  require(
    isDeepStrictEqual(await readUserInfo(path), { version: 2, global: {}, applications: {} }),
    "Smoke requires a fresh empty user-info store",
  );
}

async function assertSavedUserInfo(
  path: string,
  jobUrl: string,
  globalFactKey: string,
  applicationFactKey: string,
  reviewFactKey?: string,
): Promise<void> {
  const document = await readUserInfo(path);
  require(exactKeys(document, ["version", "global", "applications"]), "User-info document shape changed");
  require(document.version === 2, "User-info document version changed");
  const globalFacts = document.global;
  const applications = document.applications;
  require(isRecord(globalFacts) && exactKeys(globalFacts, [globalFactKey]), "User-info store did not contain exactly the expected global fact");
  require(isRecord(applications) && exactKeys(applications, [jobUrl]), "User-info store contained a cross-application bucket");
  const applicationFacts = applications[jobUrl];
  const expectedApplicationKeys = [applicationFactKey, ...(reviewFactKey ? [reviewFactKey] : [])];
  require(
    isRecord(applicationFacts) && exactKeys(applicationFacts, expectedApplicationKeys),
    "User-info store did not contain exactly the expected application facts",
  );
  const expectedRecords: [unknown, string, string][] = [
    [globalFacts[globalFactKey], "text", SUMMER_AVAILABILITY],
    [applicationFacts[applicationFactKey], "single_select", REFERRAL_SOURCE],
  ];
  if (reviewFactKey) expectedRecords.push([applicationFacts[reviewFactKey], "text", REVIEW_EMPHASIS_REPLY]);
  for (const [value, answerType, expectedValue] of expectedRecords) {
    require(isRecord(value), "User-info fact was not an object");
    const common = ["answer_type", "status", "question", "updated_at"];
    const fields = answerType === "text" ? [...common, "raw_value", "sanitized_value"] : [...common, "value"];
    require(exactKeys(value, fields), "User-info fact shape changed");
    require(value.answer_type === answerType, "User-info fact answer type changed");
    require(value.status === "answered", "User-info fact was not answered");
    if (answerType === "text") {
      require(value.raw_value === expectedValue, "User-info fact persisted the wrong raw value");
      require(value.sanitized_value === expectedValue, "User-info fact persisted the wrong final value");
    } else require(value.value === expectedValue, "User-info fact persisted the wrong value");
    require(typeof value.question === "string" && value.question.trim(), "User-info fact omitted its source question");
    require(typeof value.updated_at === "string" && value.updated_at, "User-info fact omitted its update timestamp");
  }
}

function additionalInfoCommand(event: JsonRecord): [JsonRecord, string, string] {
  const detail = event.detail;
  require(isRecord(detail), "Additional-information event omitted its detail");
  const questions = detail.questions;
  require(Array.isArray(questions) && questions.length === 2, "Agent did not ask exactly the two fixture questions in one batch");
  require(questions.every(isRecord), "Additional-information event contained an invalid question");
  const globalQuestions = questions.filter((question) => question.scope === "global" && question.answer_type === "text");
  require(globalQuestions.length === 1, "Agent requested the global fixture fact with the wrong shape");
  const globalQuestion = globalQuestions[0]!;
  const globalId = globalQuestion.id;
  const globalKey = globalQuestion.key;
  const globalPrompt = globalQuestion.question;
  require(
    [globalId, globalKey, globalPrompt].every((value) => typeof value === "string" && value.trim()),
    "Agent omitted global fixture question metadata",
  );
  const normalizedGlobalPrompt = globalPrompt.toLowerCase();
  require(
    normalizedGlobalPrompt.includes("summer") && ["availab", "date", "when", "work"].some((token) => normalizedGlobalPrompt.includes(token)),
    "Agent did not ask for the unknown summer availability",
  );
  const applicationQuestions = questions.filter(
    (question) => question.scope === "application" && question.answer_type === "single_select",
  );
  require(applicationQuestions.length === 1, "Agent requested the application fixture fact with the wrong shape");
  const applicationQuestion = applicationQuestions[0]!;
  const applicationId = applicationQuestion.id;
  const applicationKey = applicationQuestion.key;
  const applicationPrompt = applicationQuestion.question;
  require(
    [applicationId, applicationKey, applicationPrompt].every((value) => typeof value === "string" && value.trim()),
    "Agent omitted application fixture question metadata",
  );
  const normalizedApplicationPrompt = applicationPrompt.toLowerCase();
  require(
    ["hear", "learn", "referr", "source", "find", "found", "discover"].some((token) => normalizedApplicationPrompt.includes(token)),
    "Agent did not ask for the unknown referral source",
  );
  require(globalId !== applicationId, "Agent reused candidate-question IDs");
  const options = applicationQuestion.options;
  require(
    Array.isArray(options) &&
      options.every(isRecord) &&
      isDeepStrictEqual(new Set(options.map((option) => option.label)), new Set([REFERRAL_SOURCE, "Job board"])),
    "Agent did not provide the exact bounded referral-source options",
  );
  const selected = options.find((option) => option.label === REFERRAL_SOURCE);
  require(
    isRecord(selected) &&
      typeof selected.id === "string" &&
      selected.id.trim() &&
      options.every((option) => typeof option.id === "string" && option.id.trim()) &&
      new Set(options.map((option) => option.id)).size === options.length,
    "Agent omitted unique referral-source option identifiers",
  );
  return [
    {
      type: "provide_additional_info",
      answers: [
        { id: globalId, status: "answered", raw_value: SUMMER_AVAILABILITY, value: SUMMER_AVAILABILITY },
        { id: applicationId, status: "answered", option_id: selected.id },
      ],
    },
    globalKey,
    applicationKey,
  ];
}

function reviewEmphasisCommand(event: JsonRecord): [JsonRecord, string] {
  const detail = event.detail;
  require(isRecord(detail), "Review-emphasis event omitted its detail");
  const questions = detail.questions;
  require(
    Array.isArray(questions) && questions.length === 1 && isRecord(questions[0]),
    "Agent did not ask exactly one late-discovered review-emphasis question",
  );
  const question = questions[0];
  const { id, key, question: prompt } = question;
  require(
    question.scope === "application" &&
      question.answer_type === "text" &&
      [id, key, prompt].every((value) => typeof value === "string" && value.trim()),
    "Agent requested the review-emphasis fact with the wrong shape",
  );
  const normalizedPrompt = prompt.toLowerCase();
  require(
    normalizedPrompt.includes("review") && normalizedPrompt.includes("emphasis"),
    "Agent did not identify the late-discovered review-emphasis question",
  );
  return [
    {
      type: "provide_additional_info",
      answers: [{ id, status: "answered", raw_value: REVIEW_EMPHASIS_REPLY, value: REVIEW_EMPHASIS_REPLY }],
    },
    key,
  ];
}

async function waitFixtureValues(
  fixture: LocalApplicationFixture,
  expected: JsonRecord,
  failure: string,
): Promise<JsonRecord> {
  const deadline = Date.now() + FIXTURE_WAIT_MS;
  let latestProgress: JsonRecord = {};
  while (Date.now() < deadline) {
    const snapshot = await fixture.progressSnapshot();
    if (isRecord(snapshot.progress)) latestProgress = snapshot.progress;
    if (isRecord(snapshot.progress) && Object.entries(expected).every(([key, value]) => isDeepStrictEqual(snapshot.progress[key], value))) {
      return snapshot.progress;
    }
    await Bun.sleep(100);
  }
  const mismatched = Object.entries(expected)
    .filter(([key, value]) => !isDeepStrictEqual(latestProgress[key], value))
    .map(([key]) => key)
    .sort();
  throw new SmokeFailure(`${failure}; mismatched fields: ${mismatched.join(", ")}`);
}

function assertSubsequence(actual: string[], expected: string[]): void {
  let cursor = 0;
  for (const value of actual) if (cursor < expected.length && value === expected[cursor]) cursor += 1;
  require(cursor === expected.length, "Harness events did not follow the required gate/revision/submission sequence");
}

function assertSnapshot(snapshot: JsonRecord, sessionId: string, model: ModelMetadata): void {
  require(snapshot.session_id === sessionId, "Final snapshot returned the wrong session id");
  require(snapshot.state === "submitted", "Session did not reach submitted");
  require(snapshot.model_provider === model.modelProvider, "Snapshot used the wrong provider");
  require(snapshot.model === model.model, "Snapshot used the wrong model");
  require(snapshot.reasoning === model.reasoning, "Snapshot used the wrong reasoning level");
  require(snapshot.company === "Example Systems", "Snapshot did not identify the fixture company");
  require(snapshot.role === "Reliability Engineer", "Snapshot did not identify the fixture role");
  require(snapshot.revision_count === 1, "Snapshot did not record exactly one revision");
  require(isDeepStrictEqual(snapshot.files_attached, ["resume.pdf"]), "Snapshot did not record the sanitized resume");
  require(isDeepStrictEqual(snapshot.fields_needing_human, []), "Snapshot still reported fields needing human input");
  const fields = snapshot.fields_filled;
  require(Array.isArray(fields) && fields.length >= 12, "Snapshot did not report all fixture fields");
  require(
    fields.every(
      (field) => isRecord(field) && field.value_present === true && typeof field.label === "string" && field.label.trim(),
    ),
    "Snapshot field metadata was incomplete or exposed an unfilled field",
  );
  const types = new Set(fields.map((field) => field.field_type));
  require(
    ["text", "textarea", "select", "radio", "checkbox", "number", "file", "unknown"].every((type) => types.has(type)),
    "Snapshot did not cover every fixture field type",
  );
  require(snapshot.error === null, "Submitted snapshot unexpectedly contained an error");
}

async function waitFixtureProgress(fixture: LocalApplicationFixture): Promise<JsonRecord> {
  const deadline = Date.now() + FIXTURE_WAIT_MS;
  while (Date.now() < deadline) {
    const snapshot = await fixture.progressSnapshot();
    if (isRecord(snapshot.progress) && snapshot.progress.review === REVISION_VALUE) return snapshot.progress;
    await Bun.sleep(100);
  }
  throw new SmokeFailure("Fixture progress did not reflect the same-run revision");
}

function assertFixtureProgress(progress: JsonRecord): void {
  require(progress.fullName === FULL_NAME, "Fixture full name did not come from explicit profile data");
  require(progress.email === EMAIL, "Fixture email did not come from explicit profile data");
  const incident = progress.incident;
  require(typeof incident === "string" && incident.trim(), "Fixture incident answer was empty");
  const incidentLower = incident.toLowerCase();
  require(
    incidentLower.includes("rollback") && incidentLower.includes("service health"),
    "Fixture incident answer did not use the JD-relevant Quartz incident evidence",
  );
  require(
    !["orchid", "community garden", "fundraiser"].some((word) => incidentLower.includes(word)),
    "Fixture incident answer imported facts from the irrelevant anecdote",
  );
  const expected = {
    workStyle: "remote",
    focus: "deployment-systems",
    truthful: true,
    years: "7",
    summerAvailability: SUMMER_AVAILABILITY,
    referralSource: REFERRAL_SOURCE,
    resume: RESUME_NAME,
    intermediateClick: "true",
    intermediateEnter: "true",
    custom: "evaluation-set",
    humanNext: "true",
    review: REVISION_VALUE,
    reviewVisible: true,
  };
  for (const [key, value] of Object.entries(expected)) {
    require(progress[key] === value, `Fixture progress check failed for ${key}`);
  }
}

async function waitForOneSubmit(fixture: LocalApplicationFixture): Promise<void> {
  const deadline = Date.now() + FIXTURE_WAIT_MS;
  while (Date.now() < deadline) {
    const snapshot = await fixture.submitSnapshot();
    const count = snapshot.submit_count;
    require(Number.isInteger(count), "Fixture submit counter returned invalid data");
    require(count <= 1, "Fixture recorded more than one final submission");
    if (count === 1) {
      const submission = snapshot.last_submission;
      require(isRecord(submission), "Fixture did not retain the single submission");
      require(submission.full_name === FULL_NAME, "Submitted fixture name changed after approval");
      require(submission.email === EMAIL, "Submitted fixture email changed after approval");
      require(submission.review_answer === REVISION_VALUE, "Submitted fixture revision changed after approval");
      require(submission.summer_availability === SUMMER_AVAILABILITY, "Submitted fixture global answer changed after approval");
      require(submission.referral_source === REFERRAL_SOURCE, "Submitted fixture application answer changed after approval");
      require(submission.resume === RESUME_NAME, "Submitted fixture resume changed after approval");
      const serialized = JSON.stringify(submission).toLowerCase();
      require(
        !["orchid", "community garden", "fundraiser"].some((word) => serialized.includes(word)),
        "Final fixture submission imported the irrelevant anecdote",
      );
      return;
    }
    await Bun.sleep(100);
  }
  throw new SmokeFailure("Timed out waiting for the agent's one final submission");
}

function inspectJsonPrivacy(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) inspectJsonPrivacy(child);
    return;
  }
  if (!isRecord(value)) return;
  const forbiddenKeys = new Set([
    "access_token",
    "refresh_token",
    "id_token",
    "oauth_token",
    "provider_error",
    "provider_error_body",
    "reasoning_summary",
    "reasoningsummary",
  ]);
  for (const [key, child] of Object.entries(value)) {
    require(!forbiddenKeys.has(key.toLowerCase()), "Captured API data contained a forbidden private field");
    if (key.toLowerCase() === "error") {
      require(child === null, "Captured API/SSE data contained a non-null provider or session error");
    }
    if (key.toLowerCase() === "reasoning") {
      require(["medium", "high"].includes(child), "Captured API/SSE data contained a reasoning summary");
    }
    inspectJsonPrivacy(child);
  }
}

function privacyScan(capture: Capture, token: string): void {
  const corpus = capture.bodies.join("\n");
  for (const value of [
    token,
    FULL_NAME,
    EMAIL,
    PROFILE_NARRATIVE,
    RESUME_EVIDENCE,
    CONTEXT_EVIDENCE,
    RELEVANT_ANECDOTE,
    IRRELEVANT_ANECDOTE,
    REVISION,
    REVISION_VALUE,
    SUMMER_AVAILABILITY,
    REVIEW_EMPHASIS_REPLY,
  ]) {
    require(!corpus.includes(value), "Captured API/SSE data failed the privacy scan");
  }
  const lowered = corpus.toLowerCase();
  for (const marker of [
    "authorization: bearer",
    '"access_token"',
    '"refresh_token"',
    '"id_token"',
    '"provider_error"',
    '"provider_error_body"',
    '"reasoning_summary"',
    '"reasoningsummary"',
    "<secret>",
    "attributed candidate evidence",
  ]) {
    require(!lowered.includes(marker), "Captured API/SSE data contained forbidden private metadata");
  }
  for (const body of capture.bodies) {
    const stripped = body.trim();
    if (!stripped) continue;
    let candidates = stripped
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    if (!candidates.length && (stripped.startsWith("{") || stripped.startsWith("["))) candidates = [stripped];
    for (const candidate of candidates) {
      try {
        inspectJsonPrivacy(JSON.parse(candidate));
      } catch (error) {
        if (error instanceof SmokeFailure) throw error;
      }
    }
  }
}

function validateModelStatus(status: JsonRecord): ModelMetadata {
  const candidate = {
    modelProvider: status.modelProvider,
    model: status.model,
    reasoning: status.reasoning,
  } as ModelMetadata;
  const valid =
    (candidate.modelProvider === "openai-codex" && candidate.model === "gpt-5.6-sol" && candidate.reasoning === "medium") ||
    (candidate.modelProvider === "google-antigravity" && candidate.model === "gemini-3.8-flash" && candidate.reasoning === "high");
  require(valid, "Harness model status metadata was invalid");
  require(
    isDeepStrictEqual(status, { ...candidate, oauth: "connected" }),
    "Harness model status metadata was not exact",
  );
  return candidate;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function manualGate(message: string): Promise<void> {
  stdout.write(`${message}\n`);
  const readline = createInterface({ input: stdin, output: stdout });
  const interruption = new AbortController();
  const interrupt = () => interruption.abort();
  readline.once("SIGINT", interrupt);
  try {
    await readline.question("", { signal: interruption.signal });
  } catch {
    throw new SmokeFailure("Smoke interrupted while waiting for a required manual click");
  } finally {
    readline.removeListener("SIGINT", interrupt);
    readline.close();
  }
}

async function workflow(args: Arguments, token: string, capture: Capture): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  let activeSessionId: string | undefined;
  let eventStream: EventStream | undefined;
  let fixture: LocalApplicationFixture | undefined;
  const temporary = await mkdtemp(join(tmpdir(), "jobhunt-browser-harness-smoke-"));
  const inputs = await createInputs(temporary);
  try {
    fixture = new LocalApplicationFixture().start();

    const unauthenticated = await fetchWithTimeout(`${args.harnessUrl}/v1/sessions/${randomUUID()}`);
    const unauthenticatedBody = await jsonResponse(capture, unauthenticated, "Unauthenticated harness response was not JSON");
    requireStatus(unauthenticated, 401, "Harness did not reject an unauthenticated /v1 request with 401");
    require(
      isDeepStrictEqual(unauthenticatedBody, { code: "unauthorized", message: "Unauthorized" }),
      "Harness unauthenticated response was not the fixed undifferentiated error",
    );

    const statusResponse = await fetchWithTimeout(`${args.harnessUrl}${MODEL_STATUS_PATH}`, { headers });
    const status = await jsonResponse(capture, statusResponse, "Pipeline status response was not JSON");
    requireStatus(
      statusResponse,
      200,
      "Harness model status was not ready; connect the configured application model provider in Credentials",
    );
    const modelMetadata = validateModelStatus(status);
    await assertEmptyUserInfo(args.userInfoJson);

    const [createResponse, created] = await createSession(capture, args.harnessUrl, headers, fixture, inputs);
    requireStatus(createResponse, 202, "Harness did not accept the multipart session");
    require(created.state === "starting", "Harness create response did not report starting");
    require(validUuid(created.session_id), "Harness create response did not contain a UUID session id");
    activeSessionId = created.session_id;
    const expectedBase = `/v1/sessions/${activeSessionId}`;
    const eventsUrl = created.events_url;
    const commandsUrl = created.commands_url;
    require(typeof eventsUrl === "string", "Harness create response omitted events_url");
    require(typeof commandsUrl === "string", "Harness create response omitted commands_url");
    require(new URL(eventsUrl).pathname === `${expectedBase}/events`, "Harness returned the wrong events_url");
    require(new URL(commandsUrl).pathname === `${expectedBase}/commands`, "Harness returned the wrong commands_url");
    loopbackBaseUrl(new URL(eventsUrl).origin);
    loopbackBaseUrl(new URL(commandsUrl).origin);

    eventStream = new EventStream(eventsUrl, headers, capture);
    eventStream.start();

    const started = await eventStream.waitFor("session_started");
    const additionalInfo = await eventStream.waitFor("additional_info_required", started.id);
    const initialProgress = await waitFixtureValues(
      fixture,
      {
        fullName: FULL_NAME,
        email: EMAIL,
        workStyle: "remote",
        focus: "deployment-systems",
        truthful: true,
        years: "7",
        resume: RESUME_NAME,
        summerAvailability: "",
        referralSource: "",
      },
      "Agent requested additional information before filling fields supported by initial data",
    );
    const initialIncident = initialProgress.incident;
    require(
      typeof initialIncident === "string" &&
        initialIncident.toLowerCase().includes("rollback") &&
        initialIncident.toLowerCase().includes("service health"),
      "Agent requested additional information before applying initial incident evidence",
    );
    const [infoCommand, globalFactKey, applicationFactKey] = additionalInfoCommand(additionalInfo);
    await postCommand(capture, commandsUrl, headers, infoCommand, "Harness rejected the complete additional-information batch");
    const savedInfo = await eventStream.waitFor("additional_info_saved", additionalInfo.id);
    require(isDeepStrictEqual(savedInfo.detail, { count: 2 }), "Harness did not report both saved information answers");
    await assertSavedUserInfo(args.userInfoJson, fixture.postingUrl, globalFactKey, applicationFactKey);

    const navigation = await eventStream.waitFor("human_navigation_required", savedInfo.id);
    await waitFixtureValues(
      fixture,
      {
        summerAvailability: SUMMER_AVAILABILITY,
        referralSource: REFERRAL_SOURCE,
        intermediateClick: "true",
        intermediateEnter: "true",
        custom: "evaluation-set",
        humanNext: "",
        reviewVisible: false,
      },
      "Agent did not apply the accepted answers and complete every machine-actionable control",
    );
    const beforeNavigationSubmit = await fixture.submitSnapshot();
    require(beforeNavigationSubmit.submit_count === 0, "Agent submitted while applying additional information");
    await manualGate('In headed Chrome, click "Human Next" on the fixture, then press Enter here.');
    await postCommand(
      capture,
      commandsUrl,
      headers,
      { type: "continue" },
      "Harness rejected continue after the manual Human Next click",
    );

    const postNavigationInfo = await eventStream.waitFor("additional_info_required", navigation.id);
    const [reviewInfoCommand, reviewFactKey] = reviewEmphasisCommand(postNavigationInfo);
    await postCommand(
      capture,
      commandsUrl,
      headers,
      reviewInfoCommand,
      "Harness rejected the late-discovered review-emphasis answer",
    );
    const reviewInfoSaved = await eventStream.waitFor("additional_info_saved", postNavigationInfo.id);
    require(isDeepStrictEqual(reviewInfoSaved.detail, { count: 1 }), "Harness did not report the saved review-emphasis answer");
    const firstReview = await eventStream.waitFor("review_required", reviewInfoSaved.id);
    await postCommand(capture, commandsUrl, headers, { type: "revise", context: REVISION }, "Harness rejected the one same-run revision");
    const revision = await eventStream.waitFor("revision_applied", firstReview.id);
    require(isDeepStrictEqual(revision.detail, { revision_count: 1 }), "Harness did not report revision_count 1");
    const secondReview = await eventStream.waitFor("review_required", revision.id);
    const progress = await waitFixtureProgress(fixture);
    assertFixtureProgress(progress);
    const beforeSubmit = await fixture.submitSnapshot();
    require(beforeSubmit.submit_count === 0, "Configured workflow submitted before final human approval");
    require(beforeSubmit.last_submission === null, "Fixture retained a submission before final human approval");

    await postCommand(capture, commandsUrl, headers, { type: "submit" }, "Harness rejected submit approval on the second review");
    const submissionStarted = await eventStream.waitFor("submission_started", secondReview.id);
    const submitted = await eventStream.waitForOneOf(
      ["application_submitted", "submission_uncertain"],
      submissionStarted.id,
    );
    if (submitted.event !== "application_submitted") {
      await manualGate("Agent submission became uncertain. Inspect headed Chrome, then press Enter here to close the smoke session.");
      throw new SmokeFailure("Agent submission became uncertain");
    }
    await waitForOneSubmit(fixture);

    const eventNames = eventStream.events.map((event) => event.event);
    assertSubsequence(eventNames, [
      "session_started",
      "additional_info_required",
      "additional_info_saved",
      "human_navigation_required",
      "review_required",
      "revision_applied",
      "review_required",
      "submission_started",
      "application_submitted",
    ]);
    const expectedStates: Record<string, string> = {
      session_started: "running",
      additional_info_required: "awaiting_additional_info",
      additional_info_saved: "running",
      human_navigation_required: "awaiting_human_navigation",
      review_required: "awaiting_human_review",
      revision_applied: "running",
      submission_started: "submitting",
      application_submitted: "submitted",
    };
    for (const event of eventStream.events) {
      const state = expectedStates[event.event];
      if (state) require(isRecord(event.session) && event.session.state === state, "Harness event carried the wrong session state");
    }

    const snapshotResponse = await fetchWithTimeout(`${args.harnessUrl}/v1/sessions/${activeSessionId}`, { headers });
    const snapshot = await jsonResponse(capture, snapshotResponse, "Final snapshot was not JSON");
    requireStatus(snapshotResponse, 200, "Final session snapshot was unavailable");
    assertSnapshot(snapshot, activeSessionId, modelMetadata);
    require(isDeepStrictEqual(submitted.session, snapshot), "Submitted SSE snapshot disagreed with the GET snapshot");

    const deleteResponse = await fetchWithTimeout(`${args.harnessUrl}/v1/sessions/${activeSessionId}`, {
      method: "DELETE",
      headers,
    });
    const deleteBody = await deleteResponse.text();
    capture.response(deleteBody);
    requireStatus(deleteResponse, 204, "DELETE did not close and clean the submitted session");
    require(deleteBody === "", "DELETE 204 unexpectedly contained a body");
    await eventStream.waitFor("closed", submitted.id, 60_000);

    const closedResponse = await fetchWithTimeout(`${args.harnessUrl}/v1/sessions/${activeSessionId}`, { headers });
    const closed = await jsonResponse(capture, closedResponse, "Closed snapshot was not JSON");
    requireStatus(closedResponse, 200, "Closed session tombstone was unavailable");
    require(closed.state === "closed", "DELETE did not publish a closed tombstone");
    require(closed.error === null, "Closed tombstone unexpectedly retained an error");
    activeSessionId = undefined;
    await eventStream.close();
    eventStream = undefined;

    const [followupCreateResponse, followupCreated] = await createSession(capture, args.harnessUrl, headers, fixture, inputs);
    requireStatus(followupCreateResponse, 202, "A fresh session could not start after ordered cleanup completed");
    require(validUuid(followupCreated.session_id), "Follow-up create returned an invalid session id");
    const followupSessionId = followupCreated.session_id;
    activeSessionId = followupSessionId;
    const followupEventsUrl = followupCreated.events_url;
    require(typeof followupEventsUrl === "string", "Follow-up create omitted its events URL");
    eventStream = new EventStream(followupEventsUrl, headers, capture);
    eventStream.start();
    const followupStarted = await eventStream.waitFor("session_started");
    const followupGate = await eventStream.waitForOneOf(
      ["human_navigation_required", "additional_info_required"],
      followupStarted.id,
    );
    require(followupGate.event === "human_navigation_required", "Follow-up session repeated an already answered information gate");
    await waitFixtureValues(
      fixture,
      {
        fullName: FULL_NAME,
        email: EMAIL,
        summerAvailability: SUMMER_AVAILABILITY,
        referralSource: REFERRAL_SOURCE,
        humanNext: "",
        reviewVisible: false,
      },
      "Follow-up session did not apply both scoped saved facts",
    );
    require(
      !eventStream.events.some((event) => event.event === "additional_info_required"),
      "Follow-up event history contained a repeated information gate",
    );
    await assertSavedUserInfo(args.userInfoJson, fixture.postingUrl, globalFactKey, applicationFactKey, reviewFactKey);

    const followupDelete = await fetchWithTimeout(`${args.harnessUrl}/v1/sessions/${followupSessionId}`, {
      method: "DELETE",
      headers,
    });
    const followupDeleteBody = await followupDelete.text();
    capture.response(followupDeleteBody);
    requireStatus(followupDelete, 204, "Follow-up session DELETE failed");
    require(followupDeleteBody === "", "Follow-up DELETE 204 unexpectedly contained a body");
    await eventStream.waitFor("closed", followupGate.id, 60_000);
    await eventStream.close();
    eventStream = undefined;
    const followupSnapshotResponse = await fetchWithTimeout(`${args.harnessUrl}/v1/sessions/${followupSessionId}`, { headers });
    const followupSnapshot = await jsonResponse(capture, followupSnapshotResponse, "Follow-up closed snapshot was not JSON");
    requireStatus(followupSnapshotResponse, 200, "Follow-up closed tombstone was unavailable");
    require(followupSnapshot.state === "closed", "Follow-up session was not closed");
    activeSessionId = undefined;
    const finalSubmit = await fixture.submitSnapshot();
    require(finalSubmit.submit_count === 1, "Cleanup changed the one-submit fixture invariant");
  } finally {
    if (activeSessionId) {
      try {
        const response = await fetchWithTimeout(`${args.harnessUrl}/v1/sessions/${activeSessionId}`, {
          method: "DELETE",
          headers,
        });
        capture.response(await response.text());
      } catch {
        // Preserve the original failure.
      }
    }
    await eventStream?.close();
    await fixture?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function run(args: Arguments): Promise<void> {
  const token = bearerToken();
  const capture = new Capture();
  let failure: unknown;
  try {
    await workflow(args, token, capture);
  } catch (error) {
    failure = error;
  }
  try {
    privacyScan(capture, token);
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    if (failure instanceof SmokeFailure) throw failure;
    throw new SmokeFailure("Smoke failed because a local service or fixture operation failed");
  }
}

async function main(): Promise<number> {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (!args) return 0;
    await run(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    return 1;
  }
  console.log("Live headed browser-harness smoke passed; OAuth/model/API/gates/approved agent submission/cleanup verified.");
  return 0;
}

process.exitCode = await main();
