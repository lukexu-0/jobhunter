import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/system/artifacts.ts";

async function artifactRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pipeline-run-input-"));
}

const address = { run: "run-123" } as const;

describe("run input artifacts", () => {
  test("uses exactly data/runs/{run-id}/input and rejects invalid run components", async () => {
    const root = join(await artifactRoot(), "data", "runs");
    const store = new ArtifactStore(root);

    expect(store.inputRoot(address)).toBe(join(root, "run-123", "input"));
    for (const run of ["", ".", "..", "../escape", "nested/run", "/absolute", "x".repeat(129)]) {
      expect(() => store.inputRoot({ run })).toThrow(/invalid run id/i);
    }

    const input = await store.createRunInput(address);
    expect(input).toBe(join(root, "run-123", "input"));
    await expect(store.write(join(input, "..", "..", "..", "escape.txt"), "x", 1)).rejects.toThrow(/escapes/i);
  });

  test("creates only real owner-private directories and refuses symlinked paths", async () => {
    const root = join(await artifactRoot(), "data", "runs");
    const outside = await artifactRoot();
    const store = new ArtifactStore(root);
    await store.initialize();
    await symlink(outside, join(root, "linked-run"));

    await expect(store.createRunInput({ run: "linked-run" })).rejects.toThrow(/symlink/i);

    const input = await store.createRunInput(address);
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(root, address.run))).mode & 0o777).toBe(0o700);
      expect((await lstat(input)).mode & 0o777).toBe(0o700);
    }

    const linkedJobDescription = join(input, "linked-job-description.txt");
    await symlink(join(outside, "job-description.txt"), linkedJobDescription);
    await expect(store.write(linkedJobDescription, "abc", 3)).rejects.toThrow(/symlink/i);
    await expect(store.read(linkedJobDescription, 3)).rejects.toThrow(/symlink/i);
  });

  test("publishes an immutable bounded job description with stable SHA-256 metadata", async () => {
    const store = new ArtifactStore(join(await artifactRoot(), "data", "runs"));
    const input = await store.createRunInput(address);
    const jobDescription = join(input, "job-description.txt");

    const metadata = await store.write(jobDescription, "abc", 3);
    expect(metadata).toEqual({
      path: jobDescription,
      bytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    expect(Buffer.from(await store.read(jobDescription, 3)).toString("utf8")).toBe("abc");

    await expect(store.write(jobDescription, "xyz", 3)).rejects.toThrow(/already exists/i);
    expect(Buffer.from(await store.read(jobDescription, 3)).toString("utf8")).toBe("abc");
    await expect(store.write(join(input, "too-large.txt"), "abcd", 3)).rejects.toThrow(/byte limit/i);

    const boundedRead = await store.write(join(input, "bounded-read.txt"), "abcd", 4);
    await expect(store.read(boundedRead.path, 3)).rejects.toThrow(/byte limit/i);
    await expect(store.createRunInput(address)).rejects.toThrow(/already exists/i);
  });
});
