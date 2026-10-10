import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { applyMigrations, applySupabaseShim, type SqlExecutor } from "@servalume/db/test";

/**
 * A real, disposable multi-connection Postgres instance per test file —
 * genuine concurrency, unlike packages/db's PGlite-based tests (see that
 * package's test/supabaseShim.ts header comment on why that matters here:
 * pg-boss's SKIP LOCKED job claiming is meaningless to test without real
 * concurrent connections). No admin rights or Docker needed — see
 * docs/IMPLEMENTATION_PLAN.md's Phase 2 deviation note for why that matters
 * in this environment.
 */
export interface TestPostgres {
  pool: Pool;
  connectionString: string;
  stop(): Promise<void>;
}

/** A random high port per instance, not a predictable counter — reduces collision risk against a leftover process from an interrupted previous run, not just against other instances in this same run. */
function pickPort(): number {
  return 50000 + Math.floor(Math.random() * 10000);
}

function poolAsSqlExecutor(pool: Pool): SqlExecutor {
  return {
    query: <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
      pool.query(text, params as never[]).then((result) => result as unknown as { rows: T[] }),
    exec: (sql: string) => pool.query(sql),
  };
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "servalume-worker-pg-"));
  const port = pickPort();

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("servalume_test");

  const connectionString = `postgresql://postgres:postgres@localhost:${port}/servalume_test`;
  const pool = new Pool({ connectionString });

  const executor = poolAsSqlExecutor(pool);
  await applySupabaseShim(executor);
  await applyMigrations(executor);

  return {
    pool,
    connectionString,
    async stop() {
      await pool.end();
      await pg.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
