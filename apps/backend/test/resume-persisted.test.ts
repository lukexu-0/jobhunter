import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { ContextSnapshot } from "../src/context/types.ts";
import { buildMechanicalTailoringPlan } from "../src/agents/tailoring-agent.ts";
import { canonicalJson, hashJobAnalysis } from "../src/resume/ledger.ts";
import { parseBaselineResume, renderEditedResume, type JobAnalysis } from "../src/resume/index.ts";
import { parsePersistedJobAnalysis, parsePersistedTailoringPlan } from "../src/resume/persisted.ts";

const baseline = String.raw`\begin{document}
\section{Experience}
\resumeSubheading{Engineer}{2024}{Example}{Remote}
\resumeItem{Built services.}
\resumeItem{Maintained old tooling.}
\section{Projects}
\section{Competitions \& Other}
\section{Technical Skills}
\textbf{Languages}{: JavaScript}
\end{document}`;
const parsed = parseBaselineResume(baseline);
const sha = "a".repeat(64);
const snapshot: ContextSnapshot = {
  manifestSha256: sha, baselineSha256: parsed.sha256,
  sourceHashes: {}, sources: [], evidence: [], mustIncludeDirectives: [], explicitEntityBindings: {},
};

function fixtures() {
  const bullet = parsed.bullets[0]!;
  const skill = parsed.skills[0]!;
  const analysis: JobAnalysis = {
    schemaVersion: 2, id: "analysis", jobDescriptionSha256: sha,
    analysisWorkflowSha256: sha, baselineSha256: parsed.sha256,
    target: { title: "Engineer", organization: "Example" },
    jdKeywords: [{ id: "typescript", phrase: "TypeScript", jdQuote: "Build TypeScript services." }],
    exactEdits: [
      { id: "bullet-edit", kind: "bullet", baselineItemId: bullet.id, section: bullet.section,
        entityId: bullet.entityId, before: bullet.text, after: "Built TypeScript services.", keywordIds: ["typescript"] },
      { id: "skill-edit", kind: "skill", baselineItemId: skill.id, category: skill.category,
        before: skill.skill, after: "TypeScript", keywordIds: ["typescript"] },
    ],
  };
  const originalAnalysis = {
    ...analysis,
    jdKeywords: analysis.jdKeywords.map((keyword) => ({ ...keyword, evidenceIds: ["missing", "missing"] })),
    exactEdits: analysis.exactEdits.map((edit) => edit.kind === "skill"
      ? { ...edit, evidenceIds: null, evidenceEntityId: { invalid: true } }
      : { ...edit, evidenceIds: 42 }),
  };
  const originalHash = createHash("sha256").update(canonicalJson(originalAnalysis)).digest("hex");
  const plan = buildMechanicalTailoringPlan(analysis, baseline);
  const omittedId = parsed.bullets[1]!.id;
  const originalPlan = {
    ...plan, analysisSha256: originalHash, factWinners: "broken historical ledger",
    decisions: plan.decisions.map((decision) => ({
      ...decision,
      ...(decision.baselineItemId === omittedId ? { action: "omit", text: null } : {}),
      factKeys: { invalid: true }, evidenceIds: ["missing"],
    })),
    skillDecisions: plan.skillDecisions.map((decision) => ({ ...decision, entityId: 42, evidenceIds: false })),
    baselineOverrides: plan.baselineOverrides.map((override) => ({ ...override, evidenceIds: "missing" })),
    omissions: [{ baselineItemId: omittedId, rationale: "Focus on current services.", evidenceIds: null }],
  };
  return { analysis, originalAnalysis, originalHash, originalPlan };
}

test("historical citation corruption does not block rendered edits or mutate stored objects", () => {
  const { analysis, originalAnalysis, originalHash, originalPlan } = fixtures();
  const before = structuredClone({ originalAnalysis, originalPlan });
  const stored = parsePersistedJobAnalysis(originalAnalysis);
  const plan = parsePersistedTailoringPlan(originalPlan, stored);
  const tex = renderEditedResume({ plan, commentDispositions: [] }, [], stored.analysis, baseline, snapshot);
  expect(tex).toContain("Built TypeScript services.");
  expect(tex).toContain("{: TypeScript}");
  expect(tex).not.toContain("Maintained old tooling.");
  expect(stored.analysis).toEqual(analysis);
  expect(stored.sourceSha256).toBe(originalHash);
  expect(plan.analysisSha256).toBe(hashJobAnalysis(analysis));
  expect({ originalAnalysis, originalPlan }).toEqual(before);
});


test("rejects broken historical analysis linkage before replacing its hash", () => {
  const { originalAnalysis, originalPlan } = fixtures();
  const stored = parsePersistedJobAnalysis(originalAnalysis);
  expect(() => parsePersistedTailoringPlan({ ...originalPlan, analysisSha256: "b".repeat(64) }, stored)).toThrow();
  expect(() => parsePersistedTailoringPlan({ ...originalPlan, analysisId: "different-analysis" }, stored)).toThrow();
});

test("reads a citation-free follow-on plan against inherited historical analysis", () => {
  const { originalAnalysis, originalPlan } = fixtures();
  const stored = parsePersistedJobAnalysis(originalAnalysis);
  const firstPlan = parsePersistedTailoringPlan(originalPlan, stored);
  const nextPlan = parsePersistedTailoringPlan(JSON.parse(JSON.stringify(firstPlan)), stored);
  const tex = renderEditedResume({ plan: nextPlan, commentDispositions: [] }, [], stored.analysis, baseline, snapshot);
  expect(tex).toContain("Built TypeScript services.");
  expect(tex).toContain("{: TypeScript}");
  expect(tex).not.toContain("Maintained old tooling.");
});

test("historical readers discard only retired fields, not unknown contract fields", () => {
  const { originalAnalysis, originalPlan } = fixtures();
  const stored = parsePersistedJobAnalysis(originalAnalysis);
  expect(() => parsePersistedJobAnalysis({ ...originalAnalysis, invented: true })).toThrow();
  expect(() => parsePersistedJobAnalysis({
    ...originalAnalysis,
    exactEdits: originalAnalysis.exactEdits.map((edit) => ({ ...edit, invented: true })),
  })).toThrow();
  expect(() => parsePersistedTailoringPlan({ ...originalPlan, invented: true }, stored)).toThrow();
});