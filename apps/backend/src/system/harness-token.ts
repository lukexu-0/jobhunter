const MIN_TOKEN_CHARACTERS = 32;

export function resolveBrowserHarnessToken(
  environ: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const token = environ.JOBHUNT_HARNESS_TOKEN;
  if (token === undefined) return undefined;
  if ([...token].length < MIN_TOKEN_CHARACTERS) {
    throw new Error("JOBHUNT_HARNESS_TOKEN must contain at least 32 characters");
  }
  return token;
}
