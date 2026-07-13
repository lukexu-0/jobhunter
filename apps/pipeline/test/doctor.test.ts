import { describe, expect, test } from "bun:test";
import {
  DoctorProbeError,
  doctorExitCode,
  renderDoctorJson,
  runDoctor,
  type DoctorCheck,
  type DoctorDependencies,
  type DoctorProvider,
} from "../src/system/doctor.ts";
import { runDoctorScript } from "../scripts/doctor.ts";

const CODEX_DESCRIPTOR = {
  id: "gpt-5.6-sol", name: "GPT-5.6 Sol", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"], supportsTools: true,
  cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true }, contextWindow: 372_000,
  maxTokens: 128_000, preferWebsockets: false, useResponsesLite: true, priority: 1, applyPatchToolType: "freeform",
  thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
} as const;

const GEMINI_DESCRIPTOR = {
  id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", api: "google-gemini-cli", provider: "google-antigravity",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com", reasoning: true, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536,
  requestModelId: "gemini-3.5-flash-extra-low",
  thinking: {
    mode: "budget", efforts: ["minimal", "low", "medium", "high"],
    effortBudgets: { minimal: 1_000, low: 1_000, medium: 4_000, high: 10_000 },
    effortRouting: {
      off: "gemini-3.5-flash-extra-low", minimal: "gemini-3.5-flash-extra-low", low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low", high: "gemini-3-flash-agent",
    },
    suppressWhenOff: true,
  },
} as const;

function healthyDependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    now: () => 1_234,
    authStatus: async () => ({ providers: [
      { provider: "openai-codex", state: "connected" },
      { provider: "google-antigravity", state: "connected" },
    ] }),
    contextStatus: () => ({ state: "fresh" }),
    modelDescriptors: () => ({ "openai-codex": CODEX_DESCRIPTOR, "google-antigravity": GEMINI_DESCRIPTOR }),
    process: {
      findExecutable: (name) => `/system/${name}`,
      version: async (path) => `${path.slice(path.lastIndexOf("/") + 1)} 1.0`,
    },
    probeEntitlement: async () => {},
    ...overrides,
  };
}

function byId(checks: readonly DoctorCheck[], id: DoctorCheck["id"]): DoctorCheck {
  const result = checks.find((check) => check.id === id);
  if (!result) throw new Error(`Missing check ${id}`);
  return result;
}

