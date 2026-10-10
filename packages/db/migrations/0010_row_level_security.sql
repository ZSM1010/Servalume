-- Row-Level Security for every customer-facing table, plus the explicit GRANTs
-- that RLS policies sit on top of. See docs/ARCHITECTURE.md §5/§6 and
-- docs/THREAT_MODEL.md §2.
--
-- Convention: `anon` gets no table grants at all in this migration — every
-- anonymous-facing flow (free scan results, approval decisions, shared
-- reports) is served by a trusted server route using the service role with
-- its own explicit, narrow authorization checks, never direct PostgREST table
-- access. `authenticated` gets exactly the grants its RLS policies expect;
-- tables with no policy for a given operation have no grant for it either,
-- so the default is deny, not "grant exists but policy denies."
--
-- Rollback: `alter table <t> disable row level security;` plus `revoke all on
-- all tables in schema public from authenticated, anon;` reverses this file,
-- but leaves every other migration's objects intact.

-- ---------------------------------------------------------------------------
-- Organizations: no direct INSERT policy. Creating an org atomically creates
-- its first membership (the creator, as owner) — that can't be expressed as
-- two independent RLS-gated inserts without a race, so it goes through this
-- SECURITY DEFINER function instead. It is still auth.uid()-scoped: it can
-- only ever make the CALLER the owner of a BRAND NEW org, never touch an
-- existing one.
-- ---------------------------------------------------------------------------

