/**
 * Documented status-transition tables (master spec §7, §8). Every status change in
 * the product is checked against one of these tables server-side — the API/worker
 * code must call `isTransitionAllowed(...)` rather than writing a status directly.
 */

export const WORK_ITEM_STATUSES = [
  "detected",
  "needs_review",
  "recommended",
  "awaiting_approval",
  "approved",
  "declined",
  "in_progress",
  "completed",
  "verification_failed",
  "verified",
  "closed",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * Allowed `from -> to[]` transitions. `requires_client_approval = false` items skip
 * straight from recommended/needs_review to in_progress — see the
 * `requiresApproval` gate in `isWorkItemTransitionAllowed`.
 */
const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  detected: ["needs_review", "recommended", "closed"],
  needs_review: ["recommended", "in_progress", "closed"],
  recommended: ["awaiting_approval", "in_progress", "closed"],
  awaiting_approval: ["approved", "declined", "closed"],
  approved: ["in_progress", "closed"],
  declined: ["closed", "recommended"],
  in_progress: ["completed", "closed"],
  completed: ["verified", "verification_failed", "closed"],
  verification_failed: ["in_progress", "closed"],
  verified: ["closed"],
  closed: [],
};

export function isWorkItemTransitionAllowed(
  from: WorkItemStatus,
  to: WorkItemStatus,
): boolean {
  return WORK_ITEM_TRANSITIONS[from].includes(to);
}

/**
 * A work item that requires client approval may not jump from recommended/
 * needs_review straight to in_progress/approved — it must pass through
 * awaiting_approval first. Items explicitly marked `requires_client_approval =
 * false` are exempt from that specific restriction (master spec: "not every issue
 * requires client approval, and an agency should be able to document that
 * distinction").
 */
export function isWorkItemTransitionAllowedForItem(
  from: WorkItemStatus,
  to: WorkItemStatus,
  requiresClientApproval: boolean,
): boolean {
  if (!isWorkItemTransitionAllowed(from, to)) return false;
  const bypassesApproval =
    (from === "recommended" || from === "needs_review") && to === "in_progress";
  if (bypassesApproval && requiresClientApproval) return false;
  return true;
}

export const INCIDENT_STATUSES = ["confirming", "open", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  confirming: ["open", "resolved"],
  open: ["resolved"],
  resolved: [],
};

export function isIncidentTransitionAllowed(
  from: IncidentStatus,
  to: IncidentStatus,
): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export const CLIENT_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "declined",
  "clarification_requested",
  "expired",
  "revoked",
] as const;
export type ClientApprovalStatus = (typeof CLIENT_APPROVAL_STATUSES)[number];

const CLIENT_APPROVAL_TRANSITIONS: Record<
  ClientApprovalStatus,
  readonly ClientApprovalStatus[]
> = {
  pending: ["approved", "declined", "clarification_requested", "expired", "revoked"],
  clarification_requested: ["approved", "declined", "expired", "revoked"],
  approved: [],
  declined: [],
  expired: [],
  revoked: [],
};

export function isClientApprovalTransitionAllowed(
  from: ClientApprovalStatus,
  to: ClientApprovalStatus,
): boolean {
  return CLIENT_APPROVAL_TRANSITIONS[from].includes(to);
}

export const REPORT_STATUSES = ["draft", "generated", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const FINDING_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const CHECK_RESULT_STATUSES = [
  "success",
  "failure",
  "error",
  "timeout",
  "skipped",
] as const;
export type CheckResultStatus = (typeof CHECK_RESULT_STATUSES)[number];

export const SSL_CHECK_STATUSES = [
  "valid",
  "expiring_soon",
  "expired",
  "hostname_mismatch",
  "untrusted_chain",
  "unreachable",
  "error",
] as const;
export type SslCheckStatus = (typeof SSL_CHECK_STATUSES)[number];

export const MEMBERSHIP_ROLES = ["owner", "admin", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export function roleCanManageMembers(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

export function roleCanManageBilling(role: MembershipRole): boolean {
  return role === "owner";
}
