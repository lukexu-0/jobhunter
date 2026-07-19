import { checkContextFreshness, loadContextManifest, openContextDatabase, syncContext } from "../src/context/index.ts";

interface ScriptReport {
  readonly ok: boolean;
  readonly mode: "sync" | "check";
  readonly fresh?: boolean;
  readonly manifestSha256?: string;
  readonly indexedAt?: number;
  readonly changedSources?: readonly string[];
  readonly sourceCount?: number;
  readonly blockCount?: number;
  readonly staleSources?: readonly string[];
  readonly missingSources?: readonly string[];
  readonly error?: string;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\r\n\t]+/g, " ").slice(0, 500);
}

export function runContextSyncScript(args: readonly string[] = Bun.argv.slice(2)): ScriptReport {
  const mode = args.length === 0 ? "sync" : args.length === 1 && args[0] === "--check" ? "check" : null;
  if (!mode) throw new Error("Usage: bun scripts/context-sync.ts [--check]");
  const loaded = loadContextManifest();
  const database = openContextDatabase();
  try {
    if (mode === "check") {
      const report = checkContextFreshness(database, loaded);
      return Object.freeze({ ok: report.fresh, mode, ...report });
    }
    const report = syncContext(database, loaded);
    const freshness = checkContextFreshness(database, loaded);
    if (!freshness.fresh) throw new Error("Context remained stale after synchronization");
    return Object.freeze({ ok: true, mode, ...report });
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  try {
    const report = runContextSyncScript();
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const report: ScriptReport = { ok: false, mode: Bun.argv.includes("--check") ? "check" : "sync", error: boundedMessage(error) };
    console.log(JSON.stringify(report));
    process.exitCode = 1;
  }
}
