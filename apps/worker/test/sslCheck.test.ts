import type { SslCheckResult } from "@servalume/safe-fetch";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CheckSslFn } from "../src/jobs/sslCheck.js";
import { runSslCheck } from "../src/jobs/sslCheck.js";
import { seedMonitor } from "./fixtures.js";
import { startTestPostgres, type TestPostgres } from "./testPostgres.js";

let testPg: TestPostgres;

beforeAll(async () => {
  testPg = await startTestPostgres();
}, 60_000);

afterAll(async () => {
  await testPg?.stop();
});

function fakeChecker(result: Partial<SslCheckResult>): CheckSslFn {
  const full: SslCheckResult = {
    status: "valid",
    validFrom: null,
    validTo: null,
    daysUntilExpiry: null,
    issuer: null,
    subject: null,
    chainLength: null,
    failureReason: null,
    ...result,
  };
  return vi.fn(async () => full) as unknown as CheckSslFn;
}

async function findingTypesFor(pool: TestPostgres["pool"], websiteId: string): Promise<string[]> {
  const result = await pool.query<{ type: string }>("select type from public.findings where website_id = $1", [
    websiteId,
  ]);
  return result.rows.map((r) => r.type);
}

describe("runSslCheck", () => {
  it("records a valid certificate with no finding", async () => {
    const monitor = await seedMonitor(testPg.pool, "ssl-valid", "ssl_cert");
    const outcome = await runSslCheck(
      { pool: testPg.pool, checker: fakeChecker({ status: "valid", daysUntilExpiry: 200 }), sslCheckOptions: {} },
      monitor,
    );
    expect(outcome.status).toBe("valid");
    expect(await findingTypesFor(testPg.pool, monitor.websiteId)).toEqual([]);
  });

  it("upgrades status to expiring_soon and raises the matching threshold finding", async () => {
    const monitor = await seedMonitor(testPg.pool, "ssl-expiring-14", "ssl_cert");
    const outcome = await runSslCheck(
      {
        pool: testPg.pool,
        checker: fakeChecker({ status: "valid", daysUntilExpiry: 10, validTo: new Date() }),
        sslCheckOptions: {},
      },
      monitor,
    );
    expect(outcome.status).toBe("expiring_soon");
    expect(await findingTypesFor(testPg.pool, monitor.websiteId)).toEqual(["ssl_expiring_14d"]);
  });

  it("does not raise a duplicate finding of the same type on a second check in the same window", async () => {
    const monitor = await seedMonitor(testPg.pool, "ssl-expiring-dup", "ssl_cert");
    const deps = {
      pool: testPg.pool,
      checker: fakeChecker({ status: "valid", daysUntilExpiry: 25, validTo: new Date() }),
      sslCheckOptions: {},
    };
    await runSslCheck(deps, monitor);
    await runSslCheck(deps, monitor);

    expect(await findingTypesFor(testPg.pool, monitor.websiteId)).toEqual(["ssl_expiring_30d"]);
  });

  it("raises a more urgent finding when expiry moves from 30d to 7d, without duplicating", async () => {
    const monitor = await seedMonitor(testPg.pool, "ssl-expiring-escalate", "ssl_cert");
    await runSslCheck(
      { pool: testPg.pool, checker: fakeChecker({ status: "valid", daysUntilExpiry: 25 }), sslCheckOptions: {} },
      monitor,
    );
    await runSslCheck(
      { pool: testPg.pool, checker: fakeChecker({ status: "valid", daysUntilExpiry: 5 }), sslCheckOptions: {} },
      monitor,
    );

    const types = await findingTypesFor(testPg.pool, monitor.websiteId);
    expect(types).toContain("ssl_expiring_30d");
    expect(types).toContain("ssl_expiring_7d");
    expect(types).toHaveLength(2);
  });

  it("records an expired certificate and raises ssl_expired", async () => {
    const monitor = await seedMonitor(testPg.pool, "ssl-expired", "ssl_cert");
    const outcome = await runSslCheck(
      { pool: testPg.pool, checker: fakeChecker({ status: "expired", daysUntilExpiry: -5 }), sslCheckOptions: {} },
      monitor,
    );
    expect(outcome.status).toBe("expired");
    expect(await findingTypesFor(testPg.pool, monitor.websiteId)).toEqual(["ssl_expired"]);
  });

  it("records a hostname mismatch and raises ssl_hostname_mismatch", async () => {
    const monitor = await seedMonitor(testPg.pool, "ssl-mismatch", "ssl_cert");
    const outcome = await runSslCheck(
      { pool: testPg.pool, checker: fakeChecker({ status: "hostname_mismatch" }), sslCheckOptions: {} },
      monitor,
    );
    expect(outcome.status).toBe("hostname_mismatch");
    expect(await findingTypesFor(testPg.pool, monitor.websiteId)).toEqual(["ssl_hostname_mismatch"]);
  });

  it("records an untrusted chain and raises ssl_untrusted_chain", async () => {
    const monitor = await seedMonitor(testPg.pool, "ssl-untrusted", "ssl_cert");
    const outcome = await runSslCheck(
      { pool: testPg.pool, checker: fakeChecker({ status: "untrusted_chain" }), sslCheckOptions: {} },
      monitor,
    );
    expect(outcome.status).toBe("untrusted_chain");
    expect(await findingTypesFor(testPg.pool, monitor.websiteId)).toEqual(["ssl_untrusted_chain"]);
  });

  it("records unreachable with no finding — unreachable is not itself a certificate diagnosis", async () => {
    const monitor = await seedMonitor(testPg.pool, "ssl-unreachable", "ssl_cert");
    const outcome = await runSslCheck(
      { pool: testPg.pool, checker: fakeChecker({ status: "unreachable", failureReason: "connection refused" }), sslCheckOptions: {} },
      monitor,
    );
    expect(outcome.status).toBe("unreachable");
    expect(await findingTypesFor(testPg.pool, monitor.websiteId)).toEqual([]);
  });
});
