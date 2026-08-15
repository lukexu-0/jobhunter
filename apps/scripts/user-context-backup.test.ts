import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  watch,
} from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), prefix));
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
  const checkoutRoot = temporaryRoot("jobhunter-context-checkout-");
  const appsRoot = join(checkoutRoot, "apps");
  mkdirSync(join(checkoutRoot, ".git"), { recursive: true, mode: 0o700 });
  mkdirSync(join(appsRoot, "user-info", "current-context", "personal"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(join(checkoutRoot, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(checkoutRoot, "jobhunter-resume-info.md"), "synthetic root profile\n");
  writeFileSync(
    join(appsRoot, "user-info", "current-context", "personal", "user-info.json"),
    '{"synthetic":"answer"}\n',
  );
  return { appsRoot, checkoutRoot };
}

function environment(dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data")):
NodeJS.ProcessEnv {
  return {
    HOME: temporaryRoot("jobhunter-context-home-"),
    JOBHUNTER_DATA_HOME: dataHome,
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

function snapshotDirectories(dataHome: string, mode: "dev" | "start" = "start"): string[] {
  const namespace = mode === "start"
    ? join(dataHome, "production")
    : join(dataHome, "development", "main");
  const snapshots = join(namespace, "user-context-backups", "snapshots");
  return existsSync(snapshots)
    ? readdirSync(snapshots).filter((name) => !name.startsWith("."))
    : [];
}

function readManifest(snapshotPath: string): UserContextSnapshotManifest {
  return JSON.parse(readFileSync(join(snapshotPath, "manifest.json"), "utf8"));
}

describe("private user-context snapshots", () => {
  test("backs up every configured regular file in deterministic path order with private modes", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    mkdirSync(join(appsRoot, "user-info", "archive", "nested"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(join(appsRoot, "user-info", "archive", "resume.pdf"), "synthetic pdf");
    writeFileSync(join(appsRoot, "user-info", "archive", "nested", "image.png"), "synthetic image");
    writeFileSync(join(appsRoot, "user-info", "archive", "resumes.zip"), "synthetic archive");

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
        storageRoot: join(dataHome, "production"),
      },
      files: [
        expect.objectContaining({ path: "apps/user-info/archive/nested/image.png", size: 15 }),
        expect.objectContaining({ path: "apps/user-info/archive/resume.pdf", size: 13 }),
        expect.objectContaining({ path: "apps/user-info/archive/resumes.zip", size: 17 }),
        expect.objectContaining({
          path: "apps/user-info/current-context/personal/user-info.json",
          size: 23,
        }),
        expect.objectContaining({ path: "jobhunter-resume-info.md", size: 23 }),
      ],
    });
    expect(manifest.files.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256))).toBe(true);
    expect(lstatSync(result.snapshotPath).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(result.snapshotPath, "manifest.json")).mode & 0o777).toBe(0o600);
    for (const file of manifest.files) {
      expect(lstatSync(join(result.snapshotPath, "files", file.path)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(result.snapshotPath, "files", "jobhunter-resume-info.md"), "utf8"))
      .toBe("synthetic root profile\n");
  });

  test("versions unchanged snapshots and never replaces an already published snapshot", async () => {
    const { appsRoot } = checkout();
    const launchEnvironment = environment();
    const first = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const second = await deterministicSnapshot(appsRoot, launchEnvironment, 2);

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(readManifest(second.snapshotPath).files).toEqual(readManifest(first.snapshotPath).files);

    writeFileSync(join(appsRoot, "..", "jobhunter-resume-info.md"), "changed synthetic profile\n");
    await expect(deterministicSnapshot(appsRoot, launchEnvironment, 1)).rejects.toThrow(
      /already exists/i,
    );
    expect(readFileSync(join(first.snapshotPath, "files", "jobhunter-resume-info.md"), "utf8"))
      .toBe("synthetic root profile\n");
    expect(readdirSync(dirname(first.snapshotPath)).some((name) => name.startsWith(".staging-")))
      .toBe(false);
  });
  test("serializes namespace operations and reuses a released kernel lock file", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const lockPath = join(dataHome, "production", "user-context-backups", ".operation.lock");
    writeFileSync(lockPath, "", { mode: 0o600 });
    const holder = Bun.spawn([
      "/usr/bin/flock",
      "--exclusive",
      "--nonblock",
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
    writeFileSync(join(checkoutRoot, "jobhunter-resume-info.md"), "current root profile\n");
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
    expect(snapshotDirectories(dataHome)).toHaveLength(2);
  });


  test("rejects source links and configured byte or entry bounds without publishing", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const personal = join(appsRoot, "user-info", "current-context", "personal");
    symlinkSync(join(checkoutRoot, "jobhunter-resume-info.md"), join(personal, "linked-profile.md"));

    await expect(deterministicSnapshot(appsRoot, launchEnvironment, 1)).rejects.toThrow(
      /symbolic link/i,
    );
    expect(snapshotDirectories(dataHome)).toEqual([]);
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
    expect(snapshotDirectories(dataHome)).toEqual([]);
  });

  test("retains exactly the newest thirty complete snapshots", async () => {
    const { appsRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);

    for (let sequence = 1; sequence <= 31; sequence += 1) {
      await deterministicSnapshot(appsRoot, launchEnvironment, sequence);
    }

    const snapshots = snapshotDirectories(dataHome);
    expect(snapshots).toHaveLength(30);
    expect(snapshots.some((name) => name.includes("12-00-01-000Z"))).toBe(false);
    expect(snapshots.some((name) => name.includes("12-00-31-000Z"))).toBe(true);
  });
});

describe("private user-context restore", () => {
  test("verifies checksums and strict contained manifest paths before replacing source files", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const source = join(checkoutRoot, "jobhunter-resume-info.md");
    writeFileSync(source, "newer synthetic profile\n");
    const snapshotFile = join(snapshot.snapshotPath, "files", "jobhunter-resume-info.md");
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
    const dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const snapshot = await deterministicSnapshot(first.appsRoot, launchEnvironment, 1);
    const second = checkout("main");
    const secondSource = join(second.checkoutRoot, "jobhunter-resume-info.md");
    writeFileSync(secondSource, "second checkout value\n");

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
    expect(readFileSync(join(first.checkoutRoot, "jobhunter-resume-info.md"), "utf8"))
      .toBe("synthetic root profile\n");

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
    expect(readFileSync(join(otherBranch.checkoutRoot, "jobhunter-resume-info.md"), "utf8"))
      .toBe("synthetic root profile\n");
  });
  test("retains the selected recovery point when restore staging fails after the pre-restore snapshot", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    let selectedSnapshotPath = "";
    for (let sequence = 1; sequence <= 30; sequence += 1) {
      const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, sequence);
      if (sequence === 1) selectedSnapshotPath = snapshot.snapshotPath;
    }
    writeFileSync(join(checkoutRoot, "jobhunter-resume-info.md"), "current root profile\n");
    const answerDirectory = join(appsRoot, "user-info", "current-context", "personal");
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
    expect(snapshotDirectories(dataHome)).toHaveLength(31);
  });
  test("rolls back files already replaced when a later restore publication fails", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const answerPath = join(appsRoot, "user-info", "current-context", "personal", "user-info.json");
    const rootProfilePath = join(checkoutRoot, "jobhunter-resume-info.md");
    const selectedOnlyPath = join(appsRoot, "user-info", "archive", "selected-only.txt");
    mkdirSync(dirname(selectedOnlyPath), { recursive: true, mode: 0o700 });
    writeFileSync(selectedOnlyPath, "selected snapshot only\n");
    writeFileSync(rootProfilePath, `${"snapshot".repeat(1024 * 1024)}\n`);
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    rmSync(selectedOnlyPath);
    writeFileSync(answerPath, '{"synthetic":"current answer"}\n');
    writeFileSync(rootProfilePath, "current root profile\n");
    let blockedRootPublication = false;
    const watcher = watch(checkoutRoot, (_event, filename) => {
      if (
        !blockedRootPublication
        && typeof filename === "string"
        && filename.startsWith(".user-context-restore-")
      ) {
        blockedRootPublication = true;
        chmodSync(checkoutRoot, 0o500);
      }
    });
    try {
      await expect(restoreUserContextSnapshot({
        mode: "start",
        appsRoot,
        environment: launchEnvironment,
        snapshotId: snapshot.snapshotId,
        now: new Date("2026-08-15T12:00:02.000Z"),
        nonce: "00000000-0000-4000-8000-000000000002",
      })).rejects.toThrow();
    } finally {
      watcher.close();
      chmodSync(checkoutRoot, 0o700);
    }
    expect(blockedRootPublication).toBe(true);
    expect(readFileSync(answerPath, "utf8")).toBe('{"synthetic":"current answer"}\n');
    expect(readFileSync(rootProfilePath, "utf8")).toBe("current root profile\n");
    expect(existsSync(selectedOnlyPath)).toBe(false);
  });



  test("creates a pre-restore snapshot, atomically overwrites listed files, and leaves unlisted files", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const rootProfile = join(checkoutRoot, "jobhunter-resume-info.md");
    const answerFile = join(appsRoot, "user-info", "current-context", "personal", "user-info.json");
    const newerFile = join(appsRoot, "user-info", "current-context", "personal", "newer-note.txt");
    writeFileSync(rootProfile, "newer root profile\n");
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
    expect(readFileSync(rootProfile, "utf8")).toBe("synthetic root profile\n");
    expect(readFileSync(answerFile, "utf8")).toBe('{"synthetic":"answer"}\n');
    expect(readFileSync(newerFile, "utf8")).toBe("unlisted newer file\n");
    const preRestore = snapshotDirectories(dataHome).find((id) => id === result.preRestoreSnapshotId)!;
    const preManifest = readManifest(join(dataHome, "production", "user-context-backups", "snapshots", preRestore));
    expect(preManifest.reason).toBe("pre-restore");
    expect(preManifest.files.map(({ path }) => path)).toContain(
      "apps/user-info/current-context/personal/newer-note.txt",
    );
    expect(lstatSync(rootProfile).mode & 0o777).toBe(0o600);
    expect(lstatSync(answerFile).mode & 0o777).toBe(0o600);
  });

  test("rejects linked snapshot files before source replacement", async () => {
    const { appsRoot, checkoutRoot } = checkout();
    const launchEnvironment = environment();
    const snapshot = await deterministicSnapshot(appsRoot, launchEnvironment, 1);
    const snapshotFile = join(snapshot.snapshotPath, "files", "jobhunter-resume-info.md");
    rmSync(snapshotFile);
    symlinkSync(join(checkoutRoot, "jobhunter-resume-info.md"), snapshotFile);
    writeFileSync(join(checkoutRoot, "jobhunter-resume-info.md"), "new source bytes\n");

    await expect(restoreUserContextSnapshot({
      mode: "start",
      appsRoot,
      environment: launchEnvironment,
      snapshotId: snapshot.snapshotId,
    })).rejects.toThrow(/symbolic link/i);
    expect(readFileSync(join(checkoutRoot, "jobhunter-resume-info.md"), "utf8"))
      .toBe("new source bytes\n");
  });
});

