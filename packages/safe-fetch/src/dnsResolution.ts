import dns from "node:dns";
import { isIP } from "node:net";
import { BlockedDestinationError } from "./errors.js";
import { classifyAddress } from "./ipClassification.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * Real DNS resolution via the OS resolver (honors /etc/hosts, same as Node's own
 * fetch would use) with `all: true` so every A/AAAA record is inspected, per
 * THREAT_MODEL.md §1 item 4 — not just the first answer.
 */
export const defaultDnsResolver: DnsResolver = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

/**
 * Resolves `hostname` to every address it reports, validates ALL of them, and
 * returns the single address the caller should connect to.
 *
 * Fails closed as a whole if even one resolved address is non-public — a
 * multi-homed response mixing a decoy public address with a real private one is
 * a known SSRF technique, so "at least one good answer" is not good enough.
 *
 * The caller (safeFetch.ts) must reuse the exact returned address for the actual
 * socket connection via the `lookup` override, and must call this function only
 * once per logical request/redirect-hop. That is what closes the DNS-rebinding
 * TOCTOU window described in THREAT_MODEL.md §1 item 7/10: there is structurally
 * only one resolution, not a validate-then-reconnect pair.
 */
export async function resolveValidatedAddress(
  hostname: string,
  resolver: DnsResolver = defaultDnsResolver,
): Promise<ResolvedAddress> {
  const literalFamily = isIP(hostname);
  const candidates: ResolvedAddress[] =
    literalFamily !== 0
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await resolver(hostname);

  if (candidates.length === 0) {
    throw new BlockedDestinationError(`"${hostname}" did not resolve to any address`);
  }

  for (const candidate of candidates) {
    const classification = classifyAddress(candidate.address);
    if (!classification.isPublicUnicast) {
      throw new BlockedDestinationError(
        `"${hostname}" resolves to ${candidate.address}, which is not a public address (${classification.reason})`,
      );
    }
  }

  return candidates[0]!;
}
