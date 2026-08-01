# Repository Guidelines

## Project Overview

Jobhunter is a local, evidence-grounded resume tailoring and application system with three cooperating components:

- A Bun/TypeScript pipeline that ingests job postings, snapshots candidate context, runs model-backed analysis and tailoring, compiles TeX, performs PDF QA, and persists revision history.
- A Next.js review UI for initializing runs, tracking workflow state, reviewing artifacts, and managing provider OAuth.
- An optional Python/FastAPI browser harness for a constrained, human-gated application workflow.

The system favors strict contracts, source provenance, immutable artifacts, bounded I/O, and redacted public errors over permissive recovery.

## Architecture & Data Flow

1. The browser calls the Next app on `127.0.0.1:3456`. `apps/web/app/lib/pipeline-client.ts` validates requests and responses with shared schemas and uses same-origin `/api/pipeline/*` URLs.
2. `apps/web/next.config.ts` rewrites those URLs to the Bun pipeline at `127.0.0.1:3457/v1/*`.
3. Pipeline routes delegate to `RunApplicationService`, which validates the job source, requires fresh context, snapshots source hashes, writes the input artifact, and creates a queued run transactionally.
4. `WorkerScheduler` serially claims work. `PipelineStageProcessor` drives `queued → analyzing → tailoring → compiling → deterministic QA → visual QA → review`; editing, regeneration, retry, and repair create or reuse revisions under explicit state rules.
5. Model, TeX, Poppler, and visual-QA outputs are schema checked, size bounded, atomically written, hashed, and finalized in SQLite. Approval/edit commands use source hashes, revisions, and expected PDF hashes as conflict guards.
6. The Python harness listens on `127.0.0.1:8765`, owns browser/session/human-gate state, and calls only the bearer-protected Bun `/v1/internal/application-agent` boundary. Do not import across this Python/TypeScript boundary or expose the internal route to browser code.

Persistent state is split deliberately:

- Pipeline state: `apps/resume-tailoring/data/state/pipeline.sqlite`
- Context index: `apps/resume-tailoring/data/context/context.sqlite`
- OAuth state: `apps/resume-tailoring/data/oauth/auth.sqlite`
- Run files: `output/runs/<queue_sequence>/`

Treat these as runtime-owned stores. Use repository/services and supported scripts rather than ad hoc mutation.

Context directives use the literal five-source allowlist: `apps/user-info/resume-main/Alex_Example_Resume.tex`, `apps/user-info/current-context/jobs/Example-Company/automated-testing-resume-info.md`, `apps/user-info/current-context/projects/sample-project-archive.md`, `apps/user-info/current-context/projects/sample-project.md`, and `jobhunter-resume-info.md`. The fifth source has ID `jobhunter-resume-info`, entity ID `project:jobhunter`, display name `Jobhunter resume information`, and baseline entity ID `Resume Tailoring and Application Agent`; its two directives are indexed and exposed in the model-readable Must Include channel. The canonical baseline now contains the replacement project titled `Resume Tailoring and Application Agent`. The sample-project-archive dossier remains a literal context source but does not map to a baseline project; no project entity is synthesized. Snapshots ignore retained source heads outside the current manifest. Only active evidence from an allowlisted `authoritative-markdown` source with an exact parsed terminal heading matching `^(?:21\.\s+)?Must Include$` becomes a separately typed requirement. A directive is a trusted requirement, never factual evidence; it activates only when a supported non-skill bullet edit targets the same or an explicitly equivalent entity and cites non-directive factual Jobhunter evidence from that same or equivalent entity. Baseline presence or bullet retention alone does not activate a directive. Disallowed sources, other headings, or the exact case-sensitive `None specified` sentinel produce no directive.

Analysis and edit model inputs separate directive metadata from factual authoritative evidence. Every evidence block under a matching Must Include heading, including the `None specified` sentinel, is excluded from factual projections and factual support validation. Only supported non-skill bullet edits on same- or equivalent-entity targets that cite non-directive factual evidence activate directives; baseline presence or retention does not. Validation requires every active directive to remain on a same- or equivalent-entity factual edit and plan decision. Neither Must Include section IDs nor directive IDs can support keywords, skills, fact winners, omissions, one-page correction candidates, or comments; active directive target bullets are not one-page omission candidates.

## Key Directories

