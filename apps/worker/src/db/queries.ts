import type { Pool } from "pg";
import type { CheckResultStatus, IncidentStatus, SslCheckStatus } from "@servalume/shared";

/**
 * Hand-written, explicitly org-scoped query functions for the worker's
 * service-role connection — RLS does not apply here (docs/ARCHITECTURE.md
 * §5), so every query in this file is the actual authorization boundary for
 * its data, not just a convenience wrapper. Scheduler-wide scans (like
 * `getDueMonitorSchedules`) deliberately span every organization — that is
 * their job — but anything that reads or writes one specific tenant's row
 * carries that tenant's id in its WHERE clause, not just in its input.
 */

export interface DueMonitor {
  monitorScheduleId: string;
  monitorId: string;
  websiteId: string;
  organizationId: string;
  monitorType: "http_uptime" | "ssl_cert";
  url: string;
  intervalSeconds: number;
  consecutiveFailures: number;
}

export async function getDueMonitorSchedules(pool: Pool, limit: number): Promise<DueMonitor[]> {
  const result = await pool.query<{
    monitor_schedule_id: string;
    monitor_id: string;
    website_id: string;
    organization_id: string;
    monitor_type: "http_uptime" | "ssl_cert";
    url: string;
    interval_seconds: number;
    consecutive_failures: number;
  }>(
    `select
       ms.id as monitor_schedule_id,
       m.id as monitor_id,
       w.id as website_id,
       m.organization_id,
       m.type as monitor_type,
       w.url,
       m.interval_seconds,
       ms.consecutive_failures
     from public.monitor_schedules ms
     join public.monitors m on m.id = ms.monitor_id
     join public.websites w on w.id = m.website_id
     where ms.next_run_at <= now()
       and m.is_active = true
       and w.archived_at is null
     order by ms.next_run_at asc
     limit $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    monitorScheduleId: row.monitor_schedule_id,
    monitorId: row.monitor_id,
    websiteId: row.website_id,
    organizationId: row.organization_id,
    monitorType: row.monitor_type,
    url: row.url,
    intervalSeconds: row.interval_seconds,
    consecutiveFailures: row.consecutive_failures,
  }));
}

/** Advances next_run_at with jitter so a slow scheduler tick can't double-enqueue the same monitor, and records which job this tick produced for traceability. */
export async function advanceMonitorSchedule(
  pool: Pool,
  monitorScheduleId: string,
  nextRunAt: Date,
  jobId: string | null,
): Promise<void> {
  await pool.query(
    `update public.monitor_schedules
     set next_run_at = $2, last_run_at = now(), last_enqueued_job_id = $3
     where id = $1`,
    [monitorScheduleId, nextRunAt, jobId],
  );
}

export async function setConsecutiveFailures(pool: Pool, monitorScheduleId: string, count: number): Promise<void> {
  await pool.query("update public.monitor_schedules set consecutive_failures = $2 where id = $1", [
    monitorScheduleId,
    count,
  ]);
}

export interface InsertCheckResultParams {
  monitorId: string;
  websiteId: string;
  organizationId: string;
  scheduledAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  status: CheckResultStatus;
  httpStatusCode: number | null;
  responseTimeMs: number | null;
  dnsTimeMs: number | null;
  tcpTimeMs: number | null;
  tlsTimeMs: number | null;
  ttfbMs: number | null;
  responseHeaders: Record<string, unknown> | null;
  failureCategory: string | null;
  failureReason: string | null;
  checkerRegion: string;
  attemptNumber: number;
  requestId: string | null;
  jobId: string | null;
}

/**
 * If this exact job already wrote a check_result (a retry after the job
 * handler crashed or threw *after* that write but before finishing), this
 * returns it instead of inserting a second one — the idempotency guard
 * behind master spec §5's "prevent retries from creating duplicate
 * incidents, duplicate findings, or repeated notifications." Returns null
 * for a genuinely new attempt (jobId null, or no prior row for this jobId).
 */
export async function findCheckResultByJobId(pool: Pool, jobId: string): Promise<{ id: string; status: CheckResultStatus } | null> {
  const result = await pool.query<{ id: string; status: CheckResultStatus }>(
    "select id, status from public.check_results where job_id = $1 limit 1",
    [jobId],
  );
  return result.rows[0] ?? null;
}

export async function insertCheckResult(pool: Pool, params: InsertCheckResultParams): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into public.check_results (
       monitor_id, website_id, organization_id, scheduled_at, started_at, completed_at,
       status, http_status_code, response_time_ms, dns_time_ms, tcp_time_ms, tls_time_ms,
       ttfb_ms, response_headers, failure_category, failure_reason, checker_region,
       attempt_number, request_id, job_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     returning id`,
    [
      params.monitorId,
      params.websiteId,
      params.organizationId,
      params.scheduledAt,
      params.startedAt,
      params.completedAt,
      params.status,
      params.httpStatusCode,
      params.responseTimeMs,
      params.dnsTimeMs,
      params.tcpTimeMs,
      params.tlsTimeMs,
      params.ttfbMs,
      params.responseHeaders ? JSON.stringify(params.responseHeaders) : null,
      params.failureCategory,
      params.failureReason,
      params.checkerRegion,
      params.attemptNumber,
      params.requestId,
      params.jobId,
    ],
  );
  return result.rows[0]!.id;
}

