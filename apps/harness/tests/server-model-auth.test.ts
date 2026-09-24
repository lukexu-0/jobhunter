import { expect, test } from "bun:test";

import type { ApplicationModelMetadata } from "../src/application/application-agent.ts";
import type { HarnessDependencies } from "../src/host/server.ts";
import { createHarnessHandler } from "../src/host/server.ts";

const DEFAULT_MODEL: ApplicationModelMetadata = {
  modelProvider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
};

function modelAuth(
  overrides: Partial<HarnessDependencies["modelAuth"]> = {},
): HarnessDependencies["modelAuth"] {
  return {
    async setCredential() {},
    async deleteCredential() {},
    setApplicationModel() {},
    readApplicationModel: () => DEFAULT_MODEL,
    isConnected: () => false,
    ...overrides,
  };
}

test("stores a mirrored OAuth credential for the selected model provider", async () => {
  const stored: unknown[] = [];
  const handler = createHarnessHandler(
    { bearerToken: "test-token" },
    {
      modelAuth: modelAuth({
        async setCredential(provider, credential) {
          stored.push({ provider, credential });
        },
      }),
    },
  );
  const credential = {
    type: "oauth",
    refresh: "refresh-token",
    access: "access-token",
    expires: 1_800_000_000_000,
    accountId: "acct-123",
    email: "applicant@example.com",
  };

  const response = await handler(new Request(
    "http://127.0.0.1/v1/model-credentials/openai-codex",
    {
      method: "PUT",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(credential),
    },
  ));

  expect(response.status).toBe(204);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
  expect(stored).toEqual([{ provider: "openai-codex", credential }]);
});

test("deletes the mirrored credential when the model provider logs out", async () => {
  const deleted: string[] = [];
  const handler = createHarnessHandler(
    { bearerToken: "test-token" },
    {
      modelAuth: modelAuth({
        async deleteCredential(provider) {
          deleted.push(provider);
        },
      }),
    },
  );

  const response = await handler(new Request(
    "http://127.0.0.1/v1/model-credentials/google-antigravity",
    {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    },
  ));

  expect(response.status).toBe(204);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
  expect(deleted).toEqual(["google-antigravity"]);
});

test("updates the application model used by local agent runs", async () => {
  const selected: string[] = [];
  const handler = createHarnessHandler(
    { bearerToken: "test-token" },
    {
      modelAuth: modelAuth({
        setApplicationModel(model) {
          selected.push(model);
        },
      }),
    },
  );

  const response = await handler(new Request(
    "http://127.0.0.1/v1/application-model",
    {
      method: "PUT",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gemini-3.8-flash" }),
    },
  ));

  expect(response.status).toBe(204);
  expect(selected).toEqual(["gemini-3.8-flash"]);
});

test("reports the selected application model when its OAuth credential is connected", async () => {
  const selected: ApplicationModelMetadata = {
    modelProvider: "google-antigravity",
    model: "gemini-3.8-flash",
    reasoning: "high",
  };
  const handler = createHarnessHandler(
    { bearerToken: "test-token" },
    {
      modelAuth: modelAuth({
        readApplicationModel: () => selected,
        isConnected: (provider) => provider === "google-antigravity",
      }),
    },
  );

  const response = await handler(new Request(
    "http://127.0.0.1/v1/application-model",
    { headers: { authorization: "Bearer test-token" } },
  ));

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ...selected, oauth: "connected" });
});

test("rejects application model readiness when its OAuth credential is disconnected", async () => {
  const handler = createHarnessHandler(
    { bearerToken: "test-token" },
    { modelAuth: modelAuth() },
  );

  const response = await handler(new Request(
    "http://127.0.0.1/v1/application-model",
    { headers: { authorization: "Bearer test-token" } },
  ));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    code: "oauth_required",
    message: "Connect the configured application model provider in Credentials",
  });
});
