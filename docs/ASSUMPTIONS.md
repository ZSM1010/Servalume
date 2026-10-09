# Servalume — Assumptions Requiring Validation

Status: Phase 1 planning document. These are the load-bearing guesses behind the
plan in IMPLEMENTATION_PLAN.md and ARCHITECTURE.md. None of them are blockers to
starting Phase 2, but several should be confirmed or revisited before Phase 6/7
(billing goes live, deployment happens).

## Technical assumptions

1. **Supabase RLS, correctly written, is sufficient for the authenticated-user data
   path.** Validated by the Phase 2 cross-org test suite, not by inspection alone.
2. **pg-boss is operationally stable** for this job mix (minute-plus cadence
   monitors, async report/PDF jobs) at the scale of a pilot (dozens of orgs,
   low hundreds of monitors). Not yet load-tested. If Phase 3 testing surfaces
   problems, Graphile Worker (also evaluated, see ARCHITECTURE.md §1.1) is the
   fallback — not a rewrite from scratch, since both are Postgres-native queues.
3. **Node 22+ is an acceptable floor** for both deployable units (required by
   pg-boss; satisfied by the Node 24.18.0 verified locally). No current dependency
   forces anything higher.
4. **Connect-to-resolved-IP-while-preserving-SNI** (THREAT_MODEL §1.7, the
   DNS-rebinding mitigation) is implementable cleanly with Node's `undici`/`fetch`
   via a custom `Agent`/`connect` override. This needs to be proven with a working
   test in Phase 3, not assumed from documentation — this is the single riskiest
   piece of the safe-fetch module.
5. **Vercel (web) + a persistent-process host (Fly.io/Railway/Render) for the
   worker** is an acceptable split. No hosting provider is chosen yet — the master
   spec explicitly defers this to "based on worker support, pricing, networking
   controls, reliability and deployment simplicity," which is a decision to make
   closer to Phase 7 with real pricing/limits in hand, not now.
6. **A single small worker instance** can sustain the pilot's check volume within
   each monitor's configured interval. Not promised as "one-minute monitoring for
   hundreds of sites" until an actual load test says so (master spec §5
   scheduling).
7. **Playwright-based PDF rendering** on a small worker instance is affordable and
   fast enough for async generation at pilot scale. Memory headroom for a headless
   browser process alongside the job-queue worker needs to be checked once a
   hosting tier is chosen.
8. **Resend** is an acceptable default email provider (modern API, good deliverability,
   usable free/sandbox tier for development). The SMTP fallback interface exists
   specifically so this choice isn't locked in.

## Commercial assumptions (per the master spec's explicit instruction to treat the
## customer profile as a hypothesis, not a guarantee)

1. Agencies with ~10–75 care-plan clients are a real, reachable segment willing to
   pay $29–149/month for this specific evidence→approval workflow, as opposed to
   assembling the same information manually across a monitoring tool, a doc, and
   email.
2. The approval/verification workflow (not uptime monitoring itself) is the
   differentiator customers will pay for, versus existing uptime tools (e.g.
   UptimeRobot, Better Stack, Pingdom) that are cheaper or free for uptime alone.
3. The initial price points ($29/$79/$149) are roughly right relative to what this
   segment currently pays across its existing tool stack — untested against real
   willingness-to-pay.
4. Agencies will trust a new vendor to send client-facing branded reports and
   approval links on their behalf (deliverability, domain reputation, and
   professional appearance all matter here and are unproven at this stage).
5. The account-deletion audit/subscription-event retention window (default
   proposed: 90 days post-deletion) in DATA_MODEL.md §9 is an engineering default,
   not a confirmed policy — should be confirmed with the user (and checked against
   any applicable data-protection obligations for the markets being sold into)
   before Phase 4 ships the deletion workflow.

## What would change the plan if invalidated

- If pg-boss proves unstable under real load (assumption 2): swap to Graphile
  Worker behind the same job-handler interface — contained to `apps/worker`, no
  schema change.
- If the connect-to-IP/SNI approach (assumption 4) can't be made to work cleanly
  with `undici`, the fallback is a lower-level HTTP client (Node's `http`/`https`
  modules directly, or `got`'s socket-level hooks) with the same validation
  contract — still contained to `packages/safe-fetch`.
- If the commercial assumptions don't hold with real design-partner feedback, the
  master spec's own product decision rule (PRODUCT_SPEC.md §6) says to hold scope
  at the MVP and not build Phase 6+ speculatively.
