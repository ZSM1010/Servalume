import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { advanceMonitorSchedule, getDueMonitorSchedules } from "./db/queries.js";

/**
 * Durable scheduled execution with bounded concurrency and scheduling jitter
 * (master spec §5). Idempotency has two independent layers, deliberately:
 * advancing `next_run_at` immediately (so a slow tick can't re-select the
 * same monitor before the next legitimate due time) AND pg-boss's own
 * `singletonKey`/`singletonSeconds` (so even a genuine double-enqueue within
 * the same due window — e.g. two scheduler instances racing — only ever
 * admits one job). Confirmed directly against a real pg-boss/Postgres
 * instance that a duplicate `send()` with the same key returns `null`
 * rather than queuing a second job.
 */

const MAX_JITTER_MS = 10_000;
/** How much earlier than the monitor's own interval the singleton window closes — leaves room for the next legitimate tick to get through. */
const SINGLETON_WINDOW_SAFETY_MARGIN_SECONDS = 5;

export interface MonitorCheckJobPayload {
  monitorScheduleId: string;
  monitorId: string;
  websiteId: string;
  organizationId: string;
  url: string;
  scheduledAt: string;
}

export function jobNameForMonitorType(monitorType: "http_uptime" | "ssl_cert"): "monitor.check" | "ssl.check" {
  return monitorType === "http_uptime" ? "monitor.check" : "ssl.check";
}

export interface SchedulerTickResult {
  dueCount: number;
  enqueued: number;
  deduplicated: number;
}

export async function runSchedulerTick(pool: Pool, boss: PgBoss, batchSize: number): Promise<SchedulerTickResult> {
  const due = await getDueMonitorSchedules(pool, batchSize);

  let enqueued = 0;
  let deduplicated = 0;

  for (const monitor of due) {
    const jobName = jobNameForMonitorType(monitor.monitorType);
    const scheduledAt = new Date();

    const payload: MonitorCheckJobPayload = {
      monitorScheduleId: monitor.monitorScheduleId,
      monitorId: monitor.monitorId,
      websiteId: monitor.websiteId,
      organizationId: monitor.organizationId,
      url: monitor.url,
      scheduledAt: scheduledAt.toISOString(),
    };

    const singletonSeconds = Math.max(10, monitor.intervalSeconds - SINGLETON_WINDOW_SAFETY_MARGIN_SECONDS);
    const jobId = await boss.send(jobName, payload, {
      singletonKey: `${jobName}:${monitor.monitorScheduleId}`,
      singletonSeconds,
    });

    if (jobId) enqueued++;
    else deduplicated++;

    const jitterMs = Math.floor(Math.random() * MAX_JITTER_MS);
    const nextRunAt = new Date(scheduledAt.getTime() + monitor.intervalSeconds * 1000 + jitterMs);
    await advanceMonitorSchedule(pool, monitor.monitorScheduleId, nextRunAt, jobId);
  }

  return { dueCount: due.length, enqueued, deduplicated };
}
