import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_TOKEN_BYTES = 4_096;
const MIN_TOKEN_CHARACTERS = 32;
const PRIVATE_MODE_MASK = 0o077;

export interface BrowserHarnessTokenOptions {
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly defaultTokenPath?: string;
}

function validateTokenLength(token: string): string {
  let characters = 0;
  for (const _character of token) {
    characters += 1;
    if (characters >= MIN_TOKEN_CHARACTERS) return token;
  }
  throw new Error("JOBHUNT_HARNESS_TOKEN must contain at least 32 characters");
}

async function openDefaultToken(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") {
      throw new Error("Default browser harness token path must not be a symbolic link");
    }
    throw new Error("Unable to open the default browser harness token file", { cause: error });
  }
}

async function readDefaultToken(handle: FileHandle): Promise<string> {
  const stat = await handle.stat();
  if (!stat.isFile()) {
    throw new Error("Default browser harness token must be a regular file");
  }
  if ((stat.mode & PRIVATE_MODE_MASK) !== 0) {
    throw new Error("Default browser harness token file permissions must be private");
  }
  if (stat.size > MAX_TOKEN_BYTES) {
    throw new Error("Default browser harness token file must not exceed 4096 bytes");
  }

  const bytes = new Uint8Array(MAX_TOKEN_BYTES + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MAX_TOKEN_BYTES) {
    throw new Error("Default browser harness token file must not exceed 4096 bytes");
  }

  let token: string;
  try {
    token = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } catch {
    throw new Error("Default browser harness token file must contain valid UTF-8");
  }
  return validateTokenLength(token.trim());
}

export async function resolveBrowserHarnessToken({
  environ = process.env,
  defaultTokenPath = join(homedir(), ".jobhunt", "browser-harness", "token"),
}: BrowserHarnessTokenOptions = {}): Promise<string | undefined> {
  const explicitToken = environ.JOBHUNT_HARNESS_TOKEN;
  if (explicitToken !== undefined) return validateTokenLength(explicitToken);

  const handle = await openDefaultToken(defaultTokenPath);
  if (handle === undefined) return undefined;
  try {
    return await readDefaultToken(handle);
  } finally {
    await handle.close();
  }
}
