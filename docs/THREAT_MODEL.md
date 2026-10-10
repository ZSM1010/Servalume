# Servalume — Threat Model

Status: Phase 1 planning document. Each control described here is a design
requirement for Phase 2/3 implementation and must be covered by the automated tests
listed at the end of each section before it is considered done — a passing build with
no such test does not satisfy this document.

## 1. SSRF / outbound requests (highest-severity risk in this product)

Every URL this product fetches on a user's behalf — monitor checks, SSL checks, the
free scan, and later the crawler — originates from something an attacker fully
controls (a submitted website URL, or a redirect target that URL points to). The
worker process that makes these requests also has network access to the same
infrastructure (Supabase, possibly a private network) that holds tenant data, so an
SSRF bug here is a direct path to internal-service access or cloud-metadata credential
theft, not just "the monitor shows a wrong result."

### Controls (implemented once, in `packages/safe-fetch`, §6 of ARCHITECTURE.md)

1. Scheme allowlist: `http`/`https` only. Reject `file:`, `gopher:`, `ftp:`, etc.
2. Reject URLs with embedded userinfo (`https://user:pass@host`).
3. Resolve DNS ourselves (not delegate to the HTTP client), inspect **every**
   returned A/AAAA record, and reject the request if **any** resolved address is
   loopback, private (RFC1918/RFC4193), link-local, CGNAT, multicast, reserved, or an
   IPv4-mapped/IPv4-compatible IPv6 form of any of the above.
4. Explicitly block known cloud metadata addresses: `169.254.169.254`,
   `169.254.170.2`, `fd00:ec2::254`, and the metadata hostnames that resolve to them.
5. Normalize/validate host and port; default-allow only 80/443 (configurable
   allowlist), reject everything else by default.
6. Disable automatic redirect following at the HTTP client level. Each redirect hop
   is treated as a brand-new request: re-parsed, re-validated against all of the
   above, up to a strict hop limit (default 3).
7. **Connect to the validated IP address directly** (not to the hostname a second
   time) while still sending the correct `Host`/SNI for TLS — this is what prevents
   DNS rebinding between the validation step and the actual connection (the classic
   TOCTOU gap: hostname resolves to a public IP during validation, then to a private
   IP a moment later at connect time).
   **Status: implemented and tested (Phase 3, 2026-10-09).** Built via Node's
   `lookup` option on `http(s).request`/`tls.connect` — our own resolver is called
   exactly once per hop and its result is pinned directly into the socket connect
   step, so there is structurally only one resolution, not a validate-then-reconnect
   pair. Proven with a dependency-injected resolver (not a live DNS server) that
   would answer differently on a second call; the tests assert the resolver is
   called exactly once and that the pinned connection uses that first answer
   (`packages/safe-fetch/test/dnsResolution.test.ts`,
   `packages/safe-fetch/test/safeFetch.test.ts`). Two non-obvious findings from
   building this, in case they look removable later: Node's Happy-Eyeballs
   dual-stack logic (`autoSelectFamily`, on by default) must be explicitly disabled
   on every pinned connection, or Node intermittently calls our single-address
   `lookup` expecting the multi-address array form once a connection runs past its
   internal fallback timer — confirmed directly, it only showed up on slow/TLS
   connections, not fast local ones. And IPv6 address classification needs an
   explicit allowlist of the allocated `2000::/3` global-unicast block on top of
   `ipaddr.js`'s special-range blocklist, because a syntactically valid address
   like `0:0:ffff:ffff:ffff:ffff:ffff:ffff` matches none of its named special
   ranges yet was never allocated for internet routing either — see
   `packages/safe-fetch/src/ipClassification.ts`.
8. Bound total request time, response body size (read with a hard cap, not just a
   `Content-Length` check — a server can lie about or omit that header), and
   decompression ratio (zip-bomb-style compressed responses).
9. Never forward cookies, `Authorization`, or any Servalume secret to the target
   host; never execute or `eval` any part of the response.
10. Redact the target URL's credentials (if any slipped through), auth headers, and
    any token query-parameters from logs.
