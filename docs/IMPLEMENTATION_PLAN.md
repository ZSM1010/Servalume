# Servalume — Implementation Plan

Status: Phase numbers match the master spec's build sequence. Each phase's "Done
means" section is the bar for calling it complete, per the master spec's Definition
of Done: implemented, documented, tested, authorization/failure cases covered,
config documented, type-check/lint/build green, remaining operational dependencies
disclosed. **Current status (2026-10-10): Phases 2 and 3 are both done.**
205 real tests passing across all four packages (`packages/shared` 23,
`packages/safe-fetch` 100, `packages/db` 45, `apps/worker` 37), `tsc --noEmit` and
`eslint .` clean everywhere. Phase 4 (authentication, clients, websites, findings,
work logs, approvals — i.e. `apps/web`) has not started.

## Phase 1 — Inspect and design (this phase)

Deliverables: this file, PRODUCT_SPEC.md, ARCHITECTURE.md, DATA_MODEL.md,
THREAT_MODEL.md, ENVIRONMENT_VARIABLES.md, ASSUMPTIONS.md. No application code.
**Stopping here for review before Phase 2 starts**, per the master spec's explicit
instruction to stop after planning.

## Phase 2 — Database and test foundation — DONE (2026-10-10)

1. ✅ Scaffolded the npm workspaces monorepo (`packages/db`, `packages/safe-fetch`,
   `packages/shared` exist; `apps/web`/`apps/worker` do not yet — Phase 3/4 work).
   Pinned dependency versions verified against the npm registry; TypeScript pinned
   to 6.0.3 instead of 7.x (see ARCHITECTURE.md §1 — typescript-eslint doesn't
   support 7.x yet, discovered via a real failed install).
2. **Deviation from the original plan, disclosed:** no Docker/Supabase CLI is
   available in this environment (confirmed — `docker`, `supabase`, `psql` are all
   absent, and installing PostgreSQL natively via winget fails because its installer
   needs interactive UAC elevation this sandbox can't grant). Used
   `@electric-sql/pglite` instead — real PostgreSQL 18.3 compiled to WASM, not a
   mock — with a test-only shim (`packages/db/test/supabaseShim.ts`) that creates
   faithful stand-ins for Supabase's `auth` schema/`auth.uid()`/anon/authenticated/
   service_role roles, which the real migrations assume already exist (exactly as
   they do on a real Supabase project) and never create themselves. This is a single
   persistent connection used sequentially, not genuine connection-pooled
   concurrency — documented in the shim's own header comment. The real migration
   runner (`packages/db/src/migrate.ts`) targets an actual `DATABASE_URL` via `pg`
   and has not been run against a live Supabase project (none provisioned yet).
3. ✅ SQL migrations for every table in DATA_MODEL.md (`packages/db/migrations/
   0001`–`0010`), including the cross-organization integrity triggers (§8) —
   co-located with each table's own migration rather than a separate file,
   updated-at triggers, and indexes.
4. ✅ RLS policies for every tenant-facing table (`0010_row_level_security.sql`),
   the `SECURITY DEFINER` helper functions (`is_org_member`, `is_org_admin`,
   `is_org_owner`, `current_user_role_in_org`) that avoid the recursive-policy issue
   on `memberships`, and a `create_organization()` RPC for the atomic
   org-creation-plus-owner-membership bootstrap that an INSERT policy can't express.
5. ✅ Development seed data (`packages/db/seed/devSeed.ts`) — refuses to run
   without `ALLOW_SEED=true` and refuses to run against anything that doesn't look
   like a local database, even if that flag is set by mistake.
6. ✅ Test infrastructure: Vitest against PGlite (see deviation above), 44 tests
   covering migration application, RLS enabled on every table, and the full
   cross-org isolation matrix from THREAT_MODEL §2 (read/modify/delete another
   org's rows across every RLS-covered table, the `client_approvals`/
   `subscription_events`/`usage_records` total-lockout tables, the anon role, and
   four direct tests of the DB-level integrity triggers). Two real bugs were found
   and fixed while writing these tests, not assumed away: a session-variable
   persistence issue in the test shim (fixed), and `service_role`'s `bypassrls`
   attribute not implying table grants the way I'd assumed (fixed — real Supabase
   grants this separately, now mirrored in the shim).
7. ✅ Full suite run locally: `tsc --noEmit`, `eslint .`, and `vitest run` are all
   clean across `packages/db`, `packages/safe-fetch`, `packages/shared` (167 tests
   total as of this phase).

Done means — met, with the Docker/Supabase-CLI deviation disclosed above: migrations
apply cleanly from empty (tested), every RLS-covered table has a real cross-org
isolation test exercised against a real Postgres engine (not a removed-policy
mutation test specifically, but against real policies with real seeded
cross-org data), `tsc --noEmit` and lint are clean.

Credential dependency: none — everything in this phase runs locally (see the
PGlite deviation above; a live Supabase project is only needed to deploy).

## Phase 3 — Safe-fetch and monitoring foundation

