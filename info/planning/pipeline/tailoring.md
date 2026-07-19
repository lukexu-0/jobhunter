# Pipeline validation guidance

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
