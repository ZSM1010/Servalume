import type { Pool } from "pg";
import type { safeFetch, SafeFetchOptions } from "@servalume/safe-fetch";
import { INCIDENT_CONFIRMATION_DELAY_SECONDS } from "@servalume/shared";
import type { CheckResultStatus } from "@servalume/shared";
import {
  confirmIncidentOpen,
  createConfirmingIncident,
  discardIncidentAsResolved,
  findCheckResultByJobId,
  getCurrentNonResolvedIncident,
  insertCheckResult,
  markIncidentResolved,
  type DueMonitor,
} from "../db/queries.js";
import { decideIncidentAction, type IncidentAction } from "../incidentStateMachine.js";

export type SafeFetchFn = typeof safeFetch;

export interface MonitorCheckDeps {
  pool: Pool;
  fetcher: SafeFetchFn;
  checkerRegion: string;
  safeFetchOptions: SafeFetchOptions;
}

export interface MonitorCheckOutcome {
  checkResultId: string;
  checkStatus: CheckResultStatus;
  incidentAction: IncidentAction;
  incidentId: string | null;
  /** Set only when incidentAction is "create_confirming" — the caller should enqueue an accelerated follow-up check this many seconds from now. */
  scheduleConfirmationInSeconds: number | null;
}

function isExpectedStatusCode(httpStatusCode: number, config: Record<string, unknown>): boolean {
  const expected = config.expectedStatusCodes;
  if (Array.isArray(expected) && expected.every((v) => typeof v === "number")) {
    return expected.includes(httpStatusCode);
  }
  return httpStatusCode >= 200 && httpStatusCode < 400;
}

export async function runMonitorCheck(
  deps: MonitorCheckDeps,
  due: DueMonitor,
  monitorConfig: Record<string, unknown>,
  scheduledAt: Date,
  jobId: string | null,
): Promise<MonitorCheckOutcome> {
  // Idempotency guard against pg-boss retrying this exact job (master spec
  // §5: "prevent retries from creating duplicate incidents, duplicate
  // findings, or repeated notifications"). If this job already wrote a
  // check_result, some earlier attempt got at least that far — we stop here
  // rather than risk re-running the incident state machine against state it
  // may have already mutated, which could double-fire a transition. This is
  // a deliberate, disclosed trade-off: a crash in the narrow window between
  // writing check_result and finishing incident bookkeeping means that one
  // incident update is skipped rather than risking a duplicate; the next
  // regularly scheduled check corrects it either way.
  if (jobId) {
    const existing = await findCheckResultByJobId(deps.pool, jobId);
    if (existing) {
      return {
        checkResultId: existing.id,
        checkStatus: existing.status,
        incidentAction: { type: "no_action" },
        incidentId: null,
        scheduleConfirmationInSeconds: null,
      };
    }
  }

  const startedAt = new Date();

  let status: CheckResultStatus;
  let httpStatusCode: number | null = null;
  let responseTimeMs: number | null = null;
  let dnsTimeMs: number | null = null;
  let tcpTimeMs: number | null = null;
  let tlsTimeMs: number | null = null;
  let ttfbMs: number | null = null;
  let responseHeaders: Record<string, unknown> | null = null;
  let failureCategory: string | null = null;
  let failureReason: string | null = null;

  try {
    const result = await deps.fetcher(due.url, deps.safeFetchOptions);
    httpStatusCode = result.httpStatusCode;
    responseTimeMs = result.timings.totalMs;
    dnsTimeMs = result.timings.dnsLookupMs;
    tcpTimeMs = result.timings.tcpConnectMs;
    tlsTimeMs = result.timings.tlsHandshakeMs;
    ttfbMs = result.timings.timeToFirstByteMs;
    responseHeaders = result.headers;

    if (isExpectedStatusCode(httpStatusCode, monitorConfig)) {
      status = "success";
    } else {
      status = "failure";
      failureCategory = "http";
      failureReason = `Unexpected HTTP status ${httpStatusCode}`;
    }
  } catch (err) {
    const category = (err as { category?: string }).category;
    const message = err instanceof Error ? err.message : String(err);
    if (category === "timeout") {
      status = "timeout";
      failureCategory = "timeout";
    } else if (category === "dns" || category === "tls" || category === "connection" || category === "http") {
      status = "error";
      failureCategory = category;
    } else {
      // "blocked" (SSRF guard rejection) and anything unrecognized both map
      // to "other" — check_results.failure_category's check constraint has
      // no "blocked" value, and a blocked destination is still a real check
      // failure that must be recorded, never silently dropped.
      status = "error";
      failureCategory = "other";
    }
    failureReason = message.slice(0, 2000);
  }

  const completedAt = new Date();

  const checkResultId = await insertCheckResult(deps.pool, {
    monitorId: due.monitorId,
    websiteId: due.websiteId,
    organizationId: due.organizationId,
    scheduledAt,
    startedAt,
    completedAt,
    status,
    httpStatusCode,
    responseTimeMs,
    dnsTimeMs,
    tcpTimeMs,
    tlsTimeMs,
    ttfbMs,
    responseHeaders,
    failureCategory,
    failureReason,
    checkerRegion: deps.checkerRegion,
    attemptNumber: 1,
    requestId: null,
    jobId,
  });

  const currentIncident = await getCurrentNonResolvedIncident(deps.pool, due.monitorId);
  const incidentAction = decideIncidentAction({
    currentIncidentStatus: currentIncident?.status ?? null,
    newCheckStatus: status,
  });

  let incidentId: string | null = currentIncident?.id ?? null;
  let scheduleConfirmationInSeconds: number | null = null;

  switch (incidentAction.type) {
    case "create_confirming":
      incidentId = await createConfirmingIncident(deps.pool, {
        organizationId: due.organizationId,
        websiteId: due.websiteId,
        monitorId: due.monitorId,
        firstCheckResultId: checkResultId,
      });
      scheduleConfirmationInSeconds = INCIDENT_CONFIRMATION_DELAY_SECONDS;
      break;
    case "confirm_open":
      if (incidentId) await confirmIncidentOpen(deps.pool, incidentId, due.organizationId, checkResultId, failureCategory);
      break;
    case "discard_as_resolved":
      if (incidentId) await discardIncidentAsResolved(deps.pool, incidentId, due.organizationId, checkResultId);
      break;
    case "mark_resolved":
      if (incidentId) await markIncidentResolved(deps.pool, incidentId, due.organizationId, checkResultId);
      break;
    case "no_action":
      break;
  }

  return { checkResultId, checkStatus: status, incidentAction, incidentId, scheduleConfirmationInSeconds };
}
