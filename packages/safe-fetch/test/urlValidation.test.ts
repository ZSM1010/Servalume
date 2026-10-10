import { describe, expect, it } from "vitest";
import { BlockedDestinationError } from "../src/errors.js";
import { parseAndValidateUrl, resolveAndValidateRedirect } from "../src/urlValidation.js";

describe("parseAndValidateUrl", () => {
  it("accepts a plain https URL on the default port", () => {
    const { url, port } = parseAndValidateUrl("https://example.com/path?x=1");
    expect(url.hostname).toBe("example.com");
    expect(port).toBe(443);
  });

  it("accepts a plain http URL and defaults its port to 80", () => {
    const { port } = parseAndValidateUrl("http://example.com/");
    expect(port).toBe(80);
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "javascript:alert(1)"])(
    "rejects unsupported scheme in %j",
    (raw) => {
      expect(() => parseAndValidateUrl(raw)).toThrow(BlockedDestinationError);
    },
  );

  it("rejects embedded credentials", () => {
    expect(() => parseAndValidateUrl("https://user:pass@example.com/")).toThrow(
      BlockedDestinationError,
    );
  });

  it("rejects a username with no password too", () => {
    expect(() => parseAndValidateUrl("https://user@example.com/")).toThrow(BlockedDestinationError);
  });

  it("rejects a disallowed port", () => {
    expect(() => parseAndValidateUrl("http://example.com:8081/")).toThrow(BlockedDestinationError);
  });

  it("allows a custom port when explicitly allow-listed", () => {
    const { port } = parseAndValidateUrl("http://example.com:8080/", { allowedPorts: [80, 8080] });
    expect(port).toBe(8080);
  });

  it("rejects an unparseable URL", () => {
    expect(() => parseAndValidateUrl("not a url")).toThrow(BlockedDestinationError);
  });

  it("canonicalizes an obfuscated decimal IPv4 hostname before any later check sees it", () => {
    const { url } = parseAndValidateUrl("http://2130706433/");
    expect(url.hostname).toBe("127.0.0.1");
  });
});

describe("resolveAndValidateRedirect", () => {
  it("resolves a relative redirect against the current URL", () => {
    const current = new URL("https://example.com/a/b");
    const { url } = resolveAndValidateRedirect("/c/d", current);
    expect(url.toString()).toBe("https://example.com/c/d");
  });

  it("resolves an absolute redirect to a different host", () => {
    const current = new URL("https://example.com/a");
    const { url } = resolveAndValidateRedirect("https://other.example.com/x", current);
    expect(url.hostname).toBe("other.example.com");
  });

  it("re-validates the redirect target's scheme", () => {
    const current = new URL("https://example.com/a");
    expect(() => resolveAndValidateRedirect("ftp://example.com/x", current)).toThrow(
      BlockedDestinationError,
    );
  });

  it("re-validates the redirect target's port", () => {
    const current = new URL("https://example.com/a");
    expect(() => resolveAndValidateRedirect("https://example.com:9999/x", current)).toThrow(
      BlockedDestinationError,
    );
  });
});
