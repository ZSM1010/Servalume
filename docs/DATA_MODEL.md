# Servalume — Data Model

Status: Phase 1 planning document. This is the schema design to be implemented as
migrations in Phase 2, not a schema that exists yet. Column lists are the planning
baseline; migrations are the source of truth once written.

Conventions used throughout:

- Every table has `id uuid primary key default gen_random_uuid()`, `created_at
  timestamptz not null default now()`, and `updated_at timestamptz not null default
  now()` (maintained by a shared trigger) unless noted otherwise.
- Every tenant-owned table has `organization_id uuid not null references
  organizations(id)`, indexed, and is covered by Row-Level Security (RLS).
- "RLS: standard member read" means: `organization_id in (select organization_id
  from memberships where user_id = auth.uid() and status = 'active')`. Write
  policies are noted explicitly where they differ (e.g. role-restricted).
- Soft-delete (`archived_at` / `deleted_at`) is used where history must be kept for
  reports even after a record is retired; hard delete is used only where no
  reporting value exists in keeping the row (e.g. expired share tokens may be purged
  by retention job, not by user action).

## 1. Tenancy and identity

### `organizations`
| column | type | notes |
|---|---|---|
| name | text not null | |
| slug | text not null unique | URL-safe, used in share-link routing namespace |
| deleted_at | timestamptz | set by account-deletion workflow; see §9 |

RLS: members can select their own org; only `owner` can update/delete.

### `profiles`
Mirrors `auth.users` for display purposes (Supabase does not let app code join
directly against `auth.users` from the client).
| column | type | notes |
|---|---|---|
| id | uuid primary key references auth.users(id) | |
| full_name | text | |
| avatar_url | text | |

RLS: a user can select/update only their own profile; profiles of co-members are
exposed through a narrow view (`id`, `full_name`, `avatar_url` only) joined via
`memberships`, not through direct table grants.

### `memberships`
| column | type | notes |
|---|---|---|
| organization_id | uuid not null references organizations(id) | |
| user_id | uuid not null references auth.users(id) | |
| role | text not null check (role in ('owner','admin','member')) | client-facing read-only role deferred until a real need appears (see PRODUCT_SPEC) |
| status | text not null check (status in ('active','revoked')) default 'active' | |
| unique(organization_id, user_id) | | |

RLS: select own org's memberships; insert/update/delete restricted to `owner`/`admin`
of that org (checked via a `SECURITY DEFINER` helper function, not a self-referencing
policy, to avoid recursive RLS evaluation).

### `organization_invitations`
| column | type | notes |
|---|---|---|
| organization_id | uuid not null references organizations(id) | |
| email | citext not null | |
| role | text not null check (role in ('owner','admin','member')) | |
| token_hash | text not null unique | SHA-256 of a random token; raw token only ever exists in the email link |
| invited_by_user_id | uuid not null references auth.users(id) | |
| expires_at | timestamptz not null | |
| accepted_at | timestamptz | |
| revoked_at | timestamptz | |

