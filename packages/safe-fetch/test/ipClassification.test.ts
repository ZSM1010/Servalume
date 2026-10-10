import { describe, expect, it } from "vitest";
import { classifyAddress, isPublicUnicastAddress } from "../src/ipClassification.js";

describe("public addresses are allowed", () => {
  it.each([
    ["8.8.8.8", "Google public DNS"],
    ["1.1.1.1", "Cloudflare public DNS"],
    ["93.184.216.34", "a generic public IPv4"],
    ["2001:4860:4860::8888", "Google public DNS, IPv6"],
  ])("allows %s (%s)", (address) => {
    expect(isPublicUnicastAddress(address)).toBe(true);
  });
});

describe("IPv4 private/reserved ranges are rejected", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.0.0.53", "loopback (systemd-resolved stub)"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["172.16.0.1", "RFC1918 172.16/12"],
    ["192.168.1.1", "RFC1918 192.168/16"],
    ["169.254.1.1", "link-local"],
    ["169.254.169.254", "cloud metadata (explicit + link-local)"],
    ["169.254.170.2", "AWS ECS task metadata (explicit + link-local)"],
    ["100.64.0.1", "carrier-grade NAT (RFC6598)"],
    ["0.0.0.0", "unspecified"],
    ["192.0.2.1", "TEST-NET-1 documentation range"],
    ["198.51.100.1", "TEST-NET-2 documentation range"],
    ["203.0.113.1", "TEST-NET-3 documentation range"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("rejects %s (%s)", (address) => {
    const result = classifyAddress(address);
    expect(result.isPublicUnicast).toBe(false);
  });
});

describe("IPv6 private/reserved ranges are rejected", () => {
  it.each([
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fc00::1", "unique local (RFC4193)"],
    ["fd00::1", "unique local (RFC4193)"],
    ["fd00:ec2::254", "AWS IPv6 metadata (explicit + unique local)"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation range (RFC3849)"],
    ["64:ff9b::1.2.3.4", "NAT64 well-known prefix (RFC6052)"],
  ])("rejects %s (%s)", (address) => {
    const result = classifyAddress(address);
    expect(result.isPublicUnicast).toBe(false);
  });
});

describe("IPv4-mapped IPv6 addresses are unwrapped and the embedded address is checked", () => {
  it("rejects ::ffff:127.0.0.1 (maps to loopback)", () => {
    expect(isPublicUnicastAddress("::ffff:127.0.0.1")).toBe(false);
  });

  it("rejects ::ffff:10.0.0.1 (maps to RFC1918 private)", () => {
    expect(isPublicUnicastAddress("::ffff:10.0.0.1")).toBe(false);
  });

  it("rejects ::ffff:169.254.169.254 (maps to cloud metadata)", () => {
    expect(isPublicUnicastAddress("::ffff:169.254.169.254")).toBe(false);
  });

  it("allows ::ffff:8.8.8.8 (maps to a genuinely public address)", () => {
    expect(isPublicUnicastAddress("::ffff:8.8.8.8")).toBe(true);
  });
});

describe("fail-closed behavior on malformed input", () => {
  it.each([
    "not-an-ip",
    "",
    "999.999.999.999",
    "2001:db8::1::1", // double "::" is invalid
  ])("rejects unparseable input %j", (address) => {
    expect(isPublicUnicastAddress(address)).toBe(false);
  });
});

describe("IPv6 addresses outside the allocated 2000::/3 global unicast block are rejected", () => {
  it("rejects a syntactically valid address with no special-range match that isn't in 2000::/3", () => {
    // Confirmed directly against ipaddr.js 2.5.0: this address matches none of its
    // named special-purpose ranges (so .range() reports "unicast"), yet IANA has
    // never delegated this block for internet routing. This is exactly the kind
    // of ambiguous case THREAT_MODEL.md §1 requires failing closed on.
    expect(isPublicUnicastAddress("0:0:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(false);
  });

  it("still allows a real address inside 2000::/3", () => {
    expect(isPublicUnicastAddress("2001:4860:4860::8888")).toBe(true);
  });
});

describe("alternative IPv4 notations are normalized before classification, not bypassed", () => {
  it.each([
    ["2130706433", "decimal-integer form of 127.0.0.1"],
    ["0x7f000001", "hex form of 127.0.0.1"],
    ["017700000001", "octal form of 127.0.0.1"],
    ["127.1", "shorthand dotted form of 127.0.0.1"],
    ["0177.0.0.1", "octal first-octet form of 127.0.0.1"],
  ])("rejects %s (%s) as loopback once normalized", (address) => {
    expect(isPublicUnicastAddress(address)).toBe(false);
  });

  it("rejects the shorthand form of a private 10.x address", () => {
    // "10.1" normalizes to 10.0.0.1, not 10.0.0.0.1 — confirmed directly.
    expect(isPublicUnicastAddress("10.1")).toBe(false);
  });

  it("still allows a normal public address expressed as a plain decimal integer", () => {
    // 134744072 == 8.8.8.8
    expect(isPublicUnicastAddress("134744072")).toBe(true);
  });
});
