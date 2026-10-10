import { BlockedDestinationError } from "./errors.js";

export interface UrlValidationOptions {
  /** Allowed ports. Defaults to 80/443 per THREAT_MODEL.md §1 item 5. */
  allowedPorts?: readonly number[] | undefined;
}

const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

function defaultPortForScheme(scheme: string): number {
  return scheme === "https:" ? 443 : 80;
}

/**
 * Parses and validates a candidate URL against THREAT_MODEL.md §1 items 1-3.
 * Relies on the WHATWG URL parser (Node's built-in `URL`) to canonicalize the
 * hostname — this is what collapses obfuscated IPv4 notations (decimal, hex,
 * octal, shorthand) into a single canonical form before any of our own
 * comparisons run, confirmed directly: `new URL("http://2130706433/").hostname
 * === "127.0.0.1"`. We never regex-match the raw input string for this reason.
 *
 * Returns the parsed URL and the resolved port. Throws BlockedDestinationError
 * (fail closed) on any violation.
 */
export function parseAndValidateUrl(
  rawUrl: string,
  options: UrlValidationOptions = {},
): { url: URL; port: number } {
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedDestinationError(`"${rawUrl}" is not a valid URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedDestinationError(`Unsupported URL scheme "${url.protocol}"`);
  }

  if (url.username !== "" || url.password !== "") {
    throw new BlockedDestinationError("URLs with embedded credentials are not allowed");
  }

  if (url.hostname === "") {
    throw new BlockedDestinationError("URL has no hostname");
  }

  const port = url.port === "" ? defaultPortForScheme(url.protocol) : Number(url.port);
  if (!allowedPorts.includes(port)) {
    throw new BlockedDestinationError(
      `Port ${port} is not in the allowed set (${allowedPorts.join(", ")})`,
    );
  }

  return { url, port };
}

/**
 * Resolves a possibly-relative redirect Location header against the current URL,
 * then validates the result the same way as an original request URL. A redirect
 * is never trusted just because the original request was validated.
 */
export function resolveAndValidateRedirect(
  location: string,
  currentUrl: URL,
  options: UrlValidationOptions = {},
): { url: URL; port: number } {
  let resolved: string;
  try {
    resolved = new URL(location, currentUrl).toString();
  } catch {
    throw new BlockedDestinationError(`Redirect Location "${location}" could not be resolved`);
  }
  return parseAndValidateUrl(resolved, options);
}
