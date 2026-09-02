import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppNavigationView } from "../app/components/app-navigation";

describe("AppNavigationView", () => {
  test("orders the three destinations and marks Discovery current", () => {
    const markup = renderToStaticMarkup(<AppNavigationView pathname="/discovery" />);

    expect(markup.indexOf("Applications")).toBeLessThan(markup.indexOf("Discovery"));
    expect(markup.indexOf("Discovery")).toBeLessThan(markup.indexOf("Credentials"));
    expect(markup).not.toContain("Events");
    expect(markup.match(/<a[^>]*href="\/discovery"[^>]*>/)?.[0]).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Primary navigation"');
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(3);
  });

  test("links to Credentials and marks its route current", () => {
    const markup = renderToStaticMarkup(<AppNavigationView pathname="/credentials" />);

    const credentialsLink = markup.match(/<a[^>]*href="\/credentials"[^>]*>/)?.[0];
    expect(credentialsLink).toContain('aria-current="page"');
    expect(markup).toContain(">Credentials<");
    expect(markup).not.toContain(">Providers<");
  });

  test("keeps the primary navigation off run detail pages", () => {
    expect(renderToStaticMarkup(<AppNavigationView pathname="/runs/run-1" />)).toBe("");
  });
});
