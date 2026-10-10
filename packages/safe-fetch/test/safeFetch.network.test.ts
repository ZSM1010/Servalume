import { describe, expect, it } from "vitest";
import { safeFetch } from "../src/safeFetch.js";

/**
 * Real-network integration test (master spec §13: "Where a test depends on a
 * real external service, provide a clearly identified integration test and
 * document the required credentials"). This one needs outbound internet
 * access — no credentials — and hits example.com, which IANA operates
 * specifically as a stable, non-rate-limited target for exactly this kind of
 * test. Every other safe-fetch test in this package is fully offline; this is
 * the only one that genuinely proves, end to end, that:
 *   - our own DNS resolution + IP-classification + connect-to-pinned-address
 *     technique works against a real resolver and a real TLS certificate, and
 *   - TLS hostname verification (SNI, "servername" defaulted from `hostname`)
 *     succeeds against the real cert despite the socket connecting to an IP
 *     we resolved and pinned ourselves, not to the hostname a second time.
 */
describe("safeFetch against a real public HTTPS endpoint (requires network access)", () => {
  it("fetches https://example.com/ successfully with a verified TLS connection", async () => {
    const result = await safeFetch("https://example.com/", { timeoutMs: 15_000 });

    expect(result.httpStatusCode).toBe(200);
    expect(result.body.toString("utf8").toLowerCase()).toContain("example domain");
    expect(result.timings.tlsHandshakeMs).not.toBeNull();
  });

  it("rejects a request to a port example.com does not actually need to serve, before connecting", async () => {
    await expect(safeFetch("https://example.com:8443/")).rejects.toThrow();
  });
});