describe("doctor public service", () => {
  test("reports stable named checks and asserts the exact app model IDs and providers", async () => {
    const probes: Array<[DoctorProvider, string]> = [];
    const report = await runDoctor(healthyDependencies({
      probeEntitlement: async (provider, modelId) => { probes.push([provider, modelId]); },
    }));

    expect(report).toMatchObject({ ok: true, checkedAt: 1_234 });
    expect(report.checks.map((check) => check.id)).toEqual([
      "bun", "context", "auth-openai", "auth-gemini", "model-openai", "model-gemini",
      "latexmk", "pdfinfo", "pdftotext", "pdffonts", "pdftoppm",
    ]);
    expect(probes).toEqual([
      ["openai-codex", "gpt-5.6-sol"],
      ["google-antigravity", "gemini-3.5-flash"],
    ]);
    expect(report.checks.every((check) => check.status === "ok")).toBe(true);
  });

  test("uses each executable's direct version flag and keeps successful Poppler probes available", async () => {
    const argv: string[][] = [];
    const report = await runDoctor(healthyDependencies({
      process: {
        findExecutable: (name) => `/system/${name}`,
        version: async (executablePath, args) => {
          argv.push([executablePath, ...args]);
          if (executablePath.startsWith("/system/pdf") && (args.length !== 1 || args[0] !== "-v")) {
            throw new Error("Poppler only accepts -v");
          }
          return "version 24.02.0";
        },
      },
    }));

    expect(argv).toEqual([
      ["/system/bun", "--version"],
      ["/system/latexmk", "--version"],
      ["/system/pdfinfo", "-v"],
      ["/system/pdftotext", "-v"],
      ["/system/pdffonts", "-v"],
      ["/system/pdftoppm", "-v"],
    ]);
    for (const id of ["pdfinfo", "pdftotext", "pdffonts", "pdftoppm"] as const) {
      expect(byId(report.checks, id)).toMatchObject({ status: "ok", classification: "available" });
    }
  });

  test("rejects a model whose exact descriptor does not match without probing it", async () => {
    const probes: string[] = [];
    const report = await runDoctor(healthyDependencies({
      modelDescriptors: () => ({
        "openai-codex": { ...CODEX_DESCRIPTOR, id: "gpt-5.6-sol-preview" },
        "google-antigravity": GEMINI_DESCRIPTOR,
      }),
      probeEntitlement: async (provider) => { probes.push(provider); },
    }));

    expect(byId(report.checks, "model-openai")).toMatchObject({ status: "error", classification: "model_descriptor_invalid" });
    expect(probes).toEqual(["google-antigravity"]);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("classifies disconnected OAuth as warnings and never performs model probes", async () => {
    const probes: string[] = [];
    const report = await runDoctor(healthyDependencies({
      authStatus: async () => ({ providers: [
        { provider: "openai-codex", state: "disconnected" },
        { provider: "google-antigravity", state: "disconnected" },
      ] }),
      probeEntitlement: async (provider) => { probes.push(provider); },
    }));

    expect(byId(report.checks, "auth-openai")).toMatchObject({ status: "warning", classification: "auth_absent" });
    expect(byId(report.checks, "auth-gemini")).toMatchObject({ status: "warning", classification: "auth_absent" });
    expect(byId(report.checks, "model-openai").classification).toBe("auth_absent");
    expect(byId(report.checks, "model-gemini").classification).toBe("auth_absent");
    expect(probes).toEqual([]);
    expect(report.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("classifies expired OAuth separately and never performs model probes", async () => {
    let probes = 0;
    const report = await runDoctor(healthyDependencies({
      authStatus: async () => ({ providers: [
        { provider: "openai-codex", state: "expired" },
        { provider: "google-antigravity", state: "connected" },
      ] }),
      probeEntitlement: async () => { probes += 1; },
    }));

    expect(byId(report.checks, "auth-openai").classification).toBe("auth_expired");
    expect(byId(report.checks, "model-openai").classification).toBe("auth_expired");
    expect(byId(report.checks, "model-gemini").classification).toBe("entitled");
    expect(probes).toBe(1);
    expect(report.ok).toBe(true);
  });

  test("keeps callback-port conflict, network failure, and model entitlement failures distinct", async () => {
    const classifications = ["callback_port_conflict", "network_failure", "model_unentitled"] as const;
    for (const classification of classifications) {
      const report = await runDoctor(healthyDependencies({
        probeEntitlement: async (provider) => {
          if (provider === "openai-codex") throw new DoctorProbeError(classification);
        },
      }));
      expect(byId(report.checks, "model-openai")).toMatchObject({ status: "warning", classification });
      expect(report.ok).toBe(true);
      expect(doctorExitCode(report)).toBe(0);
    }
  });

  test("treats unknown upstream probe errors as network failures without exposing their body", async () => {
    const report = await runDoctor(healthyDependencies({
      probeEntitlement: async () => { throw new Error("TOKEN=secret provider-response-body /private/user/repository"); },
    }));
    const json = renderDoctorJson(report);

    expect(byId(report.checks, "model-openai").classification).toBe("network_failure");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("provider-response-body");
    expect(json).not.toContain("/private/user/repository");
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(32 * 1024);
  });

  test("caches only successful entitlement probes for ten minutes using the injected clock", async () => {
    let now = 10_000;
    let calls = 0;
    const dependencies = healthyDependencies({
      now: () => now,
      probeEntitlement: async () => { calls += 1; },
    });

    await runDoctor(dependencies);
    now += 599_999;
    const cached = await runDoctor(dependencies);
    expect(byId(cached.checks, "model-openai").classification).toBe("entitled_cached");
    expect(byId(cached.checks, "model-gemini").classification).toBe("entitled_cached");
    expect(calls).toBe(2);

    now += 1;
    await runDoctor(dependencies);
    expect(calls).toBe(4);
  });

  test("does not cache failed entitlement probes", async () => {
    let calls = 0;
    const dependencies = healthyDependencies({
      probeEntitlement: async () => {
        calls += 1;
        if (calls <= 2) throw new DoctorProbeError("network_failure");
      },
    });

    await runDoctor(dependencies);
    const recovered = await runDoctor(dependencies);
    expect(calls).toBe(4);
    expect(byId(recovered.checks, "model-openai").classification).toBe("entitled");
    expect(byId(recovered.checks, "model-gemini").classification).toBe("entitled");
  });

  test("classifies invalid and inaccessible context sources and stale indexes separately", async () => {
    const expected = [
      ["invalid", "context_source_invalid"],
      ["inaccessible", "context_source_inaccessible"],
      ["stale", "stale_index"],
    ] as const;
    for (const [state, classification] of expected) {
      const report = await runDoctor(healthyDependencies({ contextStatus: () => ({ state }) }));
      expect(byId(report.checks, "context")).toMatchObject({ status: "error", classification });
      expect(doctorExitCode(report)).toBe(1);
    }
  });

  test("classifies corrupt auth configuration as a required local error without raw errors", async () => {
    const report = await runDoctor(healthyDependencies({
      authStatus: async () => { throw new Error("sqlite at /private/auth.sqlite contains TOKEN=secret"); },
    }));
    const json = renderDoctorJson(report);

    expect(byId(report.checks, "auth-openai")).toMatchObject({ status: "error", classification: "auth_configuration_invalid" });
    expect(byId(report.checks, "auth-gemini")).toMatchObject({ status: "error", classification: "auth_configuration_invalid" });
    expect(doctorExitCode(report)).toBe(1);
    expect(json).not.toContain("/private/auth.sqlite");
    expect(json).not.toContain("secret");
  });

  test("uses executable probes only for the six approved local programs and makes a missing tool fatal", async () => {
    const lookedUp: string[] = [];
    const versioned: string[] = [];
    const dependencies = healthyDependencies({
      process: {
        findExecutable: (name) => {
          lookedUp.push(name);
          return name === "pdffonts" ? undefined : `/not-reported/${name}`;
        },
        version: async (path) => {
          versioned.push(path.slice(path.lastIndexOf("/") + 1));
          return "version 1 TOKEN=secret provider-body /not-reported/tool";
        },
      },
    });
    const result = await runDoctorScript(dependencies);

    expect(lookedUp).toEqual(["bun", "latexmk", "pdfinfo", "pdftotext", "pdffonts", "pdftoppm"]);
    expect(versioned).toEqual(["bun", "latexmk", "pdfinfo", "pdftotext", "pdftoppm"]);
    expect(byId(result.report.checks, "pdffonts")).toMatchObject({ status: "error", classification: "missing_system_tool" });
    expect(result.exitCode).toBe(1);
    expect(result.json).not.toContain("/not-reported/");
    expect(result.json).not.toContain("secret");
    expect(result.json).not.toContain("provider-body");
  });
});
