import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import {
  completeLaunchStoragePreparation,
  prepareLaunchStorage,
  prepareLaunchStorageForLaunch,
} from "./launch-storage.ts";
import { resolveLaunchConfiguration } from "./launch-config.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function availableDataHome(): string {
  return join(temporaryRoot("jobhunter-data-parent-"), "data");
}

function primaryCheckout(branch = "main"): {
  readonly appsRoot: string;
  readonly checkoutRoot: string;
  readonly gitDirectory: string;
  readonly headPath: string;
} {
  const checkoutRoot = temporaryRoot("jobhunter-primary-");
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
  const fixtureRoot = temporaryRoot("jobhunter-linked-");
  const checkoutRoot = join(fixtureRoot, "checkout");
  const appsRoot = join(checkoutRoot, "apps");
  const gitDirectory = join(fixtureRoot, "git", "worktrees", "checkout");
  mkdirSync(appsRoot, { recursive: true, mode: 0o700 });
  mkdirSync(gitDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(checkoutRoot, ".git"), `gitdir: ${gitDirectory}\n`);
  writeFileSync(join(gitDirectory, "HEAD"), `ref: refs/heads/${branch}\n`);
  return { appsRoot, checkoutRoot };
}

function configuredEnvironment(dataHome: string): NodeJS.ProcessEnv {
  return {
    HOME: temporaryRoot("jobhunter-home-"),
    JOBHUNTER_DATA_HOME: dataHome,
  };
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
  test("stable start uses the fixed external production namespace from the primary checkout", () => {
    const { appsRoot, checkoutRoot, gitDirectory } = primaryCheckout("main");
    const dataHome = availableDataHome();
    const checkoutStatus = statSync(checkoutRoot);
    const gitStatus = statSync(gitDirectory);

    expect(resolveLaunchConfiguration("start", appsRoot, configuredEnvironment(dataHome))).toEqual({
      pipelinePort: 3457,
      webPort: 3456,
      pipelineOrigin: "http://127.0.0.1:3457",
      webOrigin: "http://127.0.0.1:3456",
      harnessOrigin: "http://127.0.0.1:8765",
      pipelineDatabase: join(dataHome, "production", "pipeline.sqlite"),
      contextDatabase: join(dataHome, "production", "context.sqlite"),
      authDatabase: join(dataHome, "production", "auth.sqlite"),
      artifactRoot: join(dataHome, "production", "runs"),
      priorPipelineDatabase: join(
        appsRoot,
        "resume-tailoring",
        "data",
        "state",
        "pipeline.sqlite",
      ),
      priorContextDatabase: join(
        appsRoot,
        "resume-tailoring",
        "data",
        "context",
        "context.sqlite",
      ),
      priorAuthDatabase: join(
        appsRoot,
        "resume-tailoring",
        "data",
        "oauth",
        "auth.sqlite",
      ),
      priorArtifactRoot: join(checkoutRoot, "output", "runs"),
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

  test("first stable preparation binds its checkout before importing production state", () => {
    const { appsRoot, checkoutRoot, gitDirectory } = primaryCheckout();
    const checkoutStatus = statSync(checkoutRoot);
    const gitStatus = statSync(gitDirectory);
    const configuration = resolveLaunchConfiguration(
      "start",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
    writeDatabase(configuration.priorPipelineDatabase, "bound-production");

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
    expect(readValues(configuration.pipelineDatabase)).toEqual(["bound-production"]);
  });

  test("reuses the production binding for the same checkout", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration(
      "start",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
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
    const configuration = resolveLaunchConfiguration(
      "start",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
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

  test("rejects another primary main checkout without mutating production targets", () => {
    const first = primaryCheckout();
    const second = primaryCheckout();
    const dataHome = availableDataHome();
    const environment = configuredEnvironment(dataHome);
    const firstConfiguration = resolveLaunchConfiguration("start", first.appsRoot, environment);
    const secondConfiguration = resolveLaunchConfiguration("start", second.appsRoot, environment);
    prepareLaunchStorage(firstConfiguration);
    const receiptPath = join(dirname(firstConfiguration.pipelineDatabase), ".production-checkout");
    const receiptBefore = readFileSync(receiptPath, "utf8");
    const artifactMarker = join(firstConfiguration.artifactRoot, "unchanged");
    writeFileSync(artifactMarker, "first checkout");
    writeDatabase(secondConfiguration.priorPipelineDatabase, "second-checkout-state");

    expect(() => prepareLaunchStorage(secondConfiguration)).toThrow(
      /different primary checkout/,
    );
    expect(existsSync(firstConfiguration.pipelineDatabase)).toBe(false);
    expect(readFileSync(receiptPath, "utf8")).toBe(receiptBefore);
    expect(readFileSync(artifactMarker, "utf8")).toBe("first checkout");
  });

  test("rejects unsafe production binding receipts before importing state", () => {
    const unsafeReceipts: readonly {
      readonly create: (receiptPath: string) => void;
      readonly expectedError: RegExp;
    }[] = [
      {
        create: (receiptPath) => {
          const outsideReceipt = join(temporaryRoot("jobhunter-binding-outside-"), "receipt");
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
      const configuration = resolveLaunchConfiguration(
        "start",
        appsRoot,
        configuredEnvironment(availableDataHome()),
      );
      const namespaceRoot = dirname(configuration.pipelineDatabase);
      mkdirSync(namespaceRoot, { recursive: true, mode: 0o700 });
      unsafeReceipt.create(join(namespaceRoot, ".production-checkout"));
      writeDatabase(configuration.priorPipelineDatabase, "must-not-import");

      expect(() => prepareLaunchStorage(configuration)).toThrow(unsafeReceipt.expectedError);
      expect(existsSync(configuration.pipelineDatabase)).toBe(false);
      expect(existsSync(configuration.artifactRoot)).toBe(false);
    }
  });

  test("rejects stable start when the primary checkout is not on main", () => {
    const { appsRoot } = primaryCheckout("release");
    const dataHome = availableDataHome();

    expect(() =>
      resolveLaunchConfiguration("start", appsRoot, configuredEnvironment(dataHome)),
    ).toThrow(/main branch/);
    expect(existsSync(dataHome)).toBe(false);
  });

  test("development uses a stable branch-scoped namespace across linked checkouts", () => {
    const first = linkedCheckout("feature/runtime-storage");
    const second = linkedCheckout("feature/runtime-storage");
    const dataHome = availableDataHome();
    const environment = configuredEnvironment(dataHome);
    const firstConfiguration = resolveLaunchConfiguration("dev", first.appsRoot, environment);
    const secondConfiguration = resolveLaunchConfiguration("dev", second.appsRoot, environment);
    const namespace = join(dataHome, "development", "feature%2Fruntime-storage");

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
    expect(secondConfiguration.pipelineDatabase).toBe(firstConfiguration.pipelineDatabase);
    expect(secondConfiguration.contextDatabase).toBe(firstConfiguration.contextDatabase);
    expect(secondConfiguration.authDatabase).toBe(firstConfiguration.authDatabase);
    expect(secondConfiguration.artifactRoot).toBe(firstConfiguration.artifactRoot);
    expect(firstConfiguration.priorArtifactRoot).toBe(join(first.checkoutRoot, "output", "dev-runs"));
    expect(secondConfiguration.priorArtifactRoot).toBe(
      join(second.checkoutRoot, "output", "dev-runs"),
    );
    expect("productionCheckout" in firstConfiguration).toBe(false);
    expect("productionCheckout" in secondConfiguration).toBe(false);
  });

  test("falls back from a relative override to XDG data and then to the home data directory", () => {
    const { appsRoot } = primaryCheckout();
    const xdgDataHome = temporaryRoot("jobhunter-xdg-");
    const home = temporaryRoot("jobhunter-home-");

    const xdgConfiguration = resolveLaunchConfiguration("dev", appsRoot, {
      HOME: home,
      JOBHUNTER_DATA_HOME: "checkout-local-data",
      XDG_DATA_HOME: xdgDataHome,
    });
    const homeConfiguration = resolveLaunchConfiguration("dev", appsRoot, { HOME: home });

    expect(xdgConfiguration.artifactRoot).toBe(
      join(xdgDataHome, "jobhunter", "development", "main", "runs"),
    );
    expect(homeConfiguration.artifactRoot).toBe(
      join(home, ".local", "share", "jobhunter", "development", "main", "runs"),
    );
  });

  test("rejects stable start from a linked worktree before creating storage", () => {
    const { appsRoot } = linkedCheckout("feature/runtime-storage");
    const dataHome = availableDataHome();

    expect(() =>
      resolveLaunchConfiguration("start", appsRoot, configuredEnvironment(dataHome)),
    ).toThrow(/primary Git checkout/);
    expect(existsSync(dataHome)).toBe(false);
  });

  test("refuses storage migration while the matching pipeline is running", async () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration(
      "dev",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
    writeDatabase(configuration.priorPipelineDatabase, "legacy");
    const server = createServer();
    await new Promise<void>((resolveListening, rejectListening) => {
      server.once("error", rejectListening);
      server.listen(0, "127.0.0.1", resolveListening);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test port is unavailable");

    try {
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

  test("fails closed for a detached checkout", () => {
    const { appsRoot, headPath } = primaryCheckout();
    writeFileSync(headPath, "3f5a8e7d2a723fb36f5fca57b292a3aa18cf8d1c\n");

    expect(() =>
      resolveLaunchConfiguration("dev", appsRoot, configuredEnvironment(availableDataHome())),
    ).toThrow(/named branch/);
  });

  test("imports all legacy databases and includes committed WAL content", () => {
    const { appsRoot } = primaryCheckout("feature/storage");
    const configuration = resolveLaunchConfiguration(
      "dev",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
    mkdirSync(dirname(configuration.priorPipelineDatabase), {
      recursive: true,
      mode: 0o700,
    });
    const pipelineDatabase = new Database(configuration.priorPipelineDatabase, { create: true });
    try {
      pipelineDatabase.exec("PRAGMA journal_mode = WAL");
      pipelineDatabase.exec("PRAGMA wal_autocheckpoint = 0");
      pipelineDatabase.exec("CREATE TABLE records (value TEXT NOT NULL)");
      pipelineDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      pipelineDatabase.query("INSERT INTO records (value) VALUES (?)").run("pipeline-from-wal");
      expect(statSync(`${configuration.priorPipelineDatabase}-wal`).size).toBeGreaterThan(0);
      writeDatabase(configuration.priorContextDatabase, "context");
      writeDatabase(configuration.priorAuthDatabase, "auth");

      const preparation = prepareLaunchStorage(configuration);

      expect(readValues(configuration.pipelineDatabase)).toEqual(["pipeline-from-wal"]);
      expect(readValues(configuration.contextDatabase)).toEqual(["context"]);
      expect(readValues(configuration.authDatabase)).toEqual(["auth"]);
      expect(preparation.artifactMigration?.priorRoot).toBe(configuration.priorArtifactRoot);
      expect(existsSync(preparation.artifactMigration!.receiptPath)).toBe(true);
      expect(lstatSync(dirname(configuration.pipelineDatabase)).mode & 0o777).toBe(0o700);
      expect(lstatSync(configuration.artifactRoot).mode & 0o777).toBe(0o700);
      for (const path of [
        configuration.pipelineDatabase,
        configuration.contextDatabase,
        configuration.authDatabase,
      ]) {
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
      }

      const repeatedPreparation = prepareLaunchStorage(configuration);
      expect(repeatedPreparation.artifactMigration).toEqual(preparation.artifactMigration);
      completeLaunchStoragePreparation(preparation);
      expect(existsSync(preparation.artifactMigration!.receiptPath)).toBe(false);

      pipelineDatabase.query("INSERT INTO records (value) VALUES (?)").run("newer-source-row");
      expect(prepareLaunchStorage(configuration).artifactMigration).toBeUndefined();
      expect(readValues(configuration.pipelineDatabase)).toEqual(["pipeline-from-wal"]);
    } finally {
      pipelineDatabase.close();
    }
  });

  test("an existing regular target wins without reading or overwriting the legacy source", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration(
      "dev",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
    mkdirSync(dirname(configuration.pipelineDatabase), { recursive: true, mode: 0o700 });
    writeFileSync(configuration.pipelineDatabase, "existing-target");
    mkdirSync(dirname(configuration.priorPipelineDatabase), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(configuration.priorPipelineDatabase, "not-a-sqlite-database");

    const preparation = prepareLaunchStorage(configuration);

    expect(readFileSync(configuration.pipelineDatabase, "utf8")).toBe("existing-target");
    expect(preparation.artifactMigration).toBeUndefined();
  });

  test("recovers after an interrupted legacy preparation lock", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration(
      "dev",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
    writeDatabase(configuration.priorPipelineDatabase, "legacy");
    const staleLock = join(dirname(configuration.pipelineDatabase), ".storage-import.lock");
    mkdirSync(staleLock, { recursive: true, mode: 0o700 });

    const preparation = prepareLaunchStorage(configuration);

    expect(readValues(configuration.pipelineDatabase)).toEqual(["legacy"]);
    expect(preparation.artifactMigration?.priorRoot).toBe(configuration.priorArtifactRoot);
  });

  test("removes stale managed SQLite snapshots before retrying an import", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration(
      "dev",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
    writeDatabase(configuration.priorPipelineDatabase, "legacy");
    const namespace = dirname(configuration.pipelineDatabase);
    mkdirSync(namespace, { recursive: true, mode: 0o700 });
    const staleBuilding = join(
      namespace,
      ".pipeline.11111111-1111-4111-8111-111111111111.building",
    );
    const staleReady = join(
      namespace,
      ".pipeline.22222222-2222-4222-8222-222222222222.ready",
    );
    writeFileSync(staleBuilding, "interrupted-building-snapshot");
    writeFileSync(staleReady, "interrupted-ready-snapshot");

    prepareLaunchStorage(configuration);

    expect(existsSync(staleBuilding)).toBe(false);
    expect(existsSync(staleReady)).toBe(false);
    expect(readValues(configuration.pipelineDatabase)).toEqual(["legacy"]);
  });

  test("rejects a legacy SQLite set above the import byte limit", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration(
      "dev",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
    mkdirSync(dirname(configuration.priorPipelineDatabase), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(configuration.priorPipelineDatabase, "");
    truncateSync(configuration.priorPipelineDatabase, 1024 * 1024 * 1024 + 1);

    expect(() => prepareLaunchStorage(configuration)).toThrow(/SQLite import byte limit/i);
    expect(existsSync(configuration.pipelineDatabase)).toBe(false);
  });

  test("rejects symbolic links and non-regular managed database paths", () => {
    const { appsRoot } = primaryCheckout();
    const configuration = resolveLaunchConfiguration(
      "dev",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
    const namespace = dirname(configuration.pipelineDatabase);
    const outsideTarget = join(temporaryRoot("jobhunter-outside-"), "target.sqlite");
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
    const configuration = resolveLaunchConfiguration(
      "dev",
      appsRoot,
      configuredEnvironment(availableDataHome()),
    );
    const namespace = dirname(configuration.pipelineDatabase);
    const outsideDirectory = temporaryRoot("jobhunter-outside-directory-");
    mkdirSync(dirname(namespace), { recursive: true, mode: 0o700 });
    symlinkSync(outsideDirectory, namespace);

    expect(() => prepareLaunchStorage(configuration)).toThrow(/symbolic link/);
    expect(existsSync(join(outsideDirectory, "pipeline.sqlite"))).toBe(false);
  });
});
