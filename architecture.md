# Architecture: strengths and review priorities

Jobhunt is a local-first, three-process system. The Bun backend owns the pipeline, SQLite workflow state, and `/v1` API; the Next.js web app presents review and operations; the Bun harness owns Playwright browser sessions. The web calls the backend through a same-origin `/api/pipeline` rewrite. The backend projects harness events into durable application-session snapshots, which the web reconciles by polling. See [AGENTS.md](AGENTS.md) for the detailed data flow and development commands.

## Advantages

- **Recoverable workflow state.** SQLite persists runs, attempts, claims, events, and artifact lineage. Fenced worker claims and explicit stage transitions keep progress inspectable and prevent stale workers from silently committing as the current owner ([repository](apps/backend/src/db/repository.ts), [scheduler](apps/backend/src/worker/scheduler.ts)).
- **Human review remains part of the workflow.** Resume QA and approval precede application handoff; the harness has separate gates for missing information, CAPTCHA, review, and final submission. A transport acknowledgement is not mistaken for application completion ([stage processor](apps/backend/src/stages/processor.ts), [application session](apps/web/app/lib/application-session.ts)).
- **Clear process responsibilities.** The backend owns durable decisions, the web owns presentation and reconciliation, and the harness isolates browser state and credential handling. That keeps private browser details out of ordinary public snapshots ([bootstrap](apps/backend/src/bootstrap.ts), [harness host](apps/harness/src/host/index.ts)).
- **Validated, testable boundaries.** Backend and harness parse transport data with Zod; the web validates backend responses. Injected dependencies and separate Bun test suites make state transitions and failure paths testable without live applicant data ([backend contracts](apps/backend/src/contracts/index.ts), [web client](apps/web/app/lib/pipeline-client.ts), [Makefile](Makefile)).

## Small operational tradeoffs

- Three processes and separate installs take more setup than a single binary; the harness must be started separately and configured with a shared token.
- Snapshot polling makes the UI simpler to reconnect, at the cost of periodic requests and some update latency.
- Keeping web-facing contract schemas beside the web makes client validation straightforward, but changes must stay aligned with backend schemas. The drift risk below is more than a convenience cost and needs a check.

These advantages do not make the following weaknesses safe. This is a source review, not an exploit demonstration or a claim that every deployment exposes the API to other machines.

## 1. Harden the security boundaries

**Observed.** The public backend handler checks the `Origin` header for `POST`, `PUT`, `PATCH`, and `DELETE`; it does not authenticate callers, and the check does not apply to `GET` ([handler](apps/backend/src/api/handler.ts)). The run list, detail, iteration, and artifact `GET` routes have no caller-authentication check ([run routes](apps/backend/src/api/run-routes.ts)). Artifact publication rules restrict which kinds and states may be served, not who can fetch a served artifact. The internal submission route has separate bearer authentication; that does not protect these public reads. Loopback binding and an origin check are deployment and browser boundaries, not proof of authorization for any client that can reach the API.

**Why it matters.** Runs and resume artifacts can contain private applicant or job information. Browser reachability depends on deployment and forwarding conditions; direct local clients also need no browser origin. Treat unauthenticated reads as a security-review finding without claiming a demonstrated exploit. Review the actual exposure paths and add explicit caller authorization to sensitive read routes, including artifact downloads; retain existing publication checks and test access across the web rewrite and direct API.

**Observed.** The browser tool calls `claimSubmissionActionIfApproved`, then still sends a mutating Playwright command to `runtimeAction` when the claim returns `false` ([browser tool](apps/harness/src/agent/tools/browser/index.ts), [claim](apps/harness/src/application/agent-runtime/session/application.ts)). A `false` return means approval has not happened, not necessarily a failed claim: preapproval form entry is intentional. But the generic mutating-command path does not itself enforce a final-submit boundary. Workflow instructions and model intent cannot substitute for a runtime gate.

**Review action.** Distinguish permitted preapproval editing from actual submission at the browser execution boundary. Require a claimed approval before any submit-capable action while preserving safe form preparation and the existing snapshot-before-retry behavior. Test both permitted edits and blocked final submission; do not infer an exploit from this code path alone.

## 2. Make failures bounded and recoverable

**Observed.** The ordinary Playwright CLI invocation accepts an optional `timeoutMs` and often supplies none. With a timeout, the default process runner sends `SIGTERM` and then waits for `child.exited` without escalation. A separate managed-process termination path does escalate, so the gap is specifically the ordinary command runner ([Playwright CLI host](apps/harness/src/host/playwright-cli.ts)). A hung child can therefore leave browser work waiting indefinitely despite a nominal deadline.

**Review action.** Give every CLI operation a finite deadline appropriate to the command, escalate from graceful termination to forced termination after a bounded grace period, and bound reaping. Preserve cancellation and require inspection after ambiguous browser actions instead of automatically replaying a possible submission.

**Observed.** If `repository.acquire()` throws, the scheduler reports the error and exits the current drain. A new external `kick()` is needed to restart it; the existing delayed recovery timer covers active-claim heartbeat/release failures, not this acquisition failure ([scheduler](apps/backend/src/worker/scheduler.ts)). Queued work can remain idle after a transient storage error.

**Review action.** Schedule a bounded, delayed acquisition retry that stops on shutdown, with a deterministic test for transient failure followed by successful acquisition. Avoid a tight failure loop.

## 3. Reduce change cost incrementally

**Observed.** [Repository](apps/backend/src/db/repository.ts), [application session service](apps/backend/src/api/application-session-service.ts), and [run dashboard](apps/web/app/components/run-dashboard.tsx) each exceed 2,000 lines. Four byte-identical model/provider file pairs in backend and harness account for roughly 1,055 lines in each tree. Backend [contracts](apps/backend/src/contracts/index.ts) and web [pipeline contracts](apps/web/app/lib/pipeline-contracts.ts) are separately maintained near-copies, with some intentionally different schemas and normalization. This is a drift risk, not evidence of a current wire incompatibility.

**Review action.** Split large files at stable responsibilities as they are touched; keep a single owner per piece of logic and eliminate duplication only after checking process-specific differences. Add boundary-level contract checks for the shared wire shapes, including normalization and incompatible-change cases. Prefer incremental extraction and checks over a new framework or a wholesale rewrite.

## 4. Tighten the delivery loop

**Observed.** `make check` runs typecheck, build, and Bun tests; `make test-e2e` is separate ([Makefile](Makefile)). There is no tracked CI configuration or configured lint/formatter command in this repository. External automation may exist, but it is not established here. Local test success is useful; it does not automatically enforce the same gates for every change.

**Review action.** Run `make check` automatically for proposed changes and add targeted E2E coverage where browser behavior changes. Introduce a lint/format policy only with explicit configuration and an incremental adoption plan; do not claim an existing gate that is not configured.
