-- Fixes a real schema gap discovered while building apps/worker's SSL-check
-- job handler: docs/DATA_MODEL.md's findings table had evidence pointers for
-- scan_run_id/check_result_id/incident_id, but SSL-driven findings (expiry
-- warnings, hostname mismatch, untrusted chain, expired) had nowhere to point
-- — ssl_checks was never one of the FK slots. Appending a migration rather
-- than editing 0005, which already shipped.
--
-- Rollback: `alter table public.findings drop column ssl_check_id; drop
-- trigger check_finding_ssl_check_same_org on public.findings; drop function
-- public.check_finding_ssl_check_same_org();`

alter table public.findings
  add column ssl_check_id uuid references public.ssl_checks (id) on delete set null;

create or replace function public.check_finding_ssl_check_same_org()
returns trigger
language plpgsql
as $$
declare
  evidence_org_id uuid;
begin
  if new.organization_id is null or new.ssl_check_id is null then
    return new;
  end if;

  select organization_id into evidence_org_id from public.ssl_checks where id = new.ssl_check_id;
  if evidence_org_id is distinct from new.organization_id then
    raise exception 'finding % ssl_check % does not belong to organization %',
      new.id, new.ssl_check_id, new.organization_id;
  end if;

  return new;
end;
$$;

create trigger check_finding_ssl_check_same_org
  before insert or update on public.findings
  for each row execute function public.check_finding_ssl_check_same_org();
