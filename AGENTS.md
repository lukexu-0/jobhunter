# Repository Guidelines

## Project Overview

Jobhunter is a local, evidence-grounded system for opportunity discovery, resume tailoring, review, and application assistance. It has three cooperating processes:

- `apps/resume-tailoring/`: Bun/TypeScript pipeline API, SQLite workflow engine, discovery catalog, candidate-context snapshots, model-backed tailoring, TeX/PDF generation, QA, and application orchestration.
- `apps/web/`: Next.js App Router UI for starting and monitoring runs, reviewing revisions, browsing discovery results, managing application state, and connecting OpenAI Codex OAuth.
- `apps/application/`: separately launched Python/FastAPI harness that owns one constrained Playwright CLI/Chrome application session with human gates.

Prefer strict contracts, provenance, immutable artifacts, bounded I/O, and public-safe failures. Candidate evidence under `apps/user-info/` is private input, not general engineering documentation.

## Architecture & Data Flow

1. Browser code calls same-origin `/api/pipeline/*` through `apps/web/app/lib/pipeline-client.ts`. `apps/web/next.config.ts` rewrites those calls to the Bun `/v1/*` API; application SSE uses `apps/web/app/api/application-events/[runId]/route.ts`.
2. Run creation validates a URL or pasted description, loads/extracts opportunity text, requires a fresh candidate-context snapshot, writes a bounded input artifact, and transactionally creates the queued run, revision, source snapshot, and events.
3. `WorkerScheduler` leases at most five SQLite claims. `PipelineStageProcessor` claim-fences `analyzing → tailoring/editing → compiling/repairing → deterministic_qa → visual_qa → review/approved`. Stages create new artifacts and guarded revisions; they do not mutate finalized output.
4. `PipelineRepository` owns durable run, revision, attempt, claim, event, source-snapshot, and application-session state. `ArtifactStore` owns bounded, path-contained bytes. Writes are atomic and SHA-256/size verified; claim tokens and source/PDF hashes reject stale work.
5. Shared React data lives in `DashboardDataProvider`; detail/review and application-stream state live in their owning workspace components. Poll only while work is active and reject stale responses with request/version or generation/event guards.
6. For approved URL-backed runs, `ApplicationSessionService` sends the approved PDF, TeX source, profile, and mode to the bearer-protected Python harness. Python owns the singleton live browser session and human gates, and calls only the private Bun `/v1/internal/application-agent` model boundary. Harness snapshots/events return through SQLite and the web SSE bridge.
7. Runtime state is outside the checkout: `<data-root>/production/{pipeline.sqlite,context.sqlite,auth.sqlite,runs/}` or `<data-root>/development/<encoded-branch>/...`. `<data-root>` is absolute `JOBHUNTER_DATA_HOME`, otherwise absolute `$XDG_DATA_HOME/jobhunter`, otherwise `~/.local/share/jobhunter`. Never edit these stores directly.

## Key Directories

| Path | Purpose |
| --- | --- |
| `apps/resume-tailoring/src/` | Pipeline contracts, API, persistence, scheduler/stages, context, discovery, auth, agents, artifacts, and process boundaries. |
| `apps/resume-tailoring/test/` | Bun unit and integration tests for pipeline behavior. |
| `apps/web/app/` | Next pages, route handlers, components, provider state, and typed pipeline client. |
| `apps/web/test/` | Bun web tests; `test/e2e/` contains Playwright `*.pw.ts` scenarios. |
| `apps/application/src/browser_harness/` | FastAPI boundary, session state machine, Playwright adapter, credentials, artifacts, and pipeline client. |
| `apps/application/tests/` | Pytest protocol, API, session, process, and optional real-browser fixture tests. |
| `apps/scripts/` | Coordinated launch, port/storage selection, backups, state import, and verified recovery. |
| `apps/user-info/` | Canonical private resume and candidate evidence consumed by context sync. |
| `info/docs/apps/` | Current source-linked operational documentation. `info/planning/` is historical, not authoritative. |

## Development Commands

Run these from the repository root:

```sh
# Install
cd apps && bun install
cd apps && bun node_modules/playwright/cli.js install ffmpeg
cd apps/application && uv sync --extra dev

# Coordinated pipeline + web workspace
cd apps && bun run dev
cd apps && bun run typecheck
cd apps && bun run test
cd apps && bun run build
cd apps && bun run start
```

