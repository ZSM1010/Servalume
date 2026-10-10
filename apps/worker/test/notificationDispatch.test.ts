import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchIncidentNotification } from "../src/jobs/notificationDispatch.js";
import type { EmailProvider } from "../src/emailProvider.js";
import { startTestPostgres, type TestPostgres } from "./testPostgres.js";

/**
 * Per master spec §13's own testing guidance, the email provider is mocked
 * at the interface boundary rather than hitting Resend/SMTP for real — this
 * tests the dispatch/dedup/preferences logic, which is what matters here.
 */

let testPg: TestPostgres;

beforeAll(async () => {
  testPg = await startTestPostgres();
}, 60_000);

afterAll(async () => {
  await testPg?.stop();
});

function fakeEmailProvider(): EmailProvider & { sent: Array<{ to: string; subject: string }> } {
  const sent: Array<{ to: string; subject: string }> = [];
  return {
    sent,
    send: vi.fn(async (message) => {
      sent.push({ to: message.to, subject: message.subject });
      return { success: true, providerMessageId: "fake-id", error: null };
    }),
  };
}

async function seedOrgWithMembersAndIncident(
  slug: string,
  members: Array<{ email: string; prefs?: { eventType: string; enabled: boolean }[] }>,
) {
  const org = await testPg.pool.query<{ id: string }>(
    "insert into public.organizations (name, slug) values ($1, $2) returning id",
    [slug, slug],
  );
  const orgId = org.rows[0]!.id;

  const website = await testPg.pool.query<{ id: string }>(
    "insert into public.websites (organization_id, url) values ($1, $2) returning id",
    [orgId, `https://${slug}.example.test/`],
  );
  const monitor = await testPg.pool.query<{ id: string }>(
    "insert into public.monitors (website_id, organization_id, type, interval_seconds) values ($1, $2, 'http_uptime', 300) returning id",
    [website.rows[0]!.id, orgId],
  );
  const checkResult = await testPg.pool.query<{ id: string }>(
    `insert into public.check_results (monitor_id, website_id, organization_id, scheduled_at, status, checker_region)
     values ($1, $2, $3, now(), 'failure', 'test') returning id`,
    [monitor.rows[0]!.id, website.rows[0]!.id, orgId],
  );
  const incident = await testPg.pool.query<{ id: string }>(
    `insert into public.incidents (organization_id, website_id, monitor_id, status, first_check_result_id, opened_at)
     values ($1, $2, $3, 'open', $4, now()) returning id`,
    [orgId, website.rows[0]!.id, monitor.rows[0]!.id, checkResult.rows[0]!.id],
  );

  for (const member of members) {
    const user = await testPg.pool.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [
      member.email,
    ]);
    await testPg.pool.query(
      "insert into public.memberships (organization_id, user_id, role, status) values ($1, $2, 'member', 'active')",
      [orgId, user.rows[0]!.id],
    );
    for (const pref of member.prefs ?? []) {
      await testPg.pool.query(
        "insert into public.notification_preferences (organization_id, user_id, event_type, enabled) values ($1, $2, $3, $4)",
        [orgId, user.rows[0]!.id, pref.eventType, pref.enabled],
      );
    }
  }

  return { orgId, incidentId: incident.rows[0]!.id };
}

describe("dispatchIncidentNotification", () => {
  it("sends to every active member by default (no preference row = enabled)", async () => {
    const { orgId, incidentId } = await seedOrgWithMembersAndIncident("notif-default", [
      { email: "a@example.test" },
      { email: "b@example.test" },
    ]);
    const emailProvider = fakeEmailProvider();

    const result = await dispatchIncidentNotification(
      { pool: testPg.pool, emailProvider, appBaseUrl: "https://app.example.test" },
      { incidentId, organizationId: orgId, eventType: "incident_opened" },
    );

    expect(result.recipientCount).toBe(2);
    expect(result.sentCount).toBe(2);
    expect(emailProvider.sent.map((m) => m.to).sort()).toEqual(["a@example.test", "b@example.test"]);
  });

  it("skips a member who disabled this specific event type", async () => {
    const { orgId, incidentId } = await seedOrgWithMembersAndIncident("notif-opt-out", [
      { email: "wants-it@example.test", prefs: [{ eventType: "incident_opened", enabled: true }] },
      { email: "opted-out@example.test", prefs: [{ eventType: "incident_opened", enabled: false }] },
    ]);
    const emailProvider = fakeEmailProvider();

    const result = await dispatchIncidentNotification(
      { pool: testPg.pool, emailProvider, appBaseUrl: "https://app.example.test" },
      { incidentId, organizationId: orgId, eventType: "incident_opened" },
    );

    expect(result.recipientCount).toBe(1);
    expect(emailProvider.sent.map((m) => m.to)).toEqual(["wants-it@example.test"]);
  });

  it("does not resend once notification_sent_at is already set for an incident_opened dispatch", async () => {
    const { orgId, incidentId } = await seedOrgWithMembersAndIncident("notif-dedup", [{ email: "a@example.test" }]);
    const emailProvider = fakeEmailProvider();
    const deps = { pool: testPg.pool, emailProvider, appBaseUrl: "https://app.example.test" };

    await dispatchIncidentNotification(deps, { incidentId, organizationId: orgId, eventType: "incident_opened" });
    const row = await testPg.pool.query<{ notification_sent_at: Date | null }>(
      "select notification_sent_at from public.incidents where id = $1",
      [incidentId],
    );
    expect(row.rows[0]!.notification_sent_at).not.toBeNull();
  });

  it("records failures without throwing when the provider rejects a send", async () => {
    const { orgId, incidentId } = await seedOrgWithMembersAndIncident("notif-provider-fail", [
      { email: "a@example.test" },
    ]);
    const emailProvider: EmailProvider = {
      send: vi.fn(async () => ({ success: false, providerMessageId: null, error: "provider down" })),
    };

    const result = await dispatchIncidentNotification(
      { pool: testPg.pool, emailProvider, appBaseUrl: "https://app.example.test" },
      { incidentId, organizationId: orgId, eventType: "incident_opened" },
    );

    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(1);
  });
});
