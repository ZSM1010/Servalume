import type { CheckResultStatus, IncidentStatus } from "@servalume/shared";

/**
 * Deterministic incident confirmation/open/resolve rules (docs/DATA_MODEL.md
 * §4). Pure function: no I/O, no randomness, no clock reads — the caller
 * supplies the current state and the new check's outcome, and gets back
 * exactly one action to perform. This is what Phase 3's "test real
 * failure/recovery paths" requirement is actually testing; the DB/worker
 * plumbing around it just has to execute whatever this function decides.
 */

export type IncidentAction =
  | { type: "no_action" }
  | { type: "create_confirming" }
  | { type: "confirm_open"; notify: "incident_opened" }
  | { type: "discard_as_resolved" }
  | { type: "mark_resolved"; notify: "incident_resolved" };

function isFailure(status: CheckResultStatus): boolean {
  return status === "failure" || status === "error" || status === "timeout";
}

function isSuccess(status: CheckResultStatus): boolean {
  return status === "success";
}

export interface DecideIncidentActionParams {
  /** The monitor's current non-resolved incident, or null if its most recent incident (if any) is already resolved. */
  currentIncidentStatus: IncidentStatus | null;
  newCheckStatus: CheckResultStatus;
}

export function decideIncidentAction(params: DecideIncidentActionParams): IncidentAction {
  const { currentIncidentStatus, newCheckStatus } = params;

  // "skipped" means the check never actually ran (plan limit, worker
  // interruption, etc.) — it is evidence of nothing, so it must never
  // advance or regress incident state. Treating a missing data point as
  // either a failure or a recovery would violate docs/DATA_MODEL.md's
  // "never treat a missing data point as a successful check."
  if (!isFailure(newCheckStatus) && !isSuccess(newCheckStatus)) {
    return { type: "no_action" };
  }

  if (currentIncidentStatus === null) {
    return isFailure(newCheckStatus) ? { type: "create_confirming" } : { type: "no_action" };
  }

  if (currentIncidentStatus === "confirming") {
    if (isFailure(newCheckStatus)) {
      return { type: "confirm_open", notify: "incident_opened" };
    }
    // The confirmation check succeeded: this was a flaky blip, never truly
    // "open" — recorded as resolved-without-having-opened so the flap is
    // still visible in history without counting as reported downtime.
    return { type: "discard_as_resolved" };
  }

  if (currentIncidentStatus === "open") {
    if (isSuccess(newCheckStatus)) {
      return { type: "mark_resolved", notify: "incident_resolved" };
    }
    // Still failing while already open: no new incident, no new
    // notification — notification_sent_at already covers this incident.
    return { type: "no_action" };
  }

  return { type: "no_action" };
}
