import { SafeFetchError } from "@servalume/safe-fetch";
import type { SafeFetchResult } from "@servalume/safe-fetch";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMonitorCheck, type SafeFetchFn } from "../src/jobs/monitorCheck.js";
import { countCheckResults, getIncidentStatus, seedMonitor } from "./fixtures.js";
import { startTestPostgres, type TestPostgres } from "./testPostgres.js";

/**
 * Exercises runMonitorCheck against a real Postgres database (see
 * testPostgres.ts) with the safe-fetch call itself faked via dependency
 * injection — the same layered-testing approach used throughout
 * packages/safe-fetch: this is not testing safe-fetch again, it's testing
 * that the incident state machine and DB writes react correctly to whatever
 * safe-fetch reports.
 */

let testPg: TestPostgres;

beforeAll(async () => {
  testPg = await startTestPostgres();
}, 60_000);

afterAll(async () => {
  await testPg?.stop();
});

function fakeSuccess(httpStatusCode = 200): SafeFetchFn {
  return vi.fn(async (): Promise<SafeFetchResult> => ({
    finalUrl: "https://example.test/",
    httpStatusCode,
    headers: {},
    body: Buffer.from("ok"),
    truncated: false,
    redirectChain: [],
    timings: { dnsLookupMs: 1, tcpConnectMs: 1, tlsHandshakeMs: 1, timeToFirstByteMs: 2, totalMs: 3 },
  })) as unknown as SafeFetchFn;
}

function fakeFailure(category: "timeout" | "connection" | "dns" | "blocked" = "connection"): SafeFetchFn {
  return vi.fn(async () => {
    throw new SafeFetchError(category === "blocked" ? "blocked" : category, `simulated ${category} failure`);
  }) as unknown as SafeFetchFn;
}

const baseDeps = (fetcher: SafeFetchFn) => ({
  pool: testPg.pool,
  fetcher,
  checkerRegion: "test-region",
  safeFetchOptions: {},
});

describe("runMonitorCheck: no prior incident", () => {
  it("writes a success check_result and takes no incident action", async () => {
    const monitor = await seedMonitor(testPg.pool, "mc-success");
    const outcome = await runMonitorCheck(baseDeps(fakeSuccess()), monitor, {}, new Date(), `${monitor.monitorId}-job-1`);

    expect(outcome.checkStatus).toBe("success");
    expect(outcome.incidentAction).toEqual({ type: "no_action" });
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBeNull();
  });

  it("creates a confirming incident on the first failure and schedules a confirmation check", async () => {
    const monitor = await seedMonitor(testPg.pool, "mc-first-fail");
    const outcome = await runMonitorCheck(baseDeps(fakeFailure("connection")), monitor, {}, new Date(), `${monitor.monitorId}-job-1`);

    expect(outcome.checkStatus).toBe("error");
    expect(outcome.incidentAction.type).toBe("create_confirming");
    expect(outcome.scheduleConfirmationInSeconds).not.toBeNull();
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("confirming");
  });

  it("maps a timeout to check_results.status = 'timeout'", async () => {
    const monitor = await seedMonitor(testPg.pool, "mc-timeout");
    const outcome = await runMonitorCheck(baseDeps(fakeFailure("timeout")), monitor, {}, new Date(), `${monitor.monitorId}-job-1`);
    expect(outcome.checkStatus).toBe("timeout");
  });

  it("maps a safe-fetch SSRF rejection ('blocked') to failure_category 'other', never silently dropped", async () => {
    const monitor = await seedMonitor(testPg.pool, "mc-blocked");
    await runMonitorCheck(baseDeps(fakeFailure("blocked")), monitor, {}, new Date(), `${monitor.monitorId}-job-1`);

    const row = await testPg.pool.query<{ status: string; failure_category: string }>(
      "select status, failure_category from public.check_results where monitor_id = $1",
      [monitor.monitorId],
    );
    expect(row.rows[0]!.status).toBe("error");
    expect(row.rows[0]!.failure_category).toBe("other");
  });

  it("treats a non-2xx/3xx HTTP status as a failure", async () => {
    const monitor = await seedMonitor(testPg.pool, "mc-500");
    const outcome = await runMonitorCheck(baseDeps(fakeSuccess(500)), monitor, {}, new Date(), `${monitor.monitorId}-job-1`);
    expect(outcome.checkStatus).toBe("failure");
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("confirming");
  });

  it("honors a configured expectedStatusCodes list", async () => {
    const monitor = await seedMonitor(testPg.pool, "mc-expected-404");
    const outcome = await runMonitorCheck(baseDeps(fakeSuccess(404)), monitor, { expectedStatusCodes: [404] }, new Date(), `${monitor.monitorId}-job-1`);
    expect(outcome.checkStatus).toBe("success");
  });
});

