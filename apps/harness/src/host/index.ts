import type { Server } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  cleanupOrphanedSessionArtifacts,
  cleanupSessionArtifacts,
  createSessionArtifactDirectory,
} from "./artifacts.ts";
import { createApplicationSessionWorkerFactory } from "../application/application-session-worker.ts";
import { parseHarnessConfig } from "./config.ts";
import { GmailOAuthManager, GmailVerificationInbox } from "./gmail.ts";
import { ModelAuthStore } from "../auth/model-auth.ts";
import {
  PlaywrightCliBrowser,
  PlaywrightCliRuntime,
  recoverStalePlaywrightCliSessions,
} from "./playwright-cli.ts";
import { createHarnessHandler, startHarnessServer } from "./server.ts";
import { ApplicationSessionManager } from "./sessions.ts";
import { SourceCaptureManager, type SourceCaptureRuntime } from "./source-capture.ts";
import { UserInfoStore } from "../application/user-info.ts";

async function prepareBrowser(
  artifactsRoot: string,
  browser: PlaywrightCliBrowser,
  nodeExecutable: string,
  cliScript: string,
): Promise<void> {
  const staleTargets = await recoverStalePlaywrightCliSessions({
    artifactsRoot,
    nodeExecutable,
    cliScript,
  });
  let started = false;
  try {
    await browser.start();
    started = true;
    for (const targetId of staleTargets) await browser.closeTarget(targetId);
    let delay = 50;
    while (!(await cleanupOrphanedSessionArtifacts(artifactsRoot))) {
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 1_000);
    }
  } catch (error) {
    if (started) await browser.close().catch(() => undefined);
    throw error;
  }
}

async function sourceRuntime(
  captureId: string,
  artifactsRoot: string,
  browser: PlaywrightCliBrowser,
  nodeExecutable: string,
  cliScript: string,
): Promise<SourceCaptureRuntime> {
  const sessionDirectory = await createSessionArtifactDirectory(artifactsRoot, captureId);
  const runtime = new PlaywrightCliRuntime({
    sessionId: captureId,
    browser,
    sessionDirectory,
    nodeExecutable,
    cliScript,
  });
  let runtimeClosed = false;
  let artifactsRemoved = false;
  return {
    start: (jobUrl) => runtime.start(jobUrl),
    openBrowser: () => runtime.openBrowser(),
    captureSourceSnapshot: () => runtime.captureSourceSnapshot(),
    async close() {
      if (!runtimeClosed) {
        await runtime.close();
        runtimeClosed = true;
      }
      if (artifactsRemoved) return;
      let delay = 50;
      while (!(await cleanupSessionArtifacts(sessionDirectory))) {
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 1_000);
      }
      artifactsRemoved = true;
    },
  };
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const { config, browserLaunch } = await parseHarnessConfig(argv);
  const artifactsRoot = join(homedir(), ".jobhunt", "browser-harness", "sessions");
  const origin = `http://127.0.0.1:${config.port}`;
  const browser = new PlaywrightCliBrowser({ artifactsRoot, launch: browserLaunch });

  await prepareBrowser(
    artifactsRoot,
    browser,
    config.nodeExecutable,
    config.playwrightCliScript,
  );

  let server: Server<undefined> | undefined;
  let sessions: ApplicationSessionManager | undefined;
  let sourceCaptures: SourceCaptureManager | undefined;
  let gmailAuth: GmailOAuthManager | undefined;
  let modelAuth: ModelAuthStore | undefined;
  let shutdownPromise: Promise<void> | undefined;

  try {
    const userInfoStore = await UserInfoStore.open(config.userInfoJson);
    modelAuth = await ModelAuthStore.open(config.modelAuthDatabase);
    gmailAuth = new GmailOAuthManager({
      clientJson: config.gmailOauthClientJson,
      tokenJson: config.gmailTokenJson,
      redirectUri: `${origin}/oauth/gmail/callback`,
    });
    const gmailInbox = new GmailVerificationInbox({ tokenJson: config.gmailTokenJson });

    sessions = new ApplicationSessionManager({
      origin,
      workerFactory: createApplicationSessionWorkerFactory({
        artifactsRoot,
        browser,
        nodeExecutable: config.nodeExecutable,
        cliScript: config.playwrightCliScript,
        pipelineUrl: config.pipelineUrl,
        bearerToken: config.bearerToken,
        runtimeOrigin: origin,
        userInfoStore,
        gmailInbox,
        applicationModelReader: () => modelAuth!.readApplicationModel(),
      }),
      exclusiveOwner: () => sourceCaptures?.activeCaptureId ?? null,
    });
    sourceCaptures = new SourceCaptureManager({
      applicationActive: () => sessions?.hasActiveSessions() ?? false,
      runtimeFactory: (captureId) => sourceRuntime(
        captureId,
        artifactsRoot,
        browser,
        config.nodeExecutable,
        config.playwrightCliScript,
      ),
    });

    const handler = createHarnessHandler(
      { bearerToken: config.bearerToken },
      { gmailAuth, modelAuth, sourceCaptures, sessions },
    );
    server = startHarnessServer(config.port, handler);

    const shutdown = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        server?.stop(false);
        await Promise.allSettled([
          sourceCaptures?.shutdown(),
          sessions?.shutdown(),
          gmailAuth?.shutdown(),
          modelAuth?.close(),
        ]);
        await browser.close().catch(() => undefined);
        server?.stop(true);
      })();
      return shutdownPromise;
    };
    process.once("SIGINT", () => { void shutdown(); });
    process.once("SIGTERM", () => { void shutdown(); });
  } catch (error) {
    await Promise.allSettled([
      sourceCaptures?.shutdown(),
      sessions?.shutdown(),
      gmailAuth?.shutdown(),
      modelAuth?.close(),
    ]);
    await browser.close().catch(() => undefined);
    server?.stop(true);
    throw error;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Browser harness startup failed");
    process.exitCode = 1;
  }
}
