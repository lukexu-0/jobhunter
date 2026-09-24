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

const LUNA_DESCRIPTOR = {
  id: "gpt-5.6-luna", name: "GPT-5.6 Luna", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"],
  cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
  remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true },
  contextWindow: 372_000, maxTokens: 128_000, preferWebsockets: true, useResponsesLite: true, priority: 3,
  applyPatchToolType: "freeform",
  thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
} as const;

function healthyDependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    platform: "linux",
    now: () => 1_234,
    authStatus: async () => ({ providers: [
      { provider: "openai-codex", state: "connected" },
    ] }),
    contextStatus: () => ({ state: "fresh" }),
    modelDescriptors: () => ({
      "gpt-5.6-sol": CODEX_DESCRIPTOR,
      "gpt-5.6-luna": LUNA_DESCRIPTOR,
    }),
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
  test("recognizes macOS app-bundle Chrome without Linux services and reports native isolation limits", async () => {
    const report = await runDoctor(healthyDependencies({
      platform: "darwin",
      process: {
        findExecutable: (name) => {
          if (["google-chrome", "systemd-run", "systemctl"].includes(name)) return undefined;
          return name === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            ? name : `/system/${name}`;
        },
        version: async () => "version 1",
      },
    }));
    expect(doctorExitCode(report)).toBe(0);
    expect(byId(report.checks, "google-chrome").status).toBe("ok");
    expect(byId(report.checks, "browser-source")).toMatchObject({
      status: "warning", classification: "native_browser_isolation",
    });
    expect(report.checks.some(({ id }) => id === "systemd-run" || id === "systemctl")).toBe(false);
  });

  test("reports stable named checks and asserts the exact app model IDs and providers", async () => {
    const probes: Array<[DoctorProvider, string]> = [];
    const report = await runDoctor(healthyDependencies({
      probeEntitlement: async (provider, modelId) => { probes.push([provider, modelId]); },
    }));

    expect(report).toMatchObject({ ok: true, checkedAt: 1_234 });
    expect(report.checks.map((check) => check.id)).toEqual([
      "bun", "context", "auth-openai",
      "model-openai", "model-luna",
      "google-chrome", "systemd-run", "systemctl",
      "latexmk", "pdfinfo", "pdftotext", "pdffonts", "pdftoppm",
    ]);
    expect(probes).toEqual([
      ["openai-codex", "gpt-5.6-sol"],
      ["openai-codex", "gpt-5.6-luna"],
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
      ["/system/google-chrome", "--version"],
      ["/system/systemd-run", "--version"],
      ["/system/systemctl", "--version"],
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

  test("fails closed when any required renderer executable is missing", async () => {
    for (const missing of ["google-chrome", "systemd-run", "systemctl"] as const) {
      const report = await runDoctor(healthyDependencies({
        process: {
          findExecutable: (name) => name === missing ? undefined : `/system/${name}`,
          version: async () => "version 1",
        },
      }));

      expect(byId(report.checks, missing)).toMatchObject({
        status: "error",
        classification: "missing_system_tool",
      });
      expect(doctorExitCode(report)).toBe(1);
    }
  });

  test("rejects a model whose exact descriptor does not match without probing it", async () => {
    const probes: Array<[DoctorProvider, string]> = [];
    const report = await runDoctor(healthyDependencies({
      modelDescriptors: () => ({
        "gpt-5.6-sol": { ...CODEX_DESCRIPTOR, id: "gpt-5.6-sol-preview" },
        "gpt-5.6-luna": LUNA_DESCRIPTOR,
      }),
      probeEntitlement: async (provider, modelId) => { probes.push([provider, modelId]); },
    }));

    expect(byId(report.checks, "model-openai")).toMatchObject({ status: "error", classification: "model_descriptor_invalid" });
    expect(probes).toEqual([
      ["openai-codex", "gpt-5.6-luna"],
    ]);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("rejects Luna descriptor and high-resolution drift before probing that model", async () => {
    for (const luna of [
      { ...LUNA_DESCRIPTOR, contextWindow: 999_999 },
      { ...LUNA_DESCRIPTOR, requestModelId: "gpt-5.6-luna-high" },
    ]) {
      const probes: Array<[DoctorProvider, string]> = [];
      const report = await runDoctor(healthyDependencies({
        modelDescriptors: () => ({
          "gpt-5.6-sol": CODEX_DESCRIPTOR,
          "gpt-5.6-luna": luna,
        }),
        probeEntitlement: async (provider, modelId) => { probes.push([provider, modelId]); },
      }));

      expect(byId(report.checks, "model-luna")).toMatchObject({
        status: "error",
        classification: "model_descriptor_invalid",
      });
      expect(probes).toEqual([
        ["openai-codex", "gpt-5.6-sol"],
      ]);
    }
  });

  test("classifies disconnected OAuth as warnings and suppresses every dependent model probe", async () => {
    const probes: Array<[DoctorProvider, string]> = [];
    const report = await runDoctor(healthyDependencies({
      authStatus: async () => ({ providers: [
        { provider: "openai-codex", state: "disconnected" },
      ] }),
      probeEntitlement: async (provider, modelId) => { probes.push([provider, modelId]); },
    }));

    expect(byId(report.checks, "auth-openai")).toMatchObject({ status: "warning", classification: "auth_absent" });
    expect(byId(report.checks, "model-openai").classification).toBe("auth_absent");
    expect(byId(report.checks, "model-luna").classification).toBe("auth_absent");
    expect(probes).toEqual([]);
    expect(report.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("shares expired OpenAI auth across Sol and Luna", async () => {
    const probes: Array<[DoctorProvider, string]> = [];
    const report = await runDoctor(healthyDependencies({
      authStatus: async () => ({ providers: [
        { provider: "openai-codex", state: "expired" },
      ] }),
      probeEntitlement: async (provider, modelId) => { probes.push([provider, modelId]); },
    }));

    expect(byId(report.checks, "auth-openai").classification).toBe("auth_expired");
    expect(byId(report.checks, "model-openai").classification).toBe("auth_expired");
    expect(byId(report.checks, "model-luna").classification).toBe("auth_expired");
    expect(probes).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("keeps provider-plus-model probe failures independently classified", async () => {
    const classifications = ["callback_port_conflict", "network_failure", "model_unentitled"] as const;
    const models = [
      ["openai-codex", "gpt-5.6-sol", "model-openai"],
      ["openai-codex", "gpt-5.6-luna", "model-luna"],
    ] as const;
    for (const classification of classifications) {
      for (const [failedProvider, failedModel, checkId] of models) {
        const report = await runDoctor(healthyDependencies({
          probeEntitlement: async (provider, modelId) => {
            if (provider === failedProvider && modelId === failedModel) throw new DoctorProbeError(classification);
          },
        }));
        expect(byId(report.checks, checkId)).toMatchObject({ status: "warning", classification });
        for (const [, , otherCheckId] of models) {
          if (otherCheckId !== checkId) expect(byId(report.checks, otherCheckId).status).toBe("ok");
        }
        expect(report.ok).toBe(true);
        expect(doctorExitCode(report)).toBe(0);
      }
    }
  });

  test("treats unknown upstream probe errors as network failures without exposing their body", async () => {
    const report = await runDoctor(healthyDependencies({
      probeEntitlement: async () => { throw new Error("TOKEN=secret provider-response-body /private/user/repository"); },
    }));
    const json = renderDoctorJson(report);

    expect(byId(report.checks, "model-openai").classification).toBe("network_failure");
    expect(byId(report.checks, "model-luna").classification).toBe("network_failure");
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
    expect(byId(cached.checks, "model-luna").classification).toBe("entitled_cached");
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
    expect(byId(recovered.checks, "model-luna").classification).toBe("entitled");
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
    expect(doctorExitCode(report)).toBe(1);
    expect(json).not.toContain("/private/auth.sqlite");
    expect(json).not.toContain("secret");
  });

  test("uses executable probes only for the nine approved local programs and makes a missing tool fatal", async () => {
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

    expect(lookedUp).toEqual([
      "bun", "google-chrome", "systemd-run", "systemctl",
      "latexmk", "pdfinfo", "pdftotext", "pdffonts", "pdftoppm",
    ]);
    expect(versioned).toEqual([
      "bun", "google-chrome", "systemd-run", "systemctl",
      "latexmk", "pdfinfo", "pdftotext", "pdftoppm",
    ]);
    expect(byId(result.report.checks, "pdffonts")).toMatchObject({ status: "error", classification: "missing_system_tool" });
    expect(result.exitCode).toBe(1);
    expect(result.json).not.toContain("/not-reported/");
    expect(result.json).not.toContain("secret");
    expect(result.json).not.toContain("provider-body");
  });
});
