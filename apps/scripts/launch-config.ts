import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

type LaunchEnvironment = Readonly<Record<string, string | undefined>>;

interface CheckoutLayout {
  readonly checkoutRoot: string;
  readonly gitDirectory: string;
  readonly primary: boolean;
}

export interface ProductionCheckoutIdentity {
  readonly checkoutRoot: string;
  readonly gitDirectory: string;
  readonly checkoutDevice: number;
  readonly checkoutInode: number;
  readonly gitDevice: number;
  readonly gitInode: number;
}

export interface LaunchConfiguration {
  readonly pipelinePort: number;
  readonly webPort: number;
  readonly pipelineOrigin: string;
  readonly webOrigin: string;
  readonly harnessOrigin: string;
  readonly pipelineDatabase: string;
  readonly contextDatabase: string;
  readonly authDatabase: string;
  readonly artifactRoot: string;
  readonly priorPipelineDatabase: string;
  readonly priorContextDatabase: string;
  readonly priorAuthDatabase: string;
  readonly priorArtifactRoot: string;
  readonly productionCheckout?: ProductionCheckoutIdentity;
}

const METADATA_SIZE_LIMIT = 4_096;

function metadataLine(path: string, label: string): string {
  const lexicalPath = resolve(path);
  let status: Stats;
  try {
    status = lstatSync(lexicalPath);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${lexicalPath}`, { cause: error });
  }
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!status.isFile()) throw new Error(`${label} must be a regular file`);
  if (status.size > METADATA_SIZE_LIMIT) throw new Error(`${label} is unexpectedly large`);
  if (realpathSync(lexicalPath) !== lexicalPath) {
    throw new Error(`${label} must not traverse a symbolic link`);
  }

  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(lexicalPath));
  } catch (error) {
    throw new Error(`${label} must contain valid UTF-8`, { cause: error });
  }
  if (contents.endsWith("\n")) contents = contents.slice(0, -1);
  if (contents.endsWith("\r")) contents = contents.slice(0, -1);
  if (contents.includes("\n") || contents.includes("\r")) {
    throw new Error(`${label} must contain exactly one line`);
  }
  return contents;
}

function requireRealDirectory(path: string, label: string): string {
  const lexicalPath = resolve(path);
  let status: Stats;
  try {
    status = lstatSync(lexicalPath);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${lexicalPath}`, { cause: error });
  }
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!status.isDirectory()) throw new Error(`${label} must be a real directory`);
  if (realpathSync(lexicalPath) !== lexicalPath) {
    throw new Error(`${label} must not traverse a symbolic link`);
  }
  return lexicalPath;
}

function resolveCheckoutLayout(appsRoot: string): CheckoutLayout {
  const checkoutRoot = requireRealDirectory(resolve(appsRoot, ".."), "Checkout root");
  const dotGit = resolve(checkoutRoot, ".git");
  let status: Stats;
  try {
    status = lstatSync(dotGit);
  } catch (error) {
    throw new Error(`Checkout Git metadata is unavailable: ${dotGit}`, { cause: error });
  }
  if (status.isSymbolicLink()) {
    throw new Error("Checkout Git metadata must not be a symbolic link");
  }
  if (status.isDirectory()) {
    return {
      checkoutRoot,
      gitDirectory: requireRealDirectory(dotGit, "Primary Git directory"),
      primary: true,
    };
  }
  if (!status.isFile()) throw new Error("Checkout .git must be a real directory or gitdir file");

  const declaration = metadataLine(dotGit, "Linked-worktree gitdir file");
  const match = /^gitdir: (.+)$/.exec(declaration);
  if (!match) throw new Error("Linked-worktree .git must contain one gitdir declaration");
  return {
    checkoutRoot,
    gitDirectory: requireRealDirectory(
      resolve(checkoutRoot, match[1]),
      "Linked-worktree Git directory",
    ),
    primary: false,
  };
}

