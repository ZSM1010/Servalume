import type { Pool } from "pg";
import { getIncidentNotificationTargets, markNotificationSent } from "../db/queries.js";
import type { EmailProvider } from "../emailProvider.js";

export interface NotificationDispatchDeps {
  pool: Pool;
  emailProvider: EmailProvider;
  appBaseUrl: string;
}

export interface NotificationDispatchParams {
  incidentId: string;
  organizationId: string;
  eventType: "incident_opened" | "incident_resolved";
}

export interface NotificationDispatchResult {
  recipientCount: number;
  sentCount: number;
  failedCount: number;
}

function renderIncidentEmail(
  eventType: "incident_opened" | "incident_resolved",
  websiteLabel: string,
  appBaseUrl: string,
): { subject: string; html: string; text: string } {
  const isOpened = eventType === "incident_opened";
  const subject = isOpened ? `${websiteLabel} appears to be down` : `${websiteLabel} has recovered`;
  const body = isOpened
    ? `Servalume detected that ${websiteLabel} is not responding. We confirmed this with a second check before alerting you.`
    : `${websiteLabel} is responding normally again.`;
  const html = `<p>${body}</p><p><a href="${appBaseUrl}">View details in Servalume</a></p>`;
  const text = `${body}\n\nView details: ${appBaseUrl}`;
  return { subject, html, text };
}

/**
 * Dispatches exactly one notification pass for one incident transition.
 * Idempotency against *retries of this same job* is the caller's
 * responsibility (pg-boss singletonKey, see queue.ts) — this function marks
 * notification_sent_at so a later, unrelated job can see one was already
 * sent for this incident, per docs/DATA_MODEL.md's incident model.
 */
export async function dispatchIncidentNotification(
  deps: NotificationDispatchDeps,
  params: NotificationDispatchParams,
): Promise<NotificationDispatchResult> {
  const targets = await getIncidentNotificationTargets(deps.pool, params.incidentId, params.eventType);

  let sentCount = 0;
  let failedCount = 0;

  for (const target of targets) {
    const websiteLabel = target.websiteDisplayName ?? target.websiteUrl;
    const { subject, html, text } = renderIncidentEmail(params.eventType, websiteLabel, deps.appBaseUrl);
    const result = await deps.emailProvider.send({ to: target.userEmail, subject, html, text });
    if (result.success) sentCount++;
    else failedCount++;
  }

  if (params.eventType === "incident_opened") {
    await markNotificationSent(deps.pool, params.incidentId, params.organizationId);
  }

  return { recipientCount: targets.length, sentCount, failedCount };
}
