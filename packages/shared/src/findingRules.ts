import type { FindingSeverity } from "./statusMachines.js";

/**
 * Deterministic finding catalog. Every finding the product ever writes comes from
 * exactly one of these rule ids, evaluated against stored measurements — never
 * free text from a model. Title/description are plain template functions over the
 * evidence values, not generated prose.
 */

export const SSL_EXPIRY_WARNING_DAYS = [30, 14, 7] as const;

/** Bounded confirmation retries before a failing check becomes an "open" incident. */
export const INCIDENT_CONFIRMATION_MAX_ATTEMPTS = 2;
/** Delay between the initial failure and the confirmation attempt. */
export const INCIDENT_CONFIRMATION_DELAY_SECONDS = 60;

export type FindingTypeId =
  | "ssl_expiring_30d"
  | "ssl_expiring_14d"
  | "ssl_expiring_7d"
  | "ssl_expired"
  | "ssl_hostname_mismatch"
  | "ssl_untrusted_chain"
  | "http_incident_opened"
  | "http_non_2xx"
  | "crawler_internal_broken_link"
  | "crawler_external_broken_link"
  | "crawler_missing_title"
  | "crawler_missing_meta_description"
  | "crawler_missing_image_alt";

export interface FindingRuleDefinition {
  id: FindingTypeId;
  severity: FindingSeverity;
  title: (evidence: Record<string, unknown>) => string;
  description: (evidence: Record<string, unknown>) => string;
}

function daysLabel(days: unknown): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

export const FINDING_RULES: Record<FindingTypeId, FindingRuleDefinition> = {
  ssl_expiring_30d: {
    id: "ssl_expiring_30d",
    severity: "low",
    title: () => "SSL certificate expires in about 30 days",
    description: (e) =>
      `The SSL certificate for this website expires on ${e.validTo}, which is ${daysLabel(e.daysUntilExpiry)} away.`,
  },
  ssl_expiring_14d: {
    id: "ssl_expiring_14d",
    severity: "medium",
    title: () => "SSL certificate expires in about 14 days",
    description: (e) =>
      `The SSL certificate for this website expires on ${e.validTo}, which is ${daysLabel(e.daysUntilExpiry)} away.`,
  },
  ssl_expiring_7d: {
    id: "ssl_expiring_7d",
    severity: "high",
    title: () => "SSL certificate expires in about 7 days",
    description: (e) =>
      `The SSL certificate for this website expires on ${e.validTo}, which is ${daysLabel(e.daysUntilExpiry)} away.`,
  },
  ssl_expired: {
    id: "ssl_expired",
    severity: "critical",
    title: () => "SSL certificate has expired",
    description: (e) => `The SSL certificate expired on ${e.validTo}.`,
  },
  ssl_hostname_mismatch: {
    id: "ssl_hostname_mismatch",
    severity: "critical",
    title: () => "SSL certificate does not match the site hostname",
    description: () =>
      "The certificate presented by this website does not cover the hostname being monitored.",
  },
  ssl_untrusted_chain: {
    id: "ssl_untrusted_chain",
    severity: "critical",
    title: () => "SSL certificate chain is not trusted",
    description: (e) => `Certificate validation failed: ${e.failureReason}.`,
  },
  http_incident_opened: {
    id: "http_incident_opened",
    severity: "high",
    title: () => "Website became unreachable",
    description: (e) =>
      `Confirmed failure category: ${e.failureCategory}. First detected at ${e.openedAt}.`,
  },
  http_non_2xx: {
    id: "http_non_2xx",
    severity: "medium",
    title: (e) => `Website returned HTTP ${e.httpStatusCode}`,
    description: (e) =>
      `The monitored URL responded with HTTP ${e.httpStatusCode} at ${e.checkedAt}.`,
  },
  crawler_internal_broken_link: {
    id: "crawler_internal_broken_link",
    severity: "medium",
    title: () => "Broken internal link found",
    description: (e) => `Link to ${e.targetUrl} on page ${e.sourceUrl} returned ${e.statusCode}.`,
  },
  crawler_external_broken_link: {
    id: "crawler_external_broken_link",
    severity: "low",
    title: () => "Broken external link found",
    description: (e) => `Link to ${e.targetUrl} on page ${e.sourceUrl} returned ${e.statusCode}.`,
  },
  crawler_missing_title: {
    id: "crawler_missing_title",
    severity: "low",
    title: () => "Page is missing a title tag",
    description: (e) => `No <title> element was found on ${e.pageUrl}.`,
  },
  crawler_missing_meta_description: {
    id: "crawler_missing_meta_description",
    severity: "info",
    title: () => "Page is missing a meta description",
    description: (e) => `No meta description was found on ${e.pageUrl}.`,
  },
  crawler_missing_image_alt: {
    id: "crawler_missing_image_alt",
    severity: "info",
    title: () => "Image missing alt text",
    description: (e) => `Image ${e.imageSrc} on ${e.pageUrl} has no alt attribute.`,
  },
};

export function daysUntil(target: Date, from: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((target.getTime() - from.getTime()) / msPerDay);
}

/** Picks the single most-urgent SSL-expiry finding type for a given days-until-expiry, or null if none applies. */
export function sslExpiryFindingType(daysUntilExpiry: number): FindingTypeId | null {
  if (daysUntilExpiry < 0) return "ssl_expired";
  if (daysUntilExpiry <= 7) return "ssl_expiring_7d";
  if (daysUntilExpiry <= 14) return "ssl_expiring_14d";
  if (daysUntilExpiry <= 30) return "ssl_expiring_30d";
  return null;
}
