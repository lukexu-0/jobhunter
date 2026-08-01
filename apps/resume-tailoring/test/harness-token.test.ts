import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBrowserHarnessToken } from "../src/system/harness-token.ts";

const VALID_FILE_TOKEN = "file-token-0123456789abcdef0123456789";
const VALID_ENV_TOKEN = "environment-token-0123456789abcdef0123456789";
const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tokenFixture(): Promise<{ readonly home: string; readonly tokenPath: string }> {
  const home = await mkdtemp(join(tmpdir(), "jobhunter-harness-token-home-"));
  temporaryHomes.push(home);
  const tokenPath = join(home, ".jobhunter", "browser-harness", "token");
  await mkdir(dirname(tokenPath), { recursive: true });
  return { home, tokenPath };
}

async function writePrivateToken(tokenPath: string, content: string): Promise<void> {
  await writeFile(tokenPath, content, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
}

async function resolveToken(
  environ: Record<string, string | undefined>,
  defaultTokenPath: string,
): Promise<string | undefined> {
  return await resolveBrowserHarnessToken({ environ, defaultTokenPath });
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function expectTooFewCodePointsRejected(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && /at least 32|short/i.test(error.message)) {
      return;
    }
    throw new Error("Expected token validation to reject fewer than 32 Unicode code points");
  }
  throw new Error("Expected token validation to reject fewer than 32 Unicode code points");
}

describe("browser harness token resolver", () => {
  test("uses an explicit environment token instead of the default token file", async () => {
    const { tokenPath } = await tokenFixture();
    await mkdir(tokenPath);

    expect(await resolveToken({ JOBHUNTER_HARNESS_TOKEN: VALID_ENV_TOKEN }, tokenPath))
      .toBe(VALID_ENV_TOKEN);
  });

  test("rejects an invalid explicit environment token without falling back to the file", async () => {
    const { tokenPath } = await tokenFixture();
    await writePrivateToken(tokenPath, VALID_FILE_TOKEN);

    for (const explicitToken of ["", "too-short"]) {
      await expect(resolveToken({ JOBHUNTER_HARNESS_TOKEN: explicitToken }, tokenPath))
        .rejects.toThrow(/at least 32|short/i);
    }
  });

  test("loads a private regular default token file when the environment is absent", async () => {
    const { tokenPath } = await tokenFixture();
    await writePrivateToken(tokenPath, VALID_FILE_TOKEN);

    expect(await resolveToken({}, tokenPath)).toBe(VALID_FILE_TOKEN);
  });

  test("matches the Python runtime by removing a leading UTF-8 BOM from the private default file", async () => {
    const { tokenPath } = await tokenFixture();
    await writePrivateToken(tokenPath, `\uFEFF${VALID_FILE_TOKEN}`);

    const resolved = await resolveToken({}, tokenPath);
    if (resolved === undefined) throw new Error("Expected a configured browser harness token");
    expect(tokenFingerprint(resolved)).toBe(tokenFingerprint(VALID_FILE_TOKEN));
  });

  test("matches the Python runtime by counting Unicode code points in explicit tokens", async () => {
    const sixteenCodePoints = "😀".repeat(16);
    const thirtyTwoCodePoints = "😀".repeat(32);

    await expectTooFewCodePointsRejected(() =>
      resolveToken(
        { JOBHUNTER_HARNESS_TOKEN: sixteenCodePoints },
        "/default-token-must-not-be-read",
      ),
    );
    const resolved = await resolveToken(
      { JOBHUNTER_HARNESS_TOKEN: thirtyTwoCodePoints },
      "/default-token-must-not-be-read",
    );
    if (resolved === undefined) throw new Error("Expected a configured browser harness token");
    expect(tokenFingerprint(resolved)).toBe(tokenFingerprint(thirtyTwoCodePoints));
  });

  test("matches the Python runtime by counting Unicode code points in private default files", async () => {
    const { tokenPath } = await tokenFixture();
    const sixteenCodePoints = "😀".repeat(16);
    await writePrivateToken(tokenPath, sixteenCodePoints);

    await expectTooFewCodePointsRejected(() => resolveToken({}, tokenPath));

    const thirtyTwoCodePoints = "😀".repeat(32);
    await writePrivateToken(tokenPath, thirtyTwoCodePoints);
    const resolved = await resolveToken({}, tokenPath);
    if (resolved === undefined) throw new Error("Expected a configured browser harness token");
    expect(tokenFingerprint(resolved)).toBe(tokenFingerprint(thirtyTwoCodePoints));
  });

  test("returns unconfigured when the default token file is missing", async () => {
    const { tokenPath } = await tokenFixture();

    expect(await resolveToken({}, tokenPath)).toBeUndefined();
  });

  test("removes one trailing newline from the default token file", async () => {
    const { tokenPath } = await tokenFixture();
    const token = "n".repeat(32);
    await writePrivateToken(tokenPath, `${token}\n`);

    expect(await resolveToken({}, tokenPath)).toBe(token);
  });

  test("rejects default token content shorter than 32 characters after trimming", async () => {
    const { tokenPath } = await tokenFixture();
    await writePrivateToken(tokenPath, `${"s".repeat(31)}\n`);

    await expect(resolveToken({}, tokenPath)).rejects.toThrow(/at least 32|short/i);
  });

  test("rejects default token content that is not UTF-8", async () => {
    const { tokenPath } = await tokenFixture();
    await writeFile(tokenPath, Uint8Array.from([
      ...new TextEncoder().encode("x".repeat(32)),
      0xff,
    ]), { mode: 0o600 });
    await chmod(tokenPath, 0o600);

    await expect(resolveToken({}, tokenPath)).rejects.toThrow(/UTF-8/i);
  });

  test("rejects a default token file with group or other permissions", async () => {
    for (const mode of [0o640, 0o604]) {
      const { tokenPath } = await tokenFixture();
      await writeFile(tokenPath, VALID_FILE_TOKEN, { mode });
      await chmod(tokenPath, mode);

      await expect(resolveToken({}, tokenPath)).rejects.toThrow(/permission|mode|private/i);
    }
  });

  test("rejects a symbolic-link default token path", async () => {
    const { home, tokenPath } = await tokenFixture();
    const targetPath = join(home, "token-target");
    await writePrivateToken(targetPath, VALID_FILE_TOKEN);
    await symlink(targetPath, tokenPath);

    await expect(resolveToken({}, tokenPath)).rejects.toThrow(/symbolic link|symlink/i);
  });

  test("rejects a non-regular default token path", async () => {
    const { tokenPath } = await tokenFixture();
    await mkdir(tokenPath);

    await expect(resolveToken({}, tokenPath)).rejects.toThrow(/regular file/i);
  });

  test("rejects default token content larger than 4096 bytes", async () => {
    const { tokenPath } = await tokenFixture();
    await writePrivateToken(tokenPath, "x".repeat(4097));

    await expect(resolveToken({}, tokenPath)).rejects.toThrow(/4096|size|large/i);
  });
});
