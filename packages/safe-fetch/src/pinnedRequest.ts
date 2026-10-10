import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";
import { SafeFetchError } from "./errors.js";

/**
 * `autoSelectFamily` is a real, supported runtime option (Node's Happy-Eyeballs
 * dual-stack connect setting) that the installed @types/node version declares
 * only on `net.TcpSocketConnectOpts`, not on `http.RequestOptions` — a types
 * gap, not a sign the option is unsupported here. See the comment at its use
 * site below for why this must always be `false` for a pinned connection.
 */
type RequestOptionsWithFamilySelection = http.RequestOptions & { autoSelectFamily?: boolean };

export interface PinnedRequestParams {
  /** The hostname as the caller/attacker wrote it — used for the Host header and TLS SNI/hostname verification. Never used for the actual socket connection. */
  hostname: string;
  /** The single already-validated IP address to connect the socket to. */
  pinnedIp: string;
  family: 4 | 6;
  port: number;
  scheme: "http:" | "https:";
  method: string;
  path: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
  userAgent: string;
}

export interface PinnedResponseTimings {
  dnsLookupMs: number;
  tcpConnectMs: number | null;
  tlsHandshakeMs: number | null;
  timeToFirstByteMs: number | null;
  totalMs: number;
}

export interface PinnedResponse {
  httpStatusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  timings: PinnedResponseTimings;
}

/** Raw (possibly compressed) bytes are capped at a multiple of the decompressed cap, as a hard ceiling independent of whatever compression ratio the response claims. */
const RAW_BYTES_MULTIPLIER = 10;

/**
 * Performs exactly one HTTP request against an address that has ALREADY been
 * validated and resolved by the caller (safeFetch.ts). This function has no
 * opinion about SSRF — it only knows how to connect to one specific IP while
 * presenting the original hostname for the Host header and TLS SNI/certificate
 * verification. Never follows redirects (that's the caller's job, re-validating
 * every hop). Never sends cookies or an Authorization header — none are ever
 * placed in `headers` by any caller in this codebase.
 */
export function performPinnedRequest(params: PinnedRequestParams): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const requestStart = Date.now();
    let lookupAt: number | null = null;
    let connectAt: number | null = null;
    let secureConnectAt: number | null = null;
    let firstByteAt: number | null = null;
    let settled = false;

    const lookup: LookupFunction = (_hostname, _options, callback) => {
      lookupAt = Date.now();
      callback(null, params.pinnedIp, params.family);
    };

    const requestFn = params.scheme === "https:" ? https.request : http.request;

    const requestOptions: RequestOptionsWithFamilySelection = {
      protocol: params.scheme,
      hostname: params.hostname,
      port: params.port,
      path: params.path,
      method: params.method,
      headers: {
        "User-Agent": params.userAgent,
        Accept: "*/*",
        Connection: "close",
        ...params.headers,
      },
      lookup,
      timeout: params.timeoutMs,
      // We already resolved and validated exactly one address ourselves — Node
      // must not independently race a second address of its own choosing.
      // Without this, Node's Happy-Eyeballs dual-stack logic (default enabled)
      // calls `lookup` expecting the multi-address array callback form once a
      // connection attempt runs long enough to trigger its fallback timer,
      // which our single-address callback doesn't satisfy, confirmed directly:
      // omitting this caused intermittent "Invalid IP address: undefined"
      // failures specifically on slow/TLS connections, not fast local ones.
      autoSelectFamily: false,
      // Defaults preserved deliberately: rejectUnauthorized stays true, and
      // servername is derived by Node from `hostname` above, so TLS hostname
      // verification runs against the real hostname even though the socket
      // connects to `pinnedIp`.
    };

    const req = requestFn(requestOptions);

    function settleError(category: SafeFetchError["category"], message: string, cause?: unknown): void {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new SafeFetchError(category, message, cause !== undefined ? { cause } : undefined));
    }

    req.on("timeout", () => settleError("timeout", `Request to ${params.hostname} timed out after ${params.timeoutMs}ms`));

    req.on("socket", (socket) => {
      socket.once("connect", () => {
        connectAt = Date.now();
      });
      socket.once("secureConnect", () => {
        secureConnectAt = Date.now();
      });
    });

    req.on("error", (err) => {
      settleError("connection", `Connection to ${params.hostname} failed: ${err.message}`, err);
    });

    req.on("response", (res) => {
      firstByteAt = Date.now();
      const maxRawBytes = params.maxResponseBytes * RAW_BYTES_MULTIPLIER;

      let rawBytesRead = 0;
      let decodedBytesRead = 0;
      let truncated = false;
      const chunks: Buffer[] = [];

      const encoding = (res.headers["content-encoding"] ?? "").toLowerCase();
      let decoder: zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate | null = null;
      if (encoding === "gzip") decoder = zlib.createGunzip();
      else if (encoding === "br") decoder = zlib.createBrotliDecompress();
      else if (encoding === "deflate") decoder = zlib.createInflate();

      function finish(): void {
        if (settled) return;
        settled = true;
        resolve({
          httpStatusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          truncated,
          timings: {
            dnsLookupMs: lookupAt ? lookupAt - requestStart : 0,
            tcpConnectMs: connectAt && lookupAt ? connectAt - lookupAt : null,
            tlsHandshakeMs: secureConnectAt && connectAt ? secureConnectAt - connectAt : null,
            timeToFirstByteMs: firstByteAt ? firstByteAt - requestStart : null,
            totalMs: Date.now() - requestStart,
          },
        });
      }

      function abortOversized(): void {
        truncated = true;
        res.destroy();
        decoder?.destroy();
        finish();
      }

      res.on("data", (chunk: Buffer) => {
        rawBytesRead += chunk.length;
        if (rawBytesRead > maxRawBytes) {
          abortOversized();
          return;
        }
        if (decoder) {
          decoder.write(chunk);
        } else {
          decodedBytesRead += chunk.length;
          if (decodedBytesRead > params.maxResponseBytes) {
            abortOversized();
            return;
          }
          chunks.push(chunk);
        }
      });

      if (decoder) {
        decoder.on("data", (chunk: Buffer) => {
          decodedBytesRead += chunk.length;
          if (decodedBytesRead > params.maxResponseBytes) {
            abortOversized();
            return;
          }
          chunks.push(chunk);
        });
        decoder.on("error", (err) => settleError("other", `Decompression failed: ${err.message}`, err));
      }

      res.on("end", () => {
        decoder?.end();
        if (!decoder) finish();
      });
      decoder?.on("end", finish);

      res.on("error", (err) => settleError("connection", `Response stream error: ${err.message}`, err));
    });

    req.end();
  });
}
