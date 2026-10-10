import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createWorkerContext, registerJobHandlers } from "./queue.js";
import { runSchedulerTick } from "./scheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await createWorkerContext(config);
  await registerJobHandlers(ctx);

  logger.info({ workerConcurrency: config.workerConcurrency }, "worker started");

  let stopping = false;

  async function tick(): Promise<void> {
    if (stopping) return;
    try {
      const result = await runSchedulerTick(ctx.pool, ctx.boss, config.workerConcurrency * 5);
      if (result.dueCount > 0) {
        logger.info(result, "scheduler tick");
      }
    } catch (err) {
      logger.error({ err }, "scheduler tick failed");
    }
  }

  const intervalHandle = setInterval(tick, config.schedulerTickIntervalSeconds * 1000);
  await tick();

  async function shutdown(): Promise<void> {
    stopping = true;
    clearInterval(intervalHandle);
    logger.info("worker shutting down");
    await ctx.boss.stop();
    await ctx.pool.end();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
