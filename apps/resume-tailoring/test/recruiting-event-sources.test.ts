import { describe, expect, test } from "bun:test";
import { RECRUITING_EVENT_SOURCES } from "../src/events/sources";

describe("recruiting event source catalog", () => {
  test("exposes at least 200 unique stable HTTPS sources", () => {
    expect(RECRUITING_EVENT_SOURCES.length).toBeGreaterThanOrEqual(200);

    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const source of RECRUITING_EVENT_SOURCES) {
      expect(source.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(source.name).toBe(source.name.trim());
      expect(source.name.length).toBeGreaterThan(0);

      const url = new URL(source.url);
      expect(url.protocol).toBe("https:");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.hash).toBe("");

      expect(ids.has(source.id)).toBeFalse();
      expect(urls.has(url.href)).toBeFalse();
      ids.add(source.id);
      urls.add(url.href);
    }
  });
});