| Path | Purpose |
| --- | --- |
| `apps/resume-tailoring/src/` | Pipeline API, contracts, persistence, scheduler, stages, agents, context, auth, artifact and process boundaries. |
| `apps/resume-tailoring/test/` | Bun unit/integration tests with in-memory SQLite, injected fakes, and temporary artifact roots. |
| `apps/web/app/` | Next App Router pages, React components/providers, and the typed pipeline client. |
| `apps/web/test/` | Bun web tests; `test/e2e/` contains Playwright `*.pw.ts` scenarios. |
| `apps/application/src/browser_harness/` | Python FastAPI API, session orchestration, browser security, pipeline client, and Bubblewrap skill runtime. |
| `apps/application/tests/` | Pytest protocol/unit tests and Linux/Chromium fixture workflows. |
| `apps/scripts/` | Workspace orchestration, especially the coordinated development launcher. |
| `apps/user-info/` | Canonical resume and candidate evidence consumed by context sync. |
| `info/docs/apps/` | Source-linked operational documentation for the workspace, pipeline, web UI, and browser harness. |
| `output/runs/` | Ignored runtime artifacts addressed by durable numeric queue sequence. |

## Development Commands

Run workspace commands from the repository root:

```sh
cd apps && bun install
cd apps && bun run dev
cd apps && bun run test
cd apps && bun run typecheck
cd apps && bun run build
```

`bun run dev` starts the pipeline, waits up to 30 seconds for `http://127.0.0.1:3457/v1/health`, then starts Next on port `3456`. Stop the coordinated launcher with `Ctrl+C` so both children shut down.

Focused commands:

```sh
cd apps && bun run --cwd resume-tailoring test
cd apps && bun run --cwd web test
cd apps && bun run --cwd web test:e2e
cd apps/application && uv run --extra dev python -m pytest

cd apps && bun run --cwd resume-tailoring context:sync -- --check
cd apps && bun run --cwd resume-tailoring context:sync
cd apps && bun run --cwd resume-tailoring doctor
```

The aggregate `cd apps && bun run test` runs only the pipeline and web Bun suites. It does not run Playwright or Python tests. There is no configured lint or format command.

## Code Conventions & Common Patterns

- **Contract first:** Validate every external, persisted, or model-produced value. TypeScript uses strict Zod schemas; Python uses strict Pydantic models with extra fields forbidden. Keep bounds, hashes, enums, and semantic validation at the boundary.
- **Explicit dependency injection:** `apps/resume-tailoring/src/bootstrap.ts` is the TypeScript composition root. Services accept repositories, agents, clocks, processes, and other boundaries explicitly. Python uses protocols and constructor-injected collaborators. Extend these seams instead of adding mutable globals.
- **State machines, not flag patches:** Run, revision, attempt, claim, session, and application states have guarded transitions. Persist related changes in the existing `BEGIN IMMEDIATE` repository transactions. Events, finalized artifacts, source snapshots, and edit requests are intentionally immutable.
- **Cancellation and deadlines:** Propagate `AbortSignal` through TypeScript async work. The scheduler owns one serial claim and heartbeats it; agent tool concurrency is intentionally one. Python uses `asyncio` tasks, locks, conditions, and explicit session deadlines. Never add unbounded background work.
- **Errors stay public-safe:** Map expected failures to stable domain codes and bounded messages. Do not return raw exceptions, provider output, prompts, tokens, filesystem paths, claim data, or private evidence. Preserve `no-store` behavior on API reads.
- **Filesystem/process safety:** Keep artifact paths contained, reject symlinks, use atomic writes, and retain SHA-256/size checks. External processes are allowlisted and run with `shell: false`, sanitized environments, output limits, timeouts, and process-group cancellation.
- **Frontend state:** Shared dashboard data lives in `DashboardDataProvider`. Poll only while needed and guard against stale responses with request IDs; do not introduce a second state-management convention. Browser code must use the same-origin pipeline client.
- **Naming:** TypeScript files are generally kebab-case, types/classes PascalCase, and functions/values camelCase. Python modules/functions are snake_case and classes PascalCase. Tests use `*.test.ts[x]`, Playwright uses `*.pw.ts`, and pytest uses `test_*.py`.
- **Formatting:** No repository formatter is configured. Match adjacent style; do not introduce ESLint, Prettier, Biome, Ruff, or broad restyling incidentally.
- **Documentation:** Before a repository change, read the relevant page under `info/docs/`; afterward, update every affected page. Project docs are semantic standalone HTML with source links, concrete commands, boundaries, failure states, troubleshooting, and valid local links/fragments.

