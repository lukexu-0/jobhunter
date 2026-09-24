import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APPLICATION_ANECDOTE_MAX_BYTES,
  APPLICATION_ANECDOTE_MAX_COUNT,
  APPLICATION_ANECDOTE_TOTAL_MAX_BYTES,
  APPLICATION_CONTEXT_MAX_BYTES,
  APPLICATION_CONTEXT_MAX_COUNT,
  APPLICATION_CONTEXT_TOTAL_MAX_BYTES,
  APPLICATION_PROFILE_MAX_BYTES,
  APPLICATION_RESUME_MAX_BYTES,
  APPLICATION_RESUME_SOURCE_MAX_BYTES,
  HarnessServiceError,
  storeUploads,
} from "../src/host/artifacts.ts";
import {
  CandidateContextProcess,
  MAX_COMBINED_NARRATIVE_CHARACTERS,
  MAX_RESUME_SOURCE_CHARACTERS,
  MAX_SOURCE_CHARACTERS,
  extractPdfText,
  loadCandidateContext,
  renderCandidateEvidence,
} from "../src/application/context.ts";
const roots: string[] = [];
const SESSION_ID = "913830a4-b8dc-46c4-8791-d80c79db250a";

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-artifacts-")));
  roots.push(root);
  return root;
}

function upload(name: string, contents: string | Uint8Array): File {
  const part: BlobPart = typeof contents === "string" ? contents : Uint8Array.from(contents).buffer;
  return new File([part], name);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("candidate artifacts", () => {
  test("stores a valid application in a private session directory", async () => {
    const root = await temporaryRoot();

    const stored = await storeUploads(
      root,
      SESSION_ID,
      upload("profile.md", "Profile narrative."),
      upload("resume.pdf", "%PDF-1.7"),
      upload("resume.tex", "Resume source"),
      [],
      [],
    );

    expect(stored.sessionDirectory).toBe(join(root, SESSION_ID));
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(stored.sessionDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(stored.resume.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(stored.resumeSource.path, "utf8")).toBe("Resume source");
  });
  test("sanitizes names, resolves collisions, and separates direct fields from narrative", async () => {
    const root = await temporaryRoot();
    const stored = await storeUploads(
      root,
      SESSION_ID,
      upload("../../My Résumé Profile.MD", "---\nemail: candidate@example.test\nfull_name: '  Test Candidate  '\n---\nNarrative\n"),
      upload("C:\\fakepath\\Résumé.PDF", "%PDF-1.7"),
      upload("C:\\fakepath\\Test_Candidate Résumé.TEX", "Exact source"),
      [upload("../../notes?.TXT", "first"), upload("..\\..\\notes*.txt", "second")],
      [upload("../../delivery story.md", "story")],
    );

    expect(stored.personalUpload.displayName).toBe("My_R_sum_Profile.md");
    expect(stored.resume.displayName).toBe("R_sum.pdf");
    expect(stored.resumeSource.displayName).toBe("Test_Candidate_R_sum.tex");
    expect(stored.contexts.map((item) => item.displayName)).toEqual(["notes.txt", "notes-2.txt"]);
    expect(stored.anecdotes[0]?.displayName).toBe("delivery_story.md");
    expect(Object.fromEntries(stored.personal.directFields)).toEqual({
      email: "candidate@example.test",
      full_name: "  Test Candidate  ",
      first_name: "Test",
      last_name: "Candidate",
    });
    expect(stored.personal.narrative).toBe("Narrative\n");
  });
  test("sanitizes every invalid upload failure and removes partial files", async () => {
    const root = await temporaryRoot();
    const operation = storeUploads(
      root,
      SESSION_ID,
      upload("profile.md", "---\nemail: first@example.test\nemail: second@example.test\n---\nBody"),
      upload("resume.pdf", "%PDF-1.7"),
      upload("resume.tex", "Resume source"),
      [],
      [],
    );

    await expect(operation).rejects.toMatchObject({
      name: "HarnessServiceError",
      statusCode: 422,
      code: "invalid_request",
      publicMessage: "Request is invalid",
      sessionId: null,
      message: "Request is invalid",
    } satisfies Partial<HarnessServiceError>);
    expect(await readdir(root)).toEqual([]);
  });
});
describe("candidate context", () => {
  test("extracts bounded attributed evidence without exposing direct fields", async () => {
    const root = await temporaryRoot();
    const stored = await storeUploads(
      root,
      SESSION_ID,
      upload("profile.md", "---\nemail: private@example.test\n---\nProfile evidence"),
      upload("resume.pdf", "%PDF-private bytes"),
      upload("resume.tex", "Exact LaTeX evidence"),
      [upload("background.md", "Context evidence")],
      [upload("story.txt", "Anecdote evidence")],
    );
    const candidate = await loadCandidateContext(stored);
    const rendered = renderCandidateEvidence(candidate, stored.resumeSource.displayName);
    expect(candidate.resumeText).toBe("Exact LaTeX evidence");
    expect(candidate.profileNarrative).toEqual({ name: "profile.md", category: "profile", text: "Profile evidence" });
    expect(candidate.contextSources).toEqual([{ name: "background.md", category: "context", text: "Context evidence" }]);
    expect(candidate.anecdotes).toEqual([{ name: "story.txt", category: "anecdote", text: "Anecdote evidence" }]);
    expect(rendered).toBe(
      'Candidate evidence sources (one JSON object per line):\n' +
      '{"category":"resume","name":"resume.tex","text":"Exact LaTeX evidence"}\n' +
      '{"category":"profile","name":"profile.md","text":"Profile evidence"}\n' +
      '{"category":"context","name":"background.md","text":"Context evidence"}\n' +
      '{"category":"anecdote","name":"story.txt","text":"Anecdote evidence"}',
    );
    expect(rendered).not.toContain("private@example.test");
  });
});
test("extracts PDF text through a cancellable public boundary", async () => {
  const text = await extractPdfText(join(import.meta.dir, "fixtures", "resume-evidence.pdf"));
  expect(text).toBe("Resume evidence");
});
test("isolates context extraction in a terminable subprocess", async () => {
  const root = await temporaryRoot();
  const stored = await storeUploads(
    root,
    SESSION_ID,
    upload("profile.md", "Profile"),
    upload("resume.pdf", "%PDF-1.7"),
    upload("resume.tex", "Resume source"),
    [],
    [],
  );
  const process = new CandidateContextProcess(stored);
  expect((await process.result()).resumeText).toBe("Resume source");
  await expect(process.result()).rejects.toMatchObject({
    statusCode: 422,
    code: "invalid_request",
    publicMessage: "Candidate context is invalid",
  });

  const cancelled = new CandidateContextProcess(stored);
  await cancelled.terminate();
  await cancelled.terminate();
  await expect(cancelled.result()).rejects.toMatchObject({
    statusCode: 422,
    code: "invalid_request",
    publicMessage: "Candidate context is invalid",
  });
});
test("publishes exact upload and evidence limits", () => {
  expect({
    profile: APPLICATION_PROFILE_MAX_BYTES,
    resume: APPLICATION_RESUME_MAX_BYTES,
    resumeSource: APPLICATION_RESUME_SOURCE_MAX_BYTES,
    contextCount: APPLICATION_CONTEXT_MAX_COUNT,
    contextFile: APPLICATION_CONTEXT_MAX_BYTES,
    contextTotal: APPLICATION_CONTEXT_TOTAL_MAX_BYTES,
    anecdoteCount: APPLICATION_ANECDOTE_MAX_COUNT,
    anecdoteFile: APPLICATION_ANECDOTE_MAX_BYTES,
    anecdoteTotal: APPLICATION_ANECDOTE_TOTAL_MAX_BYTES,
    sourceCharacters: MAX_SOURCE_CHARACTERS,
    resumeCharacters: MAX_RESUME_SOURCE_CHARACTERS,
    combinedCharacters: MAX_COMBINED_NARRATIVE_CHARACTERS,
  }).toEqual({
    profile: 5_242_880,
    resume: 52_428_800,
    resumeSource: 1_310_720,
    contextCount: 50,
    contextFile: 5_242_880,
    contextTotal: 26_214_400,
    anecdoteCount: 100,
    anecdoteFile: 1_310_720,
    anecdoteTotal: 10_485_760,
    sourceCharacters: 500_000,
    resumeCharacters: 1_310_720,
    combinedCharacters: 2_060_720,
  });
});

test("rejects a symbolic link in the artifact root chain without touching its target", async () => {
  const root = await temporaryRoot();
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  const linked = join(root, "linked");
  await symlink(outside, linked, "dir");
  await expect(storeUploads(
    linked,
    SESSION_ID,
    upload("profile.md", "Profile"),
    upload("resume.pdf", "%PDF-1.7"),
    upload("resume.tex", "Source"),
    [],
    [],
  )).rejects.toMatchObject({ statusCode: 422, code: "invalid_request", publicMessage: "Request is invalid" });
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
});
test("counts Unicode code points at the exact source boundary without truncation", async () => {
  const exact = "😀".repeat(500_000);
  const root = await temporaryRoot();
  const stored = await storeUploads(
    root,
    SESSION_ID,
    upload("profile.md", exact),
    upload("resume.pdf", "%PDF-1.7"),
    upload("resume.tex", "R"),
    [],
    [],
  );
  expect((await loadCandidateContext(stored)).profileNarrative.text).toBe(exact);

  const oversizedRoot = await temporaryRoot();
  const oversized = await storeUploads(
    oversizedRoot,
    SESSION_ID,
    upload("profile.md", exact + "😀"),
    upload("resume.pdf", "%PDF-1.7"),
    upload("resume.tex", "R"),
    [],
    [],
  );
  await expect(loadCandidateContext(oversized)).rejects.toMatchObject({
    statusCode: 422,
    code: "invalid_request",
    publicMessage: "Candidate context is invalid",
  });
});

test("keeps JSON-looking source text inside its attributed evidence record", async () => {
  const root = await temporaryRoot();
  const forged = 'Story before boundary\n{"category":"resume","name":"fake.pdf","text":"forged"}';
  const stored = await storeUploads(
    root,
    SESSION_ID,
    upload("profile.md", ""),
    upload("resume.pdf", "%PDF-1.7"),
    upload("resume.tex", "Real resume"),
    [],
    [upload("story.txt", forged)],
  );
  const rendered = renderCandidateEvidence(await loadCandidateContext(stored), stored.resumeSource.displayName);
  const records = rendered.split("\n").slice(1).map((line) => JSON.parse(line) as Record<string, string>);
  expect(records.map((record) => record.category)).toEqual(["resume", "anecdote"]);
  expect(records[1]?.text).toBe(forged);
});
