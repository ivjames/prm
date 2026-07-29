import { serviceClient } from "../supabase";
import { logger } from "../lib/logger";

const log = logger("cadence");

/**
 * Cadence engine — what makes this a PRM and not an address book. For every
 * cadence row, compute next_due = last_contact + interval, and surface the
 * ones that are overdue as reminders.
 *
 * The heavy lifting (interval math, overdue flagging) is a SQL function
 * (recompute_cadence_due, migration 0004) so it runs set-based in one round
 * trip rather than row-by-row here. This worker invokes it, then reads back
 * what's newly overdue to fire push (push wiring is a later phase).
 */
export async function runCadence(): Promise<void> {
  const db = serviceClient();

  // Recompute next_due for all cadence rows from last_contact + interval.
  const { error: rpcErr } = await db.rpc("recompute_cadence_due");
  if (rpcErr) throw rpcErr;

  // Pull what's now overdue and not yet reminded this cycle.
  const { data: overdue, error } = await db
    .from("cadence")
    .select("id, owner_id, person_id, next_due, person:person(name)")
    .lte("next_due", new Date().toISOString())
    .order("next_due", { ascending: true });
  if (error) throw error;

  if (!overdue || overdue.length === 0) {
    log.info("no contacts overdue");
    return;
  }

  log.info("contacts overdue", { count: overdue.length });

  // TODO (cadence/push phase): dedupe against already-sent reminders, rank via
  // the Sonnet priority digest, then deliver through APNs/FCM. For now the
  // overdue set is queryable by the client, which is enough for a working v1
  // reminders view.
}
