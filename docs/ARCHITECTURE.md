# Servalume — Architecture

Status: Phase 1 planning document. Describes the architecture to be built, not
something already running. Versions below were checked against the npm registry on
2026-10-09 and are the pinned targets for Phase 2 scaffolding.

## 1. Stack and pinned versions

| Concern | Choice | Version checked 2026-10-09 | Notes |
|---|---|---|---|
| Framework | Next.js (App Router) | 16.4.0 | Requires Node >=20.9 |
| Language | TypeScript, strict mode | 6.0.3 | **Not** the newest `latest` tag (7.0.2, the native/Go-ported compiler line) — pinned to the last 6.x release because `typescript-eslint@8.71.1` (needed for type-aware lint rules) declares a peer range of `>=4.8.4 <6.1.0` and does not yet support the TS7 compiler line. Confirmed by an actual failed `npm install` during Phase 2, not by inspection. Revisit once typescript-eslint publishes TS7 support. |
| UI | React / React DOM | 19.3.0 | |
| Styling | Tailwind CSS | 4.3.3 | + shadcn/ui components (copied in, not a pinned runtime dep) |
| shadcn CLI | `shadcn` | 4.21.4 | dev-time only |
| Auth + DB | Supabase Auth + PostgreSQL | `@supabase/supabase-js` 2.117.3, `@supabase/ssr` 0.12.7 | Self-hosted-compatible; using Supabase Cloud for the pilot |
| Job queue | pg-boss | 12.37.1 | Requires Node >=22.12.0. Evaluated against Graphile Worker 0.18.0 (requires Node >=22.18.0) — see §4 |
| Email | Provider-agnostic interface; default Resend | `resend` 6.32.1 | SMTP (nodemailer) documented as a drop-in alternative implementation |
| PDF rendering | Playwright (isolated process) | `playwright` 1.64.0 | Also used for E2E tests, so it is already a dependency |
| Billing | Stripe | `stripe` 23.0.0 | Test mode first |
| Validation | Zod | 4.6.5 | Shared schema validation client/server |
| Testing | Vitest + `@playwright/test` | 5.0.3 / 1.64.0 | Unit/integration + E2E |
| Lint | ESLint | 10.12.0 | |

Required Node.js version for all workspaces: **Node 22 LTS or newer** (pg-boss's
floor). Verified locally against Node 24.18.0. This will be pinned via `.nvmrc` and
`engines` in Phase 2.

### 1.1 Why pg-boss over Graphile Worker

Both are Postgres-native queues (no Redis), both support Node 22+, both have
maintained TypeScript types. pg-boss is chosen because: its job API (`send`,
`work`, singleton/debounced jobs, retry/backoff config, archival) maps directly onto
this product's needs — idempotent monitor ticks, scheduled SSL re-checks, async
report/PDF generation — without hand-rolling scheduling logic on top of a lower-level
primitive. Graphile Worker's LISTEN/NOTIFY-driven low latency is not a requirement
here (checks run on minute-plus cadences, not sub-second). This decision should be
revisited only if pg-boss's operational behavior under real load fails to hold up in
Phase 3 testing.

## 2. Deployable units

Servalume is **two deployable Node.js processes against one Postgres database** —
intentionally not a microservice architecture:

1. **`apps/web`** — Next.js app. Serves the dashboard, marketing site, free-scan
   entry point, approval pages, share-link report pages, and API routes that
   **enqueue** work. It never runs a monitoring/crawl loop itself.
2. **`apps/worker`** — a persistent Node.js process. Runs the pg-boss worker loop,
   the scheduler tick, safe-fetch-based checks, the incident state machine,
   notification dispatch, report-data assembly, and PDF rendering.

Both talk to the same Supabase Postgres instance, but with different credentials and
different trust levels (see §5). There is one database — no secondary store, no
message broker beyond pg-boss's own Postgres-backed queue.

### 2.1 Why not run the worker as serverless functions

Next.js route handlers deployed to a serverless platform are short-lived and are not
an appropriate place for a durable polling loop, a scheduler, or long-running crawl
jobs — a cold start or execution-time limit would silently drop in-flight monitoring
work. The web app's job is to read/write Postgres directly for dashboard data and to
**submit jobs**; only `apps/worker`, deployed somewhere that supports a persistent
process (candidates: Fly.io, Railway, Render — final choice deferred per the master
spec, see [ASSUMPTIONS.md](./ASSUMPTIONS.md)), executes them.

## 3. Repository layout (Phase 2 scaffold target)

```
Servalume/
  apps/
    web/                  # Next.js App Router app
    worker/                # persistent worker process (scheduler + job handlers)
  packages/
    db/                    # SQL migrations, generated DB types, query helpers
    safe-fetch/             # centralized SSRF-safe outbound fetch module (shared)
    shared/                 # plan definitions, zod schemas, shared types/constants
  docs/                    # this folder
  .env.example
  package.json              # npm workspaces root
  tsconfig.base.json
```

`packages/safe-fetch` is deliberately its own package so both `apps/web` (free-scan
endpoint) and `apps/worker` (monitors, future crawler) import the exact same
SSRF-hardened client — there must not be two implementations to keep in sync.

## 4. Job lifecycle (monitoring)

