import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/**
 * Real migration runner for an actual Supabase/Postgres deployment, driven by
 * DATABASE_URL. Applies migrations/*.sql in filename order, tracking what has
 * already run in a schema_migrations table so re-running this script is a
 * no-op for anything already applied — safe to run on every deploy.
 *
 * This file assumes the target already has the Supabase-provided `auth`
 * schema/roles (see migrations/0001's header comment) — it does not apply
 * the test-only shim in packages/db/test/supabaseShim.ts.
 */

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function getAppliedMigrations(client: Client): Promise<Set<string>> {
  const result = await client.query<{ filename: string }>("select filename from public.schema_migrations");
  return new Set(result.rows.map((r) => r.filename));
}

export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];

  try {
    await ensureMigrationsTable(client);
    const alreadyApplied = await getAppliedMigrations(client);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into public.schema_migrations (filename) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
    }

    return applied;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. See docs/ENVIRONMENT_VARIABLES.md.");
    process.exit(1);
  }

  const applied = await runMigrations(databaseUrl);
  if (applied.length === 0) {
    console.log("No pending migrations.");
  } else {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
