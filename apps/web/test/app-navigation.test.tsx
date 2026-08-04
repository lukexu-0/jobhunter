import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppNavigationView } from "../app/components/app-navigation";

describe("AppNavigationView", () => {
  test("orders the four destinations and marks Discovery current", () => {
    const markup = renderToStaticMarkup(<AppNavigationView pathname="/discovery" />);

    expect(markup.indexOf("Applications")).toBeLessThan(markup.indexOf("Discovery"));
    expect(markup.indexOf("Discovery")).toBeLessThan(markup.indexOf("Events"));
    expect(markup.indexOf("Events")).toBeLessThan(markup.indexOf("Providers"));
    expect(markup.match(/<a[^>]*href="\/discovery"[^>]*>/)?.[0]).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Primary navigation"');
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(4);
  });

  test("keeps the primary navigation off run detail pages", () => {
    expect(renderToStaticMarkup(<AppNavigationView pathname="/runs/run-1" />)).toBe("");
  });
});
