-- Extensions and the one helper that has no table dependency.
--
-- Deployment: run against a Supabase project (or any Postgres 15+ that already
-- provides the `auth` schema, `auth.uid()`, and the anon/authenticated/
-- service_role roles the way Supabase does). This migration does NOT create
-- those primitives — they are assumed to already exist, exactly as they do on
-- a real Supabase project. Local/CI testing against plain Postgres applies a
-- separate shim (packages/db/test/supabaseShim.ts) that provides stand-ins
-- for them before these migrations run.
--
-- Rollback: `drop function if exists public.set_updated_at; drop extension if
-- exists citext;` — safe only if no later migration's objects still depend on
-- them (they all do, so in practice a rollback here means rolling back
-- everything after it too).

create extension if not exists citext;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Generic BEFORE UPDATE trigger: stamps updated_at = now() on every row update.';