Focused checks:

```sh
cd apps && bun run --cwd resume-tailoring test
cd apps && bun run --cwd web test
cd apps && bun run --cwd web test:e2e
cd apps/application && uv run --extra dev python -m pytest

cd apps && bun test scripts/launch-config.test.ts scripts/user-context-backup.test.ts
cd apps && bun run --cwd resume-tailoring context:sync -- --check
cd apps && bun run --cwd resume-tailoring context:sync
cd apps && bun run --cwd resume-tailoring doctor
```

| Mode | Command | Web | Pipeline | Harness | Storage |
| --- | --- | --- | --- | --- | --- |
| Development | `cd apps && bun run dev` | `127.0.0.1:3556` | `127.0.0.1:3557` | separately launch on `127.0.0.1:8865` against pipeline `3557` | `<data-root>/development/<encoded-branch>` |
| Stable | `cd apps && bun run build && bun run start` | `127.0.0.1:3456` | `127.0.0.1:3457` | separately launch on `127.0.0.1:8765` against pipeline `3457` | `<data-root>/production` |

The workspace launcher never starts the Python harness. Keep development and stable harness ports, Chrome profiles, credentials, user-information files, and storage namespaces separate. Stable start is allowed only from the primary checkout on `main`; linked worktrees must use development services and storage. See `info/docs/apps/browser-harness/application.html` for token, profile, credential, and launch commands.

## Code Conventions & Common Patterns

