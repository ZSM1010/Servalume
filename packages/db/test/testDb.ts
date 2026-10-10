import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { applySupabaseShim } from "./supabaseShim.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function applyMigrations(db: PGlite): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }
}

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
