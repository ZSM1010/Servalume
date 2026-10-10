import pino from "pino";

/**
 * Structured logging with request/job correlation IDs (master spec §14).
 * Never pass secrets, tokens, or raw client IPs into `child()` bindings or
 * log calls — see docs/THREAT_MODEL.md §6.
 */
export const logger =
  process.env.NODE_ENV === "development"
    ? pino({
        level: process.env.LOG_LEVEL ?? "info",
        transport: { target: "pino-pretty", options: { colorize: true } },
      })
    : pino({ level: process.env.LOG_LEVEL ?? "info" });

export function jobLogger(jobName: string, jobId: string | null) {
  return logger.child({ jobName, jobId });
}
