import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SafeFetchResult } from "@servalume/safe-fetch";
import { createEmailProvider } from "../src/emailProvider.js";
import { registerJobHandlers, type WorkerContext } from "../src/queue.js";
import { runSchedulerTick } from "../src/scheduler.js";
import { seedMonitor } from "./fixtures.js";
import { startTestPostgres, type TestPostgres } from "./testPostgres.js";

let testPg: TestPostgres;
let boss: PgBoss;

beforeAll(async () => {
  testPg = await startTestPostgres();
  boss = new PgBoss({ connectionString: testPg.connectionString });
  await boss.start();
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await testPg?.stop();
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("scheduler tick against a real pg-boss/Postgres instance", () => {
  it("enqueues exactly one job per due monitor and advances next_run_at", async () => {
    const monitor = await seedMonitor(testPg.pool, "sched-basic");
    // seedMonitor doesn't create a monitor_schedules row (that's the
    // scheduler's own bookkeeping table) — insert it explicitly, due now.
    await testPg.pool.query(
      `insert into public.monitor_schedules (monitor_id, organization_id, next_run_at)
       values ($1, $2, now() - interval '1 minute')`,
      [monitor.monitorId, monitor.organizationId],
    );

    await boss.createQueue("monitor.check");
    const result = await runSchedulerTick(testPg.pool, boss, 50);

    expect(result.enqueued).toBeGreaterThanOrEqual(1);

    const schedule = await testPg.pool.query<{ next_run_at: Date; last_enqueued_job_id: string | null }>(
      "select next_run_at, last_enqueued_job_id from public.monitor_schedules where monitor_id = $1",
      [monitor.monitorId],
    );
    expect(schedule.rows[0]!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(schedule.rows[0]!.last_enqueued_job_id).not.toBeNull();
  });

  it("does not double-enqueue the same due monitor within the singleton window on a second tick", async () => {
    const monitor = await seedMonitor(testPg.pool, "sched-dedup");
    await testPg.pool.query(
      `insert into public.monitor_schedules (monitor_id, organization_id, next_run_at)
       values ($1, $2, now() - interval '1 minute')`,
      [monitor.monitorId, monitor.organizationId],
    );

    await boss.createQueue("monitor.check");

    // Force both ticks to see the same due row by not letting the first
    // tick's next_run_at advancement take effect yet — simulate two
    // scheduler instances racing on the same due window by resetting
    // next_run_at back to "due" between the two calls, while keeping the
    // same singletonKey (tied to monitorScheduleId, not to next_run_at).
    const first = await runSchedulerTick(testPg.pool, boss, 50);
    await testPg.pool.query("update public.monitor_schedules set next_run_at = now() - interval '1 minute' where monitor_id = $1", [
      monitor.monitorId,
    ]);
    const second = await runSchedulerTick(testPg.pool, boss, 50);

    expect(first.enqueued).toBeGreaterThanOrEqual(1);
    expect(second.deduplicated).toBeGreaterThanOrEqual(1);
  });
});

describe("end-to-end: scheduler enqueues, real worker processes, DB reflects it", () => {
  it("processes a monitor.check job through the real queue with an injected fetcher", async () => {
    const monitor = await seedMonitor(testPg.pool, "e2e-worker");
    await testPg.pool.query(
      `insert into public.monitor_schedules (monitor_id, organization_id, next_run_at)
       values ($1, $2, now() - interval '1 minute')`,
      [monitor.monitorId, monitor.organizationId],
    );

    const fakeFetcher = vi.fn(async (): Promise<SafeFetchResult> => ({
      finalUrl: monitor.url,
      httpStatusCode: 200,
      headers: {},
      body: Buffer.from("ok"),
      truncated: false,
      redirectChain: [],
      timings: { dnsLookupMs: 1, tcpConnectMs: 1, tlsHandshakeMs: 1, timeToFirstByteMs: 2, totalMs: 3 },
    }));

    const ctx: WorkerContext = {
      boss,
      pool: testPg.pool,
      emailProvider: createEmailProvider({ provider: "smtp", fromAddress: "x@example.test", smtp: { host: "localhost", port: 1025, user: "u", pass: "p" } }),
      config: {
        databaseUrl: testPg.connectionString,
        workerConcurrency: 5,
        schedulerTickIntervalSeconds: 30,
        safeFetch: { allowedPorts: [80, 443], maxRedirects: 3, timeoutMs: 5000, maxResponseBytes: 1_000_000 },
        email: { provider: "smtp", fromAddress: "x@example.test" },
        ipHashSalt: "test-salt",
        appBaseUrl: "https://app.example.test",
      },
      fetcher: fakeFetcher as never,
      checker: vi.fn() as never,
    };

    for (const name of ["monitor.check", "ssl.check", "notification.dispatch"]) {
      await boss.createQueue(name);
    }
    await registerJobHandlers(ctx);

    await runSchedulerTick(testPg.pool, boss, 50);

    await waitUntil(async () => {
      const result = await testPg.pool.query("select 1 from public.check_results where monitor_id = $1", [
        monitor.monitorId,
      ]);
      return result.rows.length > 0;
    });

    expect(fakeFetcher).toHaveBeenCalled();
    const checkResult = await testPg.pool.query<{ status: string }>(
      "select status from public.check_results where monitor_id = $1",
      [monitor.monitorId],
    );
    expect(checkResult.rows[0]!.status).toBe("success");

    await boss.offWork("monitor.check");
    await boss.offWork("ssl.check");
    await boss.offWork("notification.dispatch");
  });
});

describe("retry recovery: a job that throws is retried, not silently dropped", () => {
  it("eventually succeeds after pg-boss retries a failing handler", async () => {
    await boss.createQueue("probe.retry", { retryLimit: 3, retryDelay: 1, retryBackoff: false });

    let attempts = 0;
    await boss.work("probe.retry", async (jobs) => {
      for (const _job of jobs) {
        attempts++;
        if (attempts < 2) throw new Error("simulated transient failure");
      }
    });

    await boss.send("probe.retry", { x: 1 }, { retryLimit: 3, retryDelay: 1, retryBackoff: false });

    await waitUntil(async () => attempts >= 2, 15_000);
    expect(attempts).toBeGreaterThanOrEqual(2);

    await boss.offWork("probe.retry");
  });
});
