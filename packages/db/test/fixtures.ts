import type { PGlite } from "@electric-sql/pglite";
import { asAuthenticatedUser, asServiceRole } from "./supabaseShim.js";
import { createTestAuthUser } from "./testDb.js";

export interface OrgFixture {
  orgId: string;
  ownerId: string;
}

/** Creates one organization with one owner user, via the same create_organization() RPC the real app uses — not a direct INSERT, since organizations has no INSERT policy for authenticated by design. */
export async function seedOrg(db: PGlite, slug: string): Promise<OrgFixture> {
  const ownerId = await createTestAuthUser(db, `${slug}@example.test`);
  const orgId = await asAuthenticatedUser(db, ownerId, async () => {
    const result = await db.query<{ id: string }>("select public.create_organization($1, $2) as id", [
      `${slug} org`,
      slug,
    ]);
    return result.rows[0]!.id;
  });
  return { orgId, ownerId };
}

export interface ClientWebsiteFixture {
  clientId: string;
  websiteId: string;
  monitorId: string;
}

/** Seeds one client + website + monitor for an org, acting as the org's owner (service role is simpler for fixture setup, but acting as the owner also exercises the INSERT policies as a side effect). */
export async function seedClientWebsiteMonitor(
  db: PGlite,
  org: OrgFixture,
  slug: string,
): Promise<ClientWebsiteFixture> {
  return asAuthenticatedUser(db, org.ownerId, async () => {
    const client = await db.query<{ id: string }>(
      "insert into public.clients (organization_id, name) values ($1, $2) returning id",
      [org.orgId, `${slug} client`],
    );
    const website = await db.query<{ id: string }>(
      "insert into public.websites (organization_id, client_id, url) values ($1, $2, $3) returning id",
      [org.orgId, client.rows[0]!.id, `https://${slug}.example.test/`],
    );
    const monitor = await db.query<{ id: string }>(
      `insert into public.monitors (website_id, organization_id, type, interval_seconds)
       values ($1, $2, 'http_uptime', 300) returning id`,
      [website.rows[0]!.id, org.orgId],
    );
    return {
      clientId: client.rows[0]!.id,
      websiteId: website.rows[0]!.id,
      monitorId: monitor.rows[0]!.id,
    };
  });
}

/**
 * The tables below are, in production, written exclusively by the worker via
 * the service role (see docs/DATA_MODEL.md and 0010_row_level_security.sql's
 * grants) — so seeding them as service_role for test setup mirrors how the
 * data actually gets there, rather than working around a policy that isn't
 * meant to allow it.
 */

export async function seedCheckResult(
  db: PGlite,
  org: OrgFixture,
  fixture: ClientWebsiteFixture,
  status: "success" | "failure" = "success",
): Promise<string> {
  return asServiceRole(db, async () => {
    const result = await db.query<{ id: string }>(
      `insert into public.check_results
         (monitor_id, website_id, organization_id, scheduled_at, status, checker_region)
       values ($1, $2, $3, now(), $4, 'local-test')
       returning id`,
      [fixture.monitorId, fixture.websiteId, org.orgId, status],
    );
    return result.rows[0]!.id;
  });
}

export async function seedIncident(
  db: PGlite,
  org: OrgFixture,
  fixture: ClientWebsiteFixture,
  checkResultId: string,
): Promise<string> {
  return asServiceRole(db, async () => {
    const result = await db.query<{ id: string }>(
      `insert into public.incidents
         (organization_id, website_id, monitor_id, status, first_check_result_id, opened_at)
       values ($1, $2, $3, 'open', $4, now())
       returning id`,
      [org.orgId, fixture.websiteId, fixture.monitorId, checkResultId],
    );
    return result.rows[0]!.id;
  });
}

export async function seedFinding(
  db: PGlite,
  org: OrgFixture,
  fixture: ClientWebsiteFixture,
): Promise<string> {
  return asServiceRole(db, async () => {
    const result = await db.query<{ id: string }>(
      `insert into public.findings (organization_id, website_id, type, severity, title, description)
       values ($1, $2, 'http_non_2xx', 'medium', 'Test finding', 'Test description')
       returning id`,
      [org.orgId, fixture.websiteId],
    );
    return result.rows[0]!.id;
  });
}

export async function seedWorkItem(
  db: PGlite,
  org: OrgFixture,
  fixture: ClientWebsiteFixture,
): Promise<string> {
  return asServiceRole(db, async () => {
    const result = await db.query<{ id: string }>(
      `insert into public.work_items (organization_id, client_id, website_id, title)
       values ($1, $2, $3, 'Test work item')
       returning id`,
      [org.orgId, fixture.clientId, fixture.websiteId],
    );
    return result.rows[0]!.id;
  });
}

export async function seedReport(db: PGlite, org: OrgFixture): Promise<string> {
  return asServiceRole(db, async () => {
    const result = await db.query<{ id: string }>(
      `insert into public.reports (organization_id, period_start, period_end, status)
       values ($1, '2026-01-01', '2026-01-31', 'generated')
       returning id`,
      [org.orgId],
    );
    return result.rows[0]!.id;
  });
}

export async function seedSubscription(db: PGlite, org: OrgFixture, plan = "solo"): Promise<string> {
  return asServiceRole(db, async () => {
    const result = await db.query<{ id: string }>(
      `insert into public.subscriptions (organization_id, plan, status)
       values ($1, $2, 'active')
       returning id`,
      [org.orgId, plan],
    );
    return result.rows[0]!.id;
  });
}

export async function seedAuditEvent(db: PGlite, org: OrgFixture): Promise<string> {
  return asServiceRole(db, async () => {
    const result = await db.query<{ id: string }>(
      `insert into public.audit_events (organization_id, actor_type, action)
       values ($1, 'system', 'test.event')
       returning id`,
      [org.orgId],
    );
    return result.rows[0]!.id;
  });
}
