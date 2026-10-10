import type { Pool } from "pg";
import type { checkSsl, SslCheckOptions } from "@servalume/safe-fetch";
import { FINDING_RULES, sslExpiryFindingType } from "@servalume/shared";
import type { SslCheckStatus } from "@servalume/shared";
import { hasOpenFindingOfType, insertFinding, insertSslCheck, type DueMonitor } from "../db/queries.js";

export type CheckSslFn = typeof checkSsl;

export interface SslCheckDeps {
  pool: Pool;
  checker: CheckSslFn;
  sslCheckOptions: SslCheckOptions;
}

function hostnameFromUrl(url: string): string {
  return new URL(url).hostname;
}

/**
 * Maps the technical result to the DB's status enum, which includes
 * "expiring_soon" — a business-rule upgrade of "valid" that
 * packages/safe-fetch's checkSsl() deliberately does not decide itself (see
 * its own module comment). The finding thresholds (30/14/7 days) live in
 * @servalume/shared, not duplicated here.
 */
function toDbStatus(technicalStatus: string, daysUntilExpiry: number | null): SslCheckStatus {
  if (technicalStatus === "valid" && daysUntilExpiry !== null && sslExpiryFindingType(daysUntilExpiry) !== null) {
    return "expiring_soon";
  }
  return technicalStatus as SslCheckStatus;
}

export async function runSslCheck(deps: SslCheckDeps, due: DueMonitor): Promise<{ sslCheckId: string; status: SslCheckStatus }> {
  const hostname = hostnameFromUrl(due.url);
  const result = await deps.checker(hostname, deps.sslCheckOptions);
  const checkedAt = new Date();

  const status = toDbStatus(result.status, result.daysUntilExpiry);

  const sslCheckId = await insertSslCheck(deps.pool, {
    monitorId: due.monitorId,
    websiteId: due.websiteId,
    organizationId: due.organizationId,
    checkedAt,
    status,
    validFrom: result.validFrom,
    validTo: result.validTo,
    daysUntilExpiry: result.daysUntilExpiry,
    issuer: result.issuer,
    subject: result.subject,
    chainLength: result.chainLength,
    failureReason: result.failureReason,
  });

  await maybeRaiseFinding(deps.pool, due, result, sslCheckId);

  return { sslCheckId, status };
}

async function maybeRaiseFinding(
  pool: Pool,
  due: DueMonitor,
  result: { status: string; daysUntilExpiry: number | null; validTo: Date | null; failureReason: string | null },
  sslCheckId: string,
): Promise<void> {
  let findingType: keyof typeof FINDING_RULES | null = null;

  if (result.status === "expired") {
    findingType = "ssl_expired";
  } else if (result.status === "hostname_mismatch") {
    findingType = "ssl_hostname_mismatch";
  } else if (result.status === "untrusted_chain") {
    findingType = "ssl_untrusted_chain";
  } else if (result.status === "valid" && result.daysUntilExpiry !== null) {
    findingType = sslExpiryFindingType(result.daysUntilExpiry);
  }

  if (!findingType) return;

  // Avoid re-raising the identical warning on every check within the same
  // window — a new, more urgent finding type (e.g. 14d after 30d already
  // fired) is still raised, since that is new information.
  if (await hasOpenFindingOfType(pool, due.websiteId, findingType)) return;

  const rule = FINDING_RULES[findingType];
  const evidence = {
    validTo: result.validTo?.toISOString() ?? null,
    daysUntilExpiry: result.daysUntilExpiry,
    failureReason: result.failureReason,
  };

  await insertFinding(pool, {
    organizationId: due.organizationId,
    websiteId: due.websiteId,
    sslCheckId,
    type: rule.id,
    severity: rule.severity,
    title: rule.title(evidence),
    description: rule.description(evidence),
    evidence,
  });
}
