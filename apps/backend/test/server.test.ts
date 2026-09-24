import { expect, test } from "bun:test";
import { resolvePipelinePort, startPipelineHttpServer } from "../src/index";

function isolatedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return fetch(input, { ...init, headers });
}

test("pipeline port accepts the isolated development port", () => {
  expect(resolvePipelinePort("3557")).toBe(3557);
});

test("pipeline port defaults safely and rejects malformed values", () => {
  expect(resolvePipelinePort(undefined)).toBe(3457);
  for (const value of ["", "0", "3.5", "3467x", "65536"]) {
    expect(() => resolvePipelinePort(value)).toThrow("JOBHUNT_PIPELINE_PORT");
  }
});

test("long-lived application event routes outlive Bun's default idle timeout", async () => {
  const server = startPipelineHttpServer(
    {
      fetch: async () => {
        await Bun.sleep(12_000);
        return new Response("completed");
      },
    },
    { port: 0 },
  );
  try {
    const response = await isolatedFetch(
      `http://127.0.0.1:${server.port}/v1/runs/run-1/application/events`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("completed");
  } finally {
    await server.stop(true);
  }
}, 18_000);

test("credential command POSTs can outlive Bun's default idle timeout", async () => {
  const server = startPipelineHttpServer(
    {
      // This integration check must cross Bun's real 10-second socket idle timeout.
      fetch: async () => {
        await Bun.sleep(12_000);
        return new Response("completed");
      },
    },
    { port: 0 },
  );
  try {
    const [
      credentialCommandRequest,
    ] = await Promise.allSettled([
      isolatedFetch(
        `http://127.0.0.1:${server.port}/v1/runs/run-1/application/commands`,
        { method: "POST" },
      ),
    ]);

    expect(credentialCommandRequest.status).toBe("fulfilled");
    if (credentialCommandRequest.status === "fulfilled") {
      expect(credentialCommandRequest.value.status).toBe(200);
      expect(await credentialCommandRequest.value.text()).toBe("completed");
    }
  } finally {
    await server.stop(true);
  }
}, 18_000);

test("validated run creation and source handoff POSTs outlive Bun's idle timeout", async () => {
  const server = startPipelineHttpServer(
    {
      // This integration check must cross Bun's real 10-second socket idle timeout.
      fetch: async (request, context) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/runs") {
          await request.json();
          context?.onRunCreationValidated?.();
        }
        if (
          request.method === "POST"
          && url.pathname === "/v1/source-handoffs"
        ) {
          await request.json();
          context?.onSourceHandoffCreationValidated?.();
        }
        if (
          request.method === "POST"
          && /^\/v1\/source-handoffs\/[^/]+\/complete$/.test(url.pathname)
          && request.body === null
        ) {
          context?.onSourceHandoffCompletionValidated?.();
        }
        await Bun.sleep(12_000);
        return new Response("completed");
      },
    },
    { port: 0 },
  );
  try {
    const [
      sourceCreationRequest,
      runCreationRequest,
      sourceCompletionRequest,
    ] = await Promise.allSettled([
      isolatedFetch(`http://127.0.0.1:${server.port}/v1/source-handoffs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobUrl: "https://jobs.example.test/role" }),
      }),
      isolatedFetch(`http://127.0.0.1:${server.port}/v1/runs?source=browser`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobUrl: "https://jobs.example.test/role" }),
      }),
      isolatedFetch(
        `http://127.0.0.1:${server.port}/v1/source-handoffs/123e4567-e89b-42d3-a456-426614174000/complete`,
        { method: "POST" },
      ),
    ]);

    expect(runCreationRequest.status).toBe("fulfilled");
    if (runCreationRequest.status === "fulfilled") {
      expect(runCreationRequest.value.status).toBe(200);
      expect(await runCreationRequest.value.text()).toBe("completed");
    }
    expect(sourceCompletionRequest.status).toBe("fulfilled");
    if (sourceCompletionRequest.status === "fulfilled") {
      expect(sourceCompletionRequest.value.status).toBe(200);
      expect(await sourceCompletionRequest.value.text()).toBe("completed");
    }
    expect(sourceCreationRequest.status).toBe("fulfilled");
    if (sourceCreationRequest.status === "fulfilled") {
      expect(sourceCreationRequest.value.status).toBe(200);
      expect(await sourceCreationRequest.value.text()).toBe("completed");
    }
  } finally {
    await server.stop(true);
  }
}, 18_000);
