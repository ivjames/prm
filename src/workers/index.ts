import cron from "node-cron";
import { config, requireFor } from "../config";
import { logger } from "../lib/logger";
import { runIngestion } from "./ingest";
import { runCadence } from "./cadence";

const log = logger("worker");

/**
 * The prm-worker process. Runs alongside prm-web under pm2 (see
 * ecosystem.config.cjs) but binds no port — it only wakes on schedule.
 *
 *   - ingestion: poll connected Gmail/Calendar accounts for new touchpoints,
 *     resolve them to people, write interactions.
 *   - cadence:   recompute "overdue" per contact and fire reminders.
 *
 * A run that throws is logged and swallowed so one bad cycle never kills the
 * scheduler; the next tick tries again.
 */
async function safe(name: string, fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await fn();
    log.info(`${name} cycle done`, { ms: Date.now() - started });
  } catch (err) {
    log.error(`${name} cycle failed`, { message: (err as Error).message });
  }
}

function main() {
  requireFor("worker");
  log.info("prm-worker starting", { ingest: config.cron.ingest, cadence: config.cron.cadence });

  cron.schedule(config.cron.ingest, () => void safe("ingest", runIngestion));
  cron.schedule(config.cron.cadence, () => void safe("cadence", runCadence));

  // Kick one ingestion at boot so a fresh deploy doesn't sit idle until the
  // first cron tick.
  void safe("ingest", runIngestion);
}

main();
