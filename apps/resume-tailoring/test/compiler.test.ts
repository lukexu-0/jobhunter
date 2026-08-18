import { describe, expect, test } from "bun:test";
import { fstatSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_LIMITS, ArtifactStore } from "../src/system/artifacts.ts";
import { runTrustedProcess, sanitizedEnvironment, type ProcessBoundary, type RunningProcess, type SpawnContract } from "../src/system/process.ts";
import { COMPILE_TIMEOUTS, compileResume } from "../src/resume/compiler.ts";

async function root(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "pipeline-compiler-")));
}

function chunks(...values: string[]): AsyncIterable<Uint8Array> {
  return (async function* () { for (const value of values) yield Buffer.from(value); })();
}

function exited(pid = 101, stdout = "", stderr = "", code = 0): RunningProcess {
  return { pid, stdout: chunks(stdout), stderr: chunks(stderr), wait: async () => ({ code, signal: null }), kill: async () => undefined };
}

const address = { run: 1, revision: "revision-1", stage: "compile", attempt: 1 } as const;
const safeTex = "\\documentclass{article}\n\\begin{document}Hello\\end{document}\n";

const testWithLinuxTexCache = test.skipIf(process.platform !== "linux");

async function storeWithAttempt(): Promise<{ store: ArtifactStore; attempt: string }> {
  const store = new ArtifactStore(await root());
  const attempt = await store.createAttempt(address);
  return { store, attempt };
}