describe("runMonitorCheck: full confirm -> open -> resolve cycle", () => {
  it("opens the incident on the second consecutive failure, then resolves it on recovery", async () => {
    const monitor = await seedMonitor(testPg.pool, "mc-cycle");

    const first = await runMonitorCheck(baseDeps(fakeFailure("connection")), monitor, {}, new Date(), `${monitor.monitorId}-job-1`);
    expect(first.incidentAction.type).toBe("create_confirming");
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("confirming");

    const second = await runMonitorCheck(baseDeps(fakeFailure("connection")), monitor, {}, new Date(), `${monitor.monitorId}-job-2`);
    expect(second.incidentAction).toMatchObject({ type: "confirm_open", notify: "incident_opened" });
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("open");

    const third = await runMonitorCheck(baseDeps(fakeFailure("connection")), monitor, {}, new Date(), `${monitor.monitorId}-job-3`);
    expect(third.incidentAction).toEqual({ type: "no_action" });
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("open");

    const fourth = await runMonitorCheck(baseDeps(fakeSuccess()), monitor, {}, new Date(), `${monitor.monitorId}-job-4`);
    expect(fourth.incidentAction).toMatchObject({ type: "mark_resolved", notify: "incident_resolved" });
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("resolved");

    // A fresh failure after resolution starts a brand new confirming cycle,
    // not a reopening of the resolved incident.
    const fifth = await runMonitorCheck(baseDeps(fakeFailure("connection")), monitor, {}, new Date(), `${monitor.monitorId}-job-5`);
    expect(fifth.incidentAction.type).toBe("create_confirming");
  });

  it("discards as resolved (no notification) when the confirmation check turns out to succeed", async () => {
    const monitor = await seedMonitor(testPg.pool, "mc-flaky");

    await runMonitorCheck(baseDeps(fakeFailure("connection")), monitor, {}, new Date(), `${monitor.monitorId}-job-1`);
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("confirming");

    const outcome = await runMonitorCheck(baseDeps(fakeSuccess()), monitor, {}, new Date(), `${monitor.monitorId}-job-2`);
    expect(outcome.incidentAction).toEqual({ type: "discard_as_resolved" });
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("resolved");
  });
});

describe("runMonitorCheck: retry idempotency", () => {
  it("does not write a second check_result or re-run incident logic when retried with the same jobId", async () => {
    const monitor = await seedMonitor(testPg.pool, "mc-retry");

    await runMonitorCheck(baseDeps(fakeFailure("connection")), monitor, {}, new Date(), "same-job-id");
    expect(await countCheckResults(testPg.pool, monitor.monitorId)).toBe(1);
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("confirming");

    // Simulate pg-boss retrying the identical job (same jobId) — a naive
    // re-run would see currentIncidentStatus "confirming" and incorrectly
    // escalate to "open" on what is actually the same single failure, not a
    // second one.
    const retryOutcome = await runMonitorCheck(baseDeps(fakeFailure("connection")), monitor, {}, new Date(), "same-job-id");

    expect(await countCheckResults(testPg.pool, monitor.monitorId)).toBe(1);
    expect(retryOutcome.incidentAction).toEqual({ type: "no_action" });
    expect(await getIncidentStatus(testPg.pool, monitor.monitorId)).toBe("confirming");
  });
});
