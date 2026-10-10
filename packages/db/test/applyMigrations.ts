import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "./supabaseShim.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Applies every migrations/*.sql file, in order, against any SqlExecutor
 * (PGlite or a real Postgres connection) — shared by packages/db's own
 * tests and by apps/worker's test harness, so there is exactly one place
 * that knows how to apply the real migration set for tests.
 */
export async function applyMigrations(db: SqlExecutor): Promise<void> {
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
