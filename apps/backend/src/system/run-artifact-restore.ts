import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  PipelineRepository,
  PrunedRunArtifact,
  PrunedRunArtifactManifest,
} from "../db/repository.ts";
import {
  publishPrivateRunOutputBackup,
  type RunOutputBackupLimits,
} from "./run-output-migration.ts";

const MAX_FAILURE_DETAILS = 100;
const MAX_FAILURE_MESSAGE_LENGTH = 512;
const MAX_FAILURE_RUN_ID_LENGTH = 128;

export interface RunArtifactRestoreFailure {
  readonly runId: string;
  readonly queueSequence: number;
  readonly message: string;
}

export interface RunArtifactRestoreSummary {
  readonly markers: number;
  readonly restored: number;
  readonly published: number;
  readonly reused: number;
  readonly unrecovered: number;
  readonly failures: readonly RunArtifactRestoreFailure[];
  readonly omittedFailures: number;
}

export interface RunArtifactRestoreOptions {
  readonly artifactRoot: string;
  readonly priorArtifactRoot: string;
  readonly limits?: Partial<RunOutputBackupLimits>;
}

type ArtifactRestoreRepository = Pick<
  PipelineRepository,
  "listPrunedRunArtifactManifests" | "clearPrunedRunArtifactMarker"
>;

function contained(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === ""
    || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function verifyArtifactFile(
  path: string,
  artifact: PrunedRunArtifact,
  buffer: Buffer,
  label: string,
): void {
  if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 0) {
    throw new Error(`${label} has an invalid persisted byte size`);
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`${label} has an invalid persisted SHA-256`);
  }

  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      typeof process.geteuid !== "function"
      || opened.uid !== process.geteuid()
      || (opened.mode & 0o077) !== 0
    ) {
      throw new Error(`${label} must be owner-private`);
    }
    if (!opened.isFile()) throw new Error(`${label} must be a regular file`);
    if (opened.size !== artifact.byteSize) {
      throw new Error(`${label} byte size does not match its persisted manifest`);
    }
    const digest = createHash("sha256");
    let bytesRead = 0;
    while (bytesRead < opened.size) {
      const chunkSize = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, opened.size - bytesRead),
        null,
      );
      if (chunkSize === 0) break;
      digest.update(buffer.subarray(0, chunkSize));
      bytesRead += chunkSize;
    }
    const completed = fstatSync(descriptor);
    if (bytesRead !== opened.size || !sameFileVersion(opened, completed)) {
      throw new Error(`${label} changed while it was verified`);
    }
    if (digest.digest("hex") !== artifact.sha256) {
      throw new Error(`${label} SHA-256 does not match its persisted manifest`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function artifactRelativePath(
  artifact: PrunedRunArtifact,
  destinationRunRoot: string,
): string {
  if (!isAbsolute(artifact.path) || resolve(artifact.path) !== artifact.path) {
    throw new Error(`artifact ${artifact.id} path must be absolute and canonical`);
  }
  if (!contained(destinationRunRoot, artifact.path) || artifact.path === destinationRunRoot) {
    throw new Error(`artifact ${artifact.id} path is outside its numeric run destination`);
  }
  return relative(destinationRunRoot, artifact.path);
}

function verifyManifestAtRoot(
  manifest: PrunedRunArtifactManifest,
  root: string,
  destinationRunRoot: string,
  buffer: Buffer,
  label: string,
): void {
  if (manifest.artifacts.length === 0) {
    throw new Error(`run ${manifest.runId} has no persisted artifact manifest`);
  }
  for (const artifact of manifest.artifacts) {
    const suffix = artifactRelativePath(artifact, destinationRunRoot);
    const candidate = resolve(root, suffix);
    if (!contained(root, candidate) || candidate === root) {
      throw new Error(`artifact ${artifact.id} path escapes its run tree`);
    }
    verifyArtifactFile(candidate, artifact, buffer, `run ${manifest.runId} ${label} artifact ${artifact.id}`);
  }
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function validateOptions(options: RunArtifactRestoreOptions): void {
  for (const [label, path] of [
    ["artifact root", options.artifactRoot],
    ["prior artifact root", options.priorArtifactRoot],
  ] as const) {
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new Error(`${label} must be an absolute canonical path`);
    }
  }
}

export function restorePrunedRunArtifacts(
  repository: ArtifactRestoreRepository,
  options: RunArtifactRestoreOptions,
): RunArtifactRestoreSummary {
  validateOptions(options);
  const manifests = repository.listPrunedRunArtifactManifests();
  const failures: RunArtifactRestoreFailure[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let restored = 0;
  let published = 0;
  let reused = 0;
  let omittedFailures = 0;

  for (const manifest of manifests) {
    try {
      if (!Number.isSafeInteger(manifest.queueSequence) || manifest.queueSequence < 1) {
        throw new Error(`run ${manifest.runId} has an invalid queue sequence`);
      }
      const destination = join(options.artifactRoot, String(manifest.queueSequence));
      const backup = join(
        options.priorArtifactRoot,
        `.${manifest.queueSequence}.jobhunt-migrated`,
      );
      const relativeFiles = [...new Set(
        manifest.artifacts.map((artifact) => artifactRelativePath(artifact, destination)),
      )];
      const publication = publishPrivateRunOutputBackup({
        source: backup,
        outputRoot: options.artifactRoot,
        runId: manifest.runId,
        queueSequence: manifest.queueSequence,
        relativeFiles,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        verifyTree: (candidateRunRoot, destinationRunRoot) => {
          if (destinationRunRoot !== destination) {
            throw new Error(`run ${manifest.runId} destination changed during recovery`);
          }
          verifyManifestAtRoot(
            manifest,
            candidateRunRoot,
            destinationRunRoot,
            buffer,
            "candidate",
          );
        },
      });
      if (publication.destination !== destination) {
        throw new Error(`run ${manifest.runId} destination changed during publication`);
      }
      verifyManifestAtRoot(
        manifest,
        publication.destination,
        publication.destination,
        buffer,
        "restored",
      );
      repository.clearPrunedRunArtifactMarker(manifest.runId, manifest.queueSequence);
      restored++;
      if (publication.moved) published++;
      else reused++;
    } catch (error) {
      if (failures.length < MAX_FAILURE_DETAILS) {
        failures.push({
          runId: manifest.runId.slice(0, MAX_FAILURE_RUN_ID_LENGTH),
          queueSequence: manifest.queueSequence,
          message: failureMessage(error),
        });
      } else {
        omittedFailures++;
      }
    }
  }

  const unrecovered = repository.listPrunedRunArtifactManifests().length;
  return {
    markers: manifests.length,
    restored,
    published,
    reused,
    unrecovered,
    failures,
    omittedFailures,
  };
}
