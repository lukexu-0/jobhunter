import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelAuthStore } from "../src/auth/model-auth.ts";

let store: ModelAuthStore | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

test("persists and removes a mirrored OAuth credential privately", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jobhunt-harness-auth-")));
  const database = join(root, "private", "model-auth.sqlite");
  store = await ModelAuthStore.open(database);

  await store.setCredential("openai-codex", {
    type: "oauth",
    refresh: "refresh-token",
    access: "access-token",
    expires: 1_800_000_000_000,
    accountId: "acct-123",
  });

  expect(store.isConnected("openai-codex")).toBe(true);
  expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
  expect((await stat(database)).mode & 0o777).toBe(0o600);

  await store.deleteCredential("openai-codex");
  expect(store.isConnected("openai-codex")).toBe(false);
});
