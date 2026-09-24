# Repository Guidelines

## Project Overview

Jobhunt is a local-first job-application system. It imports job details, analyzes fit, tailors and compiles a resume, runs deterministic and visual QA, presents the result for review, and can hand an approved run to human-gated browser automation.

Three processes cooperate:

- `apps/backend`: Bun/TypeScript pipeline, durable workflow, and HTTP API.
- `apps/web`: Next.js App Router review and operations UI.
- `apps/harness`: TypeScript/Bun service that drives Playwright CLI sessions.

Treat `.jobhunt-data/user-info/`, credentials, generated resumes, model traces, runtime databases, artifacts, and browser profiles as private runtime data. Never use their contents in logs, tests, commits, or documentation examples.

## Architecture & Data Flow

1. The web UI calls same-origin `/api/pipeline` endpoints through `apps/web/app/lib/pipeline-client.ts`. `apps/web/next.config.ts` rewrites them to backend `/v1` routes. Application sessions reconcile public snapshots by polling; the frontend does not hold persistent application event streams.
2. `apps/backend/src/index.ts` starts the pipeline. `apps/backend/src/bootstrap.ts` is the composition root for repositories, artifact storage, workers, services, routes, model tooling, and the harness client.
3. API contracts originate in Zod schemas under `apps/backend/src/contracts/`. The web mirrors and validates wire payloads; the harness uses strict Zod models. Coordinate contract changes across all three processes.
4. `PipelineRepository` stores runs, attempts, events, claims, application sessions, and artifact lineage in SQLite. `WorkerScheduler` leases fenced claims; `PipelineStageProcessor` advances analysis → tailoring/editing → compile/repair → deterministic/visual QA → review. Do not bypass repository or state-machine transitions.
5. Approved runs can create harness sessions. The Bun harness owns browser state, credential redaction, and human gates for missing information, CAPTCHA, review, and final submission. Harness SSE is projected durably by the backend; the web reconciles those public snapshots.

Frontend coordination belongs to framework-independent modules:

- `application-session.ts` owns command lifetimes, projection ordering, polling, and ambiguous delivery. `use-application-session.ts` binds that lifetime to React. HTTP acceptance is not workflow completion.
- `authorization-session.ts` owns provider/session coordination, cancellation, status reconciliation, and application-model selection. The OAuth view retains synchronous popup reservation and private prompt drafts.
- `run-collection.ts` owns Run membership, attention observers, dashboard-scoped identity metadata, and semantic updates. `DashboardDataProvider` subscribes to it; the dashboard retains view state and distinct bulk-operation policies. Creation scopes prevent delayed results from restoring removed Runs.

Keep reconciliation in these modules and transient drafts in their views. An asynchronous dialog completion may change errors, close a dialog, or restore focus only while it still owns that exact dialog.

Preserve these boundaries. Keep external I/O bounded and cancellation-aware, sanitize public errors, and never blindly retry an ambiguous application submission.

## Key Directories

| Path | Purpose |
| --- | --- |
| `apps/backend/src/` | Pipeline API, contracts, SQLite persistence, stages, agents, resume tools, and workers. |
| `apps/backend/test/` | Bun behavior and integration tests for the pipeline. |
| `apps/web/app/` | App Router pages, components, providers, API bridges, and typed pipeline transport. |
| `apps/web/test/` | Bun tests; `test/e2e/` contains Playwright specs. |
| `apps/harness/src/` | CLI, HTTP surface, sessions, browser tools, credentials, and OAuth. |
| `apps/harness/tests/` | Bun test suite and loopback browser fixtures. |
| `misc/scripts/` | Launch, doctor, backup/restore, context sync, and production operations. |
| `misc/patches/` | Required dependency patches, including patched Playwright core. |
| `.jobhunt-data/user-info/` | Git-ignored applicant source data shared by development and production in this checkout; never treat it as test or documentation material. |

