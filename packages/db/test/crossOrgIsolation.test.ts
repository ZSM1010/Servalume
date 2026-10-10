import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  seedAuditEvent,
  seedCheckResult,
  seedClientWebsiteMonitor,
  seedFinding,
  seedIncident,
  seedOrg,
  seedReport,
  seedSubscription,
  seedWorkItem,
  type ClientWebsiteFixture,
  type OrgFixture,
} from "./fixtures.js";
import { asAnon, asAuthenticatedUser, asServiceRole } from "./supabaseShim.js";
import { createTestDb } from "./testDb.js";

/**
 * Attempts to read/modify/delete another organization's records, per master
 * spec §4: "Write automated tests attempting to read, modify, delete,
 * approve and generate reports for another organization's records."
 *
 * Every assertion here exercises the actual RLS policies in
 * 0010_row_level_security.sql against a real Postgres engine (PGlite) — not
 * a mock of them.
 */

let db: PGlite;
let orgA: OrgFixture;
let orgB: OrgFixture;
let fixtureA: ClientWebsiteFixture;
let fixtureB: ClientWebsiteFixture;

beforeAll(async () => {
  db = await createTestDb();
  orgA = await seedOrg(db, "org-a");
  orgB = await seedOrg(db, "org-b");
  fixtureA = await seedClientWebsiteMonitor(db, orgA, "site-a");
  fixtureB = await seedClientWebsiteMonitor(db, orgB, "site-b");
});

afterAll(async () => {
  await db.close();
});

