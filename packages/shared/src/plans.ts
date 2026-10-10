/**
 * Central plan-definition module (master spec §9): every quota/entitlement check in
 * the product reads from this file. Nothing else hard-codes a price or a limit.
 */

export type PlanId = "free" | "solo" | "studio" | "agency";

export interface CrawlerLimits {
  maxPagesPerWebsite: number;
  maxDepth: number;
  perHostDelayMs: number;
}

export interface PlanDefinition {
  id: PlanId;
  displayName: string;
  /** Test-mode price hypothesis, in US cents. Not a commitment — see docs/ASSUMPTIONS.md. */
  priceCents: number;
  maxWebsites: number;
  maxTeamMembers: number;
  /** Floor on monitor check frequency; lower = more frequent checks allowed. */
  minMonitorIntervalSeconds: number;
  crawler: CrawlerLimits;
  /** Env var name (see docs/ENVIRONMENT_VARIABLES.md) holding this plan's Stripe Price ID. Absent for "free". */
  stripePriceEnvVar?: string;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    displayName: "Free scan",
    priceCents: 0,
    maxWebsites: 0,
    maxTeamMembers: 1,
    minMonitorIntervalSeconds: 0,
    crawler: { maxPagesPerWebsite: 0, maxDepth: 0, perHostDelayMs: 1000 },
  },
  solo: {
    id: "solo",
    displayName: "Solo",
    priceCents: 2900,
    maxWebsites: 10,
    maxTeamMembers: 2,
    minMonitorIntervalSeconds: 300,
    crawler: { maxPagesPerWebsite: 50, maxDepth: 2, perHostDelayMs: 1000 },
    stripePriceEnvVar: "STRIPE_PRICE_ID_SOLO",
  },
  studio: {
    id: "studio",
    displayName: "Studio",
    priceCents: 7900,
    maxWebsites: 40,
    maxTeamMembers: 5,
    minMonitorIntervalSeconds: 180,
    crawler: { maxPagesPerWebsite: 100, maxDepth: 3, perHostDelayMs: 1000 },
    stripePriceEnvVar: "STRIPE_PRICE_ID_STUDIO",
  },
  agency: {
    id: "agency",
    displayName: "Agency",
    priceCents: 14900,
    maxWebsites: 100,
    maxTeamMembers: 15,
    minMonitorIntervalSeconds: 60,
    crawler: { maxPagesPerWebsite: 100, maxDepth: 3, perHostDelayMs: 1000 },
    stripePriceEnvVar: "STRIPE_PRICE_ID_AGENCY",
  },
};

export function getPlan(id: PlanId): PlanDefinition {
  const plan = PLANS[id];
  if (!plan) throw new Error(`Unknown plan id: ${id}`);
  return plan;
}

/**
 * Subscription statuses that count as "entitled to use paid features." Mirrors
 * Stripe's own status vocabulary (see docs/DATA_MODEL.md subscriptions table) —
 * past_due/canceled/incomplete must not keep granting access just because a plan
 * row still exists.
 */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete";

const ENTITLED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  "trialing",
  "active",
]);

export function isEntitlementActive(status: SubscriptionStatus): boolean {
  return ENTITLED_STATUSES.has(status);
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
}

export function canAddWebsite(
  plan: PlanDefinition,
  status: SubscriptionStatus,
  currentWebsiteCount: number,
): QuotaCheckResult {
  if (!isEntitlementActive(status)) {
    return { allowed: false, reason: `Subscription is ${status}, not active.` };
  }
  if (currentWebsiteCount >= plan.maxWebsites) {
    return {
      allowed: false,
      reason: `Plan "${plan.displayName}" allows up to ${plan.maxWebsites} websites.`,
    };
  }
  return { allowed: true };
}

export function canAddTeamMember(
  plan: PlanDefinition,
  status: SubscriptionStatus,
  currentMemberCount: number,
): QuotaCheckResult {
  if (!isEntitlementActive(status)) {
    return { allowed: false, reason: `Subscription is ${status}, not active.` };
  }
  if (currentMemberCount >= plan.maxTeamMembers) {
    return {
      allowed: false,
      reason: `Plan "${plan.displayName}" allows up to ${plan.maxTeamMembers} team members.`,
    };
  }
  return { allowed: true };
}

export function clampMonitorInterval(
  plan: PlanDefinition,
  requestedSeconds: number,
): number {
  return Math.max(plan.minMonitorIntervalSeconds, requestedSeconds);
}

export function canStartScan(
  plan: PlanDefinition,
  status: SubscriptionStatus,
): QuotaCheckResult {
  if (plan.id === "free") return { allowed: true };
  if (!isEntitlementActive(status)) {
    return { allowed: false, reason: `Subscription is ${status}, not active.` };
  }
  return { allowed: true };
}
