import type { DnsResolver } from "./dnsResolution.js";
import { resolveValidatedAddress } from "./dnsResolution.js";
import { SafeFetchError } from "./errors.js";
import { performPinnedRequest } from "./pinnedRequest.js";
import type { PinnedRequestParams, PinnedResponse, PinnedResponseTimings } from "./pinnedRequest.js";
import { parseAndValidateUrl, resolveAndValidateRedirect } from "./urlValidation.js";

export type RequestPerformer = (params: PinnedRequestParams) => Promise<PinnedResponse>;

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  allowedPorts?: readonly number[];
  /** Hop limit for redirects (THREAT_MODEL.md §1 item 6). Default 3. */
  maxRedirects?: number;
  /** Total wall-clock budget for the whole call, including every redirect hop. Default 10000ms. */
  timeoutMs?: number;
  /** Cap on decompressed response body size. Default 5 MiB. */
  maxResponseBytes?: number;
  /** Injectable only for this package's own tests — production code never overrides this. */
  resolver?: DnsResolver;
  /** Injectable only for this package's own tests — production code never overrides this. */
  requestPerformer?: RequestPerformer;
  userAgent?: string;
}

export interface SafeFetchHop {
  url: string;
  httpStatusCode: number;
}

export interface SafeFetchResult {
  finalUrl: string;
  httpStatusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  redirectChain: SafeFetchHop[];
  timings: PinnedResponseTimings;
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_USER_AGENT = "ServalumeBot/1.0 (+https://servalume.example/about-our-bot)";

/** Headers never surfaced to callers — set-cookie must never be stored/acted on, and we never want to accidentally re-emit anything auth-shaped we didn't send ourselves. */
const STRIPPED_RESPONSE_HEADERS = new Set(["set-cookie", "set-cookie2"]);

function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * The only outbound HTTP client this product uses against a user- or
 * visitor-submitted URL. Enforces every control in THREAT_MODEL.md §1:
 * scheme/port allowlist, no embedded credentials, DNS resolved and validated by
 * us (every record, not just the first), connection pinned to the validated
 * address with hostname/SNI preserved, redirects re-validated hop by hop with a
 * strict limit, and a hard wall-clock + response-size budget. Fails closed on
 * any ambiguity by construction — every validation step throws rather than
 * falling through to a default-allow.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const method = options.method ?? "GET";
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const requestPerformer = options.requestPerformer ?? performPinnedRequest;
  const deadline = Date.now() + timeoutMs;

  let { url, port } = parseAndValidateUrl(rawUrl, { allowedPorts: options.allowedPorts });
  const redirectChain: SafeFetchHop[] = [];

  for (let hop = 0; ; hop++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new SafeFetchError("timeout", `Exceeded overall ${timeoutMs}ms budget before completing the request`);
    }

    const resolved = await resolveValidatedAddress(url.hostname, options.resolver);

    const response = await requestPerformer({
      hostname: url.hostname,
      pinnedIp: resolved.address,
      family: resolved.family,
      port,
      scheme: url.protocol as "http:" | "https:",
      method,
      path: `${url.pathname}${url.search}`,
      headers: options.headers ?? {},
      timeoutMs: remainingMs,
      maxResponseBytes,
      userAgent,
    });

    redirectChain.push({ url: url.toString(), httpStatusCode: response.httpStatusCode });

    if (isRedirectStatus(response.httpStatusCode)) {
      const location = response.headers.location;
      if (typeof location !== "string" || location.length === 0) {
        throw new SafeFetchError("http", `Redirect status ${response.httpStatusCode} had no Location header`);
      }
      if (hop + 1 >= maxRedirects) {
        throw new SafeFetchError("http", `Exceeded maximum of ${maxRedirects} redirects`);
      }
      const next = resolveAndValidateRedirect(location, url, { allowedPorts: options.allowedPorts });
      url = next.url;
      port = next.port;
      continue;
    }

    return {
      finalUrl: url.toString(),
      httpStatusCode: response.httpStatusCode,
      headers: sanitizeHeaders(response.headers as Record<string, string | string[] | undefined>),
      body: response.body,
      truncated: response.truncated,
      redirectChain,
      timings: response.timings,
    };
  }
}