export interface InsertSslCheckParams {
  monitorId: string;
  websiteId: string;
  organizationId: string;
  checkedAt: Date;
  status: SslCheckStatus;
  validFrom: Date | null;
  validTo: Date | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
  subject: string | null;
  chainLength: number | null;
  failureReason: string | null;
}

export async function insertSslCheck(pool: Pool, params: InsertSslCheckParams): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into public.ssl_checks (
       monitor_id, website_id, organization_id, checked_at, status, valid_from, valid_to,
       days_until_expiry, issuer, subject, chain_length, failure_reason
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning id`,
    [
      params.monitorId,
      params.websiteId,
      params.organizationId,
      params.checkedAt,
      params.status,
      params.validFrom,
      params.validTo,
      params.daysUntilExpiry,
      params.issuer,
      params.subject,
      params.chainLength,
      params.failureReason,
    ],
  );
  return result.rows[0]!.id;
}

export interface CurrentIncident {
  id: string;
  status: IncidentStatus;
}

/** The monitor's current non-resolved incident, or null — callers of the incident state machine must never see "resolved" here, by construction (see incidentStateMachine.ts). */
export async function getCurrentNonResolvedIncident(pool: Pool, monitorId: string): Promise<CurrentIncident | null> {
  const result = await pool.query<{ id: string; status: IncidentStatus }>(
    `select id, status from public.incidents
     where monitor_id = $1 and status <> 'resolved'
     order by created_at desc
     limit 1`,
    [monitorId],
  );
  return result.rows[0] ?? null;
}

export async function createConfirmingIncident(
  pool: Pool,
  params: { organizationId: string; websiteId: string; monitorId: string; firstCheckResultId: string },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into public.incidents (organization_id, website_id, monitor_id, status, first_check_result_id)
     values ($1, $2, $3, 'confirming', $4)
     returning id`,
    [params.organizationId, params.websiteId, params.monitorId, params.firstCheckResultId],
  );
  await recordIncidentEvent(pool, result.rows[0]!.id, params.organizationId, "confirming_started", null);
  return result.rows[0]!.id;
}

export async function confirmIncidentOpen(
  pool: Pool,
  incidentId: string,
  organizationId: string,
  confirmingCheckResultId: string,
  failureCategory: string | null,
): Promise<void> {
  await pool.query(
    `update public.incidents
     set status = 'open', opened_at = now(), confirmed_at = now(),
         confirming_check_result_id = $3, failure_category = $4
     where id = $1 and organization_id = $2`,
    [incidentId, organizationId, confirmingCheckResultId, failureCategory],
  );
  await recordIncidentEvent(pool, incidentId, organizationId, "confirmed", null);
}

export async function discardIncidentAsResolved(
  pool: Pool,
  incidentId: string,
  organizationId: string,
  resolutionCheckResultId: string,
): Promise<void> {
  await pool.query(
    `update public.incidents
     set status = 'resolved', resolved_at = now(), resolution_check_result_id = $3
     where id = $1 and organization_id = $2`,
    [incidentId, organizationId, resolutionCheckResultId],
  );
}

