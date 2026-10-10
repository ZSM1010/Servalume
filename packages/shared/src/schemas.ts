import { z } from "zod";

/**
 * Shared validation for everything that crosses a trust boundary (browser -> API
 * route, API route -> worker job payload). Keeping these in one place means the
 * web app and worker can never silently disagree about what a valid input looks
 * like.
 */

export const uuidSchema = z.string().uuid();

export const urlInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be a valid http:// or https:// URL");

export const createClientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).optional(),
  contactEmail: z.string().trim().email().max(320).optional(),
  notes: z.string().max(5000).optional(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

export const createWebsiteSchema = z.object({
  clientId: uuidSchema.nullable().optional(),
  url: urlInputSchema,
  displayName: z.string().trim().max(200).optional(),
  timezone: z.string().trim().max(100).default("UTC"),
});
export type CreateWebsiteInput = z.infer<typeof createWebsiteSchema>;

export const monitorTypeSchema = z.enum(["http_uptime", "ssl_cert"]);

export const createMonitorSchema = z.object({
  websiteId: uuidSchema,
  type: monitorTypeSchema,
  intervalSeconds: z.number().int().min(60).max(86400),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;

export const createWorkItemSchema = z.object({
  clientId: uuidSchema.nullable().optional(),
  websiteId: uuidSchema.nullable().optional(),
  findingId: uuidSchema.nullable().optional(),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10000).optional(),
  recommendedAction: z.string().trim().max(5000).optional(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  requiresClientApproval: z.boolean().default(true),
  assignedUserId: uuidSchema.nullable().optional(),
});
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;

export const addWorkLogSchema = z.object({
  workItemId: uuidSchema,
  description: z.string().trim().min(1).max(5000),
});
export type AddWorkLogInput = z.infer<typeof addWorkLogSchema>;

export const approvalDecisionSchema = z.object({
  token: z.string().trim().min(16).max(512),
  decision: z.enum(["approved", "declined", "clarification_requested"]),
  note: z.string().trim().max(2000).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const createReportSchema = z.object({
  clientId: uuidSchema.nullable().optional(),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

export const inviteMemberSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(["owner", "admin", "member"]),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const freeScanRequestSchema = z.object({
  url: urlInputSchema,
});
export type FreeScanRequestInput = z.infer<typeof freeScanRequestSchema>;

export const notificationPreferenceSchema = z.object({
  eventType: z.enum([
    "incident_opened",
    "incident_resolved",
    "ssl_expiring",
    "report_ready",
    "approval_decided",
  ]),
  enabled: z.boolean(),
});
export type NotificationPreferenceInput = z.infer<typeof notificationPreferenceSchema>;