RLS: `owner`/`admin` of the org only. Acceptance is handled by a server route using
the service role (the invitee isn't a member yet, so they have no RLS access) which
verifies the hash, expiry and revocation state, then creates the `memberships` row.

## 2. Clients and websites

### `clients`
| column | type | notes |
|---|---|---|
| organization_id | | |
| name | text not null | |
| contact_name | text | |
| contact_email | citext | |
| notes | text | |
| archived_at | timestamptz | |

### `websites`
| column | type | notes |
|---|---|---|
| organization_id | | |
| client_id | uuid references clients(id) | nullable: a website can exist before being assigned to a client |
| url | text not null | normalized (scheme+host+port) at write time |
| display_name | text | |
| timezone | text not null default 'UTC' | used for report period boundaries |
| archived_at | timestamptz | |
| check (client_id is null or exists matching organization_id) enforced via trigger | | DB-level guard: a website's client must belong to the same organization |

Unique index on `(organization_id, url)` to avoid accidental duplicate monitoring of
the same site within one org.

### `monitors`
| column | type | notes |
|---|---|---|
| website_id | uuid not null references websites(id) | |
| organization_id | | denormalized from website for direct RLS/filtering without a join |
| type | text not null check (type in ('http_uptime','ssl_cert')) | |
| config | jsonb not null default '{}' | e.g. expected status codes, request method |
| interval_seconds | integer not null check (interval_seconds >= 60) | plan-aware floor enforced in app logic, not just this check |
| is_active | boolean not null default true | |

Trigger enforces `monitors.organization_id = (select organization_id from websites
where id = monitor.website_id)` so a monitor can never be attached to another org's
website even by direct SQL.

### `monitor_schedules`
One row per monitor; the scheduler tick reads this table, not `monitors` directly,
so "next due" state is separate from configuration.
| column | type | notes |
|---|---|---|
| monitor_id | uuid not null unique references monitors(id) | |
| organization_id | | |
| next_run_at | timestamptz not null | advanced with jitter after each enqueue |
| last_enqueued_job_id | text | pg-boss job id, for traceability |
| last_run_at | timestamptz | |
| consecutive_failures | integer not null default 0 | feeds incident confirmation, not alerting directly |

## 3. Measurements

### `check_results`
| column | type | notes |
|---|---|---|
| monitor_id | uuid not null references monitors(id) | |
| website_id, organization_id | | denormalized for query/report performance |
| scheduled_at | timestamptz not null | when it was supposed to run |
| started_at / completed_at | timestamptz | actual execution window; null `completed_at` + old `started_at` reads as an interrupted check, not a success |
| status | text not null check (status in ('success','failure','error','timeout','skipped')) | never written until the attempt actually finished one way or another |
| http_status_code | integer | |
| response_time_ms, dns_time_ms, tcp_time_ms, tls_time_ms, ttfb_ms | integer | nullable individually — not every timing phase is always available |
| response_headers | jsonb | sanitized: auth/cookie headers stripped before storage |
| failure_category | text check (in 'dns','tls','timeout','http','connection','other') | null on success |
| failure_reason | text | human-readable, bounded length |
| checker_region | text not null | identifies which probe location ran it (see THREAT_MODEL re: honesty about single- vs multi-region) |
| attempt_number | integer not null default 1 | |
| request_id, job_id | text | correlates to worker logs |

Index on `(monitor_id, scheduled_at)` and `(organization_id, scheduled_at)` for report
period queries. **No row is ever inserted speculatively** — a scheduled check that
never ran produces no row, and reporting code treats a gap in `scheduled_at` coverage
as "unavailable," never as implicit success.

### `ssl_checks`
| column | type | notes |
|---|---|---|
| monitor_id, website_id, organization_id | | |
| checked_at | timestamptz not null | |
| status | text not null check (in 'valid','expiring_soon','expired','hostname_mismatch','untrusted_chain','unreachable','error') | |
| valid_from, valid_to | timestamptz | null if the check didn't get far enough to read the cert |
| days_until_expiry | integer | derived at write time from valid_to and checked_at |
| issuer, subject | text | |
| chain_length | integer | |
| failure_reason | text | |

### `scan_runs`
Represents one execution of the free public scan or an authenticated ad-hoc scan.
| column | type | notes |
|---|---|---|
| organization_id | uuid references organizations(id) | **nullable** — the only tenant table with a deliberate exception, for anonymous free scans; see THREAT_MODEL §free-scan |
| website_id | uuid references websites(id) | nullable for anonymous scans against a URL with no stored website row |
| submitted_url | text not null | |
| source | text not null check (in 'authenticated','public_free_scan') | |
| status | text not null check (in 'queued','running','completed','failed')) | |
| started_at, completed_at | timestamptz | |
| requested_by_user_id | uuid references auth.users(id) | null for anonymous |
| requester_ip_hash | text | salted hash, never raw IP, used only for free-scan rate limiting |

RLS: authenticated rows follow standard org policy; anonymous rows (`organization_id
is null`) are not selectable via PostgREST/RLS at all — the free-scan result page is
served by a server route using a short-lived signed result token, not a table grant.

## 4. Findings, incidents, work

### `findings`
| column | type | notes |
|---|---|---|
| organization_id | nullable, same exception as scan_runs for free-scan findings | |
| website_id | | |
| scan_run_id | uuid references scan_runs(id) | nullable |
| check_result_id | uuid references check_results(id) | nullable |
| incident_id | uuid references incidents(id) | nullable |
| type | text not null | deterministic rule identifier, e.g. `ssl_expiring_30d`, `http_5xx` |
| severity | text not null check (in 'info','low','medium','high','critical') | |
| title, description | text not null | generated by the rule template, not free text from a model |
| evidence | jsonb not null | pointer(s) to the originating row(s) plus the raw values the rule evaluated |
| detected_at | timestamptz not null | |
| status | text not null check (in 'open','dismissed','converted')) default 'open' | |

Trigger enforces that `check_result_id`/`incident_id`/`scan_run_id`, when set, belong
to the same `organization_id` as the finding (where organization_id is not null).

### `incidents`
| column | type | notes |
|---|---|---|
| organization_id, website_id, monitor_id | | |
| status | text not null check (in 'confirming','open','resolved')) | state machine detailed below |
| first_check_result_id | uuid not null references check_results(id) | the initial failing check |
| confirming_check_result_id | uuid references check_results(id) | the retry that confirmed it |
| resolution_check_result_id | uuid references check_results(id) | the check that proved recovery |
| opened_at | timestamptz | set only on confirmation, not on first failure |
| confirmed_at, resolved_at | timestamptz | |
| failure_category | text | copied from the confirming check at confirmation time |
| notification_sent_at | timestamptz | dedup marker — see worker job lifecycle |

