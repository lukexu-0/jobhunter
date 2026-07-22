import {
  ApplicationSessionCommandSchema,
  type ApplicationSessionCommand,
} from "@jobhunter/pipeline/contracts";

type ReviseCommand = Extract<
  ApplicationSessionCommand,
  { readonly type: "revise" }
>;

export type ApplicationRevisionBuildResult =
  | { readonly success: true; readonly command: ReviseCommand }
  | { readonly success: false; readonly message: string };

const INVALID_REVISION_MESSAGE =
  "Enter revision instructions between 1 and 20,000 characters.";

export function buildApplicationRevisionCommand(
  context: string,
): ApplicationRevisionBuildResult {
  const trimmed = context.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > 20_000) {
    return { success: false, message: INVALID_REVISION_MESSAGE };
  }
  const parsed = ApplicationSessionCommandSchema.safeParse({
    type: "revise",
    context: trimmed,
  });
  if (!parsed.success || parsed.data.type !== "revise") {
    return { success: false, message: INVALID_REVISION_MESSAGE };
  }
  return { success: true, command: parsed.data };
}
