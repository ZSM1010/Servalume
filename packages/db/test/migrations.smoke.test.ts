import { describe, expect, it } from "vitest";
import { createTestDb } from "./testDb.js";

describe("migrations", () => {
  it("apply cleanly from empty and produce the expected tables", async () => {
    const db = await createTestDb();

    const result = await db.query<{ table_name: string }>(`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `);
    const tableNames = result.rows.map((r) => r.table_name);

    for (const expected of [
      "organizations",
      "profiles",
      "memberships",
      "organization_invitations",
      "clients",
      "websites",
      "monitors",
      "monitor_schedules",
      "check_results",
      "ssl_checks",
      "scan_runs",
      "incidents",
      "incident_events",
      "findings",
      "work_items",
      "work_logs",
      "client_approvals",
      "reports",
      "report_deliveries",
      "share_links",
      "subscriptions",
      "subscription_events",
      "usage_records",
      "notification_preferences",
      "audit_events",
    ]) {
      expect(tableNames).toContain(expected);
    }

    await db.close();
  });

  it("every table listed in docs/DATA_MODEL.md has row level security enabled", async () => {
    const db = await createTestDb();

    const result = await db.query<{ relname: string; relrowsecurity: boolean }>(`
      select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `);

    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} should have RLS enabled`).toBe(true);
    }

    await db.close();
  });
});
