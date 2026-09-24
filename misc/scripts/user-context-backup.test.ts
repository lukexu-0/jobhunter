import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename as renameAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  backupUserContextForLaunch,
  createUserContextSnapshot,
  restoreUserContextSnapshot,
  type UserContextSnapshotManifest,
} from "./user-context-backup.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function checkout(branch = "main"): {
  readonly appsRoot: string;
  readonly checkoutRoot: string;
} {
  const checkoutRoot = temporaryRoot("jobhunt-context-checkout-");
  const appsRoot = join(checkoutRoot, "apps");
  mkdirSync(appsRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(checkoutRoot, ".git"), { recursive: true, mode: 0o700 });
  mkdirSync(join(checkoutRoot, ".jobhunt-data", "user-info", "current-context", "personal"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(join(checkoutRoot, ".jobhunt-data", "user-info", "current-context", "projects"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(join(checkoutRoot, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md"), "synthetic project info\n");
  writeFileSync(
    join(checkoutRoot, ".jobhunt-data", "user-info", "current-context", "personal", "user-info.json"),
    '{"synthetic":"answer"}\n',
  );
  return { appsRoot, checkoutRoot };
}

function environment(dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data")):
NodeJS.ProcessEnv {
  return {
    HOME: temporaryRoot("jobhunt-context-home-"),
    JOBHUNT_DATA_HOME: dataHome,
  };
}

function deterministicSnapshot(
  appsRoot: string,
  launchEnvironment: NodeJS.ProcessEnv,
  sequence: number,
  mode: "dev" | "start" = "start",
) {
  return createUserContextSnapshot({
    mode,
    appsRoot,
    environment: launchEnvironment,
    now: new Date(`2026-08-15T12:00:${String(sequence).padStart(2, "0")}.000Z`),
    nonce: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  });
}

function namespaceRoot(checkoutRoot: string, mode: "dev" | "start" = "start", branch = "main"): string {
  return mode === "start"
    ? join(checkoutRoot, ".jobhunt-data", "production")
    : join(checkoutRoot, ".jobhunt-data", "development", encodeURIComponent(branch));
}

function snapshotDirectories(checkoutRoot: string, mode: "dev" | "start" = "start"): string[] {
  const snapshots = join(namespaceRoot(checkoutRoot, mode), "user-context-backups", "snapshots");
  return existsSync(snapshots)
    ? readdirSync(snapshots).filter((name) => !name.startsWith("."))
    : [];
}

function readManifest(snapshotPath: string): UserContextSnapshotManifest {
  return JSON.parse(readFileSync(join(snapshotPath, "manifest.json"), "utf8"));
}
function stageExternalSnapshot(snapshotPath: string, dataHome: string, mode: "dev" | "start", branch = "main"): string {
  const storageRoot = mode === "start"
    ? join(dataHome, "production")
    : join(dataHome, "development", encodeURIComponent(branch));
  const externalPath = join(storageRoot, "user-context-backups", "snapshots", snapshotPath.split("/").at(-1)!);
  mkdirSync(dirname(externalPath), { recursive: true, mode: 0o700 });
  cpSync(snapshotPath, externalPath, { recursive: true });
  const manifest = readManifest(externalPath);
  writeFileSync(join(externalPath, "manifest.json"), JSON.stringify({
    ...manifest,
    scope: { ...manifest.scope, storageRoot },
  }) + "\n", { mode: 0o600 });
  rmSync(snapshotPath, { recursive: true });
  return externalPath;
}

function addLegacyRootDossier(snapshotPath: string, contents: string): void {
  const relativePath = "jobhunt-resume-info.md";
  writeFileSync(join(snapshotPath, "files", relativePath), contents, { mode: 0o600 });
  const manifest = readManifest(snapshotPath);
  const files = [
    ...manifest.files,
    {
      path: relativePath,
      size: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    },
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  writeFileSync(
    join(snapshotPath, "manifest.json"),
    `${JSON.stringify({ ...manifest, files })}\n`,
    { mode: 0o600 },
  );
}

function moveSnapshotToLegacyUserInfoPath(snapshotPath: string, legacyRoot: "user-info" | "apps/user-info"): void {
  const filesRoot = join(snapshotPath, "files");
  const destination = join(filesRoot, legacyRoot);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  renameSync(join(filesRoot, ".jobhunt-data", "user-info"), destination);
  const manifest = readManifest(snapshotPath);
  const files = manifest.files
    .map((file) => ({
      ...file,
      path: file.path.startsWith(".jobhunt-data/user-info/")
        ? `${legacyRoot}/${file.path.slice(".jobhunt-data/user-info/".length)}`
        : file.path,
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  writeFileSync(
    join(snapshotPath, "manifest.json"),
    `${JSON.stringify({ ...manifest, files })}\n`,
    { mode: 0o600 },
  );
}

describe("private user-context snapshots", () => {
  test("backs up every configured regular file in deterministic path order with private modes", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    mkdirSync(join(checkoutRoot, ".jobhunt-data", "user-info", "archive", "nested"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(join(checkoutRoot, ".jobhunt-data", "user-info", "archive", "resume.pdf"), "synthetic pdf");
    writeFileSync(join(checkoutRoot, ".jobhunt-data", "user-info", "archive", "nested", "image.png"), "synthetic image");
    writeFileSync(join(checkoutRoot, ".jobhunt-data", "user-info", "archive", "resumes.zip"), "synthetic archive");

    const result = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const manifest = readManifest(result.snapshotPath);

    expect(manifest).toEqual({
      version: 1,
      snapshotId: "2026-08-15T12-00-01-000Z-00000000-0000-4000-8000-000000000001",
      createdAt: "2026-08-15T12:00:01.000Z",
      reason: "manual",
      scope: {
        mode: "start",
        branch: "main",
        checkoutRoot,
        checkoutDevice: lstatSync(checkoutRoot).dev,
        checkoutInode: lstatSync(checkoutRoot).ino,
        storageRoot: namespaceRoot(checkoutRoot),
      },
      files: [
        expect.objectContaining({ path: ".jobhunt-data/user-info/archive/nested/image.png", size: 15 }),
        expect.objectContaining({ path: ".jobhunt-data/user-info/archive/resume.pdf", size: 13 }),
        expect.objectContaining({ path: ".jobhunt-data/user-info/archive/resumes.zip", size: 17 }),
        expect.objectContaining({
          path: ".jobhunt-data/user-info/current-context/personal/user-info.json",
          size: 23,
        }),
        expect.objectContaining({ path: ".jobhunt-data/user-info/current-context/projects/example-project.md", size: 23 }),
      ],
    });
    expect(manifest.files.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256))).toBe(true);
    expect(lstatSync(result.snapshotPath).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(result.snapshotPath, "manifest.json")).mode & 0o777).toBe(0o600);
    for (const file of manifest.files) {
      expect(lstatSync(join(result.snapshotPath, "files", file.path)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(result.snapshotPath, "files", ".jobhunt-data/user-info/current-context/projects/example-project.md"), "utf8"))
      .toBe("synthetic project info\n");
  });

  test("versions unchanged snapshots and never replaces an already published snapshot", async () => {
    const { appsRoot } = checkout();
    const launchEnvironment = environment();
    const first = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const second = await deterministicSnapshot(appsRoot, launchEnvironment, 2);

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(readManifest(second.snapshotPath).files).toEqual(readManifest(first.snapshotPath).files);

    writeFileSync(join(appsRoot, "..", ".jobhunt-data/user-info/current-context/projects/example-project.md"), "changed synthetic profile\n");
    await expect(deterministicSnapshot(appsRoot, launchEnvironment, 1)).rejects.toThrow(
      /already exists/i,
    );
    expect(readFileSync(join(first.snapshotPath, "files", ".jobhunt-data/user-info/current-context/projects/example-project.md"), "utf8"))
      .toBe("synthetic project info\n");
    expect(readdirSync(dirname(first.snapshotPath)).some((name) => name.startsWith(".staging-")))
      .toBe(false);
  });
  test("serializes namespace operations and reuses a released kernel lock file", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const lockPath = join(namespaceRoot(checkoutRoot), "user-context-backups", ".operation.lock");
    writeFileSync(lockPath, "", { mode: 0o600 });
    const holder = Bun.spawn([
      "/usr/bin/lockf",
      "-kns",
      "-t",
      "0",
      lockPath,
      process.execPath,
      "-e",
      'process.stdout.write("locked\\n"); await Bun.stdin.text();',
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = holder.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    writeFileSync(join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md"), "current project info\n");
    try {
      await expect(deterministicSnapshot(appsRoot, launchEnvironment, 2)).rejects.toThrow(
        /operation is already in progress/i,
      );
      await expect(restoreUserContextSnapshot({
        mode: "start",
        appsRoot,
        environment: launchEnvironment,
        snapshotId: snapshot.snapshotId,
      })).rejects.toThrow(/operation is already in progress/i);
    } finally {
      holder.stdin.end();
      expect(await holder.exited).toBe(0);
      reader.releaseLock();
    }
    await deterministicSnapshot(appsRoot, launchEnvironment, 2);
    expect(snapshotDirectories(checkoutRoot)).toHaveLength(2);
  });


  test("rejects source links and configured byte or entry bounds without publishing", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const personal = join(checkoutRoot, ".jobhunt-data", "user-info", "current-context", "personal");
    symlinkSync(join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md"), join(personal, "linked-profile.md"));

    await expect(deterministicSnapshot(appsRoot, launchEnvironment, 1)).rejects.toThrow(
      /symbolic link/i,
    );
    expect(snapshotDirectories(checkoutRoot)).toEqual([]);
    rmSync(join(personal, "linked-profile.md"));

    await expect(createUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      limits: { maxFileBytes: 4, maxTotalBytes: 64, maxEntries: 100 },
    })).rejects.toThrow(/byte limit/i);
    await expect(createUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      limits: { maxFileBytes: 64, maxTotalBytes: 128, maxEntries: 1 },
    })).rejects.toThrow(/entry limit/i);
    expect(snapshotDirectories(checkoutRoot)).toEqual([]);
  });

  test("refuses a symlinked canonical source and never imports the old checkout root", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const oldRoot = join(checkoutRoot, "user-info", "current-context", "projects");
    mkdirSync(oldRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(oldRoot, "obsolete.txt"), "old private content\n");
    const first = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    expect(readManifest(first.snapshotPath).files.map(({ path }) => path))
      .not.toContain("user-info/current-context/projects/obsolete.txt");

    const sourceRoot = join(checkoutRoot, ".jobhunt-data", "user-info");
    renameSync(sourceRoot, join(checkoutRoot, ".jobhunt-data", "detached-user-info"));
    await expect(deterministicSnapshot(appsRoot, launchEnvironment, 2)).rejects.toThrow(/required backup source/i);
    symlinkSync(join(checkoutRoot, ".jobhunt-data", "detached-user-info"), sourceRoot);
    await expect(deterministicSnapshot(appsRoot, launchEnvironment, 3)).rejects.toThrow(/symbolic link/i);
    expect(snapshotDirectories(checkoutRoot)).toHaveLength(1);
  });

  test("retains exactly the newest thirty complete snapshots", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);

    for (let sequence = 1; sequence <= 31; sequence += 1) {
      await deterministicSnapshot(appsRoot, launchEnvironment, sequence);
    }

    const snapshots = snapshotDirectories(checkoutRoot);
    expect(snapshots).toHaveLength(30);
    expect(snapshots.some((name) => name.includes("12-00-01-000Z"))).toBe(false);
    expect(snapshots.some((name) => name.includes("12-00-31-000Z"))).toBe(true);
  });
});

describe("private user-context restore", () => {
  test("restores a legacy version-one root dossier and snapshots its rollback bytes", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    addLegacyRootDossier(snapshot.snapshotPath, "legacy snapshot dossier\n");
    const legacyDossier = join(checkoutRoot, "jobhunt-resume-info.md");
    writeFileSync(legacyDossier, "current legacy dossier\n", { mode: 0o600 });

    const result = await restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
      now: new Date("2026-08-15T12:00:02.000Z"),
      nonce: "00000000-0000-4000-8000-000000000002",
    });

    expect(readFileSync(legacyDossier, "utf8")).toBe("legacy snapshot dossier\n");
    const preRestorePath = join(
      namespaceRoot(checkoutRoot),
      "user-context-backups",
      "snapshots",
      result.preRestoreSnapshotId,
    );
    expect(readManifest(preRestorePath).files.map(({ path }) => path))
      .toContain("jobhunt-resume-info.md");
    expect(readFileSync(join(preRestorePath, "files", "jobhunt-resume-info.md"), "utf8"))
      .toBe("current legacy dossier\n");
  });

  test("explicitly restores root user-info snapshots into canonical storage", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    moveSnapshotToLegacyUserInfoPath(snapshot.snapshotPath, "user-info");
    const canonical = join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md");
    writeFileSync(canonical, "newer synthetic profile\n");

    const restored = await restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
      now: new Date("2026-08-15T12:00:02.000Z"),
      nonce: "00000000-0000-4000-8000-000000000002",
    });

    expect(readFileSync(canonical, "utf8")).toBe("synthetic project info\n");
    expect(existsSync(join(checkoutRoot, "user-info"))).toBe(false);
    const preRestore = join(namespaceRoot(checkoutRoot), "user-context-backups", "snapshots", restored.preRestoreSnapshotId);
    expect(readManifest(preRestore).files.map(({ path }) => path)).toContain(
      ".jobhunt-data/user-info/current-context/projects/example-project.md",
    );
  });

  test("restores pre-migration user-info snapshots into canonical storage", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    moveSnapshotToLegacyUserInfoPath(snapshot.snapshotPath, "apps/user-info");
    const source = join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md");
    writeFileSync(source, "newer synthetic profile\n");

    await restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
      now: new Date("2026-08-15T12:00:02.000Z"),
      nonce: "00000000-0000-4000-8000-000000000002",
    });

    expect(readFileSync(source, "utf8")).toBe("synthetic project info\n");
    expect(existsSync(join(checkoutRoot, "apps", "user-info"))).toBe(false);
  });

  test("refuses a symlinked restore parent without writing through it", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const originalRoot = join(checkoutRoot, ".jobhunt-data", "user-info");
    const detached = join(checkoutRoot, ".jobhunt-data", "detached-user-info");
    renameSync(originalRoot, detached);
    symlinkSync(detached, originalRoot);
    const detachedSource = join(detached, "current-context", "projects", "example-project.md");
    writeFileSync(detachedSource, "unmodified synthetic profile\n");

    await expect(restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
    })).rejects.toThrow(/symbolic link/i);
    expect(readFileSync(detachedSource, "utf8")).toBe("unmodified synthetic profile\n");
    expect(snapshotDirectories(checkoutRoot)).toHaveLength(1);
  });

  test("verifies checksums and strict contained manifest paths before replacing source files", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const source = join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md");
    writeFileSync(source, "newer synthetic profile\n");
    const snapshotFile = join(snapshot.snapshotPath, "files", ".jobhunt-data/user-info/current-context/projects/example-project.md");
    writeFileSync(snapshotFile, "tampered snapshot bytes\n", { mode: 0o600 });

    await expect(restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
    })).rejects.toThrow(/sha-256|checksum/i);
    expect(readFileSync(source, "utf8")).toBe("newer synthetic profile\n");

    const valid = await deterministicSnapshot(appsRoot, launchEnvironment, 2);
    const manifestPath = join(valid.snapshotPath, "manifest.json");
    const parsedManifest = readManifest(valid.snapshotPath);
    const traversalManifest = {
      ...parsedManifest,
      files: parsedManifest.files.map((file, index) =>
        index === 0 ? { ...file, path: "../outside-private-context" } : file),
    };
    writeFileSync(manifestPath, `${JSON.stringify(traversalManifest)}\n`, { mode: 0o600 });

    await expect(restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: valid.snapshotId,
    })).rejects.toThrow(/path/i);
    expect(readFileSync(source, "utf8")).toBe("newer synthetic profile\n");

    const strict = await deterministicSnapshot(appsRoot, launchEnvironment, 3);
    const strictManifest = { ...readManifest(strict.snapshotPath), unexpected: true };
    writeFileSync(
      join(strict.snapshotPath, "manifest.json"),
      `${JSON.stringify(strictManifest)}\n`,
      { mode: 0o600 },
    );
    await expect(restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: strict.snapshotId,
    })).rejects.toThrow(/strict schema/i);
    expect(readFileSync(source, "utf8")).toBe("newer synthetic profile\n");
  });

  test("refuses cross-mode, branch, and checkout restoration before replacement", async () => {
    const first = checkout("main");
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const snapshot = await deterministicSnapshot(first.appsRoot, launchEnvironment, 1);
    const second = checkout("main");
    const secondSource = join(second.checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md");
    writeFileSync(secondSource, "second checkout value\n");
    const initializedSecond = await deterministicSnapshot(second.appsRoot, launchEnvironment, 2);
    rmSync(initializedSecond.snapshotPath, { recursive: true });
    const foreignSnapshotPath = join(dirname(initializedSecond.snapshotPath), snapshot.snapshotId);
    cpSync(snapshot.snapshotPath, foreignSnapshotPath, { recursive: true });
    chmodSync(foreignSnapshotPath, 0o700);

    await expect(restoreUserContextSnapshot({
      mode: "start",
      appsRoot: second.appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
    })).rejects.toThrow(/checkout scope/i);
    expect(readFileSync(secondSource, "utf8")).toBe("second checkout value\n");

    const initializedDev = await deterministicSnapshot(
      first.appsRoot,
      launchEnvironment,
      2,
      "dev",
    );
    const devSnapshots = dirname(initializedDev.snapshotPath);
    rmSync(initializedDev.snapshotPath, { recursive: true });
    cpSync(snapshot.snapshotPath, join(devSnapshots, snapshot.snapshotId), { recursive: true });
    chmodSync(join(devSnapshots, snapshot.snapshotId), 0o700);
    await expect(restoreUserContextSnapshot({
      mode: "dev",
      appsRoot: first.appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
    })).rejects.toThrow(/mode scope/i);
    expect(readFileSync(join(first.checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md"), "utf8"))
      .toBe("synthetic project info\n");

    rmSync(join(devSnapshots, snapshot.snapshotId), { recursive: true });
    const devSnapshot = await deterministicSnapshot(first.appsRoot, launchEnvironment, 3, "dev");
    const otherBranch = checkout("feature/other");
    const initializedBranch = await deterministicSnapshot(
      otherBranch.appsRoot,
      launchEnvironment,
      4,
      "dev",
    );
    const branchSnapshots = dirname(initializedBranch.snapshotPath);
    rmSync(initializedBranch.snapshotPath, { recursive: true });
    cpSync(devSnapshot.snapshotPath, join(branchSnapshots, devSnapshot.snapshotId), { recursive: true });
    chmodSync(join(branchSnapshots, devSnapshot.snapshotId), 0o700);
    await expect(restoreUserContextSnapshot({
      mode: "dev",
      appsRoot: otherBranch.appsRoot,
      environment: launchEnvironment,
      snapshotId: devSnapshot.snapshotId,
    })).rejects.toThrow(/branch scope/i);
    expect(readFileSync(join(otherBranch.checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md"), "utf8"))
      .toBe("synthetic project info\n");
  });
  test("retains the selected recovery point when restore staging fails after the pre-restore snapshot", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    let selectedSnapshotPath = "";
    for (let sequence = 1; sequence <= 30; sequence += 1) {
      const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, sequence);
      if (sequence === 1) selectedSnapshotPath = snapshot.snapshotPath;
    }
    writeFileSync(join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md"), "current project info\n");
    const answerDirectory = join(checkoutRoot, ".jobhunt-data", "user-info", "current-context", "personal");
    writeFileSync(join(answerDirectory, "user-info.json"), '{"synthetic":"current"}\n');
    chmodSync(answerDirectory, 0o500);
    try {
      await expect(restoreUserContextSnapshot({
        mode: "start",
        appsRoot,
        environment: launchEnvironment,
        snapshotId: "2026-08-15T12-00-01-000Z-00000000-0000-4000-8000-000000000001",
        now: new Date("2026-08-15T12:00:31.000Z"),
        nonce: "00000000-0000-4000-8000-000000000031",
      })).rejects.toThrow();
    } finally {
      chmodSync(answerDirectory, 0o700);
    }
    expect(existsSync(selectedSnapshotPath)).toBe(true);
    expect(snapshotDirectories(checkoutRoot)).toHaveLength(31);
  });
  test("rolls back files already replaced when a later restore publication fails", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const answerPath = join(checkoutRoot, ".jobhunt-data", "user-info", "current-context", "personal", "user-info.json");
    const snippetsDossierPath = join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md");
    const selectedOnlyPath = join(checkoutRoot, ".jobhunt-data", "user-info", "archive", "selected-only.txt");
    mkdirSync(dirname(selectedOnlyPath), { recursive: true, mode: 0o700 });
    writeFileSync(selectedOnlyPath, "selected snapshot only\n");
    writeFileSync(snippetsDossierPath, "snapshot project info\n");
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    rmSync(selectedOnlyPath);
    writeFileSync(answerPath, '{"synthetic":"current answer"}\n');
    writeFileSync(snippetsDossierPath, "current project info\n");
    let publishedBeforeFailure = 0;
    await expect(restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
      now: new Date("2026-08-15T12:00:02.000Z"),
      nonce: "00000000-0000-4000-8000-000000000002",
    }, {
      publishReplacement: async (source, target) => {
        if (target === snippetsDossierPath) {
          throw new Error("synthetic publication failure");
        }
        await renameAsync(source, target);
        publishedBeforeFailure += 1;
      },
    })).rejects.toThrow(/pre-restore state was restored/);
    expect(publishedBeforeFailure).toBeGreaterThan(0);
    expect(readFileSync(answerPath, "utf8")).toBe('{"synthetic":"current answer"}\n');
    expect(readFileSync(snippetsDossierPath, "utf8")).toBe("current project info\n");
    expect(existsSync(selectedOnlyPath)).toBe(false);
  });



  test("creates a pre-restore snapshot, atomically overwrites listed files, and leaves unlisted files", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const snippetsDossier = join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md");
    const answerFile = join(checkoutRoot, ".jobhunt-data", "user-info", "current-context", "personal", "user-info.json");
    const newerFile = join(checkoutRoot, ".jobhunt-data", "user-info", "current-context", "personal", "newer-note.txt");
    writeFileSync(snippetsDossier, "newer project info\n");
    writeFileSync(answerFile, '{"synthetic":"newer answer"}\n');
    writeFileSync(newerFile, "unlisted newer file\n");

    const result = await restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
      now: new Date("2026-08-15T12:01:00.000Z"),
      nonce: "00000000-0000-4000-8000-000000000100",
    });

    expect(result.preRestoreSnapshotId)
      .toBe("2026-08-15T12-01-00-000Z-00000000-0000-4000-8000-000000000100");
    expect(readFileSync(snippetsDossier, "utf8")).toBe("synthetic project info\n");
    expect(readFileSync(answerFile, "utf8")).toBe('{"synthetic":"answer"}\n');
    expect(readFileSync(newerFile, "utf8")).toBe("unlisted newer file\n");
    const preRestore = snapshotDirectories(checkoutRoot).find((id) => id === result.preRestoreSnapshotId)!;
    const preManifest = readManifest(join(namespaceRoot(checkoutRoot), "user-context-backups", "snapshots", preRestore));
    expect(preManifest.reason).toBe("pre-restore");
    expect(preManifest.files.map(({ path }) => path)).toContain(
      ".jobhunt-data/user-info/current-context/personal/newer-note.txt",
    );
    expect(lstatSync(snippetsDossier).mode & 0o777).toBe(0o600);
    expect(lstatSync(answerFile).mode & 0o777).toBe(0o600);
  });

  test("rejects linked snapshot files before source replacement", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const snapshotFile = join(snapshot.snapshotPath, "files", ".jobhunt-data/user-info/current-context/projects/example-project.md");
    rmSync(snapshotFile);
    symlinkSync(join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md"), snapshotFile);
    writeFileSync(join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md"), "new source bytes\n");

    await expect(restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
    })).rejects.toThrow(/symbolic link/i);
    expect(readFileSync(join(checkoutRoot, ".jobhunt-data/user-info/current-context/projects/example-project.md"), "utf8"))
      .toBe("new source bytes\n");
  });
});

