export type ApplicationModel =
  | { readonly modelProvider: "openai-codex"; readonly model: "gpt-5.6-sol"; readonly reasoning: "medium" }
  | { readonly modelProvider: "google-antigravity"; readonly model: "gemini-3.8-flash"; readonly reasoning: "high" };

const CODEX_APPLICATION_MODEL: ApplicationModel = Object.freeze({
  modelProvider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
});
const ANTIGRAVITY_APPLICATION_MODEL: ApplicationModel = Object.freeze({
  modelProvider: "google-antigravity",
  model: "gemini-3.8-flash",
  reasoning: "high",
});

export function resolveApplicationModel(value?: string): ApplicationModel {
  if (value === undefined || value === "gpt-5.6-sol") return CODEX_APPLICATION_MODEL;
  if (value === "gemini-3.8-flash") return ANTIGRAVITY_APPLICATION_MODEL;
  throw new Error("JOBHUNT_APPLICATION_MODEL must be gpt-5.6-sol or gemini-3.8-flash");
}
