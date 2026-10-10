-- Measurements: check_results, ssl_checks, scan_runs.
-- See docs/DATA_MODEL.md §3.
--
-- scan_runs.organization_id is deliberately nullable: the only tenant table
-- with this exception, for anonymous free scans (see docs/DATA_MODEL.md §3 and
-- docs/THREAT_MODEL.md §7). It is NOT exposed through RLS to anon/authenticated
-- roles at all — see 0010_row_level_security.sql.
--
-- Rollback: `drop table scan_runs, ssl_checks, check_results cascade;`

create table public.check_results (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.monitors (id) on delete cascade,
  website_id uuid not null references public.websites (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  scheduled_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  status text not null check (status in ('success', 'failure', 'error', 'timeout', 'skipped')),
  http_status_code integer,
  response_time_ms integer,
  dns_time_ms integer,
  tcp_time_ms integer,
  tls_time_ms integer,
  ttfb_ms integer,
  response_headers jsonb,
  failure_category text check (failure_category in ('dns', 'tls', 'timeout', 'http', 'connection', 'other')),
  failure_reason text check (length(failure_reason) <= 2000),
  checker_region text not null,
  attempt_number integer not null default 1 check (attempt_number >= 1),
  request_id text,
  job_id text,
  created_at timestamptz not null default now()
);

create index check_results_monitor_scheduled_idx on public.check_results (monitor_id, scheduled_at);
create index check_results_org_scheduled_idx on public.check_results (organization_id, scheduled_at);
create index check_results_website_id_idx on public.check_results (website_id);

create table public.ssl_checks (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.monitors (id) on delete cascade,
  website_id uuid not null references public.websites (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  checked_at timestamptz not null,
  status text not null check (
    status in ('valid', 'expiring_soon', 'expired', 'hostname_mismatch', 'untrusted_chain', 'unreachable', 'error')
  ),
  valid_from timestamptz,
  valid_to timestamptz,
  days_until_expiry integer,
  issuer text,
  subject text,
  chain_length integer,
  failure_reason text check (length(failure_reason) <= 2000),
  created_at timestamptz not null default now()
);

create index ssl_checks_monitor_checked_idx on public.ssl_checks (monitor_id, checked_at);
create index ssl_checks_org_checked_idx on public.ssl_checks (organization_id, checked_at);

create table public.scan_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  website_id uuid references public.websites (id) on delete cascade,
  submitted_url text not null check (length(submitted_url) between 1 and 2048),
  source text not null check (source in ('authenticated', 'public_free_scan')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  requested_by_user_id uuid references auth.users (id),
  requester_ip_hash text,
  created_at timestamptz not null default now(),
  check (
    (source = 'authenticated' and organization_id is not null)
    or (source = 'public_free_scan' and organization_id is null)
  )
);

create index scan_runs_org_id_idx on public.scan_runs (organization_id);
create index scan_runs_website_id_idx on public.scan_runs (website_id);
