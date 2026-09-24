import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import {
  prepareLaunchStorage,
  prepareLaunchStorageForArtifactRecovery,
  prepareLaunchStorageForLaunch,
  withStoppedPipeline,
} from "./launch-storage.ts";
import { resolveLaunchConfiguration } from "./launch-config.ts";
import { runArtifactRestoreCommand } from "./restore-artifacts.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function availableDataHome(): string {
  return join(temporaryRoot("jobhunt-data-parent-"), "data");
}

function primaryCheckout(branch = "main"): {
  readonly appsRoot: string;
  readonly checkoutRoot: string;
  readonly gitDirectory: string;
  readonly headPath: string;
} {
  const checkoutRoot = temporaryRoot("jobhunt-primary-");
  const gitDirectory = join(checkoutRoot, ".git");
  const appsRoot = join(checkoutRoot, "apps");
  mkdirSync(gitDirectory, { mode: 0o700 });
  mkdirSync(appsRoot, { mode: 0o700 });
  const headPath = join(gitDirectory, "HEAD");
  writeFileSync(headPath, `ref: refs/heads/${branch}\n`);
  return { appsRoot, checkoutRoot, gitDirectory, headPath };
}

function linkedCheckout(branch: string): {
  readonly appsRoot: string;
  readonly checkoutRoot: string;
} {
  const fixtureRoot = temporaryRoot("jobhunt-linked-");
  const checkoutRoot = join(fixtureRoot, "checkout");
  const appsRoot = join(checkoutRoot, "apps");
  const gitDirectory = join(fixtureRoot, "git", "worktrees", "checkout");
  mkdirSync(appsRoot, { recursive: true, mode: 0o700 });
  mkdirSync(gitDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(checkoutRoot, ".git"), `gitdir: ${gitDirectory}\n`);
  writeFileSync(join(gitDirectory, "HEAD"), `ref: refs/heads/${branch}\n`);
  return { appsRoot, checkoutRoot };
}


function writeDatabase(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true });
  try {
    database.exec("CREATE TABLE records (value TEXT NOT NULL)");
    database.query("INSERT INTO records (value) VALUES (?)").run(value);
  } finally {
    database.close();
  }
}

function readValues(path: string): string[] {
  const database = new Database(path, { readonly: true });
  try {
    return database
      .query<{ value: string }, []>("SELECT value FROM records ORDER BY rowid")
      .all()
      .map(({ value }) => value);
  } finally {
    database.close();
  }
}

