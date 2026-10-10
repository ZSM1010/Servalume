/**
 * Central env var parsing for the worker — see docs/ENVIRONMENT_VARIABLES.md.
 * Fails fast at startup on a missing required variable, rather than letting a
 * job handler discover it's missing mid-run.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return parsed;
}

export interface WorkerConfig {
  databaseUrl: string;
  workerConcurrency: number;
  schedulerTickIntervalSeconds: number;
  safeFetch: {
    allowedPorts: number[];
    maxRedirects: number;
    timeoutMs: number;
    maxResponseBytes: number;
  };
  email: {
    provider: "resend" | "smtp";
    fromAddress: string;
    resendApiKey?: string | undefined;
    smtp?: { host: string; port: number; user: string; pass: string } | undefined;
  };
  ipHashSalt: string;
  appBaseUrl: string;
}

export function loadConfig(): WorkerConfig {
  const emailProvider = (process.env.EMAIL_PROVIDER ?? "resend") as "resend" | "smtp";
  if (emailProvider !== "resend" && emailProvider !== "smtp") {
    throw new Error(`EMAIL_PROVIDER must be "resend" or "smtp", got "${emailProvider}"`);
  }

  return {
    databaseUrl: required("DATABASE_URL"),
    workerConcurrency: optionalInt("WORKER_CONCURRENCY", 10),
    schedulerTickIntervalSeconds: optionalInt("SCHEDULER_TICK_INTERVAL_SECONDS", 30),
    safeFetch: {
      allowedPorts: (process.env.SAFE_FETCH_ALLOWED_PORTS ?? "80,443")
        .split(",")
        .map((p) => Number.parseInt(p.trim(), 10)),
      maxRedirects: optionalInt("SAFE_FETCH_MAX_REDIRECTS", 3),
      timeoutMs: optionalInt("SAFE_FETCH_TIMEOUT_MS", 10_000),
      maxResponseBytes: optionalInt("SAFE_FETCH_MAX_RESPONSE_BYTES", 5 * 1024 * 1024),
    },
    email: {
      provider: emailProvider,
      fromAddress: required("EMAIL_FROM_ADDRESS"),
      resendApiKey: process.env.RESEND_API_KEY,
      smtp:
        emailProvider === "smtp"
          ? {
              host: required("SMTP_HOST"),
              port: optionalInt("SMTP_PORT", 587),
              user: required("SMTP_USER"),
              pass: required("SMTP_PASS"),
            }
          : undefined,
    },
    ipHashSalt: required("IP_HASH_SALT"),
    appBaseUrl: required("APP_BASE_URL"),
  };
}