function resolveNamedBranch(gitDirectory: string): string {
  const head = metadataLine(resolve(gitDirectory, "HEAD"), "Git HEAD");
  const prefix = "ref: refs/heads/";
  if (!head.startsWith(prefix)) {
    throw new Error("Workspace launch requires a named branch; detached HEAD is not supported");
  }
  const branch = head.slice(prefix.length);
  const components = branch.split("/");
  const forbidden = /[\u0000-\u0020\u007f~^:?*\[\\]/;
  if (
    branch.length === 0
    || branch === "@"
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("//")
    || branch.includes("..")
    || branch.includes("@{")
    || forbidden.test(branch)
    || components.some(
      (component) =>
        component.length === 0
        || component.startsWith(".")
        || component.endsWith(".lock"),
    )
  ) {
    throw new Error("Git HEAD contains an unsafe branch name");
  }
  return branch;
}

function resolveDataRoot(environment: LaunchEnvironment): string {
  const configured = environment.JOBHUNTER_DATA_HOME;
  if (configured && isAbsolute(configured)) return requireNonRootPath(configured);

  const xdgDataHome = environment.XDG_DATA_HOME;
  if (xdgDataHome && isAbsolute(xdgDataHome)) {
    return requireNonRootPath(resolve(xdgDataHome, "jobhunter"));
  }

  const home = environment.HOME ?? homedir();
  if (!isAbsolute(home)) throw new Error("Home directory must be absolute");
  return requireNonRootPath(resolve(home, ".local", "share", "jobhunter"));
}

function requireNonRootPath(path: string): string {
  const absolutePath = resolve(path);
  if (absolutePath === parse(absolutePath).root) {
    throw new Error("Jobhunter data root must not be the filesystem root");
  }
  return absolutePath;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

export function resolveLaunchConfiguration(
  mode: "dev" | "start",
  appsRoot: string,
  environment: LaunchEnvironment = process.env,
): LaunchConfiguration {
  const layout = resolveCheckoutLayout(appsRoot);
  if (mode === "start" && !layout.primary) {
    throw new Error("Stable start is allowed only from the primary Git checkout");
  }
  const branch = resolveNamedBranch(layout.gitDirectory);
  if (mode === "start" && branch !== "main") {
    throw new Error("Stable start is allowed only from the main branch");
  }
  const development = mode === "dev";
  const dataRoot = resolveDataRoot(environment);
  const storageRoot = development
    ? resolve(dataRoot, "development", encodeURIComponent(branch))
    : resolve(dataRoot, "production");
  if (isContained(layout.checkoutRoot, storageRoot)) {
    throw new Error("Runtime storage must be outside the Git checkout");
  }

  const pipelinePort = development ? 3557 : 3457;
  const webPort = development ? 3556 : 3456;
  const resolvedAppsRoot = resolve(appsRoot);
  const checkoutStatus = lstatSync(layout.checkoutRoot);
  const gitStatus = lstatSync(layout.gitDirectory);
  return {
    pipelinePort,
    webPort,
    pipelineOrigin: `http://127.0.0.1:${pipelinePort}`,
    webOrigin: `http://127.0.0.1:${webPort}`,
    harnessOrigin: `http://127.0.0.1:${development ? 8865 : 8765}`,
    pipelineDatabase: resolve(storageRoot, "pipeline.sqlite"),
    contextDatabase: resolve(storageRoot, "context.sqlite"),
    authDatabase: resolve(storageRoot, "auth.sqlite"),
    artifactRoot: resolve(storageRoot, "runs"),
    priorPipelineDatabase: resolve(
      resolvedAppsRoot,
      `resume-tailoring/data/state/pipeline${development ? ".dev" : ""}.sqlite`,
    ),
    priorContextDatabase: resolve(
      resolvedAppsRoot,
      `resume-tailoring/data/context/context${development ? ".dev" : ""}.sqlite`,
    ),
    priorAuthDatabase: resolve(
      resolvedAppsRoot,
      `resume-tailoring/data/oauth/auth${development ? ".dev" : ""}.sqlite`,
    ),
    priorArtifactRoot: resolve(
      resolvedAppsRoot,
      development ? "../output/dev-runs" : "../output/runs",
    ),
    ...(development
      ? {}
      : {
          productionCheckout: {
            checkoutRoot: layout.checkoutRoot,
            gitDirectory: layout.gitDirectory,
            checkoutDevice: checkoutStatus.dev,
            checkoutInode: checkoutStatus.ino,
            gitDevice: gitStatus.dev,
            gitInode: gitStatus.ino,
          },
        }),
  };
}
