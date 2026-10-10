-- Tenancy core: organizations, profiles, memberships, invitations.
-- See docs/DATA_MODEL.md §1.
--
-- Rollback: `drop table organization_invitations, memberships, profiles,
-- organizations cascade;` plus the two helper functions defined at the bottom
-- of this file. Destructive — only safe before any dependent migration runs.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.organizations
  for each row execute function public.set_updated_at();

-- Mirrors auth.users for display data the client needs to join against
-- without querying the auth schema directly (see docs/DATA_MODEL.md §1).
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text check (length(full_name) <= 200),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index memberships_user_id_idx on public.memberships (user_id);
create index memberships_org_id_idx on public.memberships (organization_id);

create trigger set_updated_at before update on public.memberships
  for each row execute function public.set_updated_at();

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email citext not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  token_hash text not null unique,
  invited_by_user_id uuid not null references auth.users (id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organization_invitations_org_id_idx on public.organization_invitations (organization_id);

create trigger set_updated_at before update on public.organization_invitations
  for each row execute function public.set_updated_at();

-- Helper functions that depend on memberships existing. SECURITY DEFINER is
-- safe on both: their WHERE clauses are hard-coded to auth.uid(), the calling
-- user's own identity, so neither can be used to learn about any other
-- user's membership. This is what avoids the RLS recursion that would
-- otherwise occur if memberships' own row policies queried memberships again
-- under the caller's normal (RLS-filtered) rights.

create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where organization_id = target_org_id
      and user_id = auth.uid()
      and status = 'active'
  );
$$;

comment on function public.is_org_member(uuid) is
  'True if the calling user (auth.uid()) has an active membership in target_org_id.';

create or replace function public.current_user_role_in_org(target_org_id uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.memberships
  where organization_id = target_org_id
    and user_id = auth.uid()
    and status = 'active'
  limit 1;
$$;

comment on function public.current_user_role_in_org(uuid) is
  'Returns the calling user''s own role in target_org_id, or null if not an active member.';

create or replace function public.is_org_admin(target_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.current_user_role_in_org(target_org_id) in ('owner', 'admin');
$$;

create or replace function public.is_org_owner(target_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.current_user_role_in_org(target_org_id) = 'owner';
$$;
