import { createHash, randomBytes } from "node:crypto";

/**
 * Shared bearer-token generation/hashing for client-approval links and report
 * share links (THREAT_MODEL.md §3). The raw token is only ever embedded in a URL;
 * only its SHA-256 hash is persisted. Both the issuing code and the verifying code
 * must use these exact functions so they can never drift apart.
 */

const TOKEN_BYTES = 32; // 256 bits

export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function saltedHashValue(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value}`, "utf8").digest("hex");
}
