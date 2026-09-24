import type { ApplicationStatus } from "./pipeline-contracts";

export const APPLICATION_STATUS_LABELS: Readonly<Record<ApplicationStatus, string>> = {
  pending: "Pending application",
  did_not_apply: "Did not apply",
  manual_application: "Manual application",
  applied: "Applied",
  oa_received: "OA received",
  oa_completed: "OA completed",
  rejected: "Rejected",
  interview: "Interview",
  accepted: "Accepted",
  failed: "Failed",
};