- **Contract-first boundaries:** TypeScript uses strict/discriminated Zod schemas; Python models are strict/frozen Pydantic and forbid extra fields. Validate URLs, enums, sizes, hashes, and semantics at ingress and persistence boundaries.
- **Explicit dependency injection:** `apps/resume-tailoring/src/bootstrap.ts` is the TypeScript composition root. Python wires protocol-backed collaborators in `browser_harness/cli.py`. Extend constructor/options seams; do not add mutable globals.
- **Guarded state machines:** Run, revision, attempt, claim, application-session, and browser states have explicit transitions. Keep related SQLite writes in repository-owned `BEGIN IMMEDIATE` transactions.
- **Bounded async work:** Propagate `AbortSignal` and deadlines through TypeScript fetches, model calls, subprocesses, scheduler work, and cleanup. Python uses `asyncio` locks, tasks, conditions, and monotonic deadlines. Avoid detached work, fixed-sleep race handling, unbounded queues, and unconstrained concurrency.
- **Public-safe errors:** Map expected failures to stable codes and bounded messages. Never expose exceptions, provider output, prompts, tokens, private evidence, claims, PIDs, session details, or filesystem paths. Preserve `no-store` responses.
- **Filesystem/process safety:** Reject traversal and symlinks; use private modes, atomic writes, byte limits, and SHA-256 checks. Keep subprocesses allowlisted, `shell: false`, environment-sanitized, output-bounded, timed out, and process-group cancellable.
- **Frontend state:** Reuse `DashboardDataProvider` and the existing detail/review state owners. Browser code must use the same-origin typed pipeline client, not direct loopback APIs.
- **Naming and formatting:** TypeScript files are generally kebab-case; symbols use PascalCase/camelCase. Python modules/functions use snake_case and classes use PascalCase. Tests use `*.test.ts[x]`, `*.pw.ts`, and `test_*.py`. No formatter or linter is configured—match adjacent style and avoid broad restyling.
- **Optional fields:** Pipeline TypeScript enables `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; preserve distinctions among missing, `undefined`, and `null`.
- **Documentation:** Before changing behavior, read the relevant `info/docs/` page and update every affected page afterward. These pages are standalone semantic HTML with source links, commands, boundaries, failure states, troubleshooting, and valid local links/fragments.

## Important Files

| Path | Why it matters |
| --- | --- |
| `apps/package.json` and `apps/bun.lock` | Bun version, workspaces, dependencies, and aggregate commands. |
| `apps/scripts/{serve,launch-config,launch-storage}.ts` | Process lifecycle, stable/development isolation, ports, external storage, and import safety. |
| `apps/scripts/user-context-backup.ts` | Private candidate-context snapshot, verification, retention, restore, and rollback rules. |
| `apps/resume-tailoring/src/{index,bootstrap}.ts` | Pipeline process entry point and composition/lifecycle root. |
| `apps/resume-tailoring/src/contracts/index.ts` | Strict shared API contracts consumed by pipeline and web. |
| `apps/resume-tailoring/src/db/repository.ts` | Durable state machines, transactions, claims, revisions, events, and artifact metadata. |
| `apps/resume-tailoring/src/stages/processor.ts` | End-to-end analysis, tailoring, compile/repair, and QA orchestration. |
| `apps/resume-tailoring/context-sources.json` | Allowlist of authoritative candidate-context sources. |
| `apps/web/{next.config.ts,app/lib/pipeline-client.ts}` | Same-origin rewrite and browser validation/redaction boundary. |
| `apps/web/app/providers/dashboard-data-provider.tsx` | Shared React run, identity, and OAuth state owner. |
| `apps/web/app/components/run-review-workspace.tsx` | Application SSE projection, action latches, and review state. |
| `apps/application/{pyproject.toml,uv.lock}` | Python runtime, exact dependencies, console entry point, and pytest setup. |
| `apps/application/src/browser_harness/{cli,api,sessions}.py` | Harness composition, HTTP/auth boundary, and singleton browser-session state machine. |
| `info/docs/apps/index.html` | Canonical workspace operations and links to pipeline, web, and harness documentation. |

## Runtime/Tooling Preferences

- Use Bun `1.3.14` with committed `apps/bun.lock`; do not create npm, pnpm, Yarn, or alternate lockfiles.
- Use Python `>=3.12,<3.13` with `uv` and committed `apps/application/uv.lock`.
- The harness also requires Node.js, exact `@playwright/cli` `0.1.17`, matching `playwright` `1.62.0-alpha-1783623505000`, Chrome, and the installed ffmpeg codec.
- Pipeline processing targets Linux. TeX/PDF work requires `latexmk`, `pdfinfo`, `pdftotext`, `pdffonts`, and `pdftoppm`; generic rendered HTML fallback also requires the documented Chrome/systemd boundary. Run `doctor` instead of guessing which prerequisite is missing.
- Provider access is OpenAI Codex OAuth only; do not add provider API keys. Pipeline and harness share a private `JOBHUNTER_HARNESS_TOKEN` of at least 32 code points. Never put it in browser code, URLs, source, or logs.
- No project `.env` template, CI workflow, container deployment, formatter, or linter is configured. Follow manifests and canonical HTML docs rather than inventing tooling.
- Do not edit generated `apps/web/next-env.d.ts`, pipeline `dist/`, Next `.next/`, test output, browser profiles, credentials, external SQLite state, or run artifacts.

## Testing & QA

- `cd apps && bun run test` runs both workspace-script tests (`launch-config` and `user-context-backup`), then all pipeline and web Bun tests. It does not run Playwright E2E or Python pytest.
- Pipeline and web unit/integration tests use `bun:test`. Prefer in-memory SQLite, temporary roots, deterministic clocks/IDs, injected fetch/model/process collaborators, controlled promises/events, and exact contract assertions. Do not use live providers or non-loopback network.
- Restore globals such as `fetch`, close databases/services/servers, and remove temporary resources in hooks or `finally`.
- Web component tests use pure helpers or `renderToStaticMarkup`; browser interaction belongs in Playwright. E2E uses one worker, a fresh Next server, intercepted `/api/pipeline/**` calls, and controlled SSE. Prefer `expect.poll` or events over fixed sleeps.
- Python uses pytest with `pytest-asyncio` automatic mode, `tmp_path`, `monkeypatch`, fake runtime collaborators, and HTTPX ASGI/Mock transports. The real-Chromium fixture is optional and skips when Chrome, Node, or Playwright CLI is unavailable.
- `apps/resume-tailoring/test/docs.test.ts` validates canonical HTML docs, links/fragments, and documented commands. Run it when changing `info/docs/`.
- No coverage tool or threshold is configured. For behavior changes, add or update the narrowest observable contract test, run the focused suite plus relevant typecheck, and use Playwright or the documented headed smoke when behavior crosses a browser/runtime boundary.
