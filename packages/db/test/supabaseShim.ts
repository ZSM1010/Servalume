import type { PGlite } from "@electric-sql/pglite";

/**
 * Our migrations target a real Supabase project, which already provides the
 * `auth` schema, `auth.uid()`, and the anon/authenticated/service_role roles
 * before any of our migrations ever run (see migrations/0001's header
 * comment). Local/CI testing against plain Postgres (via PGlite) has none of
 * that, so this shim creates faithful stand-ins — close enough that the exact
 * same migration SQL that will run against Supabase also runs here unmodified.
 *
 * This file is test-only. It must never be applied to a real Supabase
 * project, which already has the real versions of everything it creates.
 *
 * All helpers here assume one PGlite connection used sequentially — switch
 * role/user, run queries, switch back — never concurrently from multiple
 * callers at once. That matches how these tests use it and keeps the
 * role/session-variable juggling below simple and safe.
 */
export async function applySupabaseShim(db: PGlite): Promise<void> {
  await db.exec(`
    create schema if not exists auth;

    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text
    );

    -- Mirrors Supabase's real auth.uid(), which reads the JWT "sub" claim out
    -- of a Postgres session setting PostgREST populates per request. Tests
    -- call set_current_test_user() below to set the same setting directly.
    create or replace function auth.uid() returns uuid
    language sql stable
    as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;

    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role bypassrls;
      end if;
    end;
    $$;

    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant select on auth.users to anon, authenticated, service_role;
    grant all privileges on auth.users to service_role;

    -- A real Supabase project additionally grants service_role full privileges
    -- on the public schema as part of its own project bootstrapping — its
    -- bypassrls attribute only skips RLS *policy* evaluation, not the
    -- underlying GRANT/ACL check, confirmed directly (a service_role query
    -- against a table it had bypassrls but no grant on still failed with
    -- "permission denied for table", not an RLS-filtered empty result).
    -- "for tables" covers tables created by migrations that ran before this
    -- shim; the default-privileges form covers every later migration's
    -- tables too, exactly mirroring what Supabase provides.
    grant all privileges on all tables in schema public to service_role;
    grant all privileges on all sequences in schema public to service_role;
    alter default privileges in schema public grant all privileges on tables to service_role;
    alter default privileges in schema public grant all privileges on sequences to service_role;
  `);
}

/**
 * Sets the session's "logged in as" user for the rest of this connection, the
 * same way PostgREST sets it per request against real Supabase. Uses the
 * session-level form of set_config (`is_local = false`), not the
 * transaction-local form PostgREST actually uses per-request — PGlite's test
 * driver runs each `.query()` call as its own implicit transaction, so a
 * transaction-local setting from one call would not survive to the next
 * call, confirmed directly. This test harness is single-connection and
 * sequential (never concurrent — see the module comment), so a session-level
 * setting is safe here and is reset explicitly after each use.
 */
export async function setCurrentTestUser(db: PGlite, userId: string | null): Promise<void> {
  if (userId === null) {
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    return;
  }
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
}

/** Runs as the real `authenticated` Postgres role (so GRANT/REVOKE and RLS both apply), impersonating the given user id. Mirrors the role PostgREST connects as for a signed-in request. */
export async function asAuthenticatedUser<T>(
  db: PGlite,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.query("set role authenticated");
  await setCurrentTestUser(db, userId);
  try {
    return await fn();
  } finally {
    await setCurrentTestUser(db, null);
    await db.query("reset role");
  }
}

/** Runs as the real `service_role` Postgres role (bypasses RLS entirely, same as the worker/trusted server routes), the way production code must additionally filter by organization_id itself. */
export async function asServiceRole<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.query("set role service_role");
  try {
    return await fn();
  } finally {
    await db.query("reset role");
  }
}

/** Runs as the real `anon` Postgres role, for proving anonymous access is denied where it must be. */
export async function asAnon<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.query("set role anon");
  try {
    return await fn();
  } finally {
    await db.query("reset role");
  }
}
