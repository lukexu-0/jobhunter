import type { ApplicationStatus } from "@jobhunter/pipeline/contracts";

export const APPLICATION_STATUS_LABELS: Readonly<Record<ApplicationStatus, string>> = {
  pending: "Pending",
  did_not_apply: "Did not apply",
  applied: "Applied",
  waiting_for_review: "Waiting for review!",
  oa_received: "OA received",
  oa_completed: "OA completed",
  rejected: "Rejected",
  interview: "Interview",
  accepted: "Accepted",
  failed: "Failed",
};
