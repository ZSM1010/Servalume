import ipaddr from "ipaddr.js";

/**
 * Single source of truth for "is this address safe to connect to." Every other
 * module in this package (and nothing outside it) must call through here —
 * THREAT_MODEL.md §1 requires fail-closed behavior, so an address this module
 * cannot confidently classify as public unicast is rejected, not allowed.
 *
 * Built on ipaddr.js (a widely used, independently maintained IP-range library)
 * rather than hand-rolled CIDR bit-math, because a subtle off-by-one in this exact
 * logic is the kind of bug that turns into a real SSRF.
 */

/**
 * Cloud metadata addresses named explicitly in the master spec (§6 item 12), even
 * though several are already covered by the broader link-local/ULA checks below.
 * Named explicitly so a regression here fails a specific, readable test rather
 * than only a generic range test.
 */
const EXPLICITLY_BLOCKED_ADDRESSES = new Set<string>([
  "169.254.169.254", // AWS/GCP/Azure instance metadata (also link-local)
  "169.254.170.2", // AWS ECS task metadata (also link-local)
  "fd00:ec2::254", // AWS IPv6 instance metadata (also unique local)
]);

/** ipaddr.js range names that we consider non-public for outbound requests. */
const BLOCKED_RANGE_NAMES = new Set<string>([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "carrierGradeNat",
  "private",
  "reserved",
  "uniqueLocal",
  "ipv4Mapped",
  "rfc6052",
  "6to4",
  "teredo",
  "benchmarking",
  "amt",
  "as112",
  "as112v6",
  "deprecated",
  "orchid2",
  "droneRemoteIdProtocolEntityTags",
  "6bone", // used by some ipaddr.js versions for 3ffe::/16 legacy space; harmless if absent
]);

/**
 * IANA has only ever delegated the 2000::/3 block for global unicast internet
 * routing. ipaddr.js's `.range()` models the IPv6 *special-purpose* registry
 * (loopback, ULA, link-local, documentation, 6to4, Teredo, NAT64, etc.) but will
 * still report "unicast" for a syntactically valid address that simply falls
 * outside any allocated block entirely (verified directly: an address like
 * `0:0:ffff:ffff:ffff:ffff:ffff:ffff` reports range "unicast" despite not being
 * part of the allocated internet). Fail-closed per THREAT_MODEL.md §1 means we
 * additionally require real IPv6 destinations to sit inside 2000::/3, instead of
 * trusting "not a known special range" as sufficient.
 */
const GLOBAL_UNICAST_IPV6_CIDR = ipaddr.parseCIDR("2000::/3");

export interface AddressClassification {
  address: string;
  family: 4 | 6;
  isPublicUnicast: boolean;
  reason: string;
}

function classifyParsed(
  parsed: ipaddr.IPv4 | ipaddr.IPv6,
  originalAddress: string,
): AddressClassification {
  const family: 4 | 6 = parsed.kind() === "ipv4" ? 4 : 6;

  if (EXPLICITLY_BLOCKED_ADDRESSES.has(originalAddress)) {
    return {
      address: originalAddress,
      family,
      isPublicUnicast: false,
      reason: "explicitly blocked cloud metadata address",
    };
  }

  const range = parsed.range();
  if (BLOCKED_RANGE_NAMES.has(range)) {
    return {
      address: originalAddress,
      family,
      isPublicUnicast: false,
      reason: `address range "${range}" is not public unicast`,
    };
  }

  if (range !== "unicast") {
    // Fail closed: any range name we don't explicitly recognize as safe is treated
    // as unsafe, not assumed safe. ipaddr.js only ever returns "unicast" for
    // ordinary public addresses — everything else is named.
    return {
      address: originalAddress,
      family,
      isPublicUnicast: false,
      reason: `address range "${range}" is not recognized as safe public unicast`,
    };
  }

  if (family === 6 && !(parsed as ipaddr.IPv6).match(GLOBAL_UNICAST_IPV6_CIDR)) {
    return {
      address: originalAddress,
      family,
      isPublicUnicast: false,
      reason: "IPv6 address is outside the allocated 2000::/3 global unicast range",
    };
  }

  return { address: originalAddress, family, isPublicUnicast: true, reason: "public unicast" };
}

/**
 * Classifies a single IP address string. Never throws on a malformed address —
 * an unparseable address is itself a rejection (fail closed), since we cannot
 * confidently say it's safe.
 */
export function classifyAddress(address: string): AddressClassification {
  try {
    // ipaddr.js's process() (verified against v2.5.0) unwraps an IPv4-mapped IPv6
    // address like "::ffff:127.0.0.1" into the embedded IPv4 address before we
    // ever call .range() on it, so the embedded address's own range applies.
    const parsed = ipaddr.process(address);
    return classifyParsed(parsed, address);
  } catch {
    return {
      address,
      family: address.includes(":") ? 6 : 4,
      isPublicUnicast: false,
      reason: "address could not be parsed",
    };
  }
}

export function isPublicUnicastAddress(address: string): boolean {
  return classifyAddress(address).isPublicUnicast;
}
