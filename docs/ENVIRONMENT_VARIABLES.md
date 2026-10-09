# Servalume — Environment Variable Inventory

Status: Phase 1 planning inventory. These will be mirrored into a root
`.env.example` (names/descriptions/placeholders only, no real values) when Phase 2
scaffolds the repo. Variables are grouped by which deployable unit(s) read them.
"Browser-exposed" marks the only variables that are safe to prefix `NEXT_PUBLIC_` —
everything else must stay server/worker-only per THREAT_MODEL §6.

## Shared (apps/web and apps/worker)

| Variable | Purpose | Browser-exposed? |
|---|---|---|
| `DATABASE_URL` | Direct Postgres connection string for pg-boss and migration tooling | No |
| `SUPABASE_URL` | Supabase project URL | No (server-side client construction) |
| `NEXT_PUBLIC_SUPABASE_URL` | Same URL, for the browser Supabase client used only to establish an auth session | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key, session bootstrap only — granted no table access (ARCHITECTURE.md §5) | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS; used only by apps/worker and the narrow server routes listed in ARCHITECTURE.md §5 | No — never |
| `APP_BASE_URL` | Canonical base URL, used to build approval/share links and email links | No |
| `LOG_LEVEL` | Structured log verbosity (`debug`\|`info`\|`warn`\|`error`) | No |
| `NODE_ENV` | Standard Node environment flag | No |

## apps/web only

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Server-side Stripe API calls (checkout session, customer portal) |
| `STRIPE_WEBHOOK_SECRET` | Verifies incoming Stripe webhook signatures |
| `STRIPE_PRICE_ID_SOLO` / `STRIPE_PRICE_ID_STUDIO` / `STRIPE_PRICE_ID_AGENCY` | Price IDs backing the plan-definition module |
| `FREE_SCAN_RATE_LIMIT_PER_IP_PER_DAY` | Server-side cap enforced on the public scan endpoint |
| `FREE_SCAN_MAX_CONCURRENT` | Global concurrency cap on the public scan endpoint |

## apps/worker only

| Variable | Purpose |
|---|---|
| `WORKER_CONCURRENCY` | Max concurrent pg-boss jobs this worker instance runs |
| `SCHEDULER_TICK_INTERVAL_SECONDS` | How often the scheduler checks `monitor_schedules` for due monitors |
| `SAFE_FETCH_ALLOWED_PORTS` | Comma-separated port allowlist for outbound checks (default `80,443`) |
| `SAFE_FETCH_MAX_REDIRECTS` | Hop limit for redirect validation (default `3`) |
| `SAFE_FETCH_TIMEOUT_MS` | Per-request timeout bound |
| `SAFE_FETCH_MAX_RESPONSE_BYTES` | Hard cap on response body size read |
| `EMAIL_PROVIDER` | `resend` or `smtp` — selects the email interface implementation |
| `RESEND_API_KEY` | Required when `EMAIL_PROVIDER=resend` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Required when `EMAIL_PROVIDER=smtp` |
| `EMAIL_FROM_ADDRESS` | Sender address for all outbound email |
| `PLAYWRIGHT_BROWSERS_PATH` | Where Playwright's browser binaries are installed on the worker host, for PDF rendering |
| `REPORT_STORAGE_BUCKET` | Supabase Storage bucket name for generated PDFs |

## Not yet decided (flagged in ASSUMPTIONS.md)

- Hosting-provider-specific variables for `apps/worker` (e.g. a Fly.io/Railway app
  name or region) depend on the hosting decision deferred to Phase 7.
- Whether `IP_HASH_SALT` (a server-only secret used to produce the salted IP hashes
  in `scan_runs`/`client_approvals`/logs) is a dedicated env var or derived from
  `SUPABASE_SERVICE_ROLE_KEY` — planned as its own dedicated secret so it can be
  rotated independently; confirmed at Phase 3 implementation time.
