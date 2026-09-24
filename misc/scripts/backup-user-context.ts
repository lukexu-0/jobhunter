import { resolve } from "node:path";
import {
  createUserContextSnapshot,
  type UserContextMode,
} from "./user-context-backup.ts";

function parseMode(args: readonly string[]): UserContextMode {
  if (args.length !== 2 || args[0] !== "--mode" || (args[1] !== "dev" && args[1] !== "start")) {
    throw new Error("Usage: bun run user-context:backup -- --mode <start|dev>");
  }
  return args[1];
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown backup failure";
  return message.slice(0, 1_000);
}

export async function runUserContextBackupCommand(
  args: readonly string[],
  writeSummary: (summary: string) => void = console.log,
  writeError: (summary: string) => void = console.error,
): Promise<number> {
  try {
    const mode = parseMode(args);
    const result = await createUserContextSnapshot({
      mode,
      appsRoot: resolve(import.meta.dir, "../../apps"),
    });
    writeSummary(JSON.stringify({
      ok: true,
      mode,
      snapshotId: result.snapshotId,
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
  process.exitCode = await runUserContextBackupCommand(process.argv.slice(2));
}
