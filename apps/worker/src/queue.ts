import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import type { safeFetch as SafeFetchFn, checkSsl as CheckSslFn } from "@servalume/safe-fetch";
import { safeFetch, checkSsl } from "@servalume/safe-fetch";
import type { WorkerConfig } from "./config.js";
import { createEmailProvider, type EmailProvider } from "./emailProvider.js";
import { logger } from "./logger.js";
import { dispatchIncidentNotification } from "./jobs/notificationDispatch.js";
import { runMonitorCheck } from "./jobs/monitorCheck.js";
import { runSslCheck } from "./jobs/sslCheck.js";
import type { MonitorCheckJobPayload } from "./scheduler.js";

export const QUEUE_NAMES = ["monitor.check", "ssl.check", "notification.dispatch"] as const;

export interface NotificationDispatchJobPayload {
  incidentId: string;
  organizationId: string;
  eventType: "incident_opened" | "incident_resolved";
}

export interface WorkerContext {
  boss: PgBoss;
  pool: Pool;
  emailProvider: EmailProvider;
  config: WorkerConfig;
  fetcher: typeof SafeFetchFn;
  checker: typeof CheckSslFn;
}

export async function createWorkerContext(config: WorkerConfig): Promise<WorkerContext> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const boss = new PgBoss({ connectionString: config.databaseUrl });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));

  await boss.start();
  for (const name of QUEUE_NAMES) {
    await boss.createQueue(name);
  }

  return {
    boss,
    pool,
    emailProvider: createEmailProvider(config.email),
    config,
    fetcher: safeFetch,
    checker: checkSsl,
  };
}

/** Registers every job handler. Separated from createWorkerContext so tests can construct a context and register only the handlers they're exercising. */
export async function registerJobHandlers(ctx: WorkerContext): Promise<void> {
  await ctx.boss.work<MonitorCheckJobPayload>("monitor.check", { batchSize: ctx.config.workerConcurrency }, async (jobs) => {
    for (const job of jobs) {
      const log = logger.child({ jobName: "monitor.check", jobId: job.id, monitorId: job.data.monitorId });
      try {
        const outcome = await runMonitorCheck(
          {
            pool: ctx.pool,
            fetcher: ctx.fetcher,
            checkerRegion: "local",
            safeFetchOptions: {
              allowedPorts: ctx.config.safeFetch.allowedPorts,
              maxRedirects: ctx.config.safeFetch.maxRedirects,
              timeoutMs: ctx.config.safeFetch.timeoutMs,
              maxResponseBytes: ctx.config.safeFetch.maxResponseBytes,
            },
          },
          {
            monitorScheduleId: job.data.monitorScheduleId,
            monitorId: job.data.monitorId,
            websiteId: job.data.websiteId,
            organizationId: job.data.organizationId,
            monitorType: "http_uptime",
            url: job.data.url,
            intervalSeconds: 0,
            consecutiveFailures: 0,
          },
          {},
          new Date(job.data.scheduledAt),
          job.id,
        );

        log.info({ status: outcome.checkStatus, incidentAction: outcome.incidentAction.type }, "monitor check completed");

        if (outcome.scheduleConfirmationInSeconds !== null) {
          await ctx.boss.sendAfter(
            "monitor.check",
            job.data,
            { singletonKey: `monitor.check:confirm:${job.data.monitorScheduleId}` },
            outcome.scheduleConfirmationInSeconds,
          );
        }

        const action = outcome.incidentAction;
        if ((action.type === "confirm_open" || action.type === "mark_resolved") && outcome.incidentId) {
          await ctx.boss.send(
            "notification.dispatch",
            {
              incidentId: outcome.incidentId,
              organizationId: job.data.organizationId,
              eventType: action.notify,
            } satisfies NotificationDispatchJobPayload,
            { singletonKey: `notification.dispatch:${outcome.incidentId}:${action.notify}` },
          );
        }
      } catch (err) {
        log.error({ err }, "monitor check job failed");
        throw err;
      }
    }
  });

  await ctx.boss.work<MonitorCheckJobPayload>("ssl.check", { batchSize: ctx.config.workerConcurrency }, async (jobs) => {
    for (const job of jobs) {
      const log = logger.child({ jobName: "ssl.check", jobId: job.id, monitorId: job.data.monitorId });
      try {
        const result = await runSslCheck(
          {
            pool: ctx.pool,
            checker: ctx.checker,
            sslCheckOptions: { timeoutMs: ctx.config.safeFetch.timeoutMs },
          },
          {
            monitorScheduleId: job.data.monitorScheduleId,
            monitorId: job.data.monitorId,
            websiteId: job.data.websiteId,
            organizationId: job.data.organizationId,
            monitorType: "ssl_cert",
            url: job.data.url,
            intervalSeconds: 0,
            consecutiveFailures: 0,
          },
        );
        log.info({ status: result.status }, "ssl check completed");
      } catch (err) {
        log.error({ err }, "ssl check job failed");
        throw err;
      }
    }
  });

  await ctx.boss.work<NotificationDispatchJobPayload>(
    "notification.dispatch",
    { batchSize: ctx.config.workerConcurrency },
    async (jobs) => {
      for (const job of jobs) {
        const log = logger.child({ jobName: "notification.dispatch", jobId: job.id, incidentId: job.data.incidentId });
        try {
          const result = await dispatchIncidentNotification(
            { pool: ctx.pool, emailProvider: ctx.emailProvider, appBaseUrl: ctx.config.appBaseUrl },
            job.data,
          );
          log.info(result, "notification dispatch completed");
        } catch (err) {
          log.error({ err }, "notification dispatch job failed");
          throw err;
        }
      }
    },
  );
}
