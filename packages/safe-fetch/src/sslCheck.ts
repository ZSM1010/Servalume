import tls, { type ConnectionOptions, type DetailedPeerCertificate } from "node:tls";
import type { DnsResolver } from "./dnsResolution.js";
import { resolveValidatedAddress } from "./dnsResolution.js";

/** See pinnedRequest.ts's identical type for why this extension is needed. */
type ConnectionOptionsWithFamilySelection = ConnectionOptions & { autoSelectFamily?: boolean };

/**
 * Purely technical outcomes of one TLS handshake/certificate inspection. This
 * module does not decide "expiring soon" thresholds — that is a business rule
 * (docs/DATA_MODEL.md's 30/14/7-day findings, see @servalume/shared's
 * `sslExpiryFindingType`) applied by the worker job handler to this result's
 * `daysUntilExpiry`, not baked in here.
 */
export type SslTechnicalStatus =
  | "valid"
  | "expired"
  | "hostname_mismatch"
  | "untrusted_chain"
  | "unreachable"
  | "error";

export interface SslCheckResult {
  status: SslTechnicalStatus;
  validFrom: Date | null;
  validTo: Date | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
  subject: string | null;
  chainLength: number | null;
  failureReason: string | null;
}

export interface SslCheckOptions {
  port?: number;
  timeoutMs?: number;
  resolver?: DnsResolver;
}

function unreachable(failureReason: string): SslCheckResult {
  return {
    status: "unreachable",
    validFrom: null,
    validTo: null,
    daysUntilExpiry: null,
    issuer: null,
    subject: null,
    chainLength: null,
    failureReason,
  };
}

function formatDistinguishedName(name: Record<string, string | string[]> | undefined): string | null {
  if (!name) return null;
  return Object.entries(name)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("+") : value}`)
    .join(", ");
}

function chainLengthOf(cert: DetailedPeerCertificate): number {
  let length = 0;
  let cursor: DetailedPeerCertificate | undefined = cert;
  const seen = new Set<string>();
  while (cursor && cursor.fingerprint && !seen.has(cursor.fingerprint)) {
    seen.add(cursor.fingerprint);
    length++;
    cursor = cursor.issuerCertificate;
  }
  return length;
}

export interface PinnedTlsProbeParams {
  /** The hostname as written by the caller — used for TLS SNI (`servername`) and certificate hostname verification. Never used for the actual socket connection. */
  hostname: string;
  /** The single already-validated IP address to connect the socket to. */
  pinnedIp: string;
  family: 4 | 6;
  port: number;
  timeoutMs: number;
}

/**
 * Connects to `pinnedIp` while presenting `hostname` for SNI/hostname
 * verification, and classifies the certificate it gets back. Has no SSRF
 * opinion of its own — exactly like pinnedRequest.ts's `performPinnedRequest`,
 * this is the layer that is safe and meaningful to test directly against a
 * local TLS server, independent of the IP-classification tests.
 *
 * Connects with `rejectUnauthorized: false` deliberately, then validates the
 * certificate by hand, because Node would otherwise abort the handshake on the
 * first problem found (e.g. an expired cert) without letting us distinguish
 * "expired" from "hostname mismatch" from "untrusted chain" — exactly the
 * distinction the master spec requires (§5 "SSL checks").
 */
export function performPinnedTlsProbe(params: PinnedTlsProbeParams): Promise<SslCheckResult> {
  return new Promise((resolve) => {
    let settled = false;

    const connectOptions: ConnectionOptionsWithFamilySelection = {
      host: params.hostname,
      port: params.port,
      servername: params.hostname,
      lookup: (_hostname, _opts, callback) => callback(null, params.pinnedIp, params.family),
      // See pinnedRequest.ts for why this is required alongside a custom
      // single-address `lookup` — without it, Node's Happy-Eyeballs fallback
      // logic intermittently breaks on exactly the TLS-handshake-timing
      // connections this module makes, confirmed directly.
      autoSelectFamily: false,
      rejectUnauthorized: false,
      timeout: params.timeoutMs,
    };

    const socket = tls.connect(connectOptions);

    function finish(result: SslCheckResult): void {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    }

    socket.once("timeout", () => finish(unreachable(`TLS connection timed out after ${params.timeoutMs}ms`)));
    socket.once("error", (err) => finish(unreachable(err.message)));

    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(true);
      if (!cert || Object.keys(cert).length === 0) {
        finish({
          status: "error",
          validFrom: null,
          validTo: null,
          daysUntilExpiry: null,
          issuer: null,
          subject: null,
          chainLength: null,
          failureReason: "No certificate was presented",
        });
        return;
      }

      const validFrom = new Date(cert.valid_from);
      const validTo = new Date(cert.valid_to);
      const now = new Date();
      const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      const hostnameError = tls.checkServerIdentity(params.hostname, cert);
      const chainTrusted = socket.authorized;

      let status: SslTechnicalStatus;
      let failureReason: string | null = null;
      if (now.getTime() > validTo.getTime()) {
        status = "expired";
        failureReason = `Certificate expired on ${validTo.toISOString()}`;
      } else if (hostnameError) {
        status = "hostname_mismatch";
        failureReason = hostnameError.message;
      } else if (!chainTrusted) {
        status = "untrusted_chain";
        failureReason = socket.authorizationError ? String(socket.authorizationError) : "Certificate chain is not trusted";
      } else {
        status = "valid";
      }

      finish({
        status,
        validFrom,
        validTo,
        daysUntilExpiry,
        issuer: formatDistinguishedName(cert.issuer as unknown as Record<string, string | string[]>),
        subject: formatDistinguishedName(cert.subject as unknown as Record<string, string | string[]>),
        chainLength: chainLengthOf(cert),
        failureReason,
      });
    });
  });
}

/**
 * Checks certificate validity/expiry/hostname-match/chain-trust for `hostname`.
 * Uses the same DNS-resolve-and-validate-once, connect-to-pinned-address
 * technique as safeFetch.ts — an SSL check is just as much an SSRF surface as
 * an HTTP check, since it is also driven by a user-submitted hostname.
 */
export async function checkSsl(hostname: string, options: SslCheckOptions = {}): Promise<SslCheckResult> {
  const port = options.port ?? 443;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let resolved;
  try {
    resolved = await resolveValidatedAddress(hostname, options.resolver);
  } catch (err) {
    return unreachable(err instanceof Error ? err.message : "destination could not be validated");
  }

  return performPinnedTlsProbe({
    hostname,
    pinnedIp: resolved.address,
    family: resolved.family,
    port,
    timeoutMs,
  });
}
