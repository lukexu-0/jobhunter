import {
  doctorExitCode,
  renderDoctorJson,
  runDoctor,
  type DoctorDependencies,
  type DoctorCheck,
  type DoctorReport,
} from "../src/system/doctor.ts";

export async function runDoctorScript(dependencies: DoctorDependencies = {}): Promise<{
  readonly report: DoctorReport;
  readonly json: string;
  readonly exitCode: 0 | 1;
}> {
  const report = await runDoctor(dependencies);
  return Object.freeze({ report, json: renderDoctorJson(report), exitCode: doctorExitCode(report) });
}

if (import.meta.main) {
  try {
    const result = await runDoctorScript();
    console.log(result.json);
    process.exitCode = result.exitCode;
  } catch {
    const report: DoctorReport = Object.freeze({
      ok: false,
      checkedAt: Date.now(),
      checks: [{
        id: "context",
        status: "error",
        classification: "doctor_configuration_invalid",
      } satisfies DoctorCheck],
    });
    console.log(renderDoctorJson(report));
    process.exitCode = 1;
  }
}