describe("immutable artifacts", () => {
  test("contains run/revision/attempt paths and rejects traversal components", async () => {
    const store = new ArtifactStore(await root());
    expect(store.attemptRoot(address)).toEndWith("1/revisions/revision-1/attempts/compile-1");
    expect(() => store.attemptRoot({ ...address, run: 0 })).toThrow(/invalid run/i);
    expect(() => store.attemptRoot({ ...address, revision: "/tmp/escape" })).toThrow(/invalid revision/i);
    const attempt = await store.createAttempt(address);
    expect((await lstat(store.root)).mode & 0o777).toBe(0o700);
    expect((await lstat(attempt)).mode & 0o777).toBe(0o700);
    await expect(store.write(join(store.root, "..", "escape"), "x", 1)).rejects.toThrow(/escapes/i);
  });

  test("rejects symlinks and never overwrites an immutable artifact", async () => {
    const { store, attempt } = await storeWithAttempt();
    const outside = await root();
    await symlink(outside, join(attempt, "linked"));
    await expect(store.write(join(attempt, "linked", "bad.txt"), "bad", 10)).rejects.toThrow(/symlink/i);
    const first = await store.write(join(attempt, "main.tex"), "first", 10);
    expect(first).toMatchObject({ bytes: 5, sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e" });
    await expect(store.write(join(attempt, "main.tex"), "second", 10)).rejects.toThrow(/already exists/i);
    expect(Buffer.from(await store.read(first.path, 10)).toString()).toBe("first");
  });

  test("enforces byte caps on writes and reads", async () => {
    const { store, attempt } = await storeWithAttempt();
    await expect(store.write(join(attempt, "large.bin"), "1234", 3)).rejects.toThrow(/byte limit/i);
    await writeFile(join(attempt, "external.bin"), "1234");
    await chmod(join(attempt, "external.bin"), 0o600);
    await expect(store.read(join(attempt, "external.bin"), 3)).rejects.toThrow(/byte limit/i);
  });
});

describe("trusted processes", () => {
  test("spawns an allowlisted binary with array args, no shell, and an exact sanitized environment", async () => {
    let seen: SpawnContract | undefined;
    const boundary: ProcessBoundary = (contract) => { seen = contract; return exited(); };
    const cwd = await root();
    const result = await runTrustedProcess({ command: "pdfinfo", args: ["literal;not-shell"], cwd, timeoutMs: 1000 }, boundary);
    expect(seen).toEqual({ command: "pdfinfo", args: ["literal;not-shell"], cwd, shell: false, env: sanitizedEnvironment() });
    expect(result).toMatchObject({ code: 0, timedOut: false, aborted: false, killAcknowledged: false, pid: 101 });
    await expect(runTrustedProcess({ command: "bash" as "pdfinfo", args: [], cwd, timeoutMs: 1000 }, boundary)).rejects.toThrow(/not trusted/i);
  });

  test("caps captured output while draining both streams", async () => {
    let drained = 0;
    const stream = async function* () { yield Buffer.from("1234"); drained++; yield Buffer.from("5678"); drained++; };
    const boundary: ProcessBoundary = () => ({ pid: 102, stdout: stream(), stderr: stream(), wait: async () => ({ code: 0, signal: null }), kill: async () => undefined });
    const result = await runTrustedProcess({ command: "pdftotext", args: [], cwd: await root(), timeoutMs: 1000, stdoutLimit: 5, stderrLimit: 3 }, boundary);
    expect(Buffer.from(result.stdout.data).toString()).toBe("12345");
    expect(result.stdout).toMatchObject({ bytes: 8, truncated: true });
    expect(Buffer.from(result.stderr.data).toString()).toBe("123");
    expect(result.stderr).toMatchObject({ bytes: 8, truncated: true });
    expect(drained).toBe(4);
  });

  test("kills and awaits acknowledgement on timeout and AbortSignal", async () => {
    for (const kind of ["timeout", "abort"] as const) {
      const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
      let killed = false;
      let waits = 0;
      const boundary: ProcessBoundary = () => ({
        pid: 103,
        stdout: chunks(),
        stderr: chunks(),
        wait: () => { waits++; return exit.promise; },
        kill: async (signal) => { expect(signal).toBe("SIGKILL"); killed = true; exit.resolve({ code: null, signal }); },
      });
      const controller = new AbortController();
      const pending = runTrustedProcess({ command: "pdfinfo", args: [], cwd: await root(), timeoutMs: kind === "timeout" ? 1 : 10_000, signal: controller.signal }, boundary);
      if (kind === "abort") controller.abort();
      const result = await pending;
      expect(result[kind === "timeout" ? "timedOut" : "aborted"]).toBeTrue();
      expect(result.killAcknowledged).toBeTrue();
      expect(killed).toBeTrue();
      expect(waits).toBe(1);
    }
  });
});

describe("trusted resume compiler", () => {
  testWithLinuxTexCache("allows the canonical glyph mapping input to reach the compiler boundary", async () => {
    const canonical = await readFile(new URL("../../user-info/resume-main/Alex_Example_Resume.tex", import.meta.url), "utf8");
    let spawned = false;
    const artifacts = new ArtifactStore(await root());
    const result = await compileResume({
      artifacts,
      address,
      tex: canonical,
      mode: "full",
      processBoundary: (contract) => {
        spawned = true;
        writeFileSync(join(contract.cwd, "compile.pdf"), "%PDF-1.4\n%%EOF");
        return exited();
      },
    });
    expect(result.ok).toBeTrue();
    expect(spawned).toBeTrue();
  });

  test("rejects noncanonical glyph mapping inputs before spawning", async () => {
    const canonical = await readFile(new URL("../../user-info/resume-main/Alex_Example_Resume.tex", import.meta.url), "utf8");
    const trustedInput = "\\input{glyphtounicode}";
    const trustedAnchor = `\\usepackage[english]{babel}\n${trustedInput}\n\n\\pagestyle{fancy}`;
    const noncanonicalInputs = [
      canonical.replace(trustedInput, "\\input{other}"),
      canonical.replace(trustedInput, "\\input {glyphtounicode}"),
      canonical.replace(trustedInput, "\\input glyphtounicode"),
      canonical.replace(trustedInput, "\\input{./glyphtounicode}"),
      canonical.replace(trustedInput, "\\input{glyphtounicode.tex}"),
      canonical.replace(trustedInput, "\\input{glyphtounicode }"),
      canonical.replace(trustedInput, "\\INPUT{glyphtounicode}"),
      canonical.replace(trustedInput, `${trustedInput}\n${trustedInput}`),
      canonical.replace(trustedAnchor, `${trustedAnchor}\n${trustedAnchor}`),
      canonical.replace(trustedAnchor, "").replace("\\begin{document}", `\\begin{document}\n${trustedAnchor}`),
      canonical.replace(trustedInput, "\\input{../glyphtounicode}"),
      canonical.replace(trustedInput, "\\input{/etc/passwd}"),
      canonical.replace(`${trustedInput}\n`, "").replace("\\begin{document}", `\\begin{document}\n${trustedInput}`),
    ];
    for (const tex of noncanonicalInputs) {
      let spawned = false;
      const artifacts = new ArtifactStore(await root());
      const result = await compileResume({
        artifacts,
        address,
        tex,
        mode: "full",
        processBoundary: () => {
          spawned = true;
          return exited();
        },
      });
      expect(result.ok).toBeFalse();
      if (!result.ok) {
        expect(result.classification).toBe("terminal");
        expect(result.process).toBeUndefined();
      }
      expect(spawned).toBeFalse();
    }
  });

  test("rejects dynamic primitive construction and side-effect wrappers before spawning", async () => {
    const canonical = await readFile(new URL("../../user-info/resume-main/Alex_Example_Resume.tex", import.meta.url), "utf8");
    const candidates = [
      String.raw`\csname input\endcsname{secret}`,
      String.raw`\endcsname`,
      String.raw`\in^^70ut{secret}`,
      String.raw`\catcode64=0`,
      String.raw`\def\x{\input{secret}}\x`,
      String.raw`\edef\x{\input{secret}}`,
      String.raw`\gdef\x{\input{secret}}`,
      String.raw`\xdef\x{\input{secret}}`,
      String.raw`\newcommand{\x}{unsafe}`,
      String.raw`\renewcommand{\resumeItem}{unsafe}`,
      String.raw`\expandafter\x\csname input\endcsname`,
      String.raw`\noexpand\input`,
      String.raw`\let\x\input`,
      String.raw`\futurelet\x\input`,
      String.raw`\scantokens{\input{secret}}`,
      String.raw`\loop\iftrue\repeat`,
      String.raw`\newread\handle`,
      String.raw`\openin\handle=secret`,
      String.raw`\closein\handle`,
      String.raw`\read\handle to \value`,
      String.raw`\readline\handle to \value`,
      String.raw`\ifeof\handle`,
      String.raw`\newwrite\handle`,
      String.raw`\openout\handle=compile.log`,
      String.raw`\closeout\handle`,
      String.raw`\write\handle{unsafe}`,
      String.raw`\immediate\write\handle{unsafe}`,
      String.raw`\special{unsafe}`,
      String.raw`\shipout\hbox{unsafe}`,
      String.raw`\pdfobj{unsafe}`,
      String.raw`\pdfcatalog{/OpenAction 1 0 R}`,
      String.raw`\pdfinfo{/Title(unsafe)}`,
      String.raw`\pdfliteral{unsafe}`,
      String.raw`\pdfgentounicode=0`,
      String.raw`\write18{touch unsafe}`,
      String.raw`\directlua{os.execute("touch unsafe")}`,
    ];

    for (const primitive of candidates) {
      let spawned = false;
      const artifacts = new ArtifactStore(await root());
      const tex = canonical.replace("\\end{document}", `${primitive}\n\\end{document}`);
      const result = await compileResume({
        artifacts,
        address,
        tex,
        mode: "candidate",
        processBoundary: () => {
          spawned = true;
          throw new Error("candidate reached compiler boundary");
        },
      });
      expect(result.ok).toBeFalse();
      if (result.ok) throw new Error("expected terminal validation failure");
      expect(result.classification).toBe("terminal");
      expect(result.process).toBeUndefined();
      expect(result.log.bytes).toBeLessThanOrEqual(ARTIFACT_LIMITS.log);
      expect(Buffer.from(await artifacts.read(result.log.path, ARTIFACT_LIMITS.log)).toString()).toMatch(/forbidden/i);
      expect(spawned).toBeFalse();
    }

    const modifiedBaseline = canonical.replace(
      String.raw`\newcommand{\resumeItem}[1]`,
      String.raw`\newcommand{\resumeItem}[2]`,
    );
    const artifacts = new ArtifactStore(await root());
    const result = await compileResume({ artifacts, address, tex: modifiedBaseline, mode: "candidate", processBoundary: () => exited() });
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.classification).toBe("terminal");
  });

  test("rejects shell escape and parent or absolute file access before spawning", async () => {
    for (const tex of [
      `${safeTex}\n--shell-escape`,
      "\\documentclass{article}\\input{../secret}\\begin{document}x\\end{document}",
      "\\documentclass{article}\\includegraphics{/etc/passwd}\\begin{document}x\\end{document}",
    ]) {
      let spawned = false;
      const store = new ArtifactStore(await root());
      const result = await compileResume({ artifacts: store, address, tex, mode: "full", processBoundary: () => { spawned = true; return exited(); } });
      expect(result.ok).toBeFalse();
      if (!result.ok) {
        expect(result.reason).toMatch(/forbidden|file access/i);
        expect(result.log.bytes).toBeLessThanOrEqual(ARTIFACT_LIMITS.log);
      }
      expect(spawned).toBeFalse();
    }
  });

  testWithLinuxTexCache("uses a locked recipe, isolated policy, owner-only local TeX caches, and candidate/full timeouts", async () => {
    for (const mode of ["candidate", "full"] as const) {
      let seen: SpawnContract | undefined;
      const boundary: ProcessBoundary = (contract) => {
        seen = contract;
        expect(typeof contract.attemptRootFd).toBe("number");
        expect(fstatSync(contract.attemptRootFd!).isDirectory()).toBeTrue();
        if (process.platform === "linux") {
          expect(realpathSync(`/proc/self/fd/${contract.attemptRootFd}`)).toBe(realpathSync(contract.cwd));
        }
        expect(JSON.stringify(contract.env)).not.toContain(contract.cwd);
        for (const directory of [
          ".tex-cache",
          ".tex-cache/tmp",
          ".tex-cache/texmf-home",
          ".tex-cache/texmf-var",
          ".tex-cache/fonts",
        ]) {
          const cache = lstatSync(join(contract.cwd, directory));
          expect(cache.isDirectory()).toBeTrue();
          expect(cache.mode & 0o777).toBe(0o700);
        }
        writeFileSync(join(contract.cwd, "compile.pdf"), "%PDF-1.4\n%%EOF");
        return exited();
      };
      const artifacts = new ArtifactStore(await root());
      const result = await compileResume({ artifacts, address, tex: safeTex, mode, processBoundary: boundary });
      expect(result.ok).toBeTrue();
      expect(seen?.command).toBe("latexmk");
      expect(seen?.args).toEqual([
        "-pdf",
        "-pdflatex=pdflatex -interaction=nonstopmode -halt-on-error -file-line-error -no-shell-escape %O %S",
        "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-no-shell-escape", "compile.tex",
      ]);
      expect(seen?.env).toEqual(sanitizedEnvironment(".", seen?.attemptRootFd));
      const parentRoot = `/proc/${process.pid}/fd/${seen?.attemptRootFd}`;
      expect(seen?.env).toMatchObject({
        TMPDIR: `${parentRoot}/.tex-cache/tmp`,
        TEXMFHOME: ".tex-cache/texmf-home",
        TEXMFVAR: ".tex-cache/texmf-var",
        VARTEXFONTS: `${parentRoot}/.tex-cache/fonts`,
        MT_FEATURES: "appendonlydir:varfonts",
        MT_VARTEXFONTS: `${parentRoot}/.tex-cache/fonts`,
        TEXMFCNF: ".:",
      });
      expect(await readFile(join(seen!.cwd, "compile.tex"), "utf8")).toBe("\\RequirePackage{lmodern}\n\\input{main.tex}\n");
      expect(COMPILE_TIMEOUTS[mode]).toBe(mode === "candidate" ? 60_000 : 120_000);
      expect(await readFile(join(seen!.cwd, "texmf.cnf"), "utf8")).toBe("openin_any = p\nopenout_any = p\nshell_escape = f\n");
      expect(() => fstatSync(seen!.attemptRootFd!)).toThrow();
    }
  });

  testWithLinuxTexCache("always finalizes a bounded log and publishes no PDF on failure", async () => {
    const artifacts = new ArtifactStore(await root());
    const huge = "x".repeat(700_000);
    const result = await compileResume({ artifacts, address, tex: safeTex, mode: "full", processBoundary: () => exited(104, huge, huge, 1) });
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error("expected failure");
    expect(result.log.bytes).toBeLessThanOrEqual(ARTIFACT_LIMITS.log);
    expect(result.classification).toBe("terminal");
    await expect(artifacts.read(join(result.attemptRoot, "resume.pdf"), ARTIFACT_LIMITS.pdf)).rejects.toThrow();
  });

  testWithLinuxTexCache("distinguishes repairable TeX diagnostics from terminal compiler failures", async () => {
    const cases = [
      ["! Undefined control sequence.\\n\\resumeIten", "repairable"],
      ["! File ended while scanning use of \\resumeItem.", "repairable"],
      ["! LaTeX Error: File `missing.sty' not found.", "terminal"],
      ["latexmk: disk full", "terminal"],
    ] as const;
    for (const [stderr, classification] of cases) {
      const artifacts = new ArtifactStore(await root());
      const result = await compileResume({ artifacts, address, tex: safeTex, mode: "candidate", processBoundary: () => exited(105, "", stderr, 1) });
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.classification).toBe(classification);
    }
  });

  testWithLinuxTexCache("publishes a capped immutable PDF only after successful compilation", async () => {
    const artifacts = new ArtifactStore(await root());
    const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");
    const result = await compileResume({
      artifacts,
      address,
      tex: safeTex,
      mode: "full",
      processBoundary: (contract) => { writeFileSync(join(contract.cwd, "compile.pdf"), pdfBytes); return exited(106, "ok"); },
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error("expected success");
    expect(result.pdf.bytes).toBe(pdfBytes.byteLength);
    expect(Buffer.from(await artifacts.read(result.pdf.path, ARTIFACT_LIMITS.pdf))).toEqual(pdfBytes);
    await expect(artifacts.write(result.pdf.path, "replacement", 100)).rejects.toThrow(/already exists/i);
  });

  testWithLinuxTexCache("turns an oversized success PDF into a terminal failure with a finalized log", async () => {
    const artifacts = new ArtifactStore(await root());
    const result = await compileResume({
      artifacts,
      address,
      tex: safeTex,
      mode: "full",
      processBoundary: (contract) => { writeFileSync(join(contract.cwd, "compile.pdf"), Buffer.alloc(ARTIFACT_LIMITS.pdf + 1)); return exited(107); },
    });
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.classification).toBe("terminal");
      expect(result.reason).toMatch(/acceptable PDF|byte limit/i);
      expect(result.log.bytes).toBeLessThanOrEqual(ARTIFACT_LIMITS.log);
    }
  });
});