**State machine** (deterministic, enforced in application code and covered by Phase
3 tests, not just documented):
```
no incident --(check fails)--> confirming (not yet visible as "downtime")
confirming --(confirmation check also fails, within bounded retries)--> open
                                                                        (opened_at set,
                                                                         notification enqueued)
confirming --(confirmation check succeeds)--> discarded (flaky blip, no incident row
                                                           kept — see note)
open --(a later check succeeds)--> resolved (resolved_at set, recovery notification
                                              enqueued)
```
Note: a `confirming` row is only persisted once a first failure happens; if the
confirmation check immediately succeeds, the row's status is written as
`resolved`-with-no-`opened_at` rather than silently deleted, so the flapping event is
still visible in history without counting as reported downtime.

### `incident_events`
Append-only audit trail inside one incident (separate from the org-wide
`audit_events`, which tracks user actions rather than monitoring-state transitions).
| column | type | notes |
|---|---|---|
| incident_id, organization_id | | |
| event_type | text not null check (in 'confirming_started','confirmed','notification_sent','recovered','note_added')) | |
| detail | jsonb | |

### `work_items`
| column | type | notes |
|---|---|---|
| organization_id, client_id, website_id | client_id/website_id nullable individually but at least one required (check constraint) | |
| finding_id | uuid references findings(id) | nullable — manually created items have none |
| title, description | text not null | |
| recommended_action | text | |
| severity | text check (in 'info','low','medium','high','critical')) | |
| status | text not null check (in 'detected','needs_review','recommended','awaiting_approval','approved','declined','in_progress','completed','verification_failed','verified','closed')) default 'detected' | |
| requires_client_approval | boolean not null default true | lets an agency mark internal-only work explicitly |
| assigned_user_id | uuid references auth.users(id) | must be a member of the same org — enforced via trigger joining `memberships` |
| created_by_user_id | uuid references auth.users(id) | null for system-detected items until a human takes ownership |
| closed_at | timestamptz | |

Status transitions are enforced by an application-layer state table (allowed
`from -> to` pairs), checked server-side on every update — not by a DB CHECK
constraint, since the legal transition depends on `requires_client_approval` and on
whether a verification check actually ran.

### `work_logs`
| column | type | notes |
|---|---|---|
| work_item_id, organization_id | | |
| actor_user_id | uuid references auth.users(id) | null for `entry_type = 'system_event'` |
| entry_type | text not null check (in 'manual_note','status_change','system_event')) | |
| description | text not null | |
| occurred_at | timestamptz not null default now() | |

### `client_approvals`
| column | type | notes |
|---|---|---|
| work_item_id, organization_id, client_id | | |
| token_hash | text not null unique | SHA-256; raw token lives only in the emailed/shared link |
| status | text not null check (in 'pending','approved','declined','clarification_requested','expired','revoked')) default 'pending' | |
| presented_title, presented_recommendation | text not null | **snapshotted** at send time — if the work item is edited later, the approval record still shows exactly what the client saw |
| presented_evidence | jsonb | snapshot, same reasoning |
| decided_at | timestamptz | |
| decision_note | text | client's free-text clarification request, bounded length |
| expires_at | timestamptz not null | |
| revoked_at | timestamptz | |
| ip_hash, user_agent_hash | text | salted hashes only, for abuse/rate-limit detection, never raw |

RLS: no `anon`/`authenticated` policy grants direct access at all — every read/write
against this table from the public approval page goes through a server route using
the service role plus explicit token-hash lookup, expiry check and revocation check
on every request (not cached after first validation). See THREAT_MODEL §approvals.

## 5. Reporting

### `reports`
| column | type | notes |
|---|---|---|
| organization_id, client_id | client_id nullable (org-wide report) | |
| period_start, period_end | date not null | check (period_end > period_start) |
| status | text not null check (in 'draft','generated','failed')) | |
| data_snapshot | jsonb | written once by the worker job; immutable afterward (enforced by a trigger rejecting updates to this column once status='generated') |
| generated_at | timestamptz | |
| created_by_user_id | uuid references auth.users(id) | |

### `report_deliveries`
| column | type | notes |
|---|---|---|
| report_id, organization_id | | |
| channel | text not null check (in 'email','share_link')) | |
| recipient | text | email address, or null for share_link |
| status | text not null check (in 'pending','sent','failed')) | |
| sent_at | timestamptz | |
| error | text | |

### `share_links`
| column | type | notes |
|---|---|---|
| report_id, organization_id | | |
| token_hash | text not null unique | |
| status | text not null check (in 'active','revoked','expired')) default 'active' | |
| expires_at | timestamptz | |
| revoked_at | timestamptz | |
| last_accessed_at | timestamptz | |
| access_count | integer not null default 0 | |

