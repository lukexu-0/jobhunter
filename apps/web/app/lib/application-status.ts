import type { ApplicationStatus } from "@jobhunter/pipeline/contracts";

export const APPLICATION_STATUS_LABELS: Readonly<Record<ApplicationStatus, string>> = {
  pending: "Pending",
  applied: "Applied",
  rejected: "Rejected",
  interview: "Interview",
  accepted: "Accepted",
  failed: "Failed",
};
