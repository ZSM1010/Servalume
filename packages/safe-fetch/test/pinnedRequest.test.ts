import http, { type Server } from "node:http";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performPinnedRequest } from "../src/pinnedRequest.js";

/**
 * `performPinnedRequest` has no SSRF opinion of its own by design (see its
 * module comment) — it only knows how to connect to one already-decided IP
 * while presenting a given hostname. That makes it safe and meaningful to test
 * directly against a real local server bound to loopback, without needing to
 * touch or bypass the IP-classification logic tested exhaustively in
 * ipClassification.test.ts.
 */

let server: Server;
let port: number;
let lastRequestHeaders: http.IncomingHttpHeaders = {};

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("basic request mechanics", () => {
  beforeEach(async () => {
    port = await listen((req, res) => {
      lastRequestHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello world");
    });
  });

  it("connects to the pinned IP while sending the original hostname as Host and User-Agent", async () => {
    const result = await performPinnedRequest({
      hostname: "my-test-host.example",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      scheme: "http:",
      method: "GET",
      path: "/",
      headers: {},
      timeoutMs: 5000,
      maxResponseBytes: 1024,
      userAgent: "ServalumeBot/1.0 (test)",
    });

    expect(result.httpStatusCode).toBe(200);
    expect(result.body.toString("utf8")).toBe("hello world");
    // Node correctly includes the non-default port in the Host header per HTTP
    // semantics — we only assert the hostname part is the original hostname,
    // not the pinned IP, which is the actual property under test.
    expect(lastRequestHeaders.host).toBe(`my-test-host.example:${port}`);
    expect(lastRequestHeaders["user-agent"]).toBe("ServalumeBot/1.0 (test)");
  });

  it("never sends a cookie or authorization header unless explicitly passed", async () => {
    await performPinnedRequest({
      hostname: "my-test-host.example",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      scheme: "http:",
      method: "GET",
      path: "/",
      headers: {},
      timeoutMs: 5000,
      maxResponseBytes: 1024,
      userAgent: "ServalumeBot/1.0 (test)",
    });

    expect(lastRequestHeaders.cookie).toBeUndefined();
    expect(lastRequestHeaders.authorization).toBeUndefined();
  });

  it("reports sane, non-negative timing fields", async () => {
    const result = await performPinnedRequest({
      hostname: "my-test-host.example",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      scheme: "http:",
      method: "GET",
      path: "/",
      headers: {},
      timeoutMs: 5000,
      maxResponseBytes: 1024,
      userAgent: "test",
    });

    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.timeToFirstByteMs).not.toBeNull();
    expect(result.timings.tcpConnectMs).not.toBeNull();
  });
});

describe("redirects are never auto-followed", () => {
  beforeEach(async () => {
    port = await listen((_req, res) => {
      res.writeHead(302, { Location: "https://attacker.example/private" });
      res.end();
    });
  });

  it("returns the 3xx status and Location header to the caller instead of chasing it", async () => {
    const result = await performPinnedRequest({
      hostname: "redirector.example",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      scheme: "http:",
      method: "GET",
      path: "/",
      headers: {},
      timeoutMs: 5000,
      maxResponseBytes: 1024,
      userAgent: "test",
    });

    expect(result.httpStatusCode).toBe(302);
    expect(result.headers.location).toBe("https://attacker.example/private");
  });
});

describe("response size cap", () => {
  beforeEach(async () => {
    port = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      // Write far more than any cap used in these tests.
      res.end("x".repeat(200_000));
    });
  });

  it("truncates and stops reading once the cap is exceeded", async () => {
    const result = await performPinnedRequest({
      hostname: "big.example",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      scheme: "http:",
      method: "GET",
      path: "/",
      headers: {},
      timeoutMs: 5000,
      maxResponseBytes: 1000,
      userAgent: "test",
    });

    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(1000);
  });
});

describe("timeout handling", () => {
  beforeEach(async () => {
    port = await listen((_req, res) => {
      // Never respond — simulates a hung/slow server.
      void res;
    });
  });

  it("rejects with a timeout-categorized SafeFetchError", async () => {
    await expect(
      performPinnedRequest({
        hostname: "slow.example",
        pinnedIp: "127.0.0.1",
        family: 4,
        port,
        scheme: "http:",
        method: "GET",
        path: "/",
        headers: {},
        timeoutMs: 150,
        maxResponseBytes: 1024,
        userAgent: "test",
      }),
    ).rejects.toMatchObject({ category: "timeout" });
  });
});

describe("bounded decompression", () => {
  it("decodes a normal gzip response transparently", async () => {
    port = await listen((_req, res) => {
      const payload = Buffer.from("hello compressed world");
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(zlib.gzipSync(payload));
    });

    const result = await performPinnedRequest({
      hostname: "gzip.example",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      scheme: "http:",
      method: "GET",
      path: "/",
      headers: {},
      timeoutMs: 5000,
      maxResponseBytes: 10_000,
      userAgent: "test",
    });

    expect(result.body.toString("utf8")).toBe("hello compressed world");
    expect(result.truncated).toBe(false);
  });

  it("stops and truncates when a small compressed payload would inflate past the cap", async () => {
    port = await listen((_req, res) => {
      const bomb = Buffer.alloc(2_000_000, "a"); // highly compressible, inflates far past the cap
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(zlib.gzipSync(bomb));
    });

    const result = await performPinnedRequest({
      hostname: "bomb.example",
      pinnedIp: "127.0.0.1",
      family: 4,
      port,
      scheme: "http:",
      method: "GET",
      path: "/",
      headers: {},
      timeoutMs: 5000,
      maxResponseBytes: 1000,
      userAgent: "test",
    });

    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(1000);
  });
});
