import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CredentialStore } from "../src/application/credentials.ts";
import { UserInfoStore } from "../src/application/user-info.ts";

describe("UserInfoStore", () => {
  test("creates a private empty v2 store and returns empty projections", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "private", "user-info.json");

    const store = await UserInfoStore.open(path);

    expect(await store.readContents()).toBe('{"version":2,"global":{},"applications":{}}');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await store.snapshot("https://jobs.example.test/roles/42")).asTaskPayload()).toEqual({
      saved_global: {},
      saved_application: {},
    });
  });

  test("ranks suggestions by exact key then parsed UTC recency without leaking raw text", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "user-info.json");
    await writeFile(path, JSON.stringify({
      version: 2,
      global: {
        "other.whole": { answer_type: "text", status: "answered", question: "Whole?", raw_value: "private whole", sanitized_value: "Whole", updated_at: "2026-08-03T12:00:00Z" },
        "other.fraction": { answer_type: "text", status: "answered", question: "Fraction?", raw_value: "private fraction", sanitized_value: "Fraction", updated_at: "2026-08-03T12:00:00.500Z" },
        "target.answer": { answer_type: "text", status: "answered", question: "Exact?", raw_value: "private exact", sanitized_value: "Exact", updated_at: "2026-08-01T00:00:00Z" },
      },
      applications: {},
    }));
    const store = await UserInfoStore.open(path);

    const suggestions = await store.suggestions("https://jobs.example.test/roles/42", {
      id: "pending", key: "target.answer", scope: "application", question: "Pending?", answer_type: "text",
    });

    expect(suggestions).toEqual([
      { question: "Exact?", answer: "Exact" },
      { question: "Fraction?", answer: "Fraction" },
      { question: "Whole?", answer: "Whole" },
    ]);
    expect(JSON.stringify(suggestions)).not.toContain("private");
  });

  test("rejects an invalid fact key without changing committed bytes", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "user-info.json");
    const store = await UserInfoStore.open(path);
    const before = await readFile(path);

    await expect(store.merge(
      "https://jobs.example.test/roles/42",
      [{ id: "answer", key: "Bad.Key", scope: "global", question: "Answer?", answer_type: "text" }],
      [{ id: "answer", status: "answered", raw_value: "raw", value: "Sanitized" }],
    )).rejects.toMatchObject({ statusCode: 409, code: "command_conflict" });
    expect(await readFile(path)).toEqual(before);
  });


  test("rejects invalid answer values without changing committed bytes", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "user-info.json");
    const store = await UserInfoStore.open(path);
    const before = await readFile(path);

    await expect(store.merge(
      "https://jobs.example.test/roles/42",
      [{ id: "answer", key: "valid.key", scope: "global", question: "Answer?", answer_type: "text" }],
      [{ id: "answer", status: "answered", raw_value: "private raw", value: "" }],
    )).rejects.toMatchObject({ statusCode: 409, code: "command_conflict" });
    expect(await readFile(path)).toEqual(before);
  });
  test("rejects a non-integer document version with a sanitized startup error", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "user-info.json");
    await writeFile(path, '{"version":1.0,"global":{},"applications":{}}');

    await expect(UserInfoStore.open(path)).rejects.toMatchObject({
      name: "BrowserConfigurationError",
      message: "The user information store is invalid or unavailable",
    });
  });

  test("rejects malformed UTF-8 in saved user information", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "user-info.json");
    const prefix = Buffer.from('{"version":2,"global":{"valid.key":{"answer_type":"text","status":"answered","raw_value":"');
    const suffix = Buffer.from('","sanitized_value":"safe","question":"Question?","updated_at":"2026-08-03T12:00:00Z"}},"applications":{}}');
    await writeFile(path, Buffer.concat([prefix, Buffer.from([0xff]), suffix]));

    await expect(UserInfoStore.open(path)).rejects.toMatchObject({
      name: "BrowserConfigurationError",
      message: "The user information store is invalid or unavailable",
    });
  });

  test("migrates v1 text facts and persists raw and sanitized values in exact scopes", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "user-info.json");

    await writeFile(path, JSON.stringify({
      version: 1,
      global: {
        "legacy.answer": { answer_type: "text", status: "answered", question: "Legacy?", value: "Legacy answer", updated_at: "2026-07-19T12:34:56.000Z" },
      },
      applications: {},
    }));
    const store = await UserInfoStore.open(path);

    const accepted = await store.merge(
      "https://jobs.example.test/roles/42",
      [{ id: "current", key: "current.answer", scope: "application", question: "Current?", answer_type: "text" }],
      [{ id: "current", status: "answered", raw_value: "loose current", value: "Professional current." }],
    );

    expect(accepted).toEqual([{ id: "current", key: "current.answer", scope: "application", answer_type: "text", status: "answered", value: "Professional current." }]);
    const disk = JSON.parse(await readFile(path, "utf8"));
    expect(disk.version).toBe(2);
    expect(disk.global["legacy.answer"]).toEqual({
      answer_type: "text", status: "answered", raw_value: "Legacy answer", sanitized_value: "Legacy answer", question: "Legacy?", updated_at: "2026-07-19T12:34:56.000Z",
    });
    expect(disk.applications["https://jobs.example.test/roles/42"]["current.answer"].raw_value).toBe("loose current");
    expect(disk.applications["https://jobs.example.test/roles/42"]["current.answer"].sanitized_value).toBe("Professional current.");
    expect((await store.snapshot("https://jobs.example.test/roles/42")).rawTextValues).toEqual(new Set(["Legacy answer", "loose current"]));
  });
});

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jobhunt-store-"));
  temporaryDirectories.push(path);
  return realpath(path);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CredentialStore", () => {
  test("creates a private empty store and returns no credentials", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "private", "credentials.json");

    const store = await CredentialStore.open(path);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, credentials: [] });
    expect((await lstat(join(root, "private"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await store.credentialsForOrigin("https://login.example.test")).toEqual([]);
  });

  test("filters exact origins and orders fractional timestamps newest first", async () => {
    const root = await temporaryDirectory();
    const parent = join(root, "private");
    const path = join(parent, "credentials.json");
    await mkdir(parent, { mode: 0o700 });
    await chmod(parent, 0o700);
    await writeFile(path, JSON.stringify({
      version: 1,
      credentials: [
        { origin: "https://login.example.test", username: "whole", password: "first", saved_at: "2026-08-03T12:00:00Z" },
        { origin: "https://login.example.test", username: "fraction", password: "second", saved_at: "2026-08-03T12:00:00.500Z" },
        { origin: "https://other.example.test", username: "other", password: "hidden", saved_at: "2026-08-04T12:00:00Z" },
      ],
    }), { mode: 0o600 });
    await chmod(path, 0o600);

    const store = await CredentialStore.open(path);

    expect((await store.credentialsForOrigin("https://login.example.test")).map(({ username, password }) => ({ username, password }))).toEqual([
      { username: "fraction", password: "second" },
      { username: "whole", password: "first" },
    ]);
  });


  test("rejects malformed UTF-8 instead of silently changing credential data", async () => {
    const root = await temporaryDirectory();
    const parent = join(root, "private");
    const path = join(parent, "credentials.json");
    await mkdir(parent, { mode: 0o700 });
    await chmod(parent, 0o700);
    const prefix = Buffer.from('{"version":1,"credentials":[{"origin":"https://login.example.test","username":"');
    const suffix = Buffer.from('","password":"secret","saved_at":"2026-08-03T12:00:00Z"}]}');
    await writeFile(path, Buffer.concat([prefix, Buffer.from([0xff]), suffix]), { mode: 0o600 });
    await chmod(path, 0o600);

    await expect(CredentialStore.open(path)).rejects.toMatchObject({
      name: "BrowserConfigurationError",
      message: "The credential store is invalid or unavailable",
    });
  });

  test("upsert replaces only the exact origin and username identity", async () => {

    const root = await temporaryDirectory();
    const path = join(root, "private", "credentials.json");
    const moments = [
      new Date("2026-08-01T12:00:00Z"),
      new Date("2026-08-02T12:00:00Z"),
      new Date("2026-08-03T12:00:00Z"),
    ];
    const store = await CredentialStore.open(path, { clock: () => moments.shift()! });

    await store.upsert("HTTPS://LOGIN.EXAMPLE.TEST:443", "ada@example.test", "first");
    await store.upsert("https://login.example.test", "grace@example.test", "grace");
    await store.upsert("https://login.example.test", "ada@example.test", "replacement");

    expect((await store.credentialsForOrigin("https://login.example.test")).map(({ origin, username, password, savedAt }) => ({ origin, username, password, savedAt }))).toEqual([
      { origin: "https://login.example.test", username: "ada@example.test", password: "replacement", savedAt: "2026-08-03T12:00:00.000000Z" },
      { origin: "https://login.example.test", username: "grace@example.test", password: "grace", savedAt: "2026-08-02T12:00:00.000000Z" },
    ]);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });
});