Backend launcher storage lives in Git-ignored `.jobhunt-data/` at the checkout root, split into `development/<encoded-branch>/` and `production/`. Launch does not import data from an external namespace. Existing installations require a one-time, deliberate offline copy before starting the matching pipeline: stop that pipeline, copy the relevant SQLite databases and their WAL state consistently into the checkout-local namespace, copy run artifacts and user-context snapshots, then rebind persisted artifact paths and backup manifests to the destination checkout and storage root. Keep the external originals unmodified for rollback; do not rely on launch or artifact restore to find them. Stable startup snapshots a present user-context tree before launch, and restores use local storage only. Harness browser and OAuth data remain separate under `~/.jobhunt/browser-harness/`.

For a new checkout, start with no applicant tree or create your own private files under .jobhunt-data/user-info/. A fresh stable start skips its pre-start snapshot only while that tree does not exist; an existing tree must snapshot successfully. The baseline resume source ID is resume-main at .jobhunt-data/user-info/resume-main/resume.tex. To supply your own source: mkdir -p .jobhunt-data/user-info/resume-main, then create .jobhunt-data/user-info/resume-main/resume.tex privately. No applicant resume, transcript, credentials, or sample data is checked in. An optional transcript requires JOBHUNT_TRANSCRIPT_PDF set to an absolute private PDF path. Put local launch secrets in Git-ignored apps/.env.local, and keep independent user-context backups outside this checkout. Startup never imports a top-level user-info/ tree; older snapshots with user-info/ or apps/user-info/ paths restore into the checkout-local tree.

## Development Commands

Use the root `Makefile` as the command facade:

```sh
make install       # frozen Bun installs for all three applications
make dev           # backend and web; does not start the harness
make harness       # harness on :8865 against development pipeline :3557
make typecheck     # backend, web, and harness TypeScript
make build         # backend, harness, and Next production builds
make test          # script, backend, web, and harness suites
make check         # typecheck + build + test; excludes E2E
make test-e2e      # web Playwright suite
make doctor        # runtime and external-tool diagnostics
```

`make dev` runs from `apps/` so Bun loads `apps/.env.local`. Start `make harness` separately from the repository root; configure the same `JOBHUNT_HARNESS_TOKEN` (at least 32 characters) explicitly for the pipeline and harness. The pipeline does not inherit a token from `~/.jobhunt/browser-harness/token`.

Useful narrow checks:

```sh
(cd apps/backend && bun test test/repository.test.ts)
(cd apps/backend && bun test test/artifact-repository.test.ts)
(cd apps/web && bun test test/pipeline-client.test.ts)
(cd apps/harness && bun test tests/sessions.test.ts)
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
```

On macOS, run backend tests from `apps/backend` with `TMPDIR="$(bun -p 'require("node:fs").realpathSync(require("node:os").tmpdir())')" bun test` so temporary paths satisfy the canonical-path checks.

There is no configured lint or formatter command. Do not invent one; `make check` is the repository-defined non-E2E gate.

## Code Conventions & Common Patterns

- **TypeScript:** strict ESM, 2-space indentation, double quotes, semicolons, and trailing commas. Use kebab-case filenames, `PascalCase` types/classes, and `*Schema` for Zod schemas. Prefer `readonly` public data and `#private` class state.
- **Contracts:** parse untrusted data at process boundaries. Keep backend Zod, web mirrors, and harness Zod models synchronized; do not add a second transport convention.
- **Dependency injection:** extend existing factories and options such as `PipelineApplicationOptions`, `PipelineStageDependencies`, and harness option interfaces. Inject clocks, IDs, fetchers, repositories, and fakes instead of patching globals.
- **State management:** durable workflow state belongs in SQLite through `PipelineRepository`; artifacts are immutable and lineage-tracked. Keep Next route pages thin, shared transport in `app/lib`, cross-route state in providers, and transient state in components.
- **Async work:** use recursive `setTimeout` polling rather than overlapping `setInterval`. Pair work with `AbortController`, cleanup, request/version fences, and explicit timeouts. Preserve cancellation and bounded browser operations.
- **Errors and privacy:** retain structured internal causes, but expose stable sanitized API/UI errors. Redact tokens, credentials, model context, applicant data, and browser/session details.

