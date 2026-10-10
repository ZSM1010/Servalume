import { Client } from "pg";

/**
 * Development seed data ONLY. Deliberately isolated from any production data
 * path (master spec §11): requires an explicit opt-in env var, and refuses to
 * run against anything that doesn't look like a local database, even if that
 * opt-in is set by mistake in the wrong shell.
 *
 * Every seeded name/URL is obviously synthetic ("Demo ..."/"...example.test")
 * so it can never be mistaken for a real measurement in a screenshot or a
 * support ticket (master spec §10).
 */

function assertSafeToSeed(databaseUrl: string): void {
  if (process.env.ALLOW_SEED !== "true") {
    throw new Error(
      "Refusing to seed: set ALLOW_SEED=true explicitly to confirm this is a local/dev database.",
    );
  }
  const looksLocal = /localhost|127\.0\.0\.1|::1/.test(databaseUrl);
  if (!looksLocal) {
    throw new Error(
      `Refusing to seed: DATABASE_URL does not look like a local database (${databaseUrl.replace(/:[^:@]*@/, ":***@")}).`,
    );
  }
}

async function seed(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("begin");

    const demoUser = await client.query<{ id: string }>(
      `insert into auth.users (email) values ('demo-owner@example.test')
       on conflict do nothing returning id`,
    );
    const ownerId =
      demoUser.rows[0]?.id ??
      (await client.query<{ id: string }>("select id from auth.users where email = 'demo-owner@example.test'"))
        .rows[0]!.id;

    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
    await client.query("set role authenticated");

    const org = await client.query<{ id: string }>("select public.create_organization($1, $2) as id", [
      "Demo Agency",
      "demo-agency",
    ]);
    const orgId = org.rows[0]!.id;

    const client1 = await client.query<{ id: string }>(
      "insert into public.clients (organization_id, name, contact_email) values ($1, 'Demo Client Co.', 'contact@demo-client.example.test') returning id",
      [orgId],
    );

    const website1 = await client.query<{ id: string }>(
      "insert into public.websites (organization_id, client_id, url, display_name) values ($1, $2, 'https://demo-client.example.test/', 'Demo Client Co. — marketing site') returning id",
      [orgId, client1.rows[0]!.id],
    );

    await client.query(
      "insert into public.monitors (website_id, organization_id, type, interval_seconds) values ($1, $2, 'http_uptime', 300)",
      [website1.rows[0]!.id, orgId],
    );
    await client.query(
      "insert into public.monitors (website_id, organization_id, type, interval_seconds) values ($1, $2, 'ssl_cert', 3600)",
      [website1.rows[0]!.id, orgId],
    );

    await client.query("reset role");
    await client.query("commit");

    console.log(`Seeded demo organization ${orgId} ("Demo Agency") with one client and one website.`);
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  assertSafeToSeed(databaseUrl);
  await seed(databaseUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
