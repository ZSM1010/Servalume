import type { Pool } from "pg";
import type { DueMonitor } from "../src/db/queries.js";

/**
 * Seeds one organization/client/website/monitor directly as the bootstrap
 * Postgres role (not through RLS) — these tests are about job-handler logic
 * against real data, not re-proving RLS, which packages/db's own test suite
 * already covers exhaustively against the same migrations.
 */
export async function seedMonitor(pool: Pool, slug: string, monitorType: "http_uptime" | "ssl_cert" = "http_uptime"): Promise<DueMonitor> {
  const org = await pool.query<{ id: string }>(
    "insert into public.organizations (name, slug) values ($1, $2) returning id",
    [`${slug} org`, slug],
  );
  const orgId = org.rows[0]!.id;

  const client = await pool.query<{ id: string }>(
    "insert into public.clients (organization_id, name) values ($1, $2) returning id",
    [orgId, `${slug} client`],
  );

  const website = await pool.query<{ id: string }>(
    "insert into public.websites (organization_id, client_id, url) values ($1, $2, $3) returning id",
    [orgId, client.rows[0]!.id, `https://${slug}.example.test/`],
  );

  const monitor = await pool.query<{ id: string }>(
    "insert into public.monitors (website_id, organization_id, type, interval_seconds) values ($1, $2, $3, 300) returning id",
    [website.rows[0]!.id, orgId, monitorType],
  );

  return {
    monitorScheduleId: "unused-in-direct-handler-tests",
    monitorId: monitor.rows[0]!.id,
    websiteId: website.rows[0]!.id,
    organizationId: orgId,
    monitorType,
    url: `https://${slug}.example.test/`,
    intervalSeconds: 300,
    consecutiveFailures: 0,
  };
}

export async function getIncidentStatus(pool: Pool, monitorId: string): Promise<string | null> {
  const result = await pool.query<{ status: string }>(
    "select status from public.incidents where monitor_id = $1 order by created_at desc limit 1",
    [monitorId],
  );
  return result.rows[0]?.status ?? null;
}

export async function countCheckResults(pool: Pool, monitorId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from public.check_results where monitor_id = $1",
    [monitorId],
  );
  return Number.parseInt(result.rows[0]!.count, 10);
}