TypeScript is configured with strict mode, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` in the pipeline. Do not treat missing, `undefined`, and `null` as interchangeable. Use readonly interfaces/private fields where surrounding code does.

## Important Files

| Path | Why it matters |
| --- | --- |
| `apps/package.json` | Bun workspace membership and aggregate dev/test/typecheck/build commands. |
| `apps/scripts/dev.ts` | Pipeline-first startup, health wait, signal forwarding, and coordinated shutdown. |
| `apps/resume-tailoring/src/index.ts` | Pipeline process entry point. |
| `apps/resume-tailoring/src/bootstrap.ts` | Composition root and lifecycle boundary. |
| `apps/resume-tailoring/src/contracts/index.ts` | Shared strict public/API contracts consumed by pipeline and web. |
| `apps/resume-tailoring/src/db/repository.ts` | Run state machine, transactions, claims, revisions, events, and artifact metadata. |
| `apps/resume-tailoring/src/stages/processor.ts` | End-to-end workflow orchestration and retry/repair behavior. |
| `apps/resume-tailoring/src/context/service.ts` | Evidence indexing, freshness checks, and immutable source snapshots. |
| `apps/resume-tailoring/src/system/artifacts.ts` | Contained atomic artifact I/O and integrity limits. |
| `apps/resume-tailoring/context-sources.json` | Exact allowlist of authoritative candidate-context sources. |
| `apps/web/app/lib/pipeline-client.ts` | Browser API boundary, schema validation, and error redaction. |
| `apps/web/next.config.ts` | Same-origin pipeline rewrite and workspace transpilation. |
| `apps/application/pyproject.toml` | Python runtime, dependency pins, console script, and pytest configuration. |
| `apps/application/src/browser_harness/{api,sessions,skill_runtime}.py` | Harness API, single-session lifecycle, and sandboxed browser runtime. |
| `info/docs/apps/index.html` | Canonical workspace commands and links to component-specific operations. |

## Runtime/Tooling Preferences

- Use Bun `1.3.14` and the committed `apps/bun.lock` for TypeScript packages; do not substitute npm, pnpm, Yarn, Node-only execution, or another lockfile.
- The browser harness requires Python `>=3.12,<3.13`; `apps/application/uv.lock` pins Python `3.12.*`. Install the documented development environment with:

  ```sh
  python3.12 -m venv apps/application/.venv
  apps/application/.venv/bin/python -m pip install -e 'apps/application[dev]'
  apps/application/.venv/bin/browser-use install
  ```

- The pipeline requires `latexmk` plus Poppler tools `pdfinfo`, `pdftotext`, `pdffonts`, and `pdftoppm`. Use `doctor` to check prerequisites.
- Provider access is application-owned OAuth only. Never add provider API keys. The browser harness and pipeline must share a `JOBHUNTER_HARNESS_TOKEN` of at least 32 characters; never expose it to browser code, URLs, source, or logs.
- The Python sandbox expects Linux Bubblewrap (`/usr/bin/bwrap`). WSL browser operation uses the documented CDP path rather than an unsafe/default Chrome profile.
- Do not edit generated `apps/web/next-env.d.ts` or ignored runtime output (`.next/`, `dist/`, SQLite data, browser artifacts, `output/runs/`).

## Testing & QA

- Pipeline and web unit/integration tests use `bun:test`. Prefer in-memory SQLite, temporary directories, deterministic clocks/IDs, injected agents/processes, and exact contract assertions. Do not call live providers or the network.
- Restore globals such as `fetch`, close databases/services, and remove temporary files in cleanup hooks. Tests must remain deterministic and full-suite safe.
- Web component tests may use `renderToStaticMarkup`; browser behavior belongs in Playwright. E2E tests intercept exact `/api/pipeline/**` methods and payloads, use one worker, and explicitly exercise polling races, accessibility, responsive layout, and public-data boundaries. Prefer controlled promises/events over fixed sleeps.
- Python uses pytest with `pytest-asyncio` in automatic mode, `tmp_path`, `monkeypatch`, fake Browser/Bubblewrap processes, and HTTPX ASGI transports. Real Chromium/Bubblewrap fixture tests are Linux-only and may skip when prerequisites are absent.
- `apps/resume-tailoring/test/docs.test.ts` verifies standalone HTML5 docs, local links/fragments, and canonical command sampleTool. Run it when documentation changes.
- No coverage tool or threshold is configured. For a behavioral change, add or update the narrowest test that proves the changed contract, then run that focused suite and the relevant typecheck; use Playwright for UI behavior and a smoke scenario for runtime integration.