describe("clients/websites/monitors: org A cannot see or touch org B's rows", () => {
  it("org A's SELECT on clients excludes org B's client", async () => {
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.clients where id = $1", [fixtureB.clientId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org A's UPDATE on org B's website affects zero rows and does not change it", async () => {
    const updateResult = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("update public.websites set display_name = 'hijacked' where id = $1", [fixtureB.websiteId]),
    );
    expect(updateResult.affectedRows ?? 0).toBe(0);

    const actual = await asServiceRole(db, () =>
      db.query<{ display_name: string | null }>("select display_name from public.websites where id = $1", [
        fixtureB.websiteId,
      ]),
    );
    expect(actual.rows[0]!.display_name).not.toBe("hijacked");
  });

  it("org A's DELETE on org B's monitor affects zero rows and does not delete it", async () => {
    const deleteResult = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("delete from public.monitors where id = $1", [fixtureB.monitorId]),
    );
    expect(deleteResult.affectedRows ?? 0).toBe(0);

    const stillThere = await asServiceRole(db, () =>
      db.query("select id from public.monitors where id = $1", [fixtureB.monitorId]),
    );
    expect(stillThere.rows).toHaveLength(1);
  });

  it("org A cannot INSERT a monitor that points at org B's website", async () => {
    // Even with organization_id correctly set to org A's own id (satisfying
    // the RLS WITH CHECK), the cross-org integrity trigger must still reject
    // this — a work item/monitor can't straddle two organizations.
    await expect(
      asAuthenticatedUser(db, orgA.ownerId, () =>
        db.query(
          `insert into public.monitors (website_id, organization_id, type, interval_seconds)
           values ($1, $2, 'http_uptime', 300)`,
          [fixtureB.websiteId, orgA.orgId],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("measurements and findings (service-role-written, member-readable): cross-org denied", () => {
  it("org A cannot see org B's check_results", async () => {
    const checkResultB = await seedCheckResult(db, orgB, fixtureB);
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.check_results where id = $1", [checkResultB]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org A cannot see org B's incidents", async () => {
    const checkResultB = await seedCheckResult(db, orgB, fixtureB, "failure");
    const incidentB = await seedIncident(db, orgB, fixtureB, checkResultB);
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.incidents where id = $1", [incidentB]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org A cannot see org B's findings", async () => {
    const findingB = await seedFinding(db, orgB, fixtureB);
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.findings where id = $1", [findingB]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org A CAN see its own findings (the policy isn't just denying everything)", async () => {
    const findingA = await seedFinding(db, orgA, fixtureA);
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.findings where id = $1", [findingA]),
    );
    expect(rows.rows).toHaveLength(1);
  });
});

describe("work items and work logs: cross-org denied", () => {
  it("org A cannot see org B's work item", async () => {
    const workItemB = await seedWorkItem(db, orgB, fixtureB);
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.work_items where id = $1", [workItemB]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org A cannot change the status of org B's work item", async () => {
    const workItemB = await seedWorkItem(db, orgB, fixtureB);
    const updateResult = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("update public.work_items set status = 'closed' where id = $1", [workItemB]),
    );
    expect(updateResult.affectedRows ?? 0).toBe(0);
  });

  it("org A cannot attach a work item to org B's finding even inside its own org", async () => {
    const findingB = await seedFinding(db, orgB, fixtureB);
    await expect(
      asAuthenticatedUser(db, orgA.ownerId, () =>
        db.query(
          `insert into public.work_items (organization_id, client_id, finding_id, title)
           values ($1, $2, $3, 'cross-org attempt')`,
          [orgA.orgId, fixtureA.clientId, findingB],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("reports and share links: cross-org denied, including \"generate a report\" for another org", () => {
  it("org A cannot see org B's report", async () => {
    const reportB = await seedReport(db, orgB);
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.reports where id = $1", [reportB]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org A cannot create a report row for org B (generate-a-report-for-another-org attempt)", async () => {
    await expect(
      asAuthenticatedUser(db, orgA.ownerId, () =>
        db.query(
          `insert into public.reports (organization_id, period_start, period_end, status)
           values ($1, '2026-01-01', '2026-01-31', 'draft')`,
          [orgB.orgId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org A cannot create a share link for org B's report", async () => {
    const reportB = await seedReport(db, orgB);
    await expect(
      asAuthenticatedUser(db, orgA.ownerId, () =>
        db.query(
          `insert into public.share_links (report_id, organization_id, token_hash)
           values ($1, $2, 'deadbeef')`,
          [reportB, orgA.orgId],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("client_approvals: no access at all for authenticated or anon, regardless of org", () => {
  it("org A's owner gets a permission error reading client_approvals, not just an empty result", async () => {
    await expect(
      asAuthenticatedUser(db, orgA.ownerId, () => db.query("select * from public.client_approvals")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("the anon role also gets a permission error", async () => {
    await expect(asAnon(db, () => db.query("select * from public.client_approvals"))).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe("billing isolation", () => {
  it("org A cannot see org B's subscription", async () => {
    const subscriptionB = await seedSubscription(db, orgB);
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.subscriptions where id = $1", [subscriptionB]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("authenticated users have no access to subscription_events at all", async () => {
    await expect(
      asAuthenticatedUser(db, orgA.ownerId, () => db.query("select * from public.subscription_events")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("authenticated users have no access to usage_records at all", async () => {
    await expect(
      asAuthenticatedUser(db, orgA.ownerId, () => db.query("select * from public.usage_records")),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("audit events: admin-only, and still org-scoped", () => {
  it("org A's owner cannot see org B's audit events", async () => {
    const eventB = await seedAuditEvent(db, orgB);
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.audit_events where id = $1", [eventB]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("a plain member (not owner/admin) cannot see their own org's audit events", async () => {
    const memberId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        "insert into auth.users (email) values ('member@example.test') returning id",
      );
      const userId = result.rows[0]!.id;
      await db.query(
        "insert into public.memberships (organization_id, user_id, role, status) values ($1, $2, 'member', 'active')",
        [orgA.orgId, userId],
      );
      return userId;
    });

    const eventA = await seedAuditEvent(db, orgA);
    const rows = await asAuthenticatedUser(db, memberId, () =>
      db.query("select * from public.audit_events where id = $1", [eventA]),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("organizations and memberships themselves", () => {
  it("org A's owner cannot see org B's organization row", async () => {
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.organizations where id = $1", [orgB.orgId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org A's owner cannot see org B's membership rows", async () => {
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.memberships where organization_id = $1", [orgB.orgId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org A's owner cannot rename org B", async () => {
    const updateResult = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("update public.organizations set name = 'hijacked' where id = $1", [orgB.orgId]),
    );
    expect(updateResult.affectedRows ?? 0).toBe(0);
  });
});

describe("anon role has no access to ordinary tenant tables", () => {
  it("anon gets a permission error reading organizations", async () => {
    await expect(asAnon(db, () => db.query("select * from public.organizations"))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("anon gets a permission error reading clients", async () => {
    await expect(asAnon(db, () => db.query("select * from public.clients"))).rejects.toThrow(
      /permission denied/i,
    );
  });
});