11. Fail closed: any ambiguity (DNS failure mid-validation, an address family we
    don't have a confident classification for) is a rejection, not a best-effort
    allow.
12. Network-level egress rules on the worker host (e.g. cloud firewall / security
    group denying the worker outbound access to the provider's own metadata IP and
    to any private peered network) as a second layer behind the application check —
    defense in depth in case the application check is ever bypassed by a bug.

### The free-scan endpoint gets all of the above, plus

- Per-IP and global rate limits, a concurrency cap, and a request-size/time budget
  tighter than the authenticated product, so the public tool can't become a
  general-purpose proxy or a DoS amplifier against the submitted target.

### Required tests before this is considered done

Unit/integration tests for: loopback/private/link-local/reserved/multicast ranges in
both IPv4 and IPv6; IPv4-mapped IPv6 forms; cloud metadata addresses; a DNS-rebinding
scenario (answer changes between validate and connect); malicious redirect chains
(redirect to a private IP, redirect loop, redirect exceeding the hop limit); forbidden
ports; oversized/slow responses; concurrent-abuse against the free-scan rate limiter.
None of these may be skipped-and-marked-passing.

## 2. Multi-tenant isolation

Two separate mechanisms protect tenant data, and they must both be tested because
they fail differently:

1. **RLS**, for every query made with a user's own session. Risk: a missing or
   incorrectly scoped policy on a new table silently exposes cross-org data. Phase 2
   includes an automated suite that, for every RLS-covered table, authenticates as a
   user in Org A and attempts to read/update/delete a row seeded under Org B — and
   asserts zero rows affected, not just a "denied" error (a 0-row update can be
   mistaken for success by careless app code, so the test checks the row is
   genuinely unchanged).
2. **Hand-written `organization_id` filters**, for every query made with the
   service-role key (the worker, and the handful of server routes listed in
   ARCHITECTURE.md §5). RLS does not apply here at all — a forgotten `WHERE
   organization_id = $1` is a direct cross-tenant leak with no safety net. These code
   paths get the same cross-org test treatment, but against the service-role query
   functions directly, not through RLS.

DB-level triggers (DATA_MODEL.md §8) are the third layer: even a correct RLS policy
or a correct service-role filter can't stop a *logically* cross-org reference (a work
item pointing at another org's finding) unless the FK/trigger layer rejects it
outright.

## 3. Client approval links

An approval link is a bearer-token capability deliberately scoped to exactly one
work item's approval decision — not a login, not a session.

- Token: cryptographically random (≥128 bits), never guessable from the work item ID
  or timestamp.
- Storage: only the SHA-256 hash is stored (`client_approvals.token_hash`); the raw
  token exists only in the URL sent to the client and is never logged.
- Scope: the server route that serves this link validates the hash, then renders
  **only** the snapshotted `presented_title`/`presented_recommendation`/
  `presented_evidence` for that one row — it has no code path that accepts a
  different work-item ID or exposes any other organization data.
- Expiry + revocation: checked on every request, not cached; an agency can revoke a
  link and it stops working immediately, including for a request already in flight
  with a previously-valid token.
- Rate limiting: repeated invalid-token attempts against the approval-serving route
  are throttled per IP, and failures are recorded to `audit_events` so a brute-force
  attempt against the token space is visible.
- Blast radius if a token leaks: the holder can set one work item's decision to
  approved/declined/clarification-requested. They cannot see other work items, other
  clients, billing, or any authenticated dashboard data, and approving a work item
  never triggers code execution against a production website — it only writes a
  database row that an agency later acts on manually.

### Required tests

Token scope (can't be reused for a different work item), expiry, revocation taking
effect immediately, and rate-limit behavior under repeated invalid attempts.

## 4. Billing webhook trust

Subscription state is a mirror of Stripe's own state, never of anything the browser
reports.

- Every webhook request's signature is verified against the Stripe webhook secret
  before the payload is trusted.
- `subscription_events.stripe_event_id` is unique, so a retried/duplicate webhook
  delivery is a no-op rather than double-processing (e.g. double-crediting a plan
  change).
- Entitlement checks (website/monitor/team-member caps) are enforced **server-side**
  at the point of the action (creating a website, inviting a user, etc.), reading
  `subscriptions.status`/`plan` from the database — never from a client-supplied
  "I paid" flag.
- Canceled, past-due, upgraded, downgraded, and refunded transitions are each
  explicit test cases, not inferred from "whatever Stripe's current status string
  happens to be" without a corresponding handled case.

## 5. PDF rendering

The PDF renderer (Playwright, isolated process) is given **our own already-generated
HTML string** for a report that has already been computed from `data_snapshot` — it
never navigates to a user-supplied URL, never executes a report-triggered fetch of
external content, and runs with a timeout, a page-count/size limit, and no access to
the rest of the worker's network reachability beyond what rendering static HTML/CSS
requires. This keeps "render a report" from becoming a second SSRF surface or a
sandbox-escape target.

## 6. Secrets and logging

- `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the
  email provider API key exist only in server/worker environments, never in any
  `NEXT_PUBLIC_*` variable and never serialized into a response sent to the browser.
- Structured logs redact: approval tokens, share-link tokens, Supabase/Stripe keys,
  full Authorization headers, and raw client IPs (stored/logged only as salted
  hashes, consistent with `*_ip_hash` columns in the data model).

## 7. Free-scan abuse

The public free-scan tool is a customer-acquisition surface with no authentication,
so it is scoped tightly: one bounded scan at a time per IP-hash window, a hard cap on
concurrent scans globally, the same safe-fetch limits as the authenticated product,
and results that are only ever shown once the measurement has actually completed
(never a fabricated placeholder score). It must not be usable as a free SSRF oracle
or DoS amplifier — see §1's free-scan-specific controls.

## 8. Account deletion and data retention

Deletion revokes externally-reachable capabilities (share links, approval links)
immediately and synchronously, before the rest of the asynchronous cleanup runs, so
that "I deleted my account" means outside access stops immediately even if internal
row cleanup is still in progress. Audit/subscription-event retention for a bounded
window post-deletion is a deliberate exception for abuse/billing-dispute
investigation, documented in DATA_MODEL.md §9, and should be confirmed with the user
as acceptable before Phase 4 ships it (see ASSUMPTIONS.md).

## 9. What this product explicitly does not claim

Per PRODUCT_SPEC.md §7: no claim of vulnerability scanning, penetration testing, or
guaranteed outage prevention. The safe-fetch and tenant-isolation controls above
exist to protect *Servalume's own infrastructure and its customers' data from each
other and from the sites being monitored* — they are not a security assessment
product for the websites being monitored.