```
 scheduler tick (worker, every N seconds)
   -> reads monitor_schedules where next_run_at <= now() and monitor.is_active
   -> pg-boss send("monitor.check", {monitor_id, scheduled_at}, {singletonKey: monitor_id+scheduled_at})
      (singletonKey makes duplicate enqueues for the same tick a no-op)
   -> advances next_run_at (+ jitter) so a slow tick can't double-enqueue

 worker job handler "monitor.check"
   -> loads monitor + website, confirms organization/plan still entitles it to run
   -> calls packages/safe-fetch with bounded timeout/size/redirect-hop limits
   -> writes exactly one check_results row (status always set; never left "pending"
      if the job ran — a crash before this write means no row, which is read as
      missing coverage, never as success)
   -> runs the incident state machine (see THREAT_MODEL.md and DATA_MODEL.md
      incidents section) against the new result
   -> if an incident transitions to confirmed/recovered, enqueues
      "notification.dispatch" (deduplicated by incident_id + event_type)

 worker job handler "ssl.check" — same shape, writes ssl_checks instead

 worker job handler "notification.dispatch"
   -> loads notification_preferences for the org
   -> sends via the email provider interface
   -> records result on the triggering incident/report row; never retried in a way
      that can double-send (idempotency key = incident_id/report_id + event_type)
```

pg-boss's own `SKIP LOCKED`-based fetch plus an explicit `singletonKey` on every
enqueue is the mechanism that satisfies the master spec's "idempotent jobs, no
duplicate incidents/findings/notifications" requirement. This must be exercised by
the Phase 3 retry/duplicate-suppression tests before being trusted.

## 5. Data access trust boundaries

Three distinct credentials, three distinct trust levels:

1. **Browser (anon key)** — the anon Supabase key is only used to establish an
   authenticated session (sign-in/sign-up). It is granted **no table access**
   beyond what Supabase Auth itself needs. All dashboard reads/writes happen through
   the authenticated Postgres role under RLS (§6), via the Next.js server using the
   user's session, not the raw anon key for data queries.
2. **Authenticated user (RLS-bound)** — every dashboard query runs as the signed-in
   user; Postgres RLS policies decide what rows are visible/writable based on
   `memberships`. This is the default path and is what most of `apps/web` uses.
3. **Service role (worker + narrow server routes)** — `apps/worker` and a small
   number of `apps/web` server-only routes (Stripe webhook, approval-token routes,
   share-link routes) use the Supabase **service role key**, which bypasses RLS
   entirely. Every query made with this credential must carry an explicit
   `organization_id` (or token-derived scope) filter written by hand — RLS is not
   protecting these call sites, and Phase 2's test suite must include
   cross-organization authorization tests specifically targeting service-role query
   paths, not just RLS policies. The service role key never reaches the browser.

## 6. Safe-fetch architecture (summary — see THREAT_MODEL.md for the attack-level detail)

`packages/safe-fetch` is a single module used by every outbound request this product
makes to a customer- or visitor-submitted URL (uptime checks, SSL checks, the free
scan, and the future crawler). It is built and tested in Phase 3 **before** any
monitoring code calls it. Its contract: resolve DNS itself, reject any resolved
address that isn't public unicast, connect to the validated IP directly (not to the
hostname a second time), never auto-follow redirects, and fail closed on any
ambiguity. No other HTTP client is permitted to touch user-submitted URLs.

## 7. Report generation flow

```
 user clicks "Generate report" (period start/end, client/org scope)
   -> apps/web writes a `reports` row, status=draft
   -> enqueues "report.generate" job

 worker job handler "report.generate"
   -> queries check_results, ssl_checks, incidents, work_items, work_logs,
      client_approvals strictly within [period_start, period_end] and the report's
      organization_id
   -> computes uptime %, coverage %, incident counts, findings-by-severity,
      completed work, pending approvals — all deterministic, no external calls
   -> any metric with insufficient data is marked unavailable, never estimated
   -> writes the computed result into reports.data_snapshot (immutable once written)
      and sets status=generated
   -> renders the branded HTML report from data_snapshot using a server-side
      template (no client-side data fetching in the report view)
   -> on request, enqueues "report.render_pdf": an isolated Playwright instance
      renders the *same* already-generated HTML (never a URL the renderer fetches
      itself) to PDF, with a timeout and memory/page-count limit, and stores the
      file in a private Supabase Storage bucket keyed by organization_id
   -> share links reference the reports.id + a hashed token; revocation flips
      share_links.status, which the serving route checks on every request (not just
      at creation time)
```

## 8. Environment variable inventory

See [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) for the full table; it
will be mirrored into `.env.example` with placeholder values in Phase 2.

## 9. Infrastructure cost estimate for a small pilot (rough, pre-load-test)

| Item | Estimate | Notes |
|---|---|---|
| Supabase | $0–25/mo | Free tier may suffice for <20 orgs; Pro ($25/mo) likely needed once backups/log retention matter |
| Worker host (Fly.io/Railway, 1 small instance) | $5–20/mo | Persistent process, low CPU; scales with monitor count, not customer count |
| Email (Resend) | $0–20/mo | Free tier covers low-volume transactional email for a pilot |
| Stripe | 2.9% + $0.30/txn, no monthly fee | Test mode is free |
| Domain + misc | ~$1–2/mo amortized | |
| **Total** | **roughly $10–65/mo** for a pilot of a few dozen orgs | Will not hold at hundreds of orgs/sites without a real load test — see ASSUMPTIONS.md |

This is a planning estimate, not a committed budget, and explicitly does not justify
a promise of "one-minute monitoring for hundreds of sites" (per the master spec) until
Phase 3 load testing says otherwise.
