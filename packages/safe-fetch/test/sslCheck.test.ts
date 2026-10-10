import tls, { type Server } from "node:tls";
import selfsigned from "selfsigned";
import { afterEach, describe, expect, it } from "vitest";
import { performPinnedTlsProbe } from "../src/sslCheck.js";

/**
 * Like pinnedRequest.test.ts, this tests the low-level `performPinnedTlsProbe`
 * directly against a local TLS server bound to loopback — it has no SSRF
 * opinion of its own, so this doesn't need to touch or bypass
 * ipClassification.ts's real validation logic.
 */

let server: Server;

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function listen(cert: string, key: string): Promise<number> {
  return new Promise((resolve) => {
    server = tls.createServer({ cert, key }, (socket) => {
      socket.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
    });
  });
}

/**
 * `selfsigned`'s default signing algorithm is SHA-1 (per its own documented
 * default). Confirmed directly: an SHA-1-signed cert makes the TLS handshake
 * stall indefinitely against Node 24's OpenSSL 3.x stack (which disables SHA-1
 * for certificate signatures at its default security level) instead of
 * producing a clean error — so every test certificate here is signed with
 * sha256 explicitly.
 */
function generateTestCert(hostname: string, overrides: Parameters<typeof selfsigned.generate>[1] = {}) {
  return selfsigned.generate([{ name: "commonName", value: hostname }], {
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: hostname }] }],
    ...overrides,
  });
}

describe("performPinnedTlsProbe", () => {
  it("reports untrusted_chain for a technically valid but self-signed certificate", async () => {
    const pems = await generateTestCert("correct-host.test", {
      notBeforeDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    const port = await listen(pems.cert, pems.private);

    const result = await performPinnedTlsProbe({
      hostname: "correct-host.test",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      timeoutMs: 5000,
    });

    expect(result.status).toBe("untrusted_chain");
    expect(result.daysUntilExpiry).toBeGreaterThan(300);
    expect(result.subject).toContain("correct-host.test");
  });

  it("reports hostname_mismatch when the certificate does not cover the hostname being checked", async () => {
    const pems = await generateTestCert("other-host.test", {
      notBeforeDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    const port = await listen(pems.cert, pems.private);

    const result = await performPinnedTlsProbe({
      hostname: "correct-host.test",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      timeoutMs: 5000,
    });

    expect(result.status).toBe("hostname_mismatch");
  });

  it("reports expired for a certificate whose validity window has already passed, even if the hostname also matches", async () => {
    const pems = await generateTestCert("correct-host.test", {
      notBeforeDate: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000),
      notAfterDate: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });
    const port = await listen(pems.cert, pems.private);

    const result = await performPinnedTlsProbe({
      hostname: "correct-host.test",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      timeoutMs: 5000,
    });

    expect(result.status).toBe("expired");
    expect(result.daysUntilExpiry).toBeLessThan(0);
  });

  it("reports unreachable when nothing is listening on the target port", async () => {
    // Bind and immediately close to get a port that's guaranteed free right now.
    const pems = await generateTestCert("x");
    const probePort = await listen(pems.cert, pems.private);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const result = await performPinnedTlsProbe({
      hostname: "correct-host.test",
      pinnedIp: "127.0.0.1",
      family: 4,
      port: probePort,
      timeoutMs: 2000,
    });

    expect(result.status).toBe("unreachable");
  });
});
