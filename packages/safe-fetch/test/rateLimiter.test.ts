import { describe, expect, it, vi } from "vitest";
import { createPerHostDelayGate, SlidingWindowCounter } from "../src/rateLimiter.js";

describe("createPerHostDelayGate", () => {
  it("does not delay the first request to a host", async () => {
    const gate = createPerHostDelayGate(50);
    const start = Date.now();
    await gate("example.test");
    expect(Date.now() - start).toBeLessThan(20);
  });

  it("delays a second request to the same host by roughly the configured gap", async () => {
    const gate = createPerHostDelayGate(80);
    await gate("example.test");
    const start = Date.now();
    await gate("example.test");
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
  });

  it("does not delay requests to a different host", async () => {
    const gate = createPerHostDelayGate(200);
    await gate("host-a.test");
    const start = Date.now();
    await gate("host-b.test");
    expect(Date.now() - start).toBeLessThan(20);
  });
});

describe("SlidingWindowCounter", () => {
  it("allows events up to the configured max within the window", () => {
    const counter = new SlidingWindowCounter(60_000, 3);
    expect(counter.tryRecord("ip-1")).toBe(true);
    expect(counter.tryRecord("ip-1")).toBe(true);
    expect(counter.tryRecord("ip-1")).toBe(true);
    expect(counter.tryRecord("ip-1")).toBe(false);
  });

  it("tracks separate keys independently", () => {
    const counter = new SlidingWindowCounter(60_000, 1);
    expect(counter.tryRecord("ip-1")).toBe(true);
    expect(counter.tryRecord("ip-2")).toBe(true);
    expect(counter.tryRecord("ip-1")).toBe(false);
  });

  it("allows events again once the window has elapsed", () => {
    vi.useFakeTimers();
    try {
      const counter = new SlidingWindowCounter(1000, 1);
      expect(counter.tryRecord("ip-1")).toBe(true);
      expect(counter.tryRecord("ip-1")).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(counter.tryRecord("ip-1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
