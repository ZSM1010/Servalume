# Servalume — Implementation Plan

Status: Phase 1 planning document, produced before any application code exists in
this repository. Phase numbers match the master spec's build sequence. **This repo
currently contains only the Phase 1 planning docs** — nothing below Phase 1 has been
implemented yet. Each phase's "Done means" section is the bar for calling it
complete, per the master spec's Definition of Done: implemented, documented, tested,
authorization/failure cases covered, config documented, type-check/lint/build green,
remaining operational dependencies disclosed.

## Phase 1 — Inspect and design (this phase)

Deliverables: this file, PRODUCT_SPEC.md, ARCHITECTURE.md, DATA_MODEL.md,
THREAT_MODEL.md, ENVIRONMENT_VARIABLES.md, ASSUMPTIONS.md. No application code.
**Stopping here for review before Phase 2 starts**, per the master spec's explicit
instruction to stop after planning.

## Phase 2 — Database and test foundation

1. Scaffold the npm workspaces monorepo (`apps/web`, `apps/worker`,
   `packages/db`, `packages/safe-fetch`, `packages/shared`), pinned dependency
   versions from ARCHITECTURE.md §1, `.nvmrc`, root `tsconfig.base.json`,
   ESLint/Prettier config, committed lockfile.
2. Provision a local Supabase stack (Supabase CLI, Dockerized Postgres) for
   migration development and tests — this does not require a live Supabase Cloud
   project, so it is not blocked on credentials.
3. Write SQL migrations for every table in DATA_MODEL.md, including the
   cross-organization integrity triggers (§8), updated-at triggers, and indexes.
4. Write RLS policies for every tenant-facing table and the `SECURITY DEFINER`
   helper function used to avoid recursive-policy issues on `memberships`.
5. Development seed data (`packages/db/seed`), explicitly isolated from any
   production data path (a `--seed` flag/script, never auto-run against a
   non-local `DATABASE_URL`).
6. Test infrastructure: Vitest configured against the local Supabase stack (a
   disposable test database per run), plus the cross-org isolation test suite
   described in THREAT_MODEL §2 — both the RLS-path tests and the service-role-path
   tests.
7. Run the full Phase 2 test suite locally before moving on.

Done means: migrations apply cleanly from empty, seed script runs, every RLS-covered
table has at least one cross-org isolation test that fails if the policy is removed
(verified by temporarily removing a policy and confirming the test catches it),
`tsc --noEmit` and lint are clean.

Credential dependency: none — everything in this phase runs against a local
Supabase CLI stack.

## Phase 3 — Safe-fetch and monitoring foundation

1. Build `packages/safe-fetch` to the full contract in THREAT_MODEL §1, with its own
   isolated unit/integration test suite (DNS rebinding via a controllable test DNS
   resolver, redirect chains, IP-range table, forbidden ports, oversized/slow
   responses) before it is wired into anything else.
2. Build the pg-boss-backed scheduler and worker skeleton in `apps/worker`.
3. Implement `monitor.check` (HTTP uptime) and `ssl.check` job handlers using
   safe-fetch exclusively.
4. Implement the incident confirmation/open/resolve state machine and
   notification-dedup logic exactly as specified in DATA_MODEL.md §4.
5. Implement retry/backoff and job-locking/recovery behavior (kill a worker
   mid-job in a test and confirm the job is recovered, not silently dropped or
   duplicated).
6. Implement the email-provider interface with a default Resend implementation and
   a documented SMTP fallback.
7. Test real failure/recovery paths against a controlled target (a local test
   server that can be made to fail/time out/serve a bad cert on command), not just
   mocked responses.

Done means: a monitor pointed at a controlled test server correctly produces
`confirming -> open -> resolved` incident rows with exactly one notification per
transition, duplicate/retried job runs never create a second incident or a second
notification, and the full safe-fetch attack-surface test list from THREAT_MODEL §1
passes.

Credential dependency: an email provider API key is needed to test real delivery
(a sandbox/test key is sufficient and is the recommended setup, not a production
sending domain).

## Phase 4 — Product workflow

1. Authentication (Supabase Auth: email/password + magic link), organization
   creation, invitations (`organization_invitations` flow), role enforcement.
2. Client and website CRUD, monitor configuration, honoring plan limits
   server-side from the central plan module.
3. Deterministic finding rules (one rule per `findings.type` — e.g. SSL expiring in
   30/14/7 days, N consecutive HTTP failures, non-2xx status) that read stored
   `check_results`/`ssl_checks` and write `findings`, with no free-text generation.
