# Repository Guidelines

## Project Overview

Jobhunter is a local, evidence-grounded resume-tailoring and opportunity-application system with three cooperating processes:

- `apps/resume-tailoring/`: Bun/TypeScript pipeline API for opportunity ingestion, candidate-context snapshots, model-backed tailoring, TeX compilation, PDF QA, review, and application-session orchestration.
- `apps/web/`: Next.js App Router UI for creating and monitoring runs, reviewing revisions, managing application state, and connecting OpenAI Codex OAuth.
- `apps/application/`: optional Python/FastAPI harness that controls one constrained Playwright CLI/Chrome application session with human gates.

Prefer strict contracts, provenance, immutable artifacts, bounded I/O, and public-safe errors over permissive recovery.

## Architecture & Data Flow

1. Browser code calls same-origin `/api/pipeline/*` through `apps/web/app/lib/pipeline-client.ts`. `apps/web/next.config.ts` rewrites those requests to the Bun `/v1/*` API; application SSE uses the dedicated Next route at `apps/web/app/api/application-events/[runId]/route.ts`.
2. Run creation validates and safely loads an HTTP(S) opportunity, determines `job`, `hackathon`, `competition`, or `event`, requires a fresh candidate-context snapshot, writes the input artifact, and creates the queued run transactionally.
3. `WorkerScheduler` leases at most five SQLite claim slots. `PipelineStageProcessor` claim-fences analysis, tailoring, compile/repair, deterministic QA, visual QA, and review. Edits and regeneration create guarded revisions rather than mutating finalized output.
4. Zod schemas validate public, persisted, and model data. Artifact bytes are bounded, path-contained, atomically written, hashed, then finalized in SQLite. Revisions, source hashes, claim tokens, and PDF hashes reject stale work.
5. For approved runs, `ApplicationSessionService` sends the current PDF, TeX source, profile, opportunity kind, and submit mode to the authenticated Python harness. Python owns the single live browser session and human-gate state; it calls only the bearer-protected Bun `/v1/internal/application-agent` model boundary. Snapshots and events flow back through the pipeline and web SSE bridge.
6. Runtime state is outside the checkout: `<data-root>/production/{pipeline.sqlite,context.sqlite,auth.sqlite,runs/}` for stable mode and `<data-root>/development/<encoded-branch>/...` for development. The data root is absolute `JOBHUNTER_DATA_HOME`, otherwise `$XDG_DATA_HOME/jobhunter`, otherwise `~/.local/share/jobhunter`. Never edit these stores directly.

## Key Directories

| Path | Purpose |
| --- | --- |
| `apps/resume-tailoring/src/` | Pipeline API, contracts, agents, persistence, scheduler/stages, context, auth, discovery, artifacts, and process boundaries. |
| `apps/resume-tailoring/test/` | Bun unit and integration tests for pipeline behavior. |
| `apps/web/app/` | Next pages, components, shared provider state, route handlers, and typed pipeline client. |
| `apps/web/test/` | Bun web tests; `test/e2e/` contains Playwright `*.pw.ts` scenarios. |
| `apps/application/src/browser_harness/` | FastAPI API, session state machine, Playwright CLI adapter, credentials, artifacts, and pipeline client. |
| `apps/application/tests/` | Pytest protocol, API, session, process, and optional real-browser fixture tests. |
| `apps/scripts/` | Coordinated launch, port selection, external storage, and legacy-state import. |
| `apps/user-info/` | Canonical resume and candidate evidence consumed by context sync. |
| `info/docs/apps/` | Current source-linked operational documentation. Treat `info/planning/` as historical, not authoritative. |

## Development Commands

Run commands from the repository root.

```sh
# Install
cd apps && bun install
cd apps && bun node_modules/playwright/cli.js install ffmpeg
cd apps/application && uv sync --extra dev

# Workspace
cd apps && bun run dev
cd apps && bun run typecheck
cd apps && bun run test
cd apps && bun run build
cd apps && bun run start
```

### Development and stable systems

| System | Workspace command | Web | Pipeline | Harness target | Storage namespace |
| --- | --- | --- | --- | --- | --- |
| Development | `cd apps && bun run dev` | `127.0.0.1:3556` | `127.0.0.1:3557` | `127.0.0.1:8865` | `<data-root>/development/<encoded-branch>` |
| Stable production | `cd apps && bun run build && bun run start` | `127.0.0.1:3456` | `127.0.0.1:3457` | `127.0.0.1:8765` | `<data-root>/production` |

The workspace commands start only the pipeline and Next.js web process. **They do not spawn the Python application harness.** A complete development or stable system therefore requires a separately launched `jobhunter-browser-harness` process on the matching harness port, configured to call the matching pipeline URL. Keep development and stable harness ports, Chrome profiles, user-information files, credentials files, and storage namespaces separate.

Stable production requires a prior build and may run only from the primary checkout on `main`. Linked worktrees must use the development system and development storage. See `info/docs/apps/index.html` and `info/docs/apps/browser-harness/application.html` for the complete harness commands.

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

The aggregate `cd apps && bun run test` runs `apps/scripts/launch-config.test.ts`, then all pipeline and web Bun tests. It does not run Playwright E2E or Python tests. No lint or format command is configured.

## Code Conventions & Common Patterns

