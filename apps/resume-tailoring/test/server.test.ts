import { expect, test } from "bun:test";
import { APPLICATION_AGENT_PATH } from "../src/api/application-agent-routes";
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
    const [agentRequest, eventRequest, unrelatedRequest] = await Promise.allSettled([
      fetch(`http://127.0.0.1:${server.port}${APPLICATION_AGENT_PATH}`, { method: "POST" }),
      fetch(`http://127.0.0.1:${server.port}/v1/runs/run-1/application/events`),
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
    expect(unrelatedRequest.status).toBe("rejected");
  } finally {
    await server.stop(true);
  }
}, 18_000);
