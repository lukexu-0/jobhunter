# Resume Tailoring Workflow

Tailor the resume to a specific job while preserving truthful evidence and a strict one-page limit.
Treat the steps as guidance rather than a mechanical checklist; adapt them to the role, evidence, readability, and page balance.

## Step 1 — Map requirements to existing evidence

Use judgment to focus on requirements that materially affect fit:

- Favor the strongest exact evidence already present in the resume or another verified source.
- Distinguish direct experience from adjacent experience.
- Place evidence where it communicates fit most naturally.
- Leave unsupported requirements as gaps; never create evidence to make them appear covered.

## Step 2 — Rank proof and decide what to keep

Use judgment to rank entries and bullets by role relevance and evidence strength. Generally favor:

- Direct technical evidence for high-priority requirements
- Verified production, user, operational, or business impact
- Ownership, system scope, trade-offs, reliability, or security
- Adjacent technical evidence
- Communication, leadership, or high-pressure work when it supports the role
- Unrelated experience only when it adds useful context or space allows

## Step 3 — Align vocabulary truthfully

Use `analysis.keywordAlignment` as the authoritative shortlist. Prioritize its supported exact job-description terms naturally where they describe real experience; do not re-extract or add terms outside the shortlist.
Exclude screening filters, unsupported terms, and subjective culture language unless it names a concrete searchable competency.

Place supported terms where they read naturally and their evidence appears:

- Experience bullets for work performed in a role
- Project headings or bullets for project-specific tools and outcomes
- Technical Skills for verified technologies
- Competitions & Other when the activity genuinely demonstrates the competency

Avoid keyword stuffing, hidden text, unsupported synonyms, or repeated phrases that make the CV unnatural.

## Step 4 — Tailor Experience

When rewriting Experience bullets, apply the principles that improve clarity and relevance:

- Aim for one distinct evidence-backed claim, combining a specific action or verified outcome with concrete scope, relevant methods or technologies, and a verified effect when those elements strengthen the bullet.
- Include metrics only when supported and meaningful; never force or invent a number.
- Prefer concrete nouns and verbs over adjectives, responsibility phrases, or implementation details that do not show relevance, difficulty, ownership, or impact.
- Preserve verified tense and completion status, and order bullets by the strength of their matching evidence.

## Step 5 — Tailor Projects

Projects may be reordered, rewritten, shortened, or replaced based on role fit, evidence strength, and page balance.

- Usually place the strongest-matching project first unless another order improves the narrative.
- Prefer bullets that add distinct evidence and fit within the page limit.
- Cut technology repetition that adds no proof.
- Emphasize the outcomes, architecture, security, reliability, scale, or user value most relevant to the role.
- Keep every fact and date accurate.

## Step 6 — Tailor Competitions & Other

Keep, shorten, or replace an entry based on its relevance; any replacement must be a verified competition or activity.

## Step 7 — Tailor Technical Skills

Technical Skills should confirm demonstrated evidence rather than compensate for gaps. Use judgment to:

- Keep only technologies supported by verified work, projects, coursework, or demonstrated use.
- Emphasize relevant terms and remove low-value noise.
- Add a requested technology only when verified; never list it solely because it appears in the job description.
- Keep terminology consistent with Experience and Projects, avoiding labels that cannot be defended in an interview.

## Step 8 — Enforce the one-page budget

Use judgment to fit one page. Generally protect:

- the strongest Experience evidence
- the most relevant Projects and distinct project bullets
- verified Technical Skills that support the role
- concise Competitions & Other evidence when it adds value

Before shortening high-value proof, first cut duplicated or low-value bullets, repeated heading or technology labels, lower-priority project detail, and unrelated non-technical Experience.

## Pipeline validation

### Page size and count

Run:

```bash
pdfinfo main.pdf
```

Require:

- `Pages: 1`
- `Page size: 612 x 792 pts (letter)`
- an unencrypted PDF

### Text extraction and reading order

Run:

```bash
pdftotext main.pdf -
```

Confirm:

- all visible text is extractable
- the six sections appear in the required order
- bullets remain attached to the correct entries
- dates and locations remain associated with the correct headings
- keywords appear naturally in the extracted text
- no character is missing or replaced incorrectly

The current baseline can place the competition date after Technical Skills in extracted text because of the two-column heading layout. Treat this as a known ATS reading-order risk and ensure tailoring does not make it worse. If the entry is changed, verify its extracted date and title explicitly.

### Font embedding

Run:

```bash
pdffonts main.pdf
```

Confirm that text fonts remain embedded. Avoid introducing icons or decorative fonts that cannot be extracted reliably.

### Visual inspection

Render a preview when needed:

```bash
pdftoppm -png -singlefile -r 150 main.pdf /tmp/resume-preview
```

Inspect the page for:

- clipping or overlap
- text outside the margins
- inconsistent spacing
- dense bullets that are difficult to scan
- unexpectedly small text
- a second page

The current baseline has no visible clipping or overlap. Experience and Projects dominate the page, so most one-page adjustments should happen in those editable sections.

### Final CV review

Before accepting the tailored CV, confirm:

1. The PDF is exactly one US Letter page.
2. The section names and order are unchanged.
3. Header and Education are unchanged.
4. Only Experience, Projects, Competitions & Other, Technical Skills, and their bullets were edited.
5. Every job-description term maps to verified evidence.
6. No skill, metric, responsibility, project, or outcome was invented.
7. The strongest technical evidence appears first.
8. Non-technical Experience remains only when it strengthens the target role or the page has room.
9. Project order and bullets reflect the target role.
10. Technical Skills match the evidence in Experience and Projects.
11. LaTeX compiles without errors.
12. Text extraction remains readable and correctly ordered.
13. The final page has no clipping, overlap, or overflow.
