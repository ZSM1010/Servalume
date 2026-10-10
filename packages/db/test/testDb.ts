import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { applyMigrations } from "./applyMigrations.js";
import { applySupabaseShim } from "./supabaseShim.js";

/** A fresh, fully-migrated database for one test. PGlite gives us a real, isolated Postgres instance per call — no shared state between tests. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { citext } });
  await applySupabaseShim(db);
  await applyMigrations(db);
  return db;
}

/** Inserts a row into auth.users and returns its id — the minimum needed before a user can hold a membership. */
export async function createTestAuthUser(db: PGlite, email: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into auth.users (email) values ($1) returning id",
    [email],
  );
  return result.rows[0]!.id;
}
