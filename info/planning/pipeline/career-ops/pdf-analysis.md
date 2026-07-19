From the JD using `modes/heuristics/recruiter-side.md`: likely doubts, matching evidence, and which document section should address each doubt
8. Rewrite Professional Summary by injecting JD keywords + exit narrative bridge ("Built and sold a business. Now applying systems thinking to [JD domain].")
9. Select top 3-4 most relevant projects for the job
10. Reorder experience bullets by JD relevance and by the risk map: strongest matching evidence first
11. Build competency grid from JD requirements (6-8 keyword phrases)
12. Inject keywords naturally into existing achievements (NEVER invent)

## ATS Rules (clean parsing)

- Single-column layout (no sidebars, no parallel columns)
- Standard headers: "Professional Summary", "Work Experience", "Education", "Skills", "Certifications", "Projects"
- No text in images/SVGs
- No critical info in PDF headers/footers (ATS ignores them)
- UTF-8, selectable text (not rasterized)
- No nested tables
- Distributed JD keywords: Summary (top 5), first bullet of each role, Skills section
- No hidden text, keyword stuffing, or white-font tricks. Optimize for parseability plus human review.


## Keyword injection strategy (ethical, truth-based)

Examples of legitimate reformulation:
- JD says "RAG pipelines" and CV says "LLM workflows with retrieval" → change to "RAG pipeline design and LLM orchestration workflows"
- JD says "MLOps" and CV says "observability, evals, error handling" → change to "MLOps and observability: evals, error handling, cost monitoring"
- JD says "stakeholder management" and CV says "collaborated with team" → change to "stakeholder management across engineering, operations, and business"

**NEVER add skills that the candidate does not have. Only reword real experience using the exact JD vocabulary.**



## Recruiter-Side Risk Map

Before generating a CV, cover letter, form answer, recruiter script, or
interview prep, create a small internal risk map:

| Potential doubt | Evidence from CV/report | Candidate-facing fix |
|-----------------|-------------------------|----------------------|
| Can they do this stack? | Matching tools, systems, projects | Put the exact stack in truthful context |
| Are they senior enough? | Ownership, scope, tradeoffs, mentoring | Lead with senior behaviors, not tenure alone |
| Is the domain relevant? | Similar users, workflows, scale, constraints | Translate adjacent proof into the JD's language |
| Is there a logistics blocker? | Location, comp, work-auth, availability | Answer only where the form/recruiter asks |
| Is the application generic? | Weak or broad bullets | Rewrite around this role's concrete problems |

Use the map to reduce review risk. Do not print it unless the mode output
explicitly asks for analysis. Never invent evidence to close a doubt.

## Business-Value Bullets

Prefer:

`Action + system/scope + tool/approach + outcome + proof`

Good patterns:

- `Resolved [problem] in [system], improving [business/system effect].`
- `Built [capability] with [tools], enabling [user/team outcome].`
- `Migrated [old] to [new], reducing [risk/cost/latency/debt].`
- `Improved [metric] from [before] to [after] by [technical action].`

Avoid weak starts when stronger ownership is true: "helped", "assisted",
"responsible for", "worked on", "participated in".

## ATS Reality Check

Optimize for parseability and human review, not "ATS hacks":

- exact JD keywords only in truthful context
- no hidden text
- no keyword stuffing
- no white-font tricks
- no decorative layouts that break parsing
- no skills or metrics not present in the user's sources of truth
