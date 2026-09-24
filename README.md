# Jobhunt

**From an opportunity to a tailored résumé you can review—and an application you control.**

Jobhunt is a local-first workspace for preparing job applications. It collects an opportunity, analyzes fit, tailors and compiles a résumé, checks the result, and lets you review it before an optional browser-assisted application.

## What it does

- **Bring an opportunity:** enter a job URL or paste a title and description. Some URLs require a manual browser-capture step.
- **Prepare a résumé:** analyze the opportunity, tailor a LaTeX résumé, compile a PDF, and run deterministic and visual checks.
- **Review before applying:** compare iterations, inspect the PDF and findings, request edits, and approve a version.
- **Keep track:** manage runs and application statuses in a local dashboard backed by SQLite.
- **Apply with assistance (optional):** use a separate browser harness for approved runs, with human gates for missing details, CAPTCHA, form review, and submission.

## Quickstart

### Prerequisites

- [Bun](https://bun.sh/) **1.3.14**, Git, and `make`.
- For résumé processing: `latexmk` and Poppler (`pdfinfo`, `pdftotext`, `pdffonts`, `pdftoppm`). Run `make doctor` to diagnose missing system tools and configuration. It may report missing private context or authorization on a fresh checkout.

### Start the development app

```sh
git clone https://github.com/lukexu-0/jobhunter.git
cd jobhunter
make install
make dev
```

Open **http://127.0.0.1:3556**. In another terminal, check the backend:

```sh
curl -fsS http://127.0.0.1:3557/v1/health
# {"status":"ok"}
```

`make dev` starts the web UI and pipeline, **not** the browser harness. The app can open without applicant data, but creating a useful résumé run requires your own private source files. Development data is kept under `.jobhunt-data/development/` in this checkout.

### Prepare your first run

1. Create `.jobhunt-data/user-info/resume-main/resume.tex` with **your own** LaTeX résumé. The directory and résumé are not included; create the directory with `mkdir -p .jobhunt-data/user-info/resume-main`. Other context sources, if configured, are listed in `apps/backend/context-sources.json`.
2. Open **Credentials** in the app and connect OpenAI Codex for the résumé workflow. `make doctor` can help diagnose remaining setup issues.
3. On the dashboard, enter an opportunity URL or choose **Paste job details** and provide a title and description.
4. Open the run to inspect the generated PDF and checks, request edits if needed, and approve the result.

Pasted job details have no application URL, so they can be used to prepare a résumé but **cannot start an automatic browser application**. Browser-assisted applications need an approved run with an HTTPS job URL.

### Optional: browser-assisted applications

Install Node.js and Chrome/Chromium. Set `JOBHUNT_HARNESS_TOKEN` to the **same private random value** (at least 32 characters) in Git-ignored `apps/.env.local` for `make dev` and in the environment of the terminal running `make harness`. Restart `make dev` after setting it, then start the harness in the second terminal:

```sh
make harness
```

The harness listens on `127.0.0.1:8865` in development. Keep the browser session available for information requests, CAPTCHA, application review, and submission approval. `make harness` is not needed to create or review a résumé.

## How it fits together

| Component | Role |
| --- | --- |
| `apps/web` | Next.js dashboard for opportunity intake, résumé review, credentials, and application status. |
| `apps/backend` | Bun API and durable pipeline for analysis, tailoring, PDF checks, and run state. |
| `apps/harness` | Separate Bun service for human-gated browser application sessions. |

## Development

From the repository root:

```sh
make doctor      # Check external tools and local setup
make typecheck   # Type-check all three apps
make check       # Type-check, build, and run tests (not browser E2E)
make test-e2e    # Run the web Playwright suite
```

## Privacy

Applicant files, credentials, generated résumés, browser state, and local databases are private runtime data. Keep them out of commits and examples. Put applicant sources under Git-ignored `.jobhunt-data/user-info/` and local launch secrets in Git-ignored `apps/.env.local`. No personal résumé or credentials are bundled.
