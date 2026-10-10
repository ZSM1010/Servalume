-- Clients, websites, monitors, and monitor scheduling state.
-- See docs/DATA_MODEL.md §2.
--
-- Rollback: `drop table monitor_schedules, monitors, websites, clients cascade;`
-- Destructive — only safe before any dependent migration runs.

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  contact_name text check (length(contact_name) <= 200),
  contact_email citext,
  notes text check (length(notes) <= 5000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index clients_org_id_idx on public.clients (organization_id);

create trigger set_updated_at before update on public.clients
  for each row execute function public.set_updated_at();

create table public.websites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  url text not null check (length(url) between 1 and 2048),
  display_name text check (length(display_name) <= 200),
  timezone text not null default 'UTC',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, url)
);

create index websites_org_id_idx on public.websites (organization_id);
create index websites_client_id_idx on public.websites (client_id);

create trigger set_updated_at before update on public.websites
  for each row execute function public.set_updated_at();

-- A website's client, if set, must belong to the same organization as the
-- website — enforced at the DB level per docs/DATA_MODEL.md §8, not only in
-- application code.
create or replace function public.check_website_client_same_org()
returns trigger
language plpgsql
as $$
begin
  if new.client_id is not null then
    if not exists (
      select 1 from public.clients
      where id = new.client_id and organization_id = new.organization_id
    ) then
      raise exception 'website % client % does not belong to organization %',
        new.id, new.client_id, new.organization_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger check_website_client_same_org
  before insert or update on public.websites
  for each row execute function public.check_website_client_same_org();

create table public.monitors (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  type text not null check (type in ('http_uptime', 'ssl_cert')),
  config jsonb not null default '{}'::jsonb,
  interval_seconds integer not null check (interval_seconds >= 60),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index monitors_website_id_idx on public.monitors (website_id);
create index monitors_org_id_idx on public.monitors (organization_id);

create trigger set_updated_at before update on public.monitors
  for each row execute function public.set_updated_at();

-- A monitor's organization_id must match its website's organization_id —
-- this is deliberately denormalized for RLS/query performance, so it must be
-- enforced by trigger rather than left implicit.
create or replace function public.check_monitor_website_same_org()
returns trigger
language plpgsql
as $$
declare
  website_org_id uuid;
begin
  select organization_id into website_org_id
  from public.websites
  where id = new.website_id;

  if website_org_id is null then
    raise exception 'monitor % references nonexistent website %', new.id, new.website_id;
  end if;

  if website_org_id <> new.organization_id then
    raise exception 'monitor % organization % does not match website % organization %',
      new.id, new.organization_id, new.website_id, website_org_id;
  end if;

  return new;
end;
$$;

create trigger check_monitor_website_same_org
  before insert or update on public.monitors
  for each row execute function public.check_monitor_website_same_org();

create table public.monitor_schedules (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null unique references public.monitors (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  next_run_at timestamptz not null,
  last_enqueued_job_id text,
  last_run_at timestamptz,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index monitor_schedules_next_run_at_idx on public.monitor_schedules (next_run_at);
create index monitor_schedules_org_id_idx on public.monitor_schedules (organization_id);

create trigger set_updated_at before update on public.monitor_schedules
  for each row execute function public.set_updated_at();
