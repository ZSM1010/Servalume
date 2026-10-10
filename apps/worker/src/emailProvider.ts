import nodemailer, { type Transporter } from "nodemailer";
import { Resend } from "resend";
import type { WorkerConfig } from "./config.js";

/**
 * Provider-agnostic email interface (master spec §3/§9): job handlers depend
 * only on this, never on Resend or nodemailer directly, so swapping providers
 * never touches job logic. Tests mock this interface boundary rather than
 * hitting a real provider (master spec §13's guidance for exactly this case).
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendResult {
  success: boolean;
  providerMessageId: string | null;
  error: string | null;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class ResendEmailProvider implements EmailProvider {
  private readonly client: Resend;
  private readonly fromAddress: string;

  constructor(apiKey: string, fromAddress: string) {
    this.client = new Resend(apiKey);
    this.fromAddress = fromAddress;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const result = await this.client.emails.send({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    if (result.error) {
      return { success: false, providerMessageId: null, error: result.error.message };
    }
    return { success: true, providerMessageId: result.data?.id ?? null, error: null };
  }
}

export class SmtpEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor(smtp: { host: string; port: number; user: string; pass: string }, fromAddress: string) {
    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    this.fromAddress = fromAddress;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: this.fromAddress,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      return { success: true, providerMessageId: info.messageId ?? null, error: null };
    } catch (err) {
      return { success: false, providerMessageId: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createEmailProvider(config: WorkerConfig["email"]): EmailProvider {
  if (config.provider === "resend") {
    if (!config.resendApiKey) throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
    return new ResendEmailProvider(config.resendApiKey, config.fromAddress);
  }
  if (!config.smtp) throw new Error("SMTP_* variables are required when EMAIL_PROVIDER=smtp");
  return new SmtpEmailProvider(config.smtp, config.fromAddress);
}