4. Finding → work item conversion, manual work-item creation, the documented status
   state machine (DATA_MODEL.md §`work_items`), work logs.
5. Client approval link generation/sending, the public approval-decision page, and
   its audit trail — built exactly to THREAT_MODEL §3.
6. Verification: re-running the originating check against a completed work item
   where technically possible, and recording `verified`/`verification_failed`
   honestly (never auto-set without an actual re-check).

Done means: the full evidence→finding→work item→approval→verification chain is
exercised end-to-end by an integration test using a controlled test target, approval
token tests from THREAT_MODEL §3 pass, and no status transition is reachable through
the API other than the documented ones.

Credential dependency: none beyond Phase 2/3's local stack; a real Supabase Cloud
project is only needed once this is deployed, not for local development/testing.

## Phase 5 — Reporting

1. Report-period query layer (strictly bounded by `period_start`/`period_end` and
   `organization_id`), computing uptime/coverage/incident/findings/work metrics per
   ARCHITECTURE.md §7, with "unavailable" labeling for anything under-measured.
2. Branded HTML report template (global org branding: name, logo, colors, contact
   info) rendered server-side from `data_snapshot` only.
3. Async PDF rendering via the isolated Playwright process, with timeout/size
   limits, queued and retried like any other worker job.
4. Share-link creation, revocation, and the public report-viewing route that
   re-checks status/expiry on every request.
5. Report-delivery tracking (`report_deliveries`) for the email channel.

Done means: a report generated from seeded Phase 3/4 data shows numbers that are
independently reconstructable from the raw `check_results`/`incidents`/`work_items`
rows for that period; a revoked share link returns "not available" within the same
request cycle, not after a cache TTL; PDF generation failure is retried and
eventually surfaced as a visible `failed` status, never silently stuck.

Credential dependency: none for HTML reports; PDF rendering needs Playwright's
browser binaries installed on the worker host (a build-time step, not a third-party
credential).

## Phase 6 — Billing and bounded crawler

1. Stripe integration in test mode: checkout/customer-portal flow, webhook handler
   with signature verification, `subscription_events` idempotency, and the
   canceled/past-due/upgraded/downgraded/refunded test matrix from THREAT_MODEL §4.
2. Central plan-definition module wired to every enforcement point listed in the
   master spec §9 (add website, create monitor, schedule check, start scan, send
   report, invite user, premium branding, bulk jobs).
3. Bounded crawler (`crawl.run` job type): robots.txt compliance, `ServalumeBot/1.0`
   UA (checked for naming conflicts before shipping), 100-page/3-depth defaults,
   1-second per-host delay, canonicalization + loop prevention, response-size and
   execution-time caps, cancellation — reusing `packages/safe-fetch` for every
   request it makes, not a separate HTTP client.
4. Crawler findings: internal broken links, external broken links (bounded subset),
   missing title/meta description/alt text — reported as observations, not
   diagnoses.

Done means: Stripe test-mode flows pass against Stripe's test webhook event
fixtures/CLI; the crawler, pointed at a local multi-page test site with a
restrictive `robots.txt`, respects every limit above and a crawl-loop test
(symlink-style circular links) terminates instead of hanging.

Credential dependency: a Stripe test-mode account (free to create) and its test API
keys/webhook secret are required to exercise this phase; no live Stripe account is
touched.

## Phase 7 — Release-readiness review

Full test suite, `tsc --noEmit`, lint, production build, and the full security test
list (RLS, SSRF, share-link authorization, queue recovery/duplicate-notification,
missing-monitoring-data handling, account deletion) run together. Deployment
instructions finalized for the chosen hosting split (web app vs. persistent worker —
see ASSUMPTIONS.md for the undecided hosting provider). Every incomplete feature,
manual setup step, known limitation, and any skipped test is written down explicitly
— not implied by a green checkmark.

## What requires the user before it can go further than "implemented and tested
## locally"

- A live Supabase Cloud project (URL + anon key + service role key) — only needed to
  deploy; all of Phases 2–6 can be implemented and tested against the local
  Supabase CLI stack without it.
- A Stripe account in test mode (free) for Phase 6.
- An email provider account (Resend or SMTP credentials) for real-delivery testing
  in Phase 3 — a sandbox/test key is enough; Phase 3's job logic can otherwise be
  tested with the provider call mocked at the interface boundary.
- A hosting decision for `apps/worker` (persistent-process host) — see
  ASSUMPTIONS.md; not needed until Phase 7 deployment.
- Confirmation of the account-deletion retention window (DATA_MODEL.md §9) before
  Phase 4 ships the deletion workflow.

None of these block writing and testing the code; they block **deploying** it.