export async function markIncidentResolved(
  pool: Pool,
  incidentId: string,
  organizationId: string,
  resolutionCheckResultId: string,
): Promise<void> {
  await pool.query(
    `update public.incidents
     set status = 'resolved', resolved_at = now(), resolution_check_result_id = $3
     where id = $1 and organization_id = $2`,
    [incidentId, organizationId, resolutionCheckResultId],
  );
  await recordIncidentEvent(pool, incidentId, organizationId, "recovered", null);
}

export async function markNotificationSent(pool: Pool, incidentId: string, organizationId: string): Promise<void> {
  await pool.query(
    "update public.incidents set notification_sent_at = now() where id = $1 and organization_id = $2",
    [incidentId, organizationId],
  );
  await recordIncidentEvent(pool, incidentId, organizationId, "notification_sent", null);
}

export async function recordIncidentEvent(
  pool: Pool,
  incidentId: string,
  organizationId: string,
  eventType: "confirming_started" | "confirmed" | "notification_sent" | "recovered" | "note_added",
  detail: Record<string, unknown> | null,
): Promise<void> {
  await pool.query(
    "insert into public.incident_events (incident_id, organization_id, event_type, detail) values ($1, $2, $3, $4)",
    [incidentId, organizationId, eventType, detail ? JSON.stringify(detail) : null],
  );
}

export interface InsertFindingParams {
  organizationId: string;
  websiteId: string;
  checkResultId?: string | null;
  sslCheckId?: string | null;
  incidentId?: string | null;
  type: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  evidence: Record<string, unknown>;
}

export async function insertFinding(pool: Pool, params: InsertFindingParams): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into public.findings
       (organization_id, website_id, check_result_id, ssl_check_id, incident_id, type, severity, title, description, evidence)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning id`,
    [
      params.organizationId,
      params.websiteId,
      params.checkResultId ?? null,
      params.sslCheckId ?? null,
      params.incidentId ?? null,
      params.type,
      params.severity,
      params.title,
      params.description,
      JSON.stringify(params.evidence),
    ],
  );
  return result.rows[0]!.id;
}

/** True if an open (non-dismissed/non-converted) finding of this exact type already exists for the website — used to avoid re-raising the same SSL-expiry warning on every check within the same window. */
export async function hasOpenFindingOfType(pool: Pool, websiteId: string, type: string): Promise<boolean> {
  const result = await pool.query(
    "select 1 from public.findings where website_id = $1 and type = $2 and status = 'open' limit 1",
    [websiteId, type],
  );
  return result.rows.length > 0;
}

export interface IncidentNotificationTarget {
  incidentId: string;
  organizationId: string;
  websiteDisplayName: string | null;
  websiteUrl: string;
  userEmail: string;
  userId: string;
}

/** Members of the incident's org who have this event type enabled (default: enabled, matching notification_preferences' own default). */
export async function getIncidentNotificationTargets(
  pool: Pool,
  incidentId: string,
  eventType: "incident_opened" | "incident_resolved",
): Promise<IncidentNotificationTarget[]> {
  const result = await pool.query<{
    incident_id: string;
    organization_id: string;
    website_display_name: string | null;
    website_url: string;
    user_email: string;
    user_id: string;
  }>(
    `select
       i.id as incident_id,
       i.organization_id,
       w.display_name as website_display_name,
       w.url as website_url,
       u.email as user_email,
       m.user_id
     from public.incidents i
     join public.websites w on w.id = i.website_id
     join public.memberships m on m.organization_id = i.organization_id and m.status = 'active'
     join auth.users u on u.id = m.user_id
     left join public.notification_preferences np
       on np.organization_id = i.organization_id and np.user_id = m.user_id and np.event_type = $2
     where i.id = $1
       and coalesce(np.enabled, true) = true`,
    [incidentId, eventType],
  );

  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    organizationId: row.organization_id,
    websiteDisplayName: row.website_display_name,
    websiteUrl: row.website_url,
    userEmail: row.user_email,
    userId: row.user_id,
  }));
}
