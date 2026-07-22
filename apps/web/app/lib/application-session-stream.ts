import {
  ApplicationSessionEventDtoSchema,
  type ApplicationSessionEventDto,
} from "@jobhunter/pipeline/contracts";

export const APPLICATION_SESSION_EVENT_NAMES = [
  "session_started",
  "agent_step",
  "snapshot",
  "human_navigation_required",
  "origin_approval_required",
  "additional_info_required",
  "additional_info_saved",
  "review_required",
  "revision_applied",
  "ready_for_human_submit",
  "cancelled",
  "failed",
  "closed",
] as const satisfies readonly ApplicationSessionEventDto["event"][];

export type ApplicationSessionStreamProjection =
  | { readonly status: "accepted"; readonly event: ApplicationSessionEventDto }
  | { readonly status: "stale" }
  | { readonly status: "invalid" };

const EVENT_ID = /^([1-9]\d*):(0|[1-9]\d*)$/;

export function parseApplicationSessionStreamEvent(
  data: string,
  lastEventId: string,
  currentGeneration: number | null,
  eventType?: string,
): ApplicationSessionStreamProjection {
  const eventId = EVENT_ID.exec(lastEventId);
  if (!eventId) return { status: "invalid" };
  const eventGeneration = Number(eventId[1]);
  const upstreamEventId = Number(eventId[2]);
  if (!Number.isSafeInteger(eventGeneration) || !Number.isSafeInteger(upstreamEventId)) {
    return { status: "invalid" };
  }

  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { status: "invalid" };
  }
  const parsed = ApplicationSessionEventDtoSchema.safeParse(value);
  if (
    !parsed.success
    || parsed.data.generation !== eventGeneration
    || (eventType !== undefined && parsed.data.event !== eventType)
  ) {
    return { status: "invalid" };
  }
  if (currentGeneration !== null && parsed.data.generation < currentGeneration) {
    return { status: "stale" };
  }
  return { status: "accepted", event: parsed.data };
}
