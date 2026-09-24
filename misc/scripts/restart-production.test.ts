import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartProduction } from "./restart-production.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function checkout(branch = "main") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jobhunt-restart-")));
  roots.push(root);
  const appsRoot = join(root, "apps");
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git/HEAD"), `ref: refs/heads/${branch}\n`);
  await mkdir(join(appsRoot, "web/.next"), { recursive: true });
  await writeFile(join(appsRoot, "web/.next/BUILD_ID"), "previous-build");
  return { root, appsRoot };
}

test("refuses a non-main checkout before changing the existing build", async () => {
  const { appsRoot } = await checkout("feature/example");
  await expect(restartProduction(appsRoot)).rejects.toThrow();
  expect(await readFile(join(appsRoot, "web/.next/BUILD_ID"), "utf8")).toBe("previous-build");
});

test("refuses a managed development command before stopping services or clearing builds", async () => {
  const { root, appsRoot } = await checkout();
  const bin = join(root, "bin");
  await mkdir(bin);
  const spec = { application: "bun", args: ["run", "dev"], cwd: appsRoot };
  await writeFile(join(bin, "omp"), `#!/bin/sh
if [ "$2" = info ]; then
  printf '%s\n' '${JSON.stringify({ name: "jobhunt-prod", state: "ready", spec })}'
else
  touch "${root}/stopped"
fi
`);
  await chmod(join(bin, "omp"), 0o700);
  await expect(restartProduction(appsRoot, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })).rejects.toThrow();
  expect(await Bun.file(join(root, "stopped")).exists()).toBe(false);
  expect(await readFile(join(appsRoot, "web/.next/BUILD_ID"), "utf8")).toBe("previous-build");
});

test("restores usable previous output when a build succeeds without a build ID", async () => {
  const { root, appsRoot } = await checkout();
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(appsRoot, "harness/dist"), { recursive: true });
  await writeFile(join(appsRoot, "harness/dist/index.js"), "previous-harness");
  await mkdir(join(appsRoot, "backend/dist/src"), { recursive: true });
  await writeFile(join(appsRoot, "backend/dist/src/index.js"), "previous-pipeline");
  await mkdir(join(appsRoot, "web/.next/cache"));
  await writeFile(join(appsRoot, "web/.next/cache/compiler-cache"), "reusable");
  const specs = {
    "jobhunt-prod": { application: "bun", args: ["run", "start"], cwd: appsRoot },
    "jobhunt-harness-prod-bun": { application: "bun", args: ["run", "start", "--", "--port", "8765", "--pipeline-url", "http://127.0.0.1:3457"], cwd: join(appsRoot, "harness") },
  };
  await writeFile(join(root, "manager.ts"), `
    import { appendFileSync } from "node:fs";
    const [, , , action, name] = process.argv;
    if (action !== "info") appendFileSync(${JSON.stringify(join(root, "events"))}, action);
    console.log(JSON.stringify({ name, state: action === "stop" ? "exited" : "ready", spec: ${JSON.stringify(specs)}[name] }));
  `);
  await writeFile(join(bin, "omp"), `#!/bin/sh
exec "${process.execPath}" "${join(root, "manager.ts")}" "$@"
`);
  await writeFile(join(bin, "uv"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(bin, "bun"), `#!/bin/sh
if [ "$1" = run ] && [ "$2" = build ] && [ "$PWD" = "${join(appsRoot, "backend")}" ]; then
  mkdir -p dist/src
  printf partial > dist/src/index.js
fi
`);
  for (const name of ["omp", "bun", "uv"]) await chmod(join(bin, name), 0o700);
  await expect(restartProduction(appsRoot, {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log: () => {},
  })).rejects.toThrow();
  expect(await readFile(join(appsRoot, "web/.next/BUILD_ID"), "utf8")).toBe("previous-build");
  expect(await readFile(join(appsRoot, "backend/dist/src/index.js"), "utf8")).toBe("previous-pipeline");
  expect(await readFile(join(appsRoot, "harness/dist/index.js"), "utf8")).toBe("previous-harness");
  expect((await readFile(join(root, "events"), "utf8")).includes("restart")).toBe(false);
  expect(await Bun.file(join(root, ".git/jobhunt-prod-restart.lock")).exists()).toBe(false);
});

test("refuses a development harness registration before stopping production", async () => {
  const { root, appsRoot } = await checkout();
  const bin = join(root, "bin");
  await mkdir(bin);
  const specs = {
    "jobhunt-prod": { application: "bun", args: ["run", "start"], cwd: appsRoot },
    "jobhunt-harness-prod-bun": { application: join(appsRoot, "harness/.venv/bin/jobhunt-browser-harness"), args: ["--port=8865", "--pipeline-url=http://127.0.0.1:3557"], cwd: root },
  };
  await mkdir(join(appsRoot, "backend"));
  await writeFile(join(root, "manager.ts"), `
    import { writeFileSync } from "node:fs";
    const [, , , action, name] = process.argv;
    if (action !== "info") writeFileSync(${JSON.stringify(join(root, "stopped"))}, "yes");
    console.log(JSON.stringify({ name, state: "exited", spec: ${JSON.stringify(specs)}[name] }));
  `);
  await writeFile(join(bin, "omp"), `#!/bin/sh
exec "${process.execPath}" "${join(root, "manager.ts")}" "$@"
`);
  await chmod(join(bin, "omp"), 0o700);
  await expect(restartProduction(appsRoot, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log: () => {} })).rejects.toThrow();
  expect(await Bun.file(join(root, "stopped")).exists()).toBe(false);
});

