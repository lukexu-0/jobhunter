import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export const CLAIM_TTL_MS = 60_000;
export const CLAIM_HEARTBEAT_MS = 20_000;
export const RUN_CLAIM_CAPACITY = 5;

export interface RunClaim {
  readonly runId: string;
  readonly token: string;
  readonly expiresAt: number;
}

export type ClaimTokenFactory = () => string;

export function createClaimToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isClaimToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function readProcessStartToken(pid = process.pid): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fieldsFromState = stat.slice(commandEnd + 2).trim().split(/\s+/);
    return fieldsFromState[19];
  } catch {
    return undefined;
  }
}

export function isProcessIdentityAlive(pid: number, expectedStartToken: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (expectedStartToken.length > 0) {
    const currentStartToken = readProcessStartToken(pid);
    return currentStartToken === undefined ? false : currentStartToken === expectedStartToken;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
