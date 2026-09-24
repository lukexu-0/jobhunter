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

  test("accepts the localhost alias for a 127.0.0.1 mutation origin", async () => {
    let routeCalls = 0;
    const aliasHandler = createApiHandler({
      webOrigin: WEB_ORIGIN,
      route: () => {
        routeCalls += 1;
        return new Response(null, { status: 204 });
      },
    });

    const response = await aliasHandler(
      new Request("http://127.0.0.1:3457/v1/known-mutation", {
        method: "POST",
        headers: { origin: "http://localhost:3456", "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(204);
    expect(routeCalls).toBe(1);
  });

  test("accepts the 127.0.0.1 alias for a localhost mutation origin", async () => {
    let routeCalls = 0;
    const aliasHandler = createApiHandler({
      webOrigin: "http://localhost:3456",
      route: () => {
        routeCalls += 1;
        return new Response(null, { status: 204 });
      },
    });

    const response = await aliasHandler(
      new Request("http://127.0.0.1:3457/v1/known-mutation", {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(204);
    expect(routeCalls).toBe(1);
  });

  test("does not derive an alias from a normalized configured hostname", async () => {
    let routeCalls = 0;
    const configuredOrigins = [
      ["http://127.1:3456", "http://localhost:3456"],
      ["http://2130706433:3456", "http://localhost:3456"],
      ["http://%6cocalhost:3456", WEB_ORIGIN],
    ] as const;

    for (const [webOrigin, origin] of configuredOrigins) {
      const guardedHandler = createApiHandler({
        webOrigin,
        route: () => {
          routeCalls += 1;
          return new Response(null, { status: 204 });
        },
      });
      const response = await guardedHandler(
        new Request("http://127.0.0.1:3457/v1/known-mutation", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: "{}",
        }),
      );

      expect(response.status).toBe(403);
    }

    expect(routeCalls).toBe(0);
  });

  test("continues to accept the exact configured mutation origin", async () => {
    let routeCalls = 0;
    const exactOriginHandler = createApiHandler({
      webOrigin: WEB_ORIGIN,
      route: () => {
        routeCalls += 1;
        return new Response(null, { status: 204 });
      },
    });

    const response = await exactOriginHandler(
      new Request("http://127.0.0.1:3457/v1/known-mutation", {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(204);
    expect(routeCalls).toBe(1);
  });

  test("rejects mismatched and malformed mutation origins before routing", async () => {
    let routeCalls = 0;
    const guardedHandler = createApiHandler({
      webOrigin: WEB_ORIGIN,
      route: () => {
        routeCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    const rejectedOrigins = [
      "https://localhost:3456",
      "http://localhost:3457",
      "http://localhost.evil:3456",
      "http://127.0.0.2:3456",
      "https://attacker.invalid",
      "not an origin",
      "http://localhost:3456/",
      "null",
      null,
    ] as const;

    for (const origin of rejectedOrigins) {
      const headers = new Headers({ "content-type": "application/json" });
      if (origin !== null) headers.set("origin", origin);
      const response = await guardedHandler(
        new Request("http://127.0.0.1:3457/v1/known-mutation", {
          method: "POST",
          headers,
          body: "{}",
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          code: "ORIGIN_REJECTED",
          message: "Mutation origin is not allowed",
        },
      });
    }

    expect(routeCalls).toBe(0);
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