describe("workspace launch configuration", () => {
  test("transcript remains absent unless an explicit path is provided", () => {
    const { appsRoot } = primaryCheckout();
    expect(resolveLaunchConfiguration("dev", appsRoot, {}).transcriptPdf).toBeUndefined();
    expect(resolveLaunchConfiguration("dev", appsRoot, {
      JOBHUNT_TRANSCRIPT_PDF: "/private/applicant/transcript.pdf",
    }).transcriptPdf).toBe("/private/applicant/transcript.pdf");
  });
  test("development stores data in the checkout branch namespace", () => {
    const { appsRoot, checkoutRoot } = primaryCheckout("feature/storage");
    const configuration = resolveLaunchConfiguration("dev", appsRoot);

    expect(configuration.pipelineDatabase).toBe(
      join(checkoutRoot, ".jobhunt-data", "development", "feature%2Fstorage", "pipeline.sqlite"),
    );
    expect(configuration.artifactRoot).toBe(
      join(checkoutRoot, ".jobhunt-data", "development", "feature%2Fstorage", "runs"),
    );
  });
  test("stable start uses checkout-local production storage", () => {
    const { appsRoot, checkoutRoot, gitDirectory } = primaryCheckout("main");
    const checkoutStatus = statSync(checkoutRoot);
    const gitStatus = statSync(gitDirectory);

    expect(resolveLaunchConfiguration("start", appsRoot, {})).toEqual({
      pipelinePort: 3457,
      webPort: 3456,
      pipelineOrigin: "http://127.0.0.1:3457",
      webOrigin: "http://127.0.0.1:3456",
      harnessOrigin: "http://127.0.0.1:8765",
      pipelineDatabase: join(checkoutRoot, ".jobhunt-data", "production", "pipeline.sqlite"),
      contextDatabase: join(checkoutRoot, ".jobhunt-data", "production", "context.sqlite"),
      authDatabase: join(checkoutRoot, ".jobhunt-data", "production", "auth.sqlite"),
      artifactRoot: join(checkoutRoot, ".jobhunt-data", "production", "runs"),
      productionCheckout: {
        checkoutRoot,
        gitDirectory,
        checkoutDevice: checkoutStatus.dev,
        checkoutInode: checkoutStatus.ino,
        gitDevice: gitStatus.dev,
        gitInode: gitStatus.ino,
      },
    });
  });

  test("first stable preparation binds its checkout without importing production state", () => {
    const { appsRoot, checkoutRoot, gitDirectory } = primaryCheckout();
    const checkoutStatus = statSync(checkoutRoot);
    const gitStatus = statSync(gitDirectory);
    const configuration = resolveLaunchConfiguration("start", appsRoot);
    const external = join(availableDataHome(), "production");
    writeDatabase(join(external, "pipeline.sqlite"), "external-production");
    writeDatabase(join(appsRoot, "resume-tailoring", "data", "state", "pipeline.sqlite"), "legacy-production");

    prepareLaunchStorage(configuration);

    const receiptPath = join(dirname(configuration.pipelineDatabase), ".production-checkout");
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual({
      version: 2,
      checkoutRoot,
      gitDirectory,
      checkoutDevice: checkoutStatus.dev,
      checkoutInode: checkoutStatus.ino,
      gitDevice: gitStatus.dev,
      gitInode: gitStatus.ino,
    });
    expect(lstatSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(existsSync(configuration.pipelineDatabase)).toBe(false);
    expect(existsSync(configuration.contextDatabase)).toBe(false);
  });

  test("reuses the production binding for the same checkout", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration("start", appsRoot);
    prepareLaunchStorage(configuration);
    const receiptPath = join(dirname(configuration.pipelineDatabase), ".production-checkout");
    const firstReceipt = readFileSync(receiptPath, "utf8");
    const firstInode = statSync(receiptPath).ino;

    prepareLaunchStorage(configuration);

    expect(readFileSync(receiptPath, "utf8")).toBe(firstReceipt);
    expect(statSync(receiptPath).ino).toBe(firstInode);
  });

  test("rejects a production checkout whose filesystem identity changed", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration("start", appsRoot);
    const identity = configuration.productionCheckout!;

    expect(() => prepareLaunchStorage({
      ...configuration,
      productionCheckout: {
        ...identity,
        checkoutInode: identity.checkoutInode + 1,
      },
    })).toThrow(/checkout identity changed/i);
    expect(existsSync(configuration.pipelineDatabase)).toBe(false);
  });

  test("rejects unsafe production binding receipts before preparing storage", () => {
    const unsafeReceipts: readonly {
      readonly create: (receiptPath: string) => void;
      readonly expectedError: RegExp;
    }[] = [
      {
        create: (receiptPath) => {
          const outsideReceipt = join(temporaryRoot("jobhunt-binding-outside-"), "receipt");
          writeFileSync(outsideReceipt, "{}\n");
          symlinkSync(outsideReceipt, receiptPath);
        },
        expectedError: /symbolic link/,
      },
      {
        create: (receiptPath) => writeFileSync(receiptPath, "{}\n"),
        expectedError: /malformed/,
      },
      {
        create: (receiptPath) => writeFileSync(receiptPath, "x".repeat(4_097)),
        expectedError: /invalid/,
      },
    ];

    for (const unsafeReceipt of unsafeReceipts) {
      const { appsRoot } = primaryCheckout();
      const configuration = resolveLaunchConfiguration("start", appsRoot);
      const namespaceRoot = dirname(configuration.pipelineDatabase);
      mkdirSync(namespaceRoot, { recursive: true, mode: 0o700 });
      unsafeReceipt.create(join(namespaceRoot, ".production-checkout"));

      expect(() => prepareLaunchStorage(configuration)).toThrow(unsafeReceipt.expectedError);
      expect(existsSync(configuration.pipelineDatabase)).toBe(false);
      expect(existsSync(configuration.artifactRoot)).toBe(false);
    }
  });

  test("rejects stable start when the primary checkout is not on main", () => {
    const { appsRoot } = primaryCheckout("release");
    expect(() => resolveLaunchConfiguration("start", appsRoot)).toThrow(/main branch/);
  });

  test("development isolates linked checkouts on the same branch", () => {
    const first = linkedCheckout("feature/runtime-storage");
    const second = linkedCheckout("feature/runtime-storage");
    const firstConfiguration = resolveLaunchConfiguration("dev", first.appsRoot, {});
    const secondConfiguration = resolveLaunchConfiguration("dev", second.appsRoot, {});
    const namespace = join(first.checkoutRoot, ".jobhunt-data", "development", "feature%2Fruntime-storage");

    expect({
      pipelinePort: firstConfiguration.pipelinePort,
      webPort: firstConfiguration.webPort,
      pipelineOrigin: firstConfiguration.pipelineOrigin,
      webOrigin: firstConfiguration.webOrigin,
      harnessOrigin: firstConfiguration.harnessOrigin,
      pipelineDatabase: firstConfiguration.pipelineDatabase,
      contextDatabase: firstConfiguration.contextDatabase,
      authDatabase: firstConfiguration.authDatabase,
      artifactRoot: firstConfiguration.artifactRoot,
    }).toEqual({
      pipelinePort: 3557,
      webPort: 3556,
      pipelineOrigin: "http://127.0.0.1:3557",
      webOrigin: "http://127.0.0.1:3556",
      harnessOrigin: "http://127.0.0.1:8865",
      pipelineDatabase: join(namespace, "pipeline.sqlite"),
      contextDatabase: join(namespace, "context.sqlite"),
      authDatabase: join(namespace, "auth.sqlite"),
      artifactRoot: join(namespace, "runs"),
    });
    expect(secondConfiguration.pipelineDatabase).toBe(
      join(second.checkoutRoot, ".jobhunt-data", "development", "feature%2Fruntime-storage", "pipeline.sqlite"),
    );
    expect(secondConfiguration.contextDatabase).not.toBe(firstConfiguration.contextDatabase);
    expect(secondConfiguration.authDatabase).not.toBe(firstConfiguration.authDatabase);
    expect(secondConfiguration.artifactRoot).not.toBe(firstConfiguration.artifactRoot);
    expect(secondConfiguration.transcriptPdf).toBeUndefined();
    expect("productionCheckout" in firstConfiguration).toBe(false);
    expect("productionCheckout" in secondConfiguration).toBe(false);
  });


  test("rejects stable start from a linked worktree", () => {
    const { appsRoot } = linkedCheckout("feature/runtime-storage");
    expect(() => resolveLaunchConfiguration("start", appsRoot)).toThrow(/primary Git checkout/);
  });

  test("refuses storage preparation while the matching pipeline is running", async () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration("dev", appsRoot);
    const server = createServer();
    await new Promise<void>((resolveListening, rejectListening) => {
      server.once("error", rejectListening);
      server.listen(0, "127.0.0.1", resolveListening);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test port is unavailable");

    try {
      let callbackCalled = false;
      await expect(withStoppedPipeline(
        { pipelinePort: address.port },
        () => {
          callbackCalled = true;
        },
      )).rejects.toThrow(/must be stopped/);
      expect(callbackCalled).toBe(false);
      await expect(prepareLaunchStorageForLaunch({
        ...configuration,
        pipelinePort: address.port,
      })).rejects.toThrow(/must be stopped/);
      expect(existsSync(configuration.pipelineDatabase)).toBe(false);
    } finally {
      await new Promise<void>((resolveClosed, rejectClosed) => {
        server.close((error) => error ? rejectClosed(error) : resolveClosed());
      });
    }
  });

  test("requires an existing managed pipeline database for artifact recovery", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration("dev", appsRoot);

    expect(() => prepareLaunchStorageForArtifactRecovery(configuration)).toThrow(
      /managed pipeline database does not exist/i,
    );
    writeDatabase(configuration.pipelineDatabase, "managed");
    expect(() => prepareLaunchStorageForArtifactRecovery(configuration)).not.toThrow();
  });

  test("holds the stopped-pipeline exclusion until the guarded operation settles", async () => {
    const portPicker = createServer();
    await new Promise<void>((resolveListening, rejectListening) => {
      portPicker.once("error", rejectListening);
      portPicker.listen(0, "127.0.0.1", resolveListening);
    });
    const address = portPicker.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test port is unavailable");
    }
    await new Promise<void>((resolveClosed, rejectClosed) => {
      portPicker.close((error) => error ? rejectClosed(error) : resolveClosed());
    });

    let competingError: NodeJS.ErrnoException | undefined;
    await withStoppedPipeline({ pipelinePort: address.port }, async () => {
      const competingServer = createServer();
      await new Promise<void>((resolveRejected) => {
        competingServer.once("error", (error) => {
          competingError = error;
          resolveRejected();
        });
        competingServer.listen(address.port, "127.0.0.1");
      });
    });

    expect(competingError?.code).toBe("EADDRINUSE");
    const releasedServer = createServer();
    await new Promise<void>((resolveListening, rejectListening) => {
      releasedServer.once("error", rejectListening);
      releasedServer.listen(address.port, "127.0.0.1", resolveListening);
    });
    await new Promise<void>((resolveClosed, rejectClosed) => {
      releasedServer.close((error) => error ? rejectClosed(error) : resolveClosed());
    });
  });

  test("rejects restore arguments with one bounded JSON summary before resolving storage", async () => {
    const output: string[] = [];

    const exitCode = await runArtifactRestoreCommand(
      ["/caller/supplied/root", "31"],
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({
      markers: 0,
      restored: 0,
      published: 0,
      reused: 0,
      unrecovered: 0,
      failures: [],
      omittedFailures: 0,
      fatal: "artifacts:restore does not accept arguments",
    });
  });

  test("fails closed for a detached checkout", () => {
    const { appsRoot, headPath } = primaryCheckout();
    writeFileSync(headPath, "3f5a8e7d2a723fb36f5fca57b292a3aa18cf8d1c\n");

    expect(() =>
      resolveLaunchConfiguration("dev", appsRoot),
    ).toThrow(/named branch/);
  });

  test("uses checkout storage without importing external or legacy state", () => {
    const { appsRoot } = primaryCheckout("feature/storage");
    const dataHome = availableDataHome();
    const configuration = resolveLaunchConfiguration("dev", appsRoot);
    writeDatabase(configuration.pipelineDatabase, "checkout");
    const external = join(dataHome, "development", "feature%2Fstorage");
    writeDatabase(join(external, "pipeline.sqlite"), "external");
    writeDatabase(join(external, "context.sqlite"), "external-context");
    writeDatabase(join(appsRoot, "resume-tailoring", "data", "oauth", "auth.dev.sqlite"), "legacy-auth");
    mkdirSync(join(external, "runs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(external, "runs", "outside"), "external-artifact");

    prepareLaunchStorage(configuration);

    expect(readValues(configuration.pipelineDatabase)).toEqual(["checkout"]);
    expect(existsSync(configuration.contextDatabase)).toBe(false);
    expect(existsSync(configuration.authDatabase)).toBe(false);
    expect(existsSync(join(configuration.artifactRoot, "outside"))).toBe(false);
  });

  test("rejects storage paths outside the selected checkout namespace", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration("dev", appsRoot);
    const outside = temporaryRoot("jobhunt-outside-namespace-");
    expect(() => prepareLaunchStorage({
      ...configuration,
      artifactRoot: join(outside, "runs"),
    })).toThrow(/one managed namespace/);
    expect(existsSync(join(outside, "runs"))).toBe(false);
    expect(existsSync(dirname(configuration.pipelineDatabase))).toBe(false);
  });

  test("rejects orphaned SQLite companions without changing existing checkout data", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration("dev", appsRoot);
    writeDatabase(configuration.pipelineDatabase, "checkout");
    writeFileSync(`${configuration.contextDatabase}-wal`, "orphan");

    expect(() => prepareLaunchStorage(configuration)).toThrow(/companion without its database/);
    expect(readValues(configuration.pipelineDatabase)).toEqual(["checkout"]);
  });

  test("rejects symbolic links and non-regular managed database paths", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration("dev", appsRoot);
    const namespace = dirname(configuration.pipelineDatabase);
    const outsideTarget = join(temporaryRoot("jobhunt-outside-"), "target.sqlite");
    mkdirSync(namespace, { recursive: true, mode: 0o700 });
    writeFileSync(outsideTarget, "outside-target");
    symlinkSync(outsideTarget, configuration.pipelineDatabase);

    expect(() => prepareLaunchStorage(configuration)).toThrow(/symbolic link/);
    expect(readFileSync(outsideTarget, "utf8")).toBe("outside-target");

    unlinkSync(configuration.pipelineDatabase);
    mkdirSync(configuration.pipelineDatabase);
    expect(() => prepareLaunchStorage(configuration)).toThrow(/regular file/);

    rmSync(configuration.pipelineDatabase, { recursive: true });
    symlinkSync(outsideTarget, `${configuration.pipelineDatabase}-wal`);
    expect(() => prepareLaunchStorage(configuration)).toThrow(/symbolic link/);
  });

  test("rejects a symbolic-link storage namespace", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration("dev", appsRoot);
    const namespace = dirname(configuration.pipelineDatabase);
    const outsideDirectory = temporaryRoot("jobhunt-outside-directory-");
    mkdirSync(dirname(namespace), { recursive: true, mode: 0o700 });
    symlinkSync(outsideDirectory, namespace);

    expect(() => prepareLaunchStorage(configuration)).toThrow(/symbolic link/);
    expect(existsSync(join(outsideDirectory, "pipeline.sqlite"))).toBe(false);
  });
});
