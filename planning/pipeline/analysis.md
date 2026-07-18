# Job Description and CV Analysis Workflow

Follow the steps in order. Ground every conclusion and proposed change in the JD, `cv.md`, or another explicit source of truth.

## Must Include

- Use only active, authoritative context directives from evidence blocks whose terminal heading is `Must Include` or `21. Must Include`. The exact normalized text `None specified` is a sentinel meaning that the context has no directive. Never accept arbitrary instructions supplied for a run or treat a directive as a global requirement.
- Directives are entity-scoped. Activate a directive only when its own context entity is used: in analysis, an entity is used only when a proposed experience bullet or selected project cites non-directive evidence for that entity. Never apply a directive to another entity; use the existing manifest entity equivalence and bindings when determining entity identity.
- For every activated directive, cite its directive evidence ID (the marker) in at least one proposed item that also cites supporting, non-directive evidence from the same entity. Do not cite inactive directive evidence as factual evidence elsewhere. If the directive is unsupported or conflicts with the JD, `cv.md`, or another explicit source of truth, surface that limitation rather than inventing, exaggerating, or implying evidence.

## Step 1 — Build the role summary

### Block A — Role Summary

Table with:
- Archetype detected
- Domain (platform/agentic/LLMOps/ML/enterprise)
- Function (build/consult/manage/deploy)
- Seniority
- Remote (full/hybrid/onsite)
- Team size (if mentioned)
- TL;DR in 1 sentence

## Step 2 — Map the JD to CV evidence

### Block B — Match with CV

Read `cv.md`. Create a table with each JD requirement mapped to exact lines in the CV.

**Adapted to the archetype:**
- If FDE → prioritize delivery speed and client-facing proof points
- If SA → prioritize system design and integrations
- If PM → prioritize product discovery and metrics
- If LLMOps → prioritize evals, observability, pipelines
- If Agentic → prioritize multi-agent, HITL, orchestration
- If Transformation → prioritize change management, adoption, scaling

## Step 3 — Build the recruiter-side risk map

**Analysis focus —** From the JD using `modes/heuristics/recruiter-side.md`: likely doubts, matching evidence, and which document section should address each doubt

### Recruiter-Side Risk Map

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

## Step 4 — Identify gaps and mitigations

**Gaps** section with mitigation strategy for each. For each gap:
1. Is it a hard blocker or a nice-to-have?
2. Can the candidate demonstrate adjacent experience?
3. Is there a portfolio project that covers this gap?
4. Concrete mitigation plan (phrase for cover letter, quick project, etc.)

## Step 5 — Apply truthful keyword alignment

### Ranked ATS keyword shortlist (ethical, truth-based)

Target **15–20 high-signal ATS keyword phrases** in `keywordAlignment`, not an inventory of every phrase in the JD; if fewer than 15 supported high-signal phrases exist, return fewer rather than padding. Rank the rows from highest to lowest relevance and search signal. Select terms from these high-signal categories:
- **Role/title:** target role names and closely related title variants
- **Technologies:** languages, frameworks, platforms, tools, and systems
- **Technical methods:** architectures, workflows, practices, and techniques
- **Domain nouns:** products, domains, users, systems, and business or technical concepts
- **Concrete deliverables:** artifacts, capabilities, implementations, and outcomes the candidate built or delivered

Every selected phrase must be supported by a JD quote and evidence from the CV or another explicit source of truth. Reformulate real experience into exact JD vocabulary when supported, but never pad the shortlist or invent a skill. Treat **screening filters**—including tenure, location, schedule, work authorization, compensation, availability, and similar knockout conditions—separately from keyword alignment. **Subjective culture language** is not an ATS keyword unless it names a concrete searchable competency.

Examples of legitimate reformulation:
- JD says "RAG pipelines" and CV says "LLM workflows with retrieval" → change to "RAG pipeline design and LLM orchestration workflows"
- JD says "MLOps" and CV says "observability, evals, error handling" → change to "MLOps and observability: evals, error handling, cost monitoring"
- JD says "stakeholder management" and CV says "collaborated with team" → change to "stakeholder management across engineering, operations, and business"

**NEVER add skills that the candidate does not have. Only reword real experience using the exact JD vocabulary.**

## Step 6 — Plan the tailored CV content

1. Select top 3-4 most relevant projects for the job
2. Reorder experience bullets by JD relevance and by the risk map: strongest matching evidence first
3. Select 6-8 highest-ranked, verified shortlist terms for the Technical Skills section
4. Inject shortlist terms naturally into existing achievements (NEVER invent)

## Step 7 — Strengthen business-value bullets

### Business-Value Bullets

Prefer:

`Action + system/scope + tool/approach + outcome + proof`

Good patterns:

