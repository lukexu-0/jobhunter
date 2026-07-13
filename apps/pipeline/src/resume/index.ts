import type { ContextSnapshot } from "../context/types.ts";
import type { EditResult, JobAnalysis } from "./types.ts";
import { validateEditResult } from "./ledger.ts";
import { renderTailoredResume } from "./render.ts";

export * from "./types.ts";
export * from "./parser.ts";
export * from "./render.ts";
export * from "./repair.ts";
export * from "./ledger.ts";
export * from "./deterministic-qa.ts";
export * from "./rasterize.ts";

export function renderEditedResume(result: EditResult, comments: readonly string[], analysis: JobAnalysis, baseline: string, snapshot: ContextSnapshot): string {
  validateEditResult(result, comments, analysis, snapshot);
  return renderTailoredResume(result.plan, baseline, snapshot);
}
