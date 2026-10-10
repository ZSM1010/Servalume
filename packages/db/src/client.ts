import { Pool, type PoolConfig } from "pg";

/**
 * Shared Postgres pool factory for apps/worker and any trusted server route
 * that needs a direct connection (as opposed to going through Supabase's
 * PostgREST layer). Callers are responsible for only ever using this with the
 * service-role-equivalent DATABASE_URL — see docs/ARCHITECTURE.md §5 on the
 * three credential trust levels, and docs/THREAT_MODEL.md §2 on why every
 * query made through this pool must carry an explicit organization_id filter
 * written by hand: this connection bypasses RLS.
 */
export function createDbPool(databaseUrl: string, config: Omit<PoolConfig, "connectionString"> = {}): Pool {
  return new Pool({ connectionString: databaseUrl, ...config });
}

export { runMigrations } from "./migrate.js";
