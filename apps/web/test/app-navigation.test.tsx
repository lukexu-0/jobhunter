import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppNavigationView } from "../app/components/app-navigation";

describe("AppNavigationView", () => {
  test("orders the three destinations without a standalone alerts page", () => {
    const markup = renderToStaticMarkup(<AppNavigationView pathname="/" />);

    expect(markup.indexOf("Applications")).toBeLessThan(markup.indexOf("Discovery"));
    expect(markup.indexOf("Discovery")).toBeLessThan(markup.indexOf("Providers"));
    expect(markup).not.toContain("Alerts");
    expect(markup).not.toContain("/notifications");
    expect(markup.match(new RegExp('<a[^>]*href="/"[^>]*>'))?.[0]).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Primary navigation"');
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(3);
  });

  test("keeps the primary navigation off run detail pages", () => {
    expect(renderToStaticMarkup(<AppNavigationView pathname="/runs/run-1" />)).toBe("");
  });
});