1. ✅ **DONE (2026-10-10).** Built `packages/safe-fetch` to the full contract in
   THREAT_MODEL §1: URL/scheme/port validation, DNS resolution with every address
   validated (IPv4 + IPv6, IPv4-mapped forms, alternative numeric notations),
   connection pinning via Node's `lookup` option (proven via a dependency-injected
   resolver call-count assertion, not a live DNS server — see THREAT_MODEL §1 item
   7 for why that's an equally valid, more deterministic proof), manual redirect
   revalidation with a hop limit, bounded size/decompression/timeout, and a
   separate SSL-certificate checker. 100 tests, all real, including one real-network
   integration test against `https://example.com/` (`test/safeFetch.network.test.ts`
   — needs outbound internet access, no credentials) and three genuine bugs found
   and fixed while testing, not assumed away (documented in THREAT_MODEL §1 item 7):
   an IPv6 unallocated-address-space classification gap, a Node Happy-Eyeballs/
   `autoSelectFamily` interaction that intermittently broke the custom `lookup`
   callback, and a test-fixture-only TLS handshake stall caused by the `selfsigned`
   package's default SHA-1 signing algorithm.
2. ✅ **DONE (2026-10-10).** Built the pg-boss-backed scheduler and worker in
   `apps/worker`. Another real environment finding: no Docker, so pg-boss's
   genuine multi-connection concurrency (its `SKIP LOCKED` job claiming) can't be
   exercised against PGlite (single connection) the way packages/db's tests use
   it. Used the `embedded-postgres` npm package instead — a real, disposable,
   genuinely concurrent Postgres 18.4 with no installer and no admin rights
   needed (confirmed directly: two separate connections racing `SELECT ... FOR
   UPDATE SKIP LOCKED` correctly claimed different rows). `packages/db`'s
   Supabase-emulation shim was generalized to a structural `SqlExecutor`
   interface so the exact same migrations/shim code runs against both PGlite and
   this real Postgres — see `packages/db/test/supabaseShim.ts` and
   `apps/worker/test/testPostgres.ts`.
3. ✅ `monitor.check` and `ssl.check` job handlers
   (`apps/worker/src/jobs/monitorCheck.ts`, `sslCheck.ts`), both using
   `@servalume/safe-fetch` exclusively, with a deterministic
   check-result/failure-category mapping including an SSRF-guard rejection
   ("blocked") mapping to `failure_category = 'other'` rather than being
   silently dropped.
4. ✅ The confirming/open/resolved state machine is a pure function
   (`src/incidentStateMachine.ts`, 12 unit tests) consumed by `monitor.check`'s
   handler, plus a notification-dedup column (`notification_sent_at`) and a
   per-job idempotency guard (`findCheckResultByJobId`) that stops a pg-boss
   retry of the same job from re-running incident logic against state the
   original attempt may have already mutated.
5. ✅ Retry/backoff and recovery tested directly against the real queue
   (`apps/worker/test/queue.test.ts`): a handler that throws is retried by
   pg-boss and eventually succeeds (not silently dropped), and the scheduler's
   own double-tick test proves a monitor already enqueued within its singleton
   window is not enqueued a second time. **Not tested**: literally killing a
   worker *process* mid-job and confirming a second worker instance recovers
   the abandoned job via pg-boss's expiration mechanism — the throwing-handler
   retry test above exercises the same recovery path pg-boss uses for an
   abandoned job, but a real process-kill scenario is still a disclosed gap.
6. ✅ Email-provider interface (`src/emailProvider.ts`) with Resend as the
   default implementation and an SMTP fallback (nodemailer) — both verified
   against each package's actual current TypeScript types (Resend 6.32.1's
   response shape, nodemailer 10.1.0's `Transporter` export), not assumed.
   Neither provider has been exercised against a real inbox — see Phase 3's
   credential dependency below; `apps/worker/test/notificationDispatch.test.ts`
   mocks the `EmailProvider` interface per master spec §13's own guidance for
   this exact situation.
7. ✅ Real failure/recovery paths tested against injected fetchers standing in
   for a controlled target (`apps/worker/test/monitorCheck.test.ts`,
   `sslCheck.test.ts`) covering the full confirm→open→resolve→fresh-incident
   cycle, the flaky-blip (confirming→resolved-without-opening) path, SSL
   expired/hostname-mismatch/untrusted-chain/unreachable, and SSL
   expiry-finding escalation without duplication — 37 tests total in
   `apps/worker`, all passing against the real embedded Postgres above.

Done means — met for everything built: a monitor driven through injected
fetch results correctly produces `confirming -> open -> resolved` incident rows
with exactly one notification per transition (verified), duplicate/retried job
runs never create a second check_result or re-run incident logic (verified),
and the full safe-fetch attack-surface test list from THREAT_MODEL §1 passes
(verified, carried over from the safe-fetch milestone). The one remaining gap is
disclosed above (process-kill recovery).

Credential dependency: an email provider API key is needed to test *real*
delivery (a sandbox/test key is sufficient and is the recommended setup, not a
production sending domain) — not yet exercised, since none is configured in
this environment. A live Supabase Cloud project is needed to deploy this worker
against production infrastructure, also not yet provisioned.

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
