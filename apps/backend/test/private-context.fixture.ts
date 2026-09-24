import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Entirely fictional candidate and claims; no test reads an applicant's local files.
export const SYNTHETIC_RESUME = String.raw`\documentclass[letterpaper]{article}
\usepackage[english]{babel}
\input{glyphtounicode}

\pagestyle{fancy}
\newcommand{\resumeItem}[1]{\item{#1}}
\newcommand{\resumeSubheading}[4]{\item{#1, #2, #3, #4}}
\newcommand{\resumeProjectHeading}[2]{\item{#1, #2}}
\newcommand{\resumeSubHeadingListStart}{\begin{itemize}}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\newcommand{\resumeItemListStart}[1][]{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}}
\begin{document}
\textbf{Test Candidate}
\section{Experience}
\resumeSubHeadingListStart
    \resumeSubheading
      {Software Engineer}
      {2022 -- Present}
      {Example Labs}
      {Remote}
      \resumeItemListStart[0.35in]
        \resumeItem{Built an agentic testing platform for pull requests.}
        \resumeItem{Documented a repeatable release checklist for sample services.}
        \resumeItem{Delivered reliable developer tooling for an internal prototype.}
      \resumeItemListEnd
\resumeSubHeadingListEnd
\section{Projects}
\resumeSubHeadingListStart
    \resumeProjectHeading
      {Sample Delivery Dashboard $|$ TypeScript}
      {2024}
      \resumeItemListStart
        \resumeItem{Built a full-stack dashboard for test deliveries.}
        \resumeItem{Processed over \$500,000 in simulated shipment totals.}
        \resumeItem{Integrated an email API for synthetic notifications.}
      \resumeItemListEnd
    \resumeProjectHeading
      {Sample Notes $|$ Go}
      {2023}
      \resumeItemListStart
        \resumeItem{Prototyped a developer notes service.}
      \resumeItemListEnd
\resumeSubHeadingListEnd
\section{Competitions \& Other}
\resumeSubHeadingListStart
    \resumeSubheading
      {Team Award}
      {2024}
      {Example Competition}
      {Remote}
      \resumeItemListStart
        \resumeItem{Built a prototype during a weekend challenge.}
      \resumeItemListEnd
\resumeSubHeadingListEnd
\section{Technical Skills}
\textbf{Languages}{: JavaScript, Python, TypeScript}
\end{document}
`;

export const SYNTHETIC_CONTEXT_SOURCES: Readonly<Record<string, string>> = {
  ".jobhunt-data/user-info/resume-main/resume.tex": SYNTHETIC_RESUME,
  ".jobhunt-data/user-info/current-context/jobs/example-labs/automated-testing.md":
    "# Automated testing\nBuilt an agentic testing platform for pull requests. TypeScript testing reduced simulated review time.\n",
  ".jobhunt-data/user-info/current-context/projects/sample-delivery-dashboard.md":
    "# Sample Delivery Dashboard\nReconciled sample deliveries and documented simulated logistics losses of $8,000. User-reported; not independently verified.\n",
  ".jobhunt-data/user-info/current-context/projects/sample-notes.md":
    "# Sample Notes\nPrototyped a developer notes service with an ongoing Go port.\n",
};

export function writeSyntheticContextSources(root: string): void {
  for (const [relativePath, content] of Object.entries(SYNTHETIC_CONTEXT_SOURCES)) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}