describe("workspace launch backup hook", () => {
  test("stable first start skips only a missing user-info tree", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const sourceRoot = join(checkoutRoot, ".jobhunt-data", "user-info");
    rmSync(sourceRoot, { recursive: true });

    expect(await backupUserContextForLaunch("start", appsRoot, launchEnvironment)).toBeUndefined();
    expect(snapshotDirectories(checkoutRoot)).toEqual([]);

    mkdirSync(sourceRoot, { mode: 0o700 });
    const snapshot = await backupUserContextForLaunch("start", appsRoot, launchEnvironment);
    expect(snapshot?.fileCount).toBe(0);
    expect(snapshotDirectories(checkoutRoot)).toHaveLength(1);
  });
  test("stable start rejects a linked data root even when user-info is absent", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const dataRoot = join(checkoutRoot, ".jobhunt-data");
    const detached = join(checkoutRoot, "detached-data");
    rmSync(join(dataRoot, "user-info"), { recursive: true });
    renameSync(dataRoot, detached);
    symlinkSync(detached, dataRoot);

    await expect(backupUserContextForLaunch("start", appsRoot, launchEnvironment))
      .rejects.toThrow(/symbolic link/i);
    expect(snapshotDirectories(checkoutRoot)).toEqual([]);
  });
  test("development startup never copies external snapshots into its local namespace", async () => {
    const { appsRoot, checkoutRoot } = checkout("feature/context");
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1, "dev");
    const externalPath = stageExternalSnapshot(snapshot.snapshotPath, dataHome, "dev", "feature/context");
    writeFileSync(join(externalPath, "files", ".jobhunt-data/user-info/current-context/projects/example-project.md"), "corrupted source bytes\n");

    expect(await backupUserContextForLaunch("dev", appsRoot, launchEnvironment)).toBeUndefined();
    expect(snapshotDirectories(checkoutRoot, "dev")).toEqual([]);
    expect(existsSync(externalPath)).toBe(true);
  });
  test("stable startup snapshots before continuing and propagates backup failure", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);

    const result = await backupUserContextForLaunch("start", appsRoot, launchEnvironment, {
      now: new Date("2026-08-15T12:00:01.000Z"),
      nonce: "00000000-0000-4000-8000-000000000001",
    });
    expect(result?.snapshotId).toContain("2026-08-15T12-00-01-000Z");

    const answerFile = join(checkoutRoot, ".jobhunt-data", "user-info", "current-context", "personal", "user-info.json");
    rmSync(answerFile);
    symlinkSync(join(appsRoot, "..", ".jobhunt-data/user-info/current-context/projects/example-project.md"), answerFile);
    await expect(backupUserContextForLaunch("start", appsRoot, launchEnvironment)).rejects.toThrow(
      /symbolic link/i,
    );
    expect(snapshotDirectories(checkoutRoot)).toHaveLength(1);
  });

  test("development startup never creates or touches backup storage", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunt-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);

    expect(await backupUserContextForLaunch("dev", appsRoot, launchEnvironment)).toBeUndefined();
    expect(existsSync(dataHome)).toBe(false);
    expect(existsSync(namespaceRoot(checkoutRoot, "dev"))).toBe(false);
  });
});
