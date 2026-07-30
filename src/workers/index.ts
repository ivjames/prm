import cron from "node-cron";
import { config, requireFor } from "../config";
import { logger } from "../lib/logger";
import { runIngestion, runCleanup } from "./ingest";
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
 *
 * Also runnable as a one-shot for manual/on-demand triggering, so you don't
 * have to wait for the next cron tick to test the pipeline (e.g. right after
 * connecting a Google account). The `prm` CLI wraps this:
 *
 *   node dist/workers/index.js --once [ingest|cadence ...]   # defaults to ingest
 *
 * Unlike the scheduler, one-shot mode does NOT swallow failures — a job that
 * throws exits non-zero so the caller (and `prm ingest`) sees the error.
 */
/**
 * A job's outcome. Jobs that isolate per-item failures (ingestion) don't throw
 * on a partial failure; they report `failed > 0` here instead, so one-shot mode
 * can still exit non-zero. Jobs with nothing to report resolve `void`.
 */
type JobResult = { failed?: number; accounts?: number } | void;

async function safe(name: string, fn: () => Promise<JobResult>) {
  const started = Date.now();
  try {
    await fn();
    log.info(`${name} cycle done`, { ms: Date.now() - started });
  } catch (err) {
    log.error(`${name} cycle failed`, { message: (err as Error).message });
  }
}

const JOBS: Record<string, () => Promise<JobResult>> = {
  ingest: runIngestion,
  cadence: runCadence,
  cleanup: runCleanup,
};

/**
 * Parse `--once [job ...]` out of argv. Returns the list of jobs to run once
 * (defaulting to just `ingest`), or null when no `--once` flag is present and
 * the process should start the long-running scheduler instead.
 */
function parseOnce(argv: string[]): string[] | null {
  const i = argv.indexOf("--once");
  if (i === -1) return null;
  const jobs = argv.slice(i + 1).filter((a) => !a.startsWith("-"));
  return jobs.length ? jobs : ["ingest"];
}

/** Run the requested jobs a single time, then let the process exit. */
async function runOnce(jobs: string[]): Promise<void> {
  requireFor("worker");
  for (const name of jobs) {
    const fn = JOBS[name];
    if (!fn) {
      log.error("unknown job", { job: name, known: Object.keys(JOBS) });
      process.exitCode = 2;
      continue;
    }
    const started = Date.now();
    try {
      log.info(`${name} (once) starting`);
      const result = await fn();
      // Jobs that isolate per-item failures resolve normally but report
      // `failed > 0`; surface that as a non-zero exit for one-shot callers.
      if (result && typeof result.failed === "number" && result.failed > 0) {
        log.error(`${name} (once) had account failures`, {
          failed: result.failed,
          accounts: result.accounts,
        });
        process.exitCode = 1;
      } else {
        log.info(`${name} (once) done`, { ms: Date.now() - started });
      }
    } catch (err) {
      log.error(`${name} (once) failed`, { message: (err as Error).message });
      process.exitCode = 1;
    }
  }
}

function main() {
  const once = parseOnce(process.argv.slice(2));
  if (once) {
    // One-shot: run and exit with whatever exitCode the jobs set (0 on success).
    void runOnce(once).then(() => process.exit(process.exitCode ?? 0));
    return;
  }

  requireFor("worker");
  log.info("prm-worker starting", { ingest: config.cron.ingest, cadence: config.cron.cadence });

  cron.schedule(config.cron.ingest, () => void safe("ingest", runIngestion));
  cron.schedule(config.cron.cadence, () => void safe("cadence", runCadence));

  // Kick one ingestion at boot so a fresh deploy doesn't sit idle until the
  // first cron tick.
  void safe("ingest", runIngestion);
}

main();