test("refuses the legacy Python harness registration before stopping production", async () => {
  const { root, appsRoot } = await checkout();
  const bin = join(root, "bin");
  await mkdir(bin);
  const specs = {
    "jobhunt-prod": { application: "bun", args: ["run", "start"], cwd: appsRoot },
    "jobhunt-harness-prod-bun": { application: join(appsRoot, "harness/.venv/bin/jobhunt-browser-harness"), args: ["--port", "8765", "--pipeline-url", "http://127.0.0.1:3457"], cwd: root },
  };
  await writeFile(join(root, "manager.ts"), [
    'import { writeFileSync } from "node:fs";',
    'const [, , , action, name] = process.argv;',
    'if (action !== "info") writeFileSync(' + JSON.stringify(join(root, "stopped")) + ', "yes");',
    'console.log(JSON.stringify({ name, state: "ready", spec: ' + JSON.stringify(specs) + '[name] }));',
  ].join("\n"));
  await writeFile(join(bin, "omp"), ["#!/bin/sh", 'exec "' + process.execPath + '" "' + join(root, "manager.ts") + '" "$@"', ""].join("\n"));
  await writeFile(join(bin, "bun"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(bin, "uv"), "#!/bin/sh\nexit 0\n");
  for (const name of ["omp", "bun", "uv"]) await chmod(join(bin, name), 0o700);

  await expect(restartProduction(appsRoot, {
    env: { ...process.env, PATH: bin + ":" + process.env.PATH }, log: () => {},
  })).rejects.toThrow("not registered");
  expect(await Bun.file(join(root, "stopped")).exists()).toBe(false);
});

test("cancellation terminates build descendants before restoring previous output", async () => {
  const { root, appsRoot } = await checkout();
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(appsRoot, "harness/dist"), { recursive: true });
  await writeFile(join(appsRoot, "harness/dist/index.js"), "previous-harness");
  await mkdir(join(appsRoot, "backend"));
  const specs = {
    "jobhunt-prod": { application: "bun", args: ["run", "start"], cwd: appsRoot },
    "jobhunt-harness-prod-bun": { application: "bun", args: ["run", "start", "--", "--port", "8765", "--pipeline-url", "http://127.0.0.1:3457"], cwd: join(appsRoot, "harness") },
  };
  await writeFile(join(root, "manager.ts"), [
    'const [, , , action, name] = process.argv;',
    'console.log(JSON.stringify({ name, state: action === "stop" ? "exited" : "ready", spec: ' + JSON.stringify(specs) + '[name] }));',
  ].join(String.fromCharCode(10)));
  const pidPath = join(root, "descendant.pid");
  await writeFile(join(root, "descendant.ts"), [
    'import { writeFileSync } from "node:fs";',
    'process.on("SIGTERM", () => {});',
    'writeFileSync(' + JSON.stringify(pidPath) + ', String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join(String.fromCharCode(10)));
  await writeFile(join(root, "build.ts"), [
    'import { spawn } from "node:child_process";',
    'process.on("SIGTERM", () => process.exit(0));',
    'spawn(process.execPath, [' + JSON.stringify(join(root, "descendant.ts")) + '], { stdio: "inherit" });',
    'setInterval(() => {}, 1000);',
  ].join(String.fromCharCode(10)));
  await writeFile(join(bin, "omp"), ["#!/bin/sh", 'exec "' + process.execPath + '" "' + join(root, "manager.ts") + '" "$@"', ""].join(String.fromCharCode(10)));
  await writeFile(join(bin, "uv"), ["#!/bin/sh", "exit 0", ""].join(String.fromCharCode(10)));
  await writeFile(join(bin, "bun"), ["#!/bin/sh", 'if [ "$1" = run ]; then', 'exec "' + process.execPath + '" "' + join(root, "build.ts") + '"', "fi", ""].join(String.fromCharCode(10)));
  for (const name of ["omp", "bun", "uv"]) await chmod(join(bin, name), 0o700);
  const controller = new AbortController();
  const restarting = restartProduction(appsRoot, {
    env: { ...process.env, PATH: bin + ":" + process.env.PATH }, signal: controller.signal, log: () => {},
  }).then(() => null, (error: unknown) => error);
  let pid: number | undefined;
  try {
    const deadline = Date.now() + 5_000;
    while (!(await Bun.file(pidPath).exists())) {
      if (Date.now() >= deadline) throw new Error("Build descendant did not start");
      await Bun.sleep(10);
    }
    pid = Number(await readFile(pidPath, "utf8"));
    controller.abort();
    expect(await restarting).toBeInstanceOf(Error);
    expect(await readFile(join(appsRoot, "web/.next/BUILD_ID"), "utf8")).toBe("previous-build");
    expect(await readFile(join(appsRoot, "harness/dist/index.js"), "utf8")).toBe("previous-harness");
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    controller.abort();
    await restarting;
    if (pid !== undefined) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}, 10_000);


test("ordinary restarts retain the build cache while clean restarts discard it", async () => {
  const { root, appsRoot } = await checkout();
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(appsRoot, "harness/dist"), { recursive: true });
  await writeFile(join(appsRoot, "harness/dist/index.js"), "previous-harness");
  await mkdir(join(appsRoot, "backend"));
  await mkdir(join(appsRoot, "web/.next/cache"));
  await writeFile(join(appsRoot, "web/.next/cache/compiler-cache"), "reusable");
  await mkdir(join(appsRoot, "node_modules"));
  await writeFile(join(appsRoot, "node_modules/shared-install-marker"), "obsolete");
  const specs = {
    "jobhunt-prod": { application: "bun", args: ["run", "start"], cwd: appsRoot },
    "jobhunt-harness-prod-bun": { application: "bun", args: ["run", "start", "--", "--port", "8765", "--pipeline-url", "http://127.0.0.1:3457"], cwd: join(appsRoot, "harness") },
  };
  await writeFile(join(root, "manager.ts"), [
    'const [, , , action, name] = process.argv;',
    'console.log(JSON.stringify({ name, state: action === "stop" ? "exited" : "ready", spec: ' + JSON.stringify(specs) + '[name] }));',
  ].join("\n"));
  await writeFile(join(root, "build.ts"), [
    'import { mkdir, readFile, writeFile } from "node:fs/promises";',
    'const cached = await Bun.file(' + JSON.stringify(join(appsRoot, "web/.next/cache/compiler-cache")) + ').exists();',
    'await mkdir(' + JSON.stringify(join(appsRoot, "web/.next")) + ', { recursive: true });',
    'await writeFile(' + JSON.stringify(join(appsRoot, "web/.next/BUILD_ID")) + ', "updated-build");',
    'if (process.cwd() === ' + JSON.stringify(join(appsRoot, "harness")) + ') {',
    '  await mkdir(' + JSON.stringify(join(appsRoot, "harness/dist")) + ', { recursive: true });',
    '  await writeFile(' + JSON.stringify(join(appsRoot, "harness/dist/index.js")) + ', "updated-harness");',
    '}',
    'await writeFile(' + JSON.stringify(join(appsRoot, "cache-observed")) + ', cached ? "reused" : "cold");',
  ].join("\n"));
  await writeFile(join(bin, "omp"), ["#!/bin/sh", 'exec "' + process.execPath + '" "' + join(root, "manager.ts") + '" "$@"', ""].join("\n"));
  await writeFile(join(bin, "bun"), [
    "#!/bin/sh",
    'printf \'bun|%s|%s\\n\' "$PWD" "$*" >> "' + join(root, "commands") + '"',
    'if [ "$1" = run ]; then',
    'exec "' + process.execPath + '" "' + join(root, "build.ts") + '"',
    "fi",
    "",
  ].join("\n"));
  for (const name of ["omp", "bun"]) await chmod(join(bin, name), 0o700);
  const options = {
    env: { ...process.env, PATH: bin + ":" + process.env.PATH }, log: () => {},
    fetch: Object.assign(async (url: string | URL | Request) => String(url).endsWith("/")
      ? new Response(await readFile(join(appsRoot, "web/.next/BUILD_ID")))
      : Response.json({ status: "ok" }), { preconnect: fetch.preconnect }),
  };
  await restartProduction(appsRoot, options);
  expect((await readFile(join(root, "commands"), "utf8")).trim().split("\n")).toEqual([
    `bun|${join(appsRoot, "backend")}|install --frozen-lockfile`,
    `bun|${join(appsRoot, "web")}|install --frozen-lockfile`,
    `bun|${join(appsRoot, "harness")}|install --frozen-lockfile`,
    `bun|${join(appsRoot, "backend")}|run build`,
    `bun|${join(appsRoot, "harness")}|run build`,
    `bun|${join(appsRoot, "web")}|run build`,
  ]);
  expect(await Bun.file(join(appsRoot, "node_modules")).exists()).toBe(false);
  expect(await readFile(join(appsRoot, "cache-observed"), "utf8")).toBe("reused");
  expect(await readFile(join(appsRoot, "web/.next/BUILD_ID"), "utf8")).toBe("updated-build");
  await restartProduction(appsRoot, { ...options, clean: true });
  expect(await readFile(join(appsRoot, "cache-observed"), "utf8")).toBe("cold");
});

