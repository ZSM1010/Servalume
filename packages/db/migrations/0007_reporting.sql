-- Reports, deliveries, share links. See docs/DATA_MODEL.md §5.
--
-- Rollback: `drop table share_links, report_deliveries, reports cascade;`

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft', 'generated', 'failed')),
  data_snapshot jsonb,
  generated_at timestamptz,
  created_by_user_id uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end > period_start)
);

create index reports_org_id_idx on public.reports (organization_id);
create index reports_client_id_idx on public.reports (client_id);

create trigger set_updated_at before update on public.reports
  for each row execute function public.set_updated_at();

-- Once a report has been generated, its data_snapshot is immutable — a report
-- must always reflect exactly the data it was generated from, never a later
-- edit (docs/DATA_MODEL.md §5 "reports").
create or replace function public.check_report_snapshot_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'generated' and new.data_snapshot is distinct from old.data_snapshot then
    raise exception 'report % data_snapshot is immutable once generated', old.id;
  end if;
  return new;
end;
$$;

create trigger check_report_snapshot_immutable
  before update on public.reports
  for each row execute function public.check_report_snapshot_immutable();

create table public.report_deliveries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  channel text not null check (channel in ('email', 'share_link')),
  recipient text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create index report_deliveries_report_id_idx on public.report_deliveries (report_id);

create or replace function public.check_delivery_report_same_org()
returns trigger
language plpgsql
as $$
declare
  report_org_id uuid;
begin
  select organization_id into report_org_id from public.reports where id = new.report_id;
  if report_org_id is distinct from new.organization_id then
    raise exception 'report_delivery % report % does not belong to organization %',
      new.id, new.report_id, new.organization_id;
  end if;
  return new;
end;
$$;

create trigger check_delivery_report_same_org
  before insert or update on public.report_deliveries
  for each row execute function public.check_delivery_report_same_org();

create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index share_links_report_id_idx on public.share_links (report_id);

create or replace function public.check_share_link_report_same_org()
returns trigger
language plpgsql
as $$
declare
  report_org_id uuid;
begin
  select organization_id into report_org_id from public.reports where id = new.report_id;
  if report_org_id is distinct from new.organization_id then
    raise exception 'share_link % report % does not belong to organization %',
      new.id, new.report_id, new.organization_id;
  end if;
  return new;
end;
$$;

create trigger check_share_link_report_same_org
  before insert or update on public.share_links
  for each row execute function public.check_share_link_report_same_org();
