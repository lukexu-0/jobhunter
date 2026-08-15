import { resolve } from "node:path";
import {
  restoreUserContextSnapshot,
  type UserContextMode,
} from "./user-context-backup.ts";

interface RestoreArguments {
  readonly mode: UserContextMode;
  readonly snapshotId: string;
}

function parseArguments(args: readonly string[]): RestoreArguments {
  if (
    args.length !== 4
    || args[0] !== "--mode"
    || (args[1] !== "dev" && args[1] !== "start")
    || args[2] !== "--snapshot"
    || args[3].length === 0
  ) {
    throw new Error(
      "Usage: bun run user-context:restore -- --mode <start|dev> --snapshot <snapshot-id>",
    );
  }
  return { mode: args[1], snapshotId: args[3] };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown restore failure";
  return message.slice(0, 1_000);
}

export async function runUserContextRestoreCommand(
  args: readonly string[],
  writeSummary: (summary: string) => void = console.log,
  writeError: (summary: string) => void = console.error,
): Promise<number> {
  try {
    const parsed = parseArguments(args);
    const result = await restoreUserContextSnapshot({
      mode: parsed.mode,
      appsRoot: resolve(import.meta.dir, ".."),
      snapshotId: parsed.snapshotId,
    });
    writeSummary(JSON.stringify({
      ok: true,
      mode: parsed.mode,
      restoredSnapshotId: result.restoredSnapshotId,
      preRestoreSnapshotId: result.preRestoreSnapshotId,
      fileCount: result.fileCount,
      totalBytes: result.totalBytes,
    }));
    return 0;
  } catch (error) {
    writeError(JSON.stringify({ ok: false, error: safeErrorMessage(error) }));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runUserContextRestoreCommand(process.argv.slice(2));
}
