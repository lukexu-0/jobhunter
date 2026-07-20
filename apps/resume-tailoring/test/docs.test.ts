import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const documents = [
  "info/docs/apps/index.html",
  "info/docs/apps/pipeline/index.html",
  "info/docs/apps/browser-harness/index.html",
  "info/docs/apps/browser-harness/application.html",
  "info/docs/apps/web/index.html",
];
function localHref(value: string): boolean {
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

describe("application documentation", () => {
  test("is standalone HTML5 with resolvable local links and fragments", async () => {
    for (const relativeDocument of documents) {
      const documentPath = resolve(repositoryRoot, relativeDocument);
      const html = await readFile(documentPath, "utf8");
      expect(html.toLowerCase().startsWith("<!doctype html>")).toBeTrue();
      expect(html).toContain("<html lang=\"en\">");
      expect(html).toContain("</html>");

      for (const match of html.matchAll(/href="([^"]+)"/g)) {
        const href = match[1]!;
        if (!localHref(href)) continue;
        const [pathPart = "", fragment] = href.split("#", 2);
        const targetPath = pathPart
          ? resolve(dirname(documentPath), decodeURIComponent(pathPart))
          : documentPath;
        expect((await stat(targetPath)).isFile()).toBeTrue();
        if (fragment) {
          const target = await readFile(targetPath, "utf8");
          expect(target).toContain(`id="${decodeURIComponent(fragment)}"`);
        }
      }
    }
  });

  test("publishes the executable workspace verification commands", async () => {
    const html = await readFile(resolve(repositoryRoot, "info/docs/apps/index.html"), "utf8");
    for (const command of [
      "cd apps &amp;&amp; bun install",
      "cd apps &amp;&amp; bun run dev",
      "cd apps &amp;&amp; bun run test",
      "cd apps &amp;&amp; bun run typecheck",
      "cd apps &amp;&amp; bun run build",
      "cd apps &amp;&amp; bun run --cwd resume-tailoring context:sync",
      "cd apps &amp;&amp; bun run --cwd resume-tailoring doctor",
    ]) {
      expect(html).toContain(command);
    }
  });
});
