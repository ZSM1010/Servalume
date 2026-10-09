# Servalume — Product Specification

Status: Phase 1 planning document. No application code has been written against this
spec yet. See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for build sequencing.

## 1. What Servalume is

Servalume is a multi-tenant **website care operations and evidence platform** for
independent web developers and small agencies that run ongoing website care /
maintenance plans for clients.

It is explicitly **not** an uptime-monitoring tool with a PDF export bolted on. The
product's value is the closed loop between:

1. A measurement or maintenance action happens and is stored as evidence.
2. The evidence is explained with a deterministic, inspectable rule (no LLM).
3. The explained issue becomes a recommended work item.
4. The agency asks the client to approve, decline, or ask a question about that item.
5. The decision is recorded with a timestamp.
6. The work is logged as actually completed (manually, or machine-verified).
7. Where technically possible, the original condition is re-checked.
8. The verified before/after state, remaining issues and open decisions are what
   appears in the client-facing report.

No step in this chain may be skipped or faked. A report must never describe work that
has no corresponding `work_log` / `check_result` row, and a "verified" status must
never be set without an actual re-check having run.

No generative AI is used anywhere in this product. All findings, report language and
recommendations come from deterministic rules and stored data.

## 2. Primary customer (hypothesis, not a guarantee)

Independent web dev/design agencies with ~10–75 active care-plan clients/sites, a
small team (1–10 people), and recurring maintenance/support revenue.

Target platforms for the sites being monitored: WordPress, Webflow, Shopify,
Squarespace, custom stacks — monitored externally (HTTP/SSL/crawl), with no
proprietary plugin required for the MVP's basic checks.

This profile must be validated with real design partners before scope expands beyond
the MVP. See [ASSUMPTIONS.md](./ASSUMPTIONS.md) for the specific commercial
assumptions this depends on.

## 3. Scope

### 3.1 MVP (build first — Phases 2–5 of the implementation plan)

- Authentication and organization management (Supabase Auth; owner/admin/member roles).
- Client and website management.
- HTTP availability monitoring (safe-fetch based).
- SSL certificate validity/expiration monitoring.
- Incident confirmation → history → resolution → alert suppression.
- Manual maintenance activity log (agency-entered, clearly labeled as manual).
- Finding → work item → client approval → verification workflow.
- Branded HTML reports + async PDF export + revocable share links.
- Email notifications (incidents, SSL expiry, report ready, approval decided).
- Central plan/entitlement module with server-side enforcement.
- RLS-backed multi-tenant data model, migrations, automated tests, deploy docs, logs.

### 3.2 Next phase (after MVP is solid — Phase 6)

Bounded crawler: internal link checks, a bounded set of external link checks, missing
`<title>`, missing meta description, missing image `alt`. Respects `robots.txt`,
documented UA string, per-host delay, page/depth caps, response-size caps,
cancellation. Server-side, plan-aware limits.

### 3.3 Later — only after paying customers validate demand

Custom-domain reporting, scheduled email reports from verified sender domains, CSV
import, additional roles, Search Console / analytics integrations, browser-based
journey tests, PM tool integrations. None of these are built speculatively.

### 3.4 Explicitly out of scope for v1

Generative AI dependencies; automated editing or execution of customer-supplied code;
full WP backup/update management; a general SEO platform; claims of vulnerability
scanning or pentesting; enterprise SSO; unbounded crawling; arbitrary browser
automation against customer sites; custom-domain infra before core reporting is
reliable; a mobile app; unnecessary microservices or extra databases.

## 4. Differentiating workflow — statuses

Work items move through a documented state machine (see
[DATA_MODEL.md](./DATA_MODEL.md#work_items) for the enforced transitions):

`detected → needs_review → recommended → awaiting_approval → approved|declined →
in_progress → completed → verification_failed|verified → closed`

Not every finding requires client approval — an agency can mark a work item as
internal-only and skip straight to `in_progress`/`completed`. That distinction is
recorded, not implied.

## 5. Pricing hypotheses (not commitments)

| Plan | Price | Website cap |
|---|---|---|
| Free scan | $0 | 1 bounded public scan, no persistent monitoring |
| Solo | $29/mo | 10 |
| Studio | $79/mo | 40 |
| Agency | $149/mo | 100 |

These live in a single configurable plan-definition module
(`packages/shared/src/plans.ts`, see [ARCHITECTURE.md](./ARCHITECTURE.md)), not
scattered across the frontend. Stripe runs in test mode until a real pilot customer
is ready to pay.

## 6. Product decision rule

Before building anything not already in the MVP list, answer:

1. Does it solve a validated problem for the target agency?
2. Does it make monitoring more reliable, or the evidence→action workflow more
   valuable?
3. Can it be built and tested without weakening tenant isolation or SSRF protection?
4. Does its infra/support cost fit the expected subscription revenue?
5. Is there customer evidence to justify building it now?

A "no" on any of these is a reason to defer, not to build "just in case."

## 7. What Servalume does not claim

Servalume does not claim to guarantee client retention, prevent all outages, generate
revenue, or detect every security problem. Reports state only what was actually
measured, during the actual measured period, with actual coverage — a missing metric
is labeled "unavailable," never backfilled with a placeholder number.