The public report-viewing route re-checks `status`/`expires_at` on **every** request
— revocation takes effect immediately, not only for new links.

## 6. Billing and usage

### `subscriptions`
| column | type | notes |
|---|---|---|
| organization_id | uuid not null unique references organizations(id) | one subscription per org for v1 |
| plan | text not null check (in 'free','solo','studio','agency')) | |
| status | text not null check (in 'trialing','active','past_due','canceled','incomplete')) | mirrors Stripe subscription status, not a locally-invented state |
| stripe_customer_id, stripe_subscription_id | text | |
| current_period_start, current_period_end | timestamptz | |
| cancel_at_period_end | boolean not null default false | |

RLS: select by any member; update only ever performed by the Stripe-webhook server
route using the service role — never by a client-side mutation, per the master
spec's "do not grant entitlements because the browser says payment succeeded" rule.

### `subscription_events`
| column | type | notes |
|---|---|---|
| organization_id | uuid references organizations(id) | nullable until the customer is matched |
| stripe_event_id | text not null unique | webhook idempotency key — a replayed/duplicate Stripe event is a no-op insert conflict, not reprocessed |
| type | text not null | |
| payload | jsonb not null | raw event, for audit/debugging |
| processed_at | timestamptz | |

### `usage_records`
Generic metered-usage counter for anything that needs a rolling window rather than a
live count (free-scan rate limiting by IP, monthly report-send caps). Live entitlement
checks for "number of websites" or "number of team members" are plain `COUNT(*)`
queries against the real tables, not tracked here, so they can never drift from
reality.
| column | type | notes |
|---|---|---|
| organization_id | uuid references organizations(id) | nullable (IP-keyed anonymous usage has none) |
| subject_type | text not null check (in 'organization','ip_hash')) | |
| subject_key | text not null | org id as text, or the salted IP hash |
| metric | text not null | e.g. `free_scan`, `report_send` |
| period_start, period_end | timestamptz not null | |
| count | integer not null default 0 | |
| unique(subject_type, subject_key, metric, period_start) | | |

## 7. Notifications and audit

### `notification_preferences`
| column | type | notes |
|---|---|---|
| organization_id, user_id | | |
| event_type | text not null check (in 'incident_opened','incident_resolved','ssl_expiring','report_ready','approval_decided')) | |
| channel | text not null check (in 'email')) default 'email' | extensible later |
| enabled | boolean not null default true | |
| unique(organization_id, user_id, event_type, channel) | | |

### `audit_events`
| column | type | notes |
|---|---|---|
| organization_id | | |
| actor_user_id | uuid references auth.users(id) | null for system/service actions |
| actor_type | text not null check (in 'user','system','service')) | |
| action | text not null | e.g. `work_item.status_changed`, `share_link.revoked` |
| target_type, target_id | text, uuid | polymorphic reference, not a FK (targets span many tables) |
| metadata | jsonb | never includes secrets/tokens — redacted before insert |

RLS: read-only for `owner`/`admin`; never writable by any client-side call — every
insert happens server-side.

## 8. Cross-organization integrity, enforced at the DB level

Beyond FKs, the following are implemented as triggers (not just app-layer checks),
because the master spec requires this to hold even against direct SQL / a buggy
service-role query:

- `monitors.organization_id` must match its `website.organization_id`.
- `websites.client_id`, when set, must belong to `websites.organization_id`.
- `findings.{scan_run_id, check_result_id, incident_id}`, when set, must share the
  finding's `organization_id`.
- `work_items.finding_id`, when set, must share the work item's `organization_id`.
- `work_items.assigned_user_id`, when set, must be an active member of
  `work_items.organization_id`.
- `client_approvals.work_item_id` must share `client_approvals.organization_id`.
- `share_links.report_id` must share `share_links.organization_id`.

These are exactly the cases the master spec calls out (e.g. "do not allow a work item
to reference a finding from another organization") and are the first targets of the
Phase 2 cross-org isolation test suite, exercised both through RLS (as a normal user)
and directly (as the service role, which RLS does not constrain).

## 9. Account deletion

Deleting an organization (`organizations.deleted_at` set) triggers, in order:
revoke all `share_links` and `client_approvals` immediately (status flip, not
deletion, so audit history survives); cancel any pending pg-boss jobs referencing the
org; retain `audit_events` and `subscription_events` per a documented retention
window (default: 90 days post-deletion, then purged) for billing-dispute and abuse
investigation purposes; hard-delete all other tenant rows via `ON DELETE CASCADE`
from `organizations`. The exact retention window is a policy choice to confirm with
the user before Phase 4 implements the deletion workflow — see
[ASSUMPTIONS.md](./ASSUMPTIONS.md).
