import { describe, expect, test } from "bun:test";

import {
  DiscoveryHttpBudget,
  SafePublicHttpClient,
  type ConnectorFetch,
} from "../src/discovery/connectors/http";

const PUBLIC_ADDRESS = "93.184.216.34";

describe("SafePublicHttpClient", () => {
  test("rejects numeric options that could disable network safety limits", () => {
    const invalidClients = [
      () => new SafePublicHttpClient({ timeoutMs: Number.NaN }),
      () => new SafePublicHttpClient({ timeoutMs: Number.POSITIVE_INFINITY }),
      () => new SafePublicHttpClient({ timeoutMs: 0 }),
      () => new SafePublicHttpClient({ timeoutMs: 1.5 }),
      () => new SafePublicHttpClient({ maxRedirects: Number.NaN }),
      () => new SafePublicHttpClient({ maxRedirects: Number.POSITIVE_INFINITY }),
      () => new SafePublicHttpClient({ maxRedirects: -1 }),
      () => new SafePublicHttpClient({ maxRedirects: 0.5 }),
      () => new SafePublicHttpClient({ maxRedirects: Number.MAX_SAFE_INTEGER + 1 }),
      () => new SafePublicHttpClient({ maxBodyBytes: Number.NaN }),
      () => new SafePublicHttpClient({ maxBodyBytes: Number.POSITIVE_INFINITY }),
      () => new SafePublicHttpClient({ maxBodyBytes: 0 }),
      () => new SafePublicHttpClient({ maxBodyBytes: 1.5 }),
    ];

    for (const createClient of invalidClients) {
      expect(createClient).toThrow("Invalid safe public HTTP client options");
    }

    expect(() => new SafePublicHttpClient({
      timeoutMs: 1,
      maxRedirects: 0,
      maxBodyBytes: 1,
    })).not.toThrow();
  });

  test("pins each redirect hop to a freshly validated public address", async () => {
    const resolved: string[] = [];
    const requests: Array<{ url: string; host: string | null }> = [];
    const fetchImpl: ConnectorFetch = async (input, init) => {
      requests.push({ url: String(input), host: new Headers(init?.headers).get("host") });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://jobs.example.net/detail/7" },
        });
      }
      return new Response("description", { headers: { "content-type": "text/plain" } });
    };
    const client = new SafePublicHttpClient({
      fetchImpl,
      resolveHost: async (hostname) => {
        resolved.push(hostname);
        return [{ address: PUBLIC_ADDRESS, family: 4 }];
      },
    });

    const response = await client.get("https://board.example/jobs", {
      acceptedMediaTypes: ["text/plain"],
    });

    expect(response.text()).toBe("description");
    expect(response.url.href).toBe("https://jobs.example.net/detail/7");
    expect(resolved).toEqual(["board.example", "jobs.example.net"]);
    expect(requests).toEqual([
      { url: `https://${PUBLIC_ADDRESS}/jobs`, host: "board.example" },
      { url: `https://${PUBLIC_ADDRESS}/detail/7`, host: "jobs.example.net" },
    ]);
  });

  test("preserves an explicit Accept header while validating allowed response media", async () => {
    const seenAccept: Array<string | null> = [];
    const client = new SafePublicHttpClient({
      fetchImpl: async (_input, init) => {
        seenAccept.push(new Headers(init.headers).get("accept"));
        return new Response("# internships", {
          headers: { "content-type": "application/vnd.github.raw+json; charset=utf-8" },
        });
      },
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });

    const response = await client.get("https://api.github.com/repos/example/jobs/contents/README.md", {
      headers: { accept: "application/vnd.github.raw+json" },
      acceptedMediaTypes: ["application/vnd.github.raw+json", "application/json"],
    });

    expect(seenAccept).toEqual(["application/vnd.github.raw+json"]);
    expect(response.text()).toBe("# internships");
  });

  test("rejects a destination when any DNS answer is private", async () => {
    const client = new SafePublicHttpClient({
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
      resolveHost: async () => [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });

    await expect(client.get("https://board.example/jobs")).rejects.toMatchObject({
      code: "DESTINATION_BLOCKED",
      message: "Discovery source must resolve to a public HTTP(S) address",
    });
  });

  test("revalidates and blocks a redirect to a private destination", async () => {
    const client = new SafePublicHttpClient({
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      }),
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });

    await expect(client.get("https://board.example/jobs")).rejects.toMatchObject({ code: "DESTINATION_BLOCKED" });
  });

  test("rejects an oversized streamed body without exposing body text", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789"));
        controller.close();
      },
    });
    const client = new SafePublicHttpClient({
      maxBodyBytes: 8,
      fetchImpl: async () => new Response(body, { headers: { "content-type": "text/html" } }),
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });

    try {
      await client.get("https://board.example/jobs");
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "RESPONSE_TOO_LARGE", message: "Discovery source response exceeded the size limit" });
      expect(String(error)).not.toContain("0123456789");
    }
  });

  test("cancels an encoded response body before rejecting it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const client = new SafePublicHttpClient({
      fetchImpl: async () => new Response(body, {
        headers: {
          "content-encoding": "gzip",
          "content-type": "application/json",
        },
      }),
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });

    await expect(client.get("https://board.example/jobs")).rejects.toMatchObject({
      code: "REQUEST_FAILED",
    });
    expect(cancelled).toBe(true);
  });

  test("strips authorization across HTTPS default-port cross-host redirects", async () => {
    const seenAuthorization: Array<string | null> = [];
    const redirects = [
      "https://uploads.github.com/repos/a/b",
      "https://raw.githubusercontent.com/a/b",
    ];
    const client = new SafePublicHttpClient({
      fetchImpl: async (_input, init) => {
        seenAuthorization.push(new Headers(init?.headers).get("authorization"));
        const location = redirects.shift();
        return location
          ? new Response(null, { status: 302, headers: { location } })
          : new Response("{}", { headers: { "content-type": "application/json" } });
      },
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });

    await client.get("https://api.github.com/repos/a/b", {
      headers: { authorization: "Bearer top-secret" },
      authorizationOrigin: "https://api.github.com",
    });

    expect(seenAuthorization).toEqual(["Bearer top-secret", null, null]);
  });

  test("never requests redirects that downgrade HTTPS or use an alternate port without an allowlist", async () => {
    for (const location of [
      "http://board.example/jobs",
      "https://board.example:8443/jobs",
    ]) {
      const requests: string[] = [];
      let resolutions = 0;
      const client = new SafePublicHttpClient({
        fetchImpl: async (input) => {
          requests.push(String(input));
          return new Response(null, { status: 302, headers: { location } });
        },
        resolveHost: async () => {
          resolutions += 1;
          return [{ address: PUBLIC_ADDRESS, family: 4 }];
        },
      });

      await expect(client.get("https://board.example/start")).rejects.toMatchObject({
        code: "DESTINATION_BLOCKED",
        message: "Discovery source must resolve to a public HTTP(S) address",
      });
      expect(requests).toEqual([`https://${PUBLIC_ADDRESS}/start`]);
      expect(resolutions).toBe(1);
    }
  });

  test("rejects unsupported media and never forwards authorization off its allowlisted host", async () => {
    const seenAuthorization: Array<string | null> = [];
    const client = new SafePublicHttpClient({
      fetchImpl: async (_input, init) => {
        seenAuthorization.push(new Headers(init?.headers).get("authorization"));
        if (seenAuthorization.length === 1) {
          return new Response(null, { status: 301, headers: { location: "https://cdn.example/file" } });
        }
        return new Response("{}", { headers: { "content-type": "application/octet-stream" } });
      },
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });

    await expect(client.get("https://api.github.com/repos/a/b", {
      headers: { authorization: "Bearer top-secret" },
      authorizationOrigin: "https://api.github.com",
    })).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
    expect(seenAuthorization).toEqual(["Bearer top-secret", null]);
  });

  test("charges every resolved-address transport attempt against the request budget", async () => {
    let attempts = 0;
    const client = new SafePublicHttpClient({
      budget: new DiscoveryHttpBudget({ maxRequests: 2, maxBytes: 32 }),
      fetchImpl: async () => {
        attempts += 1;
        throw new Error(`private connection failure ${attempts}`);
      },
      resolveHost: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "8.8.8.8", family: 4 },
        { address: "9.9.9.9", family: 4 },
      ],
    });

    await expect(client.get("https://board.example/jobs")).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      message: "Discovery synchronization exceeded its network budget",
    });
    expect(attempts).toBe(2);
  });

  test("refunds only unused bytes after successful reads across client forks", async () => {
    let requests = 0;
    const budget = new DiscoveryHttpBudget({ maxRequests: 3, maxBytes: 12 });
    const client = new SafePublicHttpClient({
      fetchImpl: async () => {
        requests += 1;
        return new Response("123456", { headers: { "content-type": "text/plain" } });
      },
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    }).withBudget(budget);

    await expect(client.get("https://board.example/one")).resolves.toMatchObject({ status: 200 });
    await expect(client.get("https://board.example/two")).resolves.toMatchObject({ status: 200 });
    await expect(client.get("https://board.example/three")).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
    expect(requests).toBe(3);
  });

  test("consumes full byte reservations after oversized and errored body reads", async () => {
    const encoder = new TextEncoder();
    const scenarios = [
      {
        code: "RESPONSE_TOO_LARGE",
        message: "Discovery source response exceeded the size limit",
        body: () => new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("123456789"));
            controller.close();
          },
        }),
      },
      {
        code: "REQUEST_FAILED",
        message: "Discovery source could not be loaded",
        body: () => {
          let emitted = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!emitted) {
                emitted = true;
                controller.enqueue(encoder.encode("123"));
                return;
              }
              controller.error(new Error("private stream failure"));
            },
          });
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      let attempts = 0;
      let secondBodyCancelled = false;
      const client = new SafePublicHttpClient({
        budget: new DiscoveryHttpBudget({ maxRequests: 2, maxBytes: 8 }),
        maxBodyBytes: 8,
        fetchImpl: async () => {
          attempts += 1;
          const body = attempts === 1
            ? scenario.body()
            : new ReadableStream<Uint8Array>({
              cancel() {
                secondBodyCancelled = true;
              },
            });
          return new Response(body, { headers: { "content-type": "text/plain" } });
        },
        resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
      });

      await expect(client.get("https://board.example/one")).rejects.toMatchObject({
        code: scenario.code,
        message: scenario.message,
      });
      await expect(client.get("https://board.example/two")).rejects.toMatchObject({
        code: "BUDGET_EXCEEDED",
        message: "Discovery synchronization exceeded its network budget",
      });
      expect(attempts).toBe(2);
      expect(secondBodyCancelled).toBe(true);
    }
  });

  test("enforces the redirect cap and the single network deadline", async () => {
    const redirecting = new SafePublicHttpClient({
      maxRedirects: 1,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "/again" },
      }),
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    await expect(redirecting.get("https://board.example/jobs")).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });

    const timingOut = new SafePublicHttpClient({
      timeoutMs: 5,
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    await expect(timingOut.get("https://board.example/jobs")).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      message: "Discovery source request timed out",
    });
  });

  test("propagates caller abort rather than replacing it with a network error", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled by caller", "AbortError");
    const client = new SafePublicHttpClient({
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    const request = client.get("https://board.example/jobs", { signal: controller.signal });
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });
});
