import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedClientWebsiteMonitor, seedOrg, type ClientWebsiteFixture, type OrgFixture } from "./fixtures.js";
import { asAuthenticatedUser, asServiceRole } from "./supabaseShim.js";
import { createTestDb } from "./testDb.js";

/**
 * Covers the tables/triggers crossOrgIsolation.test.ts doesn't already touch
 * directly, so every RLS-covered table in docs/DATA_MODEL.md has at least one
 * real cross-org isolation assertion, and every cross-org integrity trigger
 * has at least one direct test — not just the ones that happened to come up
 * naturally while exercising the headline work_item/approval/report flows.
 */

let db: PGlite;
let orgA: OrgFixture;
let orgB: OrgFixture;
let fixtureA: ClientWebsiteFixture;
let fixtureB: ClientWebsiteFixture;

beforeAll(async () => {
  db = await createTestDb();
  orgA = await seedOrg(db, "rem-org-a");
  orgB = await seedOrg(db, "rem-org-b");
  fixtureA = await seedClientWebsiteMonitor(db, orgA, "rem-site-a");
  fixtureB = await seedClientWebsiteMonitor(db, orgB, "rem-site-b");
});

afterAll(async () => {
  await db.close();
});

describe("remaining tables: cross-org SELECT isolation", () => {
  it("profiles: org A cannot see org B's owner's profile row directly", async () => {
    await asServiceRole(db, () =>
      db.query("insert into public.profiles (id, full_name) values ($1, 'Org B Owner')", [orgB.ownerId]),
    );
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.profiles where id = $1", [orgB.ownerId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org_member_profiles(): returns nothing for an org the caller is not a member of", async () => {
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.org_member_profiles($1)", [orgB.orgId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("org_member_profiles(): returns co-members' profiles for the caller's own org", async () => {
    await asServiceRole(db, () =>
      db.query("insert into public.profiles (id, full_name) values ($1, 'Org A Owner')", [orgA.ownerId]),
    );
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.org_member_profiles($1)", [orgA.orgId]),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ full_name: "Org A Owner" });
  });

  it("organization_invitations: org A cannot see org B's pending invitation", async () => {
    const invitation = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.organization_invitations
           (organization_id, email, role, token_hash, invited_by_user_id, expires_at)
         values ($1, 'invitee@example.test', 'member', 'hash123', $2, now() + interval '7 days')
         returning id`,
        [orgB.orgId, orgB.ownerId],
      );
      return result.rows[0]!.id;
    });
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.organization_invitations where id = $1", [invitation]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("ssl_checks: org A cannot see org B's ssl check", async () => {
    const sslCheckId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.ssl_checks (monitor_id, website_id, organization_id, checked_at, status)
         values ($1, $2, $3, now(), 'valid') returning id`,
        [fixtureB.monitorId, fixtureB.websiteId, orgB.orgId],
      );
      return result.rows[0]!.id;
    });
    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.ssl_checks where id = $1", [sslCheckId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("scan_runs: org A cannot see org B's authenticated scan run, and nobody can see an anonymous one", async () => {
    const authedScanId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.scan_runs (organization_id, submitted_url, source, status)
         values ($1, 'https://rem-site-b.example.test/', 'authenticated', 'completed') returning id`,
        [orgB.orgId],
      );
      return result.rows[0]!.id;
    });
    const anonScanId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.scan_runs (organization_id, submitted_url, source, status)
         values (null, 'https://anonymous.example.test/', 'public_free_scan', 'completed') returning id`,
      );
      return result.rows[0]!.id;
    });

    const crossOrgRows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.scan_runs where id = $1", [authedScanId]),
    );
    expect(crossOrgRows.rows).toHaveLength(0);

    const anonRowsForA = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.scan_runs where id = $1", [anonScanId]),
    );
    expect(anonRowsForA.rows).toHaveLength(0);

    const anonRowsForB = await asAuthenticatedUser(db, orgB.ownerId, () =>
      db.query("select * from public.scan_runs where id = $1", [anonScanId]),
    );
    expect(anonRowsForB.rows).toHaveLength(0);
  });

  it("incident_events: org A cannot see org B's incident event", async () => {
    const checkResultId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.check_results (monitor_id, website_id, organization_id, scheduled_at, status, checker_region)
         values ($1, $2, $3, now(), 'failure', 'local-test') returning id`,
        [fixtureB.monitorId, fixtureB.websiteId, orgB.orgId],
      );
      return result.rows[0]!.id;
    });
    const eventId = await asServiceRole(db, async () => {
      const incident = await db.query<{ id: string }>(
        `insert into public.incidents (organization_id, website_id, monitor_id, status, first_check_result_id)
         values ($1, $2, $3, 'confirming', $4) returning id`,
        [orgB.orgId, fixtureB.websiteId, fixtureB.monitorId, checkResultId],
      );
      const event = await db.query<{ id: string }>(
        `insert into public.incident_events (incident_id, organization_id, event_type)
         values ($1, $2, 'confirming_started') returning id`,
        [incident.rows[0]!.id, orgB.orgId],
      );
      return event.rows[0]!.id;
    });

    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.incident_events where id = $1", [eventId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("work_logs: org A cannot see org B's work log entry", async () => {
    const logId = await asServiceRole(db, async () => {
      const workItem = await db.query<{ id: string }>(
        `insert into public.work_items (organization_id, client_id, title) values ($1, $2, 'B item') returning id`,
        [orgB.orgId, fixtureB.clientId],
      );
      const log = await db.query<{ id: string }>(
        `insert into public.work_logs (work_item_id, organization_id, entry_type, description)
         values ($1, $2, 'system_event', 'did something') returning id`,
        [workItem.rows[0]!.id, orgB.orgId],
      );
      return log.rows[0]!.id;
    });

    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.work_logs where id = $1", [logId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("report_deliveries: org A cannot see org B's report delivery", async () => {
    const deliveryId = await asServiceRole(db, async () => {
      const report = await db.query<{ id: string }>(
        `insert into public.reports (organization_id, period_start, period_end, status)
         values ($1, '2026-02-01', '2026-02-28', 'generated') returning id`,
        [orgB.orgId],
      );
      const delivery = await db.query<{ id: string }>(
        `insert into public.report_deliveries (report_id, organization_id, channel, status)
         values ($1, $2, 'email', 'sent') returning id`,
        [report.rows[0]!.id, orgB.orgId],
      );
      return delivery.rows[0]!.id;
    });

    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.report_deliveries where id = $1", [deliveryId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("monitor_schedules: org A cannot see org B's monitor schedule", async () => {
    const scheduleId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.monitor_schedules (monitor_id, organization_id, next_run_at)
         values ($1, $2, now()) returning id`,
        [fixtureB.monitorId, orgB.orgId],
      );
      return result.rows[0]!.id;
    });

    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.monitor_schedules where id = $1", [scheduleId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("notification_preferences: org A's owner cannot see org B's owner's preference row", async () => {
    const prefId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.notification_preferences (organization_id, user_id, event_type, enabled)
         values ($1, $2, 'incident_opened', true) returning id`,
        [orgB.orgId, orgB.ownerId],
      );
      return result.rows[0]!.id;
    });

    const rows = await asAuthenticatedUser(db, orgA.ownerId, () =>
      db.query("select * from public.notification_preferences where id = $1", [prefId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("notification_preferences: a user cannot see a co-member's preference row within their OWN org", async () => {
    const memberId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        "insert into auth.users (email) values ('rem-member@example.test') returning id",
      );
      const userId = result.rows[0]!.id;
      await db.query(
        "insert into public.memberships (organization_id, user_id, role, status) values ($1, $2, 'member', 'active')",
        [orgA.orgId, userId],
      );
      return userId;
    });
    const ownerPrefId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.notification_preferences (organization_id, user_id, event_type, enabled)
         values ($1, $2, 'report_ready', true) returning id`,
        [orgA.orgId, orgA.ownerId],
      );
      return result.rows[0]!.id;
    });

    const rows = await asAuthenticatedUser(db, memberId, () =>
      db.query("select * from public.notification_preferences where id = $1", [ownerPrefId]),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("cross-org integrity triggers, tested directly (bypassing RLS via service_role)", () => {
  it("rejects a website whose client_id belongs to a different organization than the website itself", async () => {
    await expect(
      asServiceRole(db, () =>
        db.query(
          `insert into public.websites (organization_id, client_id, url)
           values ($1, $2, 'https://mismatched.example.test/')`,
          [orgA.orgId, fixtureB.clientId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects a client_approval whose work_item belongs to a different organization", async () => {
    const workItemB = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.work_items (organization_id, client_id, title) values ($1, $2, 'B item 2') returning id`,
        [orgB.orgId, fixtureB.clientId],
      );
      return result.rows[0]!.id;
    });

    await expect(
      asServiceRole(db, () =>
        db.query(
          `insert into public.client_approvals
             (work_item_id, organization_id, client_id, token_hash, presented_title, expires_at)
           values ($1, $2, $3, 'tok', 'title', now() + interval '7 days')`,
          [workItemB, orgA.orgId, fixtureA.clientId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects a finding whose ssl_check belongs to a different organization", async () => {
    const sslCheckB = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.ssl_checks (monitor_id, website_id, organization_id, checked_at, status)
         values ($1, $2, $3, now(), 'valid') returning id`,
        [fixtureB.monitorId, fixtureB.websiteId, orgB.orgId],
      );
      return result.rows[0]!.id;
    });

    await expect(
      asServiceRole(db, () =>
        db.query(
          `insert into public.findings (organization_id, website_id, ssl_check_id, type, severity, title, description)
           values ($1, $2, $3, 'ssl_expiring_30d', 'low', 'title', 'description')`,
          [orgA.orgId, fixtureA.websiteId, sslCheckB],
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects a report_delivery whose report belongs to a different organization", async () => {
    const reportB = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        `insert into public.reports (organization_id, period_start, period_end, status)
         values ($1, '2026-03-01', '2026-03-31', 'generated') returning id`,
        [orgB.orgId],
      );
      return result.rows[0]!.id;
    });

    await expect(
      asServiceRole(db, () =>
        db.query(
          `insert into public.report_deliveries (report_id, organization_id, channel, status)
           values ($1, $2, 'email', 'pending')`,
          [reportB, orgA.orgId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects a work_item assigned to a user who is not an active member of its organization", async () => {
    const outsiderId = await asServiceRole(db, async () => {
      const result = await db.query<{ id: string }>(
        "insert into auth.users (email) values ('outsider@example.test') returning id",
      );
      return result.rows[0]!.id;
    });

    await expect(
      asServiceRole(db, () =>
        db.query(
          `insert into public.work_items (organization_id, client_id, title, assigned_user_id)
           values ($1, $2, 'bad assignment', $3)`,
          [orgA.orgId, fixtureA.clientId, outsiderId],
        ),
      ),
    ).rejects.toThrow();
  });
});