- **Contract-first boundaries:** TypeScript uses strict Zod schemas; Python models are strict/frozen and forbid extra fields. Keep URL, enum, size, hash, and semantic checks at ingress and persistence boundaries.
- **Explicit dependency injection:** `apps/resume-tailoring/src/bootstrap.ts` is the TypeScript composition root. Python constructs protocol-backed collaborators in `browser_harness/cli.py`. Extend existing constructor/options seams instead of adding mutable globals.
- **Guarded state machines:** Run, revision, attempt, claim, application-session, and browser states have explicit transitions. Keep related SQLite writes in repository-owned `BEGIN IMMEDIATE` transactions. Finalized artifacts, events, and source snapshots are immutable.
- **Bounded async work:** Propagate `AbortSignal` and deadlines through TypeScript fetches, model calls, subprocesses, and scheduler work. Python uses `asyncio` locks, conditions, tasks, and monotonic session deadlines. Do not add unbounded queues, detached work, or unconstrained concurrency.
- **Public-safe errors:** Map expected failures to stable codes and bounded messages. Never expose exceptions, provider output, prompts, tokens, private evidence, claim data, or filesystem paths. Preserve `no-store` reads.
- **Filesystem/process safety:** Reject traversal and symlinks, use private modes and atomic writes, and verify byte count/SHA-256. External tools remain allowlisted, `shell: false`, environment-sanitized, output-bounded, timed out, and process-group cancelled.
- **Frontend state:** Shared run/identity/OAuth snapshots live in `DashboardDataProvider`; application stream/action state stays in `RunReviewWorkspace`. Use the same-origin pipeline client, poll only while active, and reject stale responses with request/version guards.
- **Naming and formatting:** TypeScript files are generally kebab-case, symbols PascalCase/camelCase; Python modules/functions are snake_case and classes PascalCase. Tests use `*.test.ts[x]`, `*.pw.ts`, and `test_*.py`. No formatter is configured—match adjacent style and avoid broad restyling.
- **Documentation:** Before changing behavior, read the relevant `info/docs/` page; update every affected page afterward. Docs are standalone semantic HTML with source links, commands, constraints, failure states, troubleshooting, and valid local links/fragments.

Pipeline TypeScript additionally enables `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; preserve the distinction between missing, `undefined`, and `null`.

## Important Files

| Path | Why it matters |
| --- | --- |
| `apps/package.json` | Bun `1.3.14` workspace and aggregate commands. |
| `apps/scripts/{serve,launch-config,launch-storage}.ts` | Coordinated lifecycle, stable/development ports, storage namespaces, and safe import. |
| `apps/resume-tailoring/src/{index,bootstrap}.ts` | Pipeline entry point and composition/lifecycle root. |
| `apps/resume-tailoring/src/contracts/index.ts` | Shared strict API contracts consumed by pipeline and web. |
| `apps/resume-tailoring/src/db/repository.ts` | Durable state machines, transactions, claims, revisions, events, and artifact metadata. |
| `apps/resume-tailoring/src/stages/processor.ts` | End-to-end tailoring workflow and repair/QA orchestration. |
| `apps/resume-tailoring/context-sources.json` | Exact allowlist of authoritative candidate-context sources. |
| `apps/web/{next.config.ts,app/lib/pipeline-client.ts}` | Same-origin rewrite and browser API validation/redaction boundary. |
| `apps/web/app/providers/dashboard-data-provider.tsx` | Existing shared React state owner. |
| `apps/application/{pyproject.toml,uv.lock}` | Python runtime, dependencies, console entry point, and pytest setup. |
| `apps/application/src/browser_harness/{cli,api,sessions,playwright_cli}.py` | Harness composition, HTTP boundary, single-session state, and browser adapter. |
| `info/docs/apps/index.html` | Canonical commands and links to pipeline, web, and harness operations. |

## Runtime/Tooling Preferences

- Use Bun `1.3.14` and committed `apps/bun.lock` for the TypeScript workspace; do not create npm, pnpm, Yarn, or alternate lockfiles.
- Use Python `3.12` with `uv` and `apps/application/uv.lock`. The harness also needs Node.js, exact `@playwright/cli` `0.1.17`, matching direct `playwright` runtime `1.62.0-alpha-1783623505000`, and the installed ffmpeg codec.
- Production pipeline processing targets Linux with `/proc`. TeX/PDF stages require `latexmk`, `pdfinfo`, `pdftotext`, `pdffonts`, and `pdftoppm`; run `doctor` rather than guessing which prerequisite is missing.
- Provider access is OpenAI Codex OAuth only. Do not add provider API keys. Pipeline and harness share a private `JOBHUNTER_HARNESS_TOKEN` of at least 32 code points; never put it in browser code, URLs, source, or logs.
- Do not edit generated `apps/web/next-env.d.ts`. Treat build output, test results, external SQLite state, browser profiles, credentials, and run artifacts as generated/private even when a path is not ignored by Git.

## Testing & QA

- Pipeline and web unit/integration tests use `bun:test`. Prefer in-memory SQLite, temporary roots, deterministic clocks/IDs, injected agents/processes/transports, and exact contract assertions. Avoid live providers and non-loopback network.
- Restore globals such as `fetch`, close databases/services, and clean temporary resources in hooks or `finally`.
- Web component tests use pure helpers or `renderToStaticMarkup`; browser behavior belongs in Playwright. E2E runs one worker, starts only Next, and intercepts `/api/pipeline/**`; use controlled promises/events instead of fixed sleeps for races.
- Python uses pytest with `pytest-asyncio` automatic mode, `tmp_path`, `monkeypatch`, fake process/runtime collaborators, and HTTPX ASGI/Mock transports. The optional real-Chromium fixture uses isolated loopback servers and skips when Chrome, Node, or Playwright CLI is unavailable.
- `apps/resume-tailoring/test/docs.test.ts` validates the canonical HTML docs, links/fragments, and command sampleTool. Run it for documentation changes.
- No coverage tool or threshold is configured. For behavior changes, add or update the narrowest contract test, run that focused suite plus the relevant typecheck, and use Playwright or a real smoke scenario when the changed behavior crosses a browser/runtime boundary.
