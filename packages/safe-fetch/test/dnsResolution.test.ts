import { describe, expect, it, vi } from "vitest";
import { BlockedDestinationError } from "../src/errors.js";
import { resolveValidatedAddress } from "../src/dnsResolution.js";
import type { ResolvedAddress } from "../src/dnsResolution.js";

describe("resolveValidatedAddress", () => {
  it("uses an IP literal directly without calling the resolver", async () => {
    const resolver = vi.fn();
    const result = await resolveValidatedAddress("8.8.8.8", resolver);
    expect(result).toEqual({ address: "8.8.8.8", family: 4 });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects an IP literal that is private, without calling the resolver", async () => {
    const resolver = vi.fn();
    await expect(resolveValidatedAddress("10.0.0.5", resolver)).rejects.toThrow(
      BlockedDestinationError,
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("accepts a hostname that resolves to a single public address", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "93.184.216.34", family: 4 }]);
    const result = await resolveValidatedAddress("example.test", resolver);
    expect(result.address).toBe("93.184.216.34");
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("rejects a hostname whose only resolved address is private", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "192.168.1.1", family: 4 }]);
    await expect(resolveValidatedAddress("internal.test", resolver)).rejects.toThrow(
      BlockedDestinationError,
    );
  });

  it("rejects a hostname that resolves to a mix of public and private addresses", async () => {
    // The documented SSRF technique: a decoy public answer alongside a real
    // private one. "At least one good answer" must not be good enough.
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(resolveValidatedAddress("multihomed.test", resolver)).rejects.toThrow(
      BlockedDestinationError,
    );
  });

  it("rejects a hostname that resolves to nothing", async () => {
    const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => []);
    await expect(resolveValidatedAddress("nowhere.test", resolver)).rejects.toThrow(
      BlockedDestinationError,
    );
  });

  describe("DNS rebinding structural proof", () => {
    it("resolves exactly once per call, so a resolver that would answer differently on a second call never gets the chance", async () => {
      // This resolver is deliberately stateful: it answers with a public address
      // the first time and would answer with a private address on any
      // subsequent call. If resolveValidatedAddress ever called the resolver a
      // second time between "validate" and "connect" (the classic TOCTOU
      // rebinding window), the caller downstream would end up trusting a
      // different, unvalidated address. Asserting a single call proves that
      // window does not exist in this implementation.
      let callCount = 0;
      const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => {
        callCount++;
        if (callCount === 1) return [{ address: "93.184.216.34", family: 4 }];
        return [{ address: "127.0.0.1", family: 4 }];
      });

      const result = await resolveValidatedAddress("rebinding.test", resolver);

      expect(result.address).toBe("93.184.216.34");
      expect(resolver).toHaveBeenCalledTimes(1);

      // Calling it again (simulating a second, independent logical request) is
      // allowed to see the attacker's second answer and must reject it — proving
      // the first call's result, not a fresh lookup, is what a caller must pin to.
      await expect(resolveValidatedAddress("rebinding.test", resolver)).rejects.toThrow(
        BlockedDestinationError,
      );
    });
  });
});
