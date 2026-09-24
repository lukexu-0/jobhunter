export function findChromeExecutable(
  findExecutable: (command: string) => string | null | undefined = Bun.which,
  platform = process.platform,
): string | undefined {
  return findExecutable("google-chrome")
    ?? (platform === "darwin"
      ? findExecutable("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        ?? findExecutable("/Applications/Chromium.app/Contents/MacOS/Chromium")
      : undefined)
    ?? undefined;
}
