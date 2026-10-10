-- Work items, work logs, client approvals. The product's main differentiating
-- module — see docs/DATA_MODEL.md §4 (work_items/work_logs/client_approvals).
--
-- Rollback: `drop table client_approvals, work_logs, work_items cascade;`

create table public.work_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  website_id uuid references public.websites (id) on delete set null,
  finding_id uuid references public.findings (id) on delete set null,
  title text not null check (length(title) between 1 and 300),
  description text check (length(description) <= 10000),
  recommended_action text check (length(recommended_action) <= 5000),
  severity text check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  status text not null default 'detected' check (
    status in (
      'detected', 'needs_review', 'recommended', 'awaiting_approval', 'approved',
      'declined', 'in_progress', 'completed', 'verification_failed', 'verified', 'closed'
    )
  ),
  requires_client_approval boolean not null default true,
  assigned_user_id uuid references auth.users (id),
  created_by_user_id uuid references auth.users (id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (client_id is not null or website_id is not null)
);

create index work_items_org_id_idx on public.work_items (organization_id);
create index work_items_client_id_idx on public.work_items (client_id);
create index work_items_website_id_idx on public.work_items (website_id);
create index work_items_status_idx on public.work_items (status);

create trigger set_updated_at before update on public.work_items
  for each row execute function public.set_updated_at();

create or replace function public.check_work_item_refs_same_org()
returns trigger
language plpgsql
as $$
declare
  ref_org_id uuid;
begin
  if new.finding_id is not null then
    select organization_id into ref_org_id from public.findings where id = new.finding_id;
    if ref_org_id is distinct from new.organization_id then
      raise exception 'work_item % finding % does not belong to organization %',
        new.id, new.finding_id, new.organization_id;
    end if;
  end if;

  if new.client_id is not null then
    select organization_id into ref_org_id from public.clients where id = new.client_id;
    if ref_org_id is distinct from new.organization_id then
      raise exception 'work_item % client % does not belong to organization %',
        new.id, new.client_id, new.organization_id;
    end if;
  end if;

  if new.website_id is not null then
    select organization_id into ref_org_id from public.websites where id = new.website_id;
    if ref_org_id is distinct from new.organization_id then
      raise exception 'work_item % website % does not belong to organization %',
        new.id, new.website_id, new.organization_id;
    end if;
  end if;

  if new.assigned_user_id is not null then
    if not exists (
      select 1 from public.memberships
      where organization_id = new.organization_id
        and user_id = new.assigned_user_id
        and status = 'active'
    ) then
      raise exception 'work_item % assigned_user % is not an active member of organization %',
        new.id, new.assigned_user_id, new.organization_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger check_work_item_refs_same_org
  before insert or update on public.work_items
  for each row execute function public.check_work_item_refs_same_org();

create table public.work_logs (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.work_items (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_user_id uuid references auth.users (id),
  entry_type text not null check (entry_type in ('manual_note', 'status_change', 'system_event')),
  description text not null check (length(description) between 1 and 5000),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index work_logs_work_item_id_idx on public.work_logs (work_item_id);
create index work_logs_org_id_idx on public.work_logs (organization_id);

create or replace function public.check_work_log_work_item_same_org()
returns trigger
language plpgsql
as $$
declare
  item_org_id uuid;
begin
  select organization_id into item_org_id from public.work_items where id = new.work_item_id;
  if item_org_id is null then
    raise exception 'work_log % references nonexistent work_item %', new.id, new.work_item_id;
  end if;
  if item_org_id <> new.organization_id then
    raise exception 'work_log % work_item % does not belong to organization %',
      new.id, new.work_item_id, new.organization_id;
  end if;
  return new;
end;
$$;

create trigger check_work_log_work_item_same_org
  before insert or update on public.work_logs
  for each row execute function public.check_work_log_work_item_same_org();

-- client_approvals is deliberately NOT exposed to anon/authenticated via
-- normal table grants at all (see 0010_row_level_security.sql and
-- docs/THREAT_MODEL.md §3) — every read/write from the public approval page
-- goes through a server route using the service role plus explicit
-- token-hash/expiry/revocation checks on every request.
create table public.client_approvals (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.work_items (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  token_hash text not null unique,
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'declined', 'clarification_requested', 'expired', 'revoked')
  ),
  presented_title text not null check (length(presented_title) between 1 and 300),
  presented_recommendation text,
  presented_evidence jsonb,
  decided_at timestamptz,
  decision_note text check (length(decision_note) <= 2000),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index client_approvals_work_item_id_idx on public.client_approvals (work_item_id);
create index client_approvals_org_id_idx on public.client_approvals (organization_id);

create trigger set_updated_at before update on public.client_approvals
  for each row execute function public.set_updated_at();

create or replace function public.check_approval_work_item_same_org()
returns trigger
language plpgsql
as $$
declare
  item_org_id uuid;
begin
  select organization_id into item_org_id from public.work_items where id = new.work_item_id;
  if item_org_id is null then
    raise exception 'client_approval % references nonexistent work_item %', new.id, new.work_item_id;
  end if;
  if item_org_id <> new.organization_id then
    raise exception 'client_approval % work_item % does not belong to organization %',
      new.id, new.work_item_id, new.organization_id;
  end if;
  return new;
end;
$$;

create trigger check_approval_work_item_same_org
  before insert or update on public.client_approvals
  for each row execute function public.check_approval_work_item_same_org();
