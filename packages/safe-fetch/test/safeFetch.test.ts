import { describe, expect, it, vi } from "vitest";
import { BlockedDestinationError, SafeFetchError } from "../src/errors.js";
import { safeFetch } from "../src/safeFetch.js";
import type { RequestPerformer } from "../src/safeFetch.js";
import type { PinnedResponse } from "../src/pinnedRequest.js";
import type { ResolvedAddress } from "../src/dnsResolution.js";

/**
 * These tests exercise safeFetch's own orchestration (resolve -> request ->
 * follow/reject redirects -> enforce hop limit and deadline) with the DNS
 * resolver and request mechanics both faked via dependency injection, so
 * nothing here touches the network or the real IP-classification tables
 * (already covered exhaustively elsewhere). That keeps these tests fast and
 * deterministic while still testing real production logic, not mocks of it.
 */

function fakeTimings() {
  return {
    dnsLookupMs: 1,
    tcpConnectMs: 1,
    tlsHandshakeMs: null,
    timeToFirstByteMs: 2,
    totalMs: 3,
  };
}

function okResponse(body = "ok"): PinnedResponse {
  return {
    httpStatusCode: 200,
    headers: { "content-type": "text/plain" },
    body: Buffer.from(body),
    truncated: false,
    timings: fakeTimings(),
  };
}

function redirectResponse(location: string): PinnedResponse {
  return {
    httpStatusCode: 302,
    headers: { location },
    body: Buffer.alloc(0),
    truncated: false,
    timings: fakeTimings(),
  };
}

describe("safeFetch happy path", () => {
  it("resolves, requests once, and returns the sanitized result", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "93.184.216.34", family: 4 }]);
    const requestPerformer = vi.fn<RequestPerformer>(async () => okResponse("hello"));

    const result = await safeFetch("https://example.test/page", { resolver, requestPerformer });

    expect(result.httpStatusCode).toBe(200);
    expect(result.body.toString()).toBe("hello");
    expect(requestPerformer).toHaveBeenCalledTimes(1);
    expect(requestPerformer.mock.calls[0]![0].pinnedIp).toBe("93.184.216.34");
    expect(requestPerformer.mock.calls[0]![0].hostname).toBe("example.test");
  });

  it("strips set-cookie from the returned headers", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "93.184.216.34", family: 4 }]);
    const requestPerformer = vi.fn<RequestPerformer>(async () => ({
      ...okResponse(),
      headers: { "content-type": "text/html", "set-cookie": ["session=abc; HttpOnly"] },
    }));

    const result = await safeFetch("https://example.test/", { resolver, requestPerformer });
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers["content-type"]).toBe("text/html");
  });
});

describe("safeFetch rejects dangerous destinations before ever requesting", () => {
  it("rejects a private IP literal without calling requestPerformer", async () => {
    const requestPerformer = vi.fn();
    await expect(safeFetch("http://10.0.0.5/", { requestPerformer })).rejects.toThrow(
      BlockedDestinationError,
    );
    expect(requestPerformer).not.toHaveBeenCalled();
  });

  it("rejects a hostname whose only DNS answer is private, without calling requestPerformer", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "127.0.0.1", family: 4 }]);
    const requestPerformer = vi.fn();
    await expect(
      safeFetch("http://internal.test/", { resolver, requestPerformer }),
    ).rejects.toThrow(BlockedDestinationError);
    expect(requestPerformer).not.toHaveBeenCalled();
  });

  it("rejects a disallowed scheme before any DNS resolution happens", async () => {
    const resolver = vi.fn();
    await expect(safeFetch("file:///etc/passwd", { resolver })).rejects.toThrow(
      BlockedDestinationError,
    );
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("safeFetch redirect handling", () => {
  it("follows a redirect to a validated public host and returns the final response", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "93.184.216.34", family: 4 }]);
    const requestPerformer = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://hop2.test/next"))
      .mockResolvedValueOnce(okResponse("final"));

    const result = await safeFetch("https://hop1.test/start", { resolver, requestPerformer });

    expect(result.httpStatusCode).toBe(200);
    expect(result.finalUrl).toBe("https://hop2.test/next");
    expect(result.redirectChain).toHaveLength(2);
    expect(result.redirectChain[0]!.httpStatusCode).toBe(302);
    expect(requestPerformer).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect to a private address and never calls requestPerformer again", async () => {
    const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
      if (hostname === "hop1.test") return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "169.254.169.254", family: 4 }]; // cloud metadata
    });
    const requestPerformer = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("http://internal-metadata.test/latest"));

    await expect(
      safeFetch("https://hop1.test/start", { resolver, requestPerformer }),
    ).rejects.toThrow(BlockedDestinationError);
    expect(requestPerformer).toHaveBeenCalledTimes(1);
  });

  it("enforces the redirect hop limit and stops calling requestPerformer at the cap", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "93.184.216.34", family: 4 }]);
    const requestPerformer = vi.fn(async () => redirectResponse("https://next-hop.test/"));

    await expect(
      safeFetch("https://hop0.test/", { resolver, requestPerformer, maxRedirects: 3 }),
    ).rejects.toThrow(SafeFetchError);
    expect(requestPerformer).toHaveBeenCalledTimes(3);
  });

  it("rejects a redirect response with no Location header", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "93.184.216.34", family: 4 }]);
    const requestPerformer = vi.fn(async (): Promise<PinnedResponse> => ({
      httpStatusCode: 302,
      headers: {},
      body: Buffer.alloc(0),
      truncated: false,
      timings: fakeTimings(),
    }));

    await expect(safeFetch("https://hop0.test/", { resolver, requestPerformer })).rejects.toThrow(
      SafeFetchError,
    );
  });
});

describe("DNS rebinding structural proof at the safeFetch level", () => {
  it("passes requestPerformer the exact address the resolver returned, with exactly one resolve call per hop", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "93.184.216.34", family: 4 }]);
    const requestPerformer = vi.fn<RequestPerformer>(async () => okResponse());

    await safeFetch("https://pin-check.test/", { resolver, requestPerformer });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(requestPerformer).toHaveBeenCalledTimes(1);
    expect(requestPerformer.mock.calls[0]![0].pinnedIp).toBe(
      (await resolver.mock.results[0]!.value)[0].address,
    );
  });
});

describe("overall deadline budget", () => {
  it("stops following redirects once the wall-clock budget is exhausted, without a further request", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "93.184.216.34", family: 4 }]);
    const requestPerformer = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return redirectResponse("https://next-hop.test/");
    });

    await expect(
      safeFetch("https://hop0.test/", {
        resolver,
        requestPerformer,
        timeoutMs: 80,
        maxRedirects: 10,
      }),
    ).rejects.toMatchObject({ category: "timeout" });

    // One hop (60ms) fits in the 80ms budget; the second hop's remaining budget
    // should already be exhausted before a third request would be attempted.
    expect(requestPerformer.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