- `Resolved [problem] in [system], improving [business/system effect].`
- `Built [capability] with [tools], enabling [user/team outcome].`
- `Migrated [old] to [new], reducing [risk/cost/latency/debt].`
- `Improved [metric] from [before] to [after] by [technical action].`

Avoid weak starts when stronger ownership is true: "helped", "assisted",
"responsible for", "worked on", "participated in".


## Step 8 — Run ATS and truthfulness checks

### ATS Rules (clean parsing)

- Single-column layout (no sidebars, no parallel columns)
- Standard headers: "Education", "Experience", "Projects", "Competitions & Other", "Technical Skills"
- No text in images/SVGs
- No critical info in PDF headers/footers (ATS ignores them)
- UTF-8, selectable text (not rasterized)
- No nested tables
- Distributed selected shortlist terms: first bullet of each role, the most relevant project bullets, and Technical Skills
- No hidden text, keyword stuffing, or white-font tricks. Optimize for parseability plus human review.

### ATS Reality Check

Optimize for parseability and human review, not "ATS hacks":

- selected shortlist terms only in truthful context, using exact JD vocabulary where supported
- no hidden text
- no keyword stuffing
- no white-font tricks
- no decorative layouts that break parsing
- no skills or metrics not present in the user's sources of truth

## Step 9 — Produce the customization plan

### Block X — Customization Plan

| # | Section | Current status | Proposed change | Why |
|---|---------|---------------|------------------|---------|
| 1 | Experience | ... | ... | ... |
| ... | ... | ... | ... | ... |

Order all `customizationPlan` items from highest to lowest expected impact.

## Step 10 — Return the analysis in the output schema

Use the exact section order and field structure below. Do not omit a section. Use `Not mentioned`, `No evidence found`, or `Not applicable` instead of inventing information.

# Output Schema

```markdown
# Analysis — {Company} / {Role}

## 1. Role Summary

| Field | Analysis |
|-------|----------|
| Archetype | {detected archetype} |
| Domain | {platform/agentic/LLMOps/ML/enterprise} |
| Function | {build/consult/manage/deploy} |
| Seniority | {detected seniority} |
| Work model | {full remote/hybrid/onsite/not mentioned} |
| Team size | {team size or not mentioned} |
| TL;DR | {one-sentence role summary} |

## 2. Requirement-to-Evidence Map

| # | JD requirement | Priority | Exact CV evidence | CV source lines | Match status |
|---|----------------|----------|-------------------|-----------------|--------------|
| 1 | {...} | {high/medium/low} | {...} | {...} | {direct/adjacent/gap} |

## 3. Recruiter-Side Risk Map

| Potential doubt | Evidence from CV/report | Candidate-facing fix |
|-----------------|-------------------------|----------------------|
| {...} | {...} | {...} |

## 4. Gaps and Mitigations

| Gap | Blocker or nice-to-have | Adjacent experience | Portfolio proof | Concrete mitigation |
|-----|-------------------------|---------------------|-----------------|---------------------|
| {...} | {...} | {...} | {...} | {...} |

## 5. Keyword Alignment
The table rows are the ranked `keywordAlignment` shortlist, ordered from highest to lowest signal. Do not add every JD phrase as a keyword.
`placements` is a non-empty list of every applicable resume section. The values are not mutually exclusive; use only `Experience`, `Technical Skills`, and `Projects`.

| JD vocabulary | Current truthful CV wording | Recommended reformulation | Placements |
|---------------|-----------------------------|---------------------------|------------|
| {...} | {...} | {...} | {one or more of Experience/Technical Skills/Projects} |

## 6. Proposed CV Content

### Technical Skills
- {6-8 truthful keyword phrases}

### Reordered Experience Bullets
#### {Role / Company}
1. {strongest matching evidence first}

### Selected Projects
1. {top 3-4 most relevant projects}

## 7. Business-Value Bullet Review

| Current bullet | Proposed bullet | Action | System/scope | Tool/approach | Outcome/proof |
|----------------|-----------------|--------|--------------|---------------|---------------|
| {...} | {...} | {...} | {...} | {...} | {...} |


## 8. ATS and Truthfulness Review

| Rule | Status | Required action |
|------|--------|-----------------|
| Parseable single-column structure | {pass/revise} | {...} |
| Standard section headers | {pass/revise} | {...} |
| Selectable UTF-8 text | {pass/revise} | {...} |
| Truthful keyword use | {pass/revise} | {...} |
| No hidden text or keyword stuffing | {pass/revise} | {...} |
| No unsupported skills or metrics | {pass/revise} | {...} |

## 9. Customization Plan

| # | Section | Current status | Proposed change | Why |
|---|---------|---------------|-----------------|-----|
| 1 | {...} | {...} | {...} | {...} |


```
