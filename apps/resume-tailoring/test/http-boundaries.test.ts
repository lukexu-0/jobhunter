import { describe, expect, test } from "bun:test";
import { createApiHandler } from "../src/api/handler";

const WEB_ORIGIN = "http://127.0.0.1:3456";
const handler = createApiHandler({ webOrigin: WEB_ORIGIN });

describe("HTTP boundary policy", () => {
  test("health is loopback-safe and never cached", async () => {
    const response = await handler(new Request("http://127.0.0.1:3457/v1/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("rejects a mutation from an untrusted origin before routing", async () => {
    const response = await handler(
      new Request("http://127.0.0.1:3457/v1/unknown", {
        method: "POST",
        headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
  });

  test("requires JSON for mutation bodies", async () => {
    const response = await handler(
      new Request("http://127.0.0.1:3457/v1/unknown", {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(415);
  });

  test("rejects JSON-prefixed non-JSON media types before routing", async () => {
    let routeCalls = 0;
    const guardedHandler = createApiHandler({
      webOrigin: WEB_ORIGIN,
      route: () => {
        routeCalls += 1;
        return new Response(null, { status: 204 });
      },
    });

    for (const contentType of ["application/jsonp", "application/json-evil"]) {
      const response = await guardedHandler(
        new Request("http://127.0.0.1:3457/v1/known-mutation", {
          method: "POST",
          headers: { origin: WEB_ORIGIN, "content-type": contentType },
          body: "{}",
        }),
      );

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({
        error: {
          code: "JSON_REQUIRED",
          message: "Mutation request bodies must use application/json",
        },
      });
    }

    expect(routeCalls).toBe(0);
  });

  test("permits bodyless DELETE requests without a content type", async () => {
    const response = await handler(
      new Request("http://127.0.0.1:3457/v1/auth/sessions/not-found", {
        method: "DELETE",
        headers: { origin: WEB_ORIGIN },
      }),
    );
    expect(response.status).toBe(404);
  });
});