describe("workspace launch backup hook", () => {
  test("stable startup snapshots before continuing and propagates backup failure", async () => {
    const { appsRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);

    const result = await backupUserContextForLaunch("start", appsRoot, launchEnvironment, {
      now: new Date("2026-08-15T12:00:01.000Z"),
      nonce: "00000000-0000-4000-8000-000000000001",
    });
    expect(result?.snapshotId).toContain("2026-08-15T12-00-01-000Z");

    const answerFile = join(appsRoot, "user-info", "current-context", "personal", "user-info.json");
    rmSync(answerFile);
    symlinkSync(join(appsRoot, "..", "jobhunter-resume-info.md"), answerFile);
    await expect(backupUserContextForLaunch("start", appsRoot, launchEnvironment)).rejects.toThrow(
      /symbolic link/i,
    );
    expect(snapshotDirectories(dataHome)).toHaveLength(1);
  });

  test("development startup never creates or touches backup storage", async () => {
    const { appsRoot } = checkout();
    const dataHome = join(temporaryRoot("jobhunter-context-data-parent-"), "data");
    const launchEnvironment = environment(dataHome);

    expect(await backupUserContextForLaunch("dev", appsRoot, launchEnvironment)).toBeUndefined();
    expect(existsSync(dataHome)).toBe(false);
  });
});
