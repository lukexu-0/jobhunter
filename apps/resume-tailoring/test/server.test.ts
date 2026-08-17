import { expect, test } from "bun:test";
import { APPLICATION_AGENT_PATH } from "../src/api/application-agent-routes";
import { DISCOVERY_SYNC_PATH } from "../src/api/discovery-routes";
import { resolvePipelinePort, startPipelineHttpServer } from "../src/index";

test("pipeline port accepts the isolated development port", () => {
  expect(resolvePipelinePort("3557")).toBe(3557);
});

test("pipeline port defaults safely and rejects malformed values", () => {
  expect(resolvePipelinePort(undefined)).toBe(3457);
  for (const value of ["", "0", "3.5", "3467x", "65536"]) {
    expect(() => resolvePipelinePort(value)).toThrow("JOBHUNTER_PIPELINE_PORT");
  }
});

test("only long-lived application routes disable Bun's default idle timeout", async () => {
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
    const [
      agentRequest,
      eventRequest,
      discoverySyncRequest,
      unrelatedRequest,
    ] = await Promise.allSettled([
      fetch(`http://127.0.0.1:${server.port}${APPLICATION_AGENT_PATH}`, { method: "POST" }),
      fetch(`http://127.0.0.1:${server.port}/v1/runs/run-1/application/events`),
      fetch(`http://127.0.0.1:${server.port}${DISCOVERY_SYNC_PATH}`, { method: "POST" }),
      fetch(`http://127.0.0.1:${server.port}/long-running-unrelated-request`),
    ]);

    expect(agentRequest.status).toBe("fulfilled");
    if (agentRequest.status === "fulfilled") {
      expect(agentRequest.value.status).toBe(200);
      expect(await agentRequest.value.text()).toBe("completed");
    }
    expect(eventRequest.status).toBe("fulfilled");
    if (eventRequest.status === "fulfilled") {
      expect(eventRequest.value.status).toBe(200);
      expect(await eventRequest.value.text()).toBe("completed");
    }
    expect(discoverySyncRequest.status).toBe("fulfilled");
    if (discoverySyncRequest.status === "fulfilled") {
      expect(discoverySyncRequest.value.status).toBe(200);
      expect(await discoverySyncRequest.value.text()).toBe("completed");
    }
    expect(unrelatedRequest.status).toBe("rejected");
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
      samePathGetRequest,
      unrelatedRunRequest,
    ] = await Promise.allSettled([
      fetch(
        `http://127.0.0.1:${server.port}/v1/runs/run-1/application/commands`,
        { method: "POST" },
      ),
      fetch(`http://127.0.0.1:${server.port}/v1/runs/run-1/application/commands`),
      fetch(
        `http://127.0.0.1:${server.port}/v1/runs/run-1/application/retry`,
        { method: "POST" },
      ),
    ]);

    expect(credentialCommandRequest.status).toBe("fulfilled");
    if (credentialCommandRequest.status === "fulfilled") {
      expect(credentialCommandRequest.value.status).toBe(200);
      expect(await credentialCommandRequest.value.text()).toBe("completed");
    }
    expect(samePathGetRequest.status).toBe("rejected");
    expect(unrelatedRunRequest.status).toBe("rejected");
  } finally {
    await server.stop(true);
  }
}, 18_000);

test("only exact run-creation POSTs can outlive Bun's default idle timeout", async () => {
  const server = startPipelineHttpServer(
    {
      // This integration check must cross Bun's real 10-second socket idle timeout.
      fetch: async (request, context) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/runs") {
          await request.json();
          context?.onRunCreationValidated?.();
        }
        await Bun.sleep(12_000);
        return new Response("completed");
      },
    },
    { port: 0 },
  );
  try {
    const [
      runCreationRequest,
      runListRequest,
      nestedRunMutationRequest,
    ] = await Promise.allSettled([
      fetch(`http://127.0.0.1:${server.port}/v1/runs?source=browser`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobUrl: "https://jobs.example.test/role" }),
      }),
      fetch(`http://127.0.0.1:${server.port}/v1/runs`),
      fetch(`http://127.0.0.1:${server.port}/v1/runs/run-1/retry`, {
        method: "POST",
      }),
    ]);

    expect(runCreationRequest.status).toBe("fulfilled");
    if (runCreationRequest.status === "fulfilled") {
      expect(runCreationRequest.value.status).toBe(200);
      expect(await runCreationRequest.value.text()).toBe("completed");
    }
    expect(runListRequest.status).toBe("rejected");
    expect(nestedRunMutationRequest.status).toBe("rejected");
  } finally {
    await server.stop(true);
  }
}, 18_000);
