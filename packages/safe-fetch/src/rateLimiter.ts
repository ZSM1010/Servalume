/**
 * Enforces "at least `delayMs` between requests to the same host" (master spec
 * §5 crawler requirement, and good manners for monitoring too). Keyed by
 * hostname, not by destination IP, so pinning a connection to a validated
 * address elsewhere in this package doesn't accidentally bypass the per-host
 * pacing.
 */
export function createPerHostDelayGate(delayMs: number) {
  const nextAllowedAt = new Map<string, number>();

  return async function waitForHost(host: string): Promise<void> {
    const now = Date.now();
    const earliestAllowed = nextAllowedAt.get(host) ?? 0;
    const waitMs = Math.max(0, earliestAllowed - now);
    nextAllowedAt.set(host, Math.max(now, earliestAllowed) + delayMs);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
}

/**
 * In-process sliding-window counter. Useful as a cheap first line of defense
 * against bursts (e.g. the free-scan endpoint), but it resets on process
 * restart and is NOT shared across multiple worker/web instances — it is not a
 * substitute for the durable, DB-backed `usage_records` counter
 * (docs/DATA_MODEL.md §6) that is the actual source of truth for a plan's
 * metered limits. Documented here rather than overstated.
 */
export class SlidingWindowCounter {
  private readonly timestamps = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxEvents: number,
  ) {}

  /** Returns true and records the event if the key is still under its limit; otherwise returns false without recording. */
  tryRecord(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const existing = (this.timestamps.get(key) ?? []).filter((t) => t > cutoff);

    if (existing.length >= this.maxEvents) {
      this.timestamps.set(key, existing);
      return false;
    }

    existing.push(now);
    this.timestamps.set(key, existing);
    return true;
  }
}