create or replace function public.create_organization(org_name text, org_slug text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
begin
  if auth.uid() is null then
    raise exception 'create_organization requires an authenticated caller';
  end if;

  insert into public.organizations (name, slug) values (org_name, org_slug)
  returning id into new_org_id;

  insert into public.memberships (organization_id, user_id, role, status)
  values (new_org_id, auth.uid(), 'owner', 'active');

  return new_org_id;
end;
$$;

revoke all on function public.create_organization(text, text) from public;
grant execute on function public.create_organization(text, text) to authenticated;

alter table public.organizations enable row level security;
grant select, update, delete on public.organizations to authenticated;

create policy organizations_select on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

create policy organizations_update on public.organizations
  for update to authenticated
  using (public.is_org_owner(id))
  with check (public.is_org_owner(id));

create policy organizations_delete on public.organizations
  for delete to authenticated
  using (public.is_org_owner(id));

-- ---------------------------------------------------------------------------
-- Profiles: strictly own-row. Co-members' display names are exposed only
-- through the narrow SECURITY DEFINER function below, never a direct grant.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
grant select, insert, update on public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create or replace function public.org_member_profiles(target_org_id uuid)
returns table (user_id uuid, full_name text, avatar_url text)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_org_member(target_org_id) then
    return;
  end if;

  return query
    select p.id, p.full_name, p.avatar_url
    from public.profiles p
    join public.memberships m on m.user_id = p.id
    where m.organization_id = target_org_id
      and m.status = 'active';
end;
$$;

revoke all on function public.org_member_profiles(uuid) from public;
grant execute on function public.org_member_profiles(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Memberships: own org's rows selectable; owner/admin manage membership.
-- ---------------------------------------------------------------------------

alter table public.memberships enable row level security;
grant select, insert, update, delete on public.memberships to authenticated;

create policy memberships_select on public.memberships
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy memberships_insert on public.memberships
  for insert to authenticated
  with check (public.is_org_admin(organization_id));

create policy memberships_update on public.memberships
  for update to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

create policy memberships_delete on public.memberships
  for delete to authenticated
  using (public.is_org_admin(organization_id));

-- ---------------------------------------------------------------------------
-- Organization invitations: owner/admin only. Acceptance is handled by a
-- server route with the service role (the invitee has no membership yet to
-- check RLS against), not by a policy here.
-- ---------------------------------------------------------------------------

alter table public.organization_invitations enable row level security;
grant select, insert, update, delete on public.organization_invitations to authenticated;

create policy invitations_select on public.organization_invitations
  for select to authenticated
  using (public.is_org_admin(organization_id));

create policy invitations_insert on public.organization_invitations
  for insert to authenticated
  with check (public.is_org_admin(organization_id));

create policy invitations_update on public.organization_invitations
  for update to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

create policy invitations_delete on public.organization_invitations
  for delete to authenticated
  using (public.is_org_admin(organization_id));

-- ---------------------------------------------------------------------------
-- Clients, websites, monitors: any active member can manage day-to-day;
-- deleting a client/website (real data loss for reporting history) is
-- admin-only. monitor_schedules is worker-managed (service role) and only
-- readable here.
-- ---------------------------------------------------------------------------

alter table public.clients enable row level security;
grant select, insert, update, delete on public.clients to authenticated;

create policy clients_select on public.clients for select to authenticated using (public.is_org_member(organization_id));
create policy clients_insert on public.clients for insert to authenticated with check (public.is_org_member(organization_id));
create policy clients_update on public.clients for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy clients_delete on public.clients for delete to authenticated using (public.is_org_admin(organization_id));

alter table public.websites enable row level security;
grant select, insert, update, delete on public.websites to authenticated;

create policy websites_select on public.websites for select to authenticated using (public.is_org_member(organization_id));
create policy websites_insert on public.websites for insert to authenticated with check (public.is_org_member(organization_id));
create policy websites_update on public.websites for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy websites_delete on public.websites for delete to authenticated using (public.is_org_admin(organization_id));

alter table public.monitors enable row level security;
grant select, insert, update, delete on public.monitors to authenticated;

create policy monitors_select on public.monitors for select to authenticated using (public.is_org_member(organization_id));
create policy monitors_insert on public.monitors for insert to authenticated with check (public.is_org_member(organization_id));
create policy monitors_update on public.monitors for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy monitors_delete on public.monitors for delete to authenticated using (public.is_org_member(organization_id));

alter table public.monitor_schedules enable row level security;
grant select on public.monitor_schedules to authenticated;

create policy monitor_schedules_select on public.monitor_schedules
  for select to authenticated
  using (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- Measurements and findings: read-only for members. Every write comes from
-- the worker's deterministic checks via the service role, never a client
-- mutation — so there is no insert/update/delete grant for authenticated at
-- all. Rows with a null organization_id (free-scan) are excluded by the
-- policy, not just left to chance.
-- ---------------------------------------------------------------------------

alter table public.check_results enable row level security;
grant select on public.check_results to authenticated;
create policy check_results_select on public.check_results for select to authenticated using (public.is_org_member(organization_id));

alter table public.ssl_checks enable row level security;
grant select on public.ssl_checks to authenticated;
create policy ssl_checks_select on public.ssl_checks for select to authenticated using (public.is_org_member(organization_id));

alter table public.scan_runs enable row level security;
grant select on public.scan_runs to authenticated;
create policy scan_runs_select on public.scan_runs
  for select to authenticated
  using (organization_id is not null and public.is_org_member(organization_id));

alter table public.incidents enable row level security;
grant select on public.incidents to authenticated;
create policy incidents_select on public.incidents for select to authenticated using (public.is_org_member(organization_id));

alter table public.incident_events enable row level security;
grant select on public.incident_events to authenticated;
create policy incident_events_select on public.incident_events for select to authenticated using (public.is_org_member(organization_id));

alter table public.findings enable row level security;
grant select on public.findings to authenticated;
create policy findings_select on public.findings
  for select to authenticated
  using (organization_id is not null and public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- Work items, work logs: members manage work items; logs are append-only
-- (no update/delete grant — a correction is a new log entry, not an edit).
-- ---------------------------------------------------------------------------

alter table public.work_items enable row level security;
grant select, insert, update on public.work_items to authenticated;

create policy work_items_select on public.work_items for select to authenticated using (public.is_org_member(organization_id));
create policy work_items_insert on public.work_items for insert to authenticated with check (public.is_org_member(organization_id));
create policy work_items_update on public.work_items for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));

alter table public.work_logs enable row level security;
grant select, insert on public.work_logs to authenticated;

create policy work_logs_select on public.work_logs for select to authenticated using (public.is_org_member(organization_id));
create policy work_logs_insert on public.work_logs for insert to authenticated with check (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- Client approvals: no grant to anon or authenticated at all. The public
-- approval page and the agency dashboard's approval view are both served by
-- server routes using the service role with their own explicit checks
-- (token hash + expiry + revocation for the public page; org membership for
-- the dashboard) — see docs/THREAT_MODEL.md §3.
-- ---------------------------------------------------------------------------

alter table public.client_approvals enable row level security;
revoke all on public.client_approvals from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reporting: members can request/view reports and manage their own org's
-- share links. The worker (service role) fills in data_snapshot/status.
-- ---------------------------------------------------------------------------

alter table public.reports enable row level security;
grant select, insert on public.reports to authenticated;

create policy reports_select on public.reports for select to authenticated using (public.is_org_member(organization_id));
create policy reports_insert on public.reports
  for insert to authenticated
  with check (public.is_org_member(organization_id) and status = 'draft');

alter table public.report_deliveries enable row level security;
grant select on public.report_deliveries to authenticated;
create policy report_deliveries_select on public.report_deliveries for select to authenticated using (public.is_org_member(organization_id));

alter table public.share_links enable row level security;
grant select, insert, update on public.share_links to authenticated;

create policy share_links_select on public.share_links for select to authenticated using (public.is_org_member(organization_id));
create policy share_links_insert on public.share_links for insert to authenticated with check (public.is_org_member(organization_id));
create policy share_links_update on public.share_links for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- Billing: subscriptions readable by members; every write is the Stripe
-- webhook route via service role. subscription_events/usage_records are
-- internal bookkeeping with no client-facing access at all.
-- ---------------------------------------------------------------------------

alter table public.subscriptions enable row level security;
grant select on public.subscriptions to authenticated;
create policy subscriptions_select on public.subscriptions for select to authenticated using (public.is_org_member(organization_id));

alter table public.subscription_events enable row level security;
revoke all on public.subscription_events from anon, authenticated;

alter table public.usage_records enable row level security;
revoke all on public.usage_records from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Notification preferences: each user manages only their own rows.
-- ---------------------------------------------------------------------------

alter table public.notification_preferences enable row level security;
grant select, insert, update, delete on public.notification_preferences to authenticated;

create policy notification_preferences_select on public.notification_preferences
  for select to authenticated
  using (user_id = auth.uid() and public.is_org_member(organization_id));

create policy notification_preferences_insert on public.notification_preferences
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_org_member(organization_id));

create policy notification_preferences_update on public.notification_preferences
  for update to authenticated
  using (user_id = auth.uid() and public.is_org_member(organization_id))
  with check (user_id = auth.uid() and public.is_org_member(organization_id));

create policy notification_preferences_delete on public.notification_preferences
  for delete to authenticated
  using (user_id = auth.uid() and public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- Audit events: owner/admin can read their org's trail; never client-writable.
-- ---------------------------------------------------------------------------

alter table public.audit_events enable row level security;
grant select on public.audit_events to authenticated;
create policy audit_events_select on public.audit_events for select to authenticated using (public.is_org_admin(organization_id));