## Important Files

| Path | Why it matters |
| --- | --- |
| `Makefile` | Canonical install, development, build, test, doctor, and restart commands. |
| `apps/package.json` | Dependency-free stable launcher; this repository is not a Bun workspace. |
| `apps/backend/src/index.ts` | Backend process entry point and shutdown handling. |
| `apps/backend/src/bootstrap.ts` | Main TypeScript composition root. |
| `apps/backend/src/contracts/index.ts` | Central backend API and domain schemas. |
| `apps/backend/src/db/repository.ts` | Durable workflow, claim fencing, transactions, and events. |
| `apps/backend/src/db/artifacts.ts` | Internal artifact publication checks, metadata reads, and retry inheritance. |
| `apps/backend/src/stages/processor.ts` | Pipeline stage orchestration. |
| `apps/web/app/lib/pipeline-client.ts` | Validated web-to-pipeline transport, including authorization operations. |
| `apps/web/app/lib/application-session.ts` | Application commands and authoritative snapshot reconciliation. |
| `apps/web/app/lib/use-application-session.ts` | React subscription and lifetime adapter for application sessions. |
| `apps/web/app/lib/authorization-session.ts` | Provider authorization and application-model coordination. |
| `apps/web/app/lib/run-collection.ts` | Shared Run snapshots, membership, attention, and identity metadata lifetimes. |
| `apps/web/next.config.ts` | Same-origin pipeline rewrites and backend-origin configuration. |
| `apps/web/playwright.config.ts` | One-worker web E2E setup and isolated ports. |
| `apps/harness/package.json` | Harness dependencies, CLI scripts, build, and test commands. |
| `apps/harness/src/host/index.ts` | Harness configuration and dependency composition. |
| `apps/harness/src/host/server.ts` | Authenticated loopback HTTP surface. |
| `apps/harness/src/contracts/models.ts` | Strict harness transport contracts. |
| `.omp/RULES.md` | Repository-specific prohibition on production use from worktrees. |

## Runtime/Tooling Preferences

- Use **Bun 1.3.14**. `apps/backend`, `apps/web`, and `apps/harness` each have an independent `package.json` and `bun.lock`; use frozen installs and update the matching lockfile. Never substitute npm, pnpm, or Yarn.
- Harness browser automation also requires a real Node executable, Chrome/Chromium, pinned `@playwright/cli`, and `misc/patches/playwright-core@1.62.0-alpha-1783623505000.patch`. Preserve the patch.
- Resume processing requires `latexmk` and Poppler (`pdfinfo`, `pdftotext`, `pdffonts`, `pdftoppm`). Run `make doctor` before treating missing-tool failures as application bugs.
- `apps/.env.local` may contain live secrets. Never print or quote it. Runtime state belongs under configured data homes, not in source control.
- Do not edit generated outputs such as `apps/backend/dist/`, `apps/web/.next/`, `apps/web/next-env.d.ts`, `*.tsbuildinfo`, coverage files, or test results.
- In linked worktrees, use development services and storage only. Never touch, restart, or modify production. Production restart targets are restricted to the primary `main` checkout.

## Testing & QA

- Backend, web, and operational-script tests use Bun's built-in runner with `*.test.ts` or `*.test.tsx` names. Web component tests commonly render with `react-dom/server`; do not assume Testing Library or JSDOM exists.
- Harness tests use Bun's built-in runner. Prefer temporary directories, injected fetchers/clocks/process runners, and hand-written fakes.
- Web E2E uses `@playwright/test` files named `*.pw.ts`. The config runs one worker, starts a fresh Next dev server, and uses isolated loopback ports.
- Match existing isolation patterns: inject dependencies, use in-memory SQLite, restore environment/time overrides in `finally`, close databases/servers, and remove temporary directories.
- Test observable contracts, state transitions, race handling, and real failures—not field forwarding or implementation details. Start with the narrow affected test, then run the package typecheck/test and `make test`; add `make test-e2e` for browser-visible web changes.
- No coverage threshold is configured. Do not claim or enforce one without an explicit project decision.
