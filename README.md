# Servalume

Multi-tenant website care operations and evidence platform for independent web
developers and small agencies running ongoing website care plans.

**Status: Phase 1 (planning) complete. No application code has been written yet.**
See [docs/IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md) for the build
sequence and current phase.

## Start here

- [docs/PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md) — what this product is and isn't
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — stack, deployable units, job/report flows
- [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) — full schema design and tenant-isolation rules
- [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) — SSRF defenses, approval-token security, billing trust
- [docs/IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md) — phase-by-phase build sequence and done-criteria
- [docs/ENVIRONMENT_VARIABLES.md](./docs/ENVIRONMENT_VARIABLES.md) — required configuration
- [docs/ASSUMPTIONS.md](./docs/ASSUMPTIONS.md) — technical/commercial assumptions still needing validation

No generative AI dependency is used anywhere in this product: findings, reports and
recommendations come from deterministic rules over stored measurements.
