import type { RunDto } from "./pipeline-contracts";

export function isApplicationSessionOpen(
  run: Pick<RunDto, "isApplicationSessionOpen" | "isApplying">,
): boolean {
  return run.isApplicationSessionOpen ?? Boolean(run.isApplying);
}

