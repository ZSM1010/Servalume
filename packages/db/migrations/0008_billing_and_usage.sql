-- Subscriptions, webhook idempotency, metered usage. See docs/DATA_MODEL.md §6.
--
-- subscriptions is only ever written by the Stripe-webhook server route using
-- the service role (docs/THREAT_MODEL.md §4) — never by a client-side
-- mutation. Enforced by RLS (0010_row_level_security.sql), not by this file.
--
-- Rollback: `drop table usage_records, subscription_events, subscriptions cascade;`

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations (id) on delete cascade,
  plan text not null check (plan in ('free', 'solo', 'studio', 'agency')),
  status text not null check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

create table public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  stripe_event_id text not null unique,
  type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index subscription_events_org_id_idx on public.subscription_events (organization_id);

create table public.usage_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  subject_type text not null check (subject_type in ('organization', 'ip_hash')),
  subject_key text not null,
  metric text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (subject_type, subject_key, metric, period_start)
);

create index usage_records_org_id_idx on public.usage_records (organization_id);

create trigger set_updated_at before update on public.usage_records
  for each row execute function public.set_updated_at();
