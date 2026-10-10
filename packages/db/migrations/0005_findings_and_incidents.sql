-- Incidents (verified failures and recovery) and findings (deterministic
-- rule output). See docs/DATA_MODEL.md §4.
--
-- findings.organization_id is nullable for the same free-scan reason as
-- scan_runs (docs/DATA_MODEL.md §3/§4) — not exposed via RLS to anon/
-- authenticated roles; see 0010_row_level_security.sql.
--
-- Rollback: `drop table findings, incident_events, incidents cascade;`

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null references public.websites (id) on delete cascade,
  monitor_id uuid not null references public.monitors (id) on delete cascade,
  status text not null check (status in ('confirming', 'open', 'resolved')),
  first_check_result_id uuid not null references public.check_results (id),
  confirming_check_result_id uuid references public.check_results (id),
  resolution_check_result_id uuid references public.check_results (id),
  opened_at timestamptz,
  confirmed_at timestamptz,
  resolved_at timestamptz,
  failure_category text check (failure_category in ('dns', 'tls', 'timeout', 'http', 'connection', 'other')),
  notification_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index incidents_org_id_idx on public.incidents (organization_id);
create index incidents_monitor_id_idx on public.incidents (monitor_id);
create index incidents_status_idx on public.incidents (status);

create trigger set_updated_at before update on public.incidents
  for each row execute function public.set_updated_at();

create table public.incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_type text not null check (
    event_type in ('confirming_started', 'confirmed', 'notification_sent', 'recovered', 'note_added')
  ),
  detail jsonb,
  created_at timestamptz not null default now()
);

create index incident_events_incident_id_idx on public.incident_events (incident_id);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  website_id uuid not null references public.websites (id) on delete cascade,
  scan_run_id uuid references public.scan_runs (id) on delete set null,
  check_result_id uuid references public.check_results (id) on delete set null,
  incident_id uuid references public.incidents (id) on delete set null,
  type text not null,
  severity text not null check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  title text not null check (length(title) between 1 and 300),
  description text not null check (length(description) <= 5000),
  evidence jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'dismissed', 'converted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index findings_org_id_idx on public.findings (organization_id);
create index findings_website_id_idx on public.findings (website_id);
create index findings_status_idx on public.findings (status);

create trigger set_updated_at before update on public.findings
  for each row execute function public.set_updated_at();

-- A finding's scan_run/check_result/incident, when set, must share the
-- finding's organization_id (docs/DATA_MODEL.md §8). Skipped when the
-- finding's own organization_id is null (the free-scan exception), since
-- those referenced rows are themselves org-less in that case.
create or replace function public.check_finding_evidence_same_org()
returns trigger
language plpgsql
as $$
declare
  evidence_org_id uuid;
begin
  if new.organization_id is null then
    return new;
  end if;

  if new.scan_run_id is not null then
    select organization_id into evidence_org_id from public.scan_runs where id = new.scan_run_id;
    if evidence_org_id is distinct from new.organization_id then
      raise exception 'finding % scan_run % does not belong to organization %',
        new.id, new.scan_run_id, new.organization_id;
    end if;
  end if;

  if new.check_result_id is not null then
    select organization_id into evidence_org_id from public.check_results where id = new.check_result_id;
    if evidence_org_id is distinct from new.organization_id then
      raise exception 'finding % check_result % does not belong to organization %',
        new.id, new.check_result_id, new.organization_id;
    end if;
  end if;

  if new.incident_id is not null then
    select organization_id into evidence_org_id from public.incidents where id = new.incident_id;
    if evidence_org_id is distinct from new.organization_id then
      raise exception 'finding % incident % does not belong to organization %',
        new.id, new.incident_id, new.organization_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger check_finding_evidence_same_org
  before insert or update on public.findings
  for each row execute function public.check_finding_evidence_same_org();
