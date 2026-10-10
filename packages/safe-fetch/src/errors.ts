/**
 * Mirrors check_results.failure_category in docs/DATA_MODEL.md so a caller can
 * write this straight into a row without translation.
 */
export type SafeFetchFailureCategory =
  | "dns"
  | "tls"
  | "timeout"
  | "http"
  | "connection"
  | "blocked"
  | "other";

export class SafeFetchError extends Error {
  readonly category: SafeFetchFailureCategory;

  constructor(category: SafeFetchFailureCategory, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.category = category;
    this.name = "SafeFetchError";
  }
}

/** Thrown specifically when a destination is rejected by the SSRF guard — never a bug, always "fail closed." */
export class BlockedDestinationError extends SafeFetchError {
  constructor(message: string) {
    super("blocked", message);
    this.name = "BlockedDestinationError";
  }
}
