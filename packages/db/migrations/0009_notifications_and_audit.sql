-- Notification preferences and the organization-wide audit trail.
-- See docs/DATA_MODEL.md §7.
--
-- audit_events is never writable by any client-side call — every insert
-- happens server-side (service role or a trusted server route). Enforced by
-- RLS (0010_row_level_security.sql): read-only for owner/admin, no insert
-- policy granted to the authenticated role at all.
--
-- Rollback: `drop table audit_events, notification_preferences cascade;`

create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  event_type text not null check (
    event_type in ('incident_opened', 'incident_resolved', 'ssl_expiring', 'report_ready', 'approval_decided')
  ),
  channel text not null default 'email' check (channel in ('email')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, event_type, channel)
);

create index notification_preferences_org_user_idx on public.notification_preferences (organization_id, user_id);

create trigger set_updated_at before update on public.notification_preferences
  for each row execute function public.set_updated_at();

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_user_id uuid references auth.users (id),
  actor_type text not null check (actor_type in ('user', 'system', 'service')),
  action text not null check (length(action) between 1 and 200),
  target_type text,
  target_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_org_id_idx on public.audit_events (organization_id);
create index audit_events_created_at_idx on public.audit_events (created_at);
