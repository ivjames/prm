import { serviceClient } from "../supabase";
import { logger } from "../lib/logger";
import { resolvePerson, IdentifierType } from "./entity-resolution";

const log = logger("ingest");

/**
 * One normalized touchpoint pulled from a provider, before entity resolution.
 * Providers (Gmail, Calendar, later MS Graph) each map their payloads to this
 * shape; the rest of the pipeline is provider-agnostic.
 */
export interface RawTouchpoint {
  externalId: string; // provider's stable id, for idempotent upsert
  source: "gmail" | "gcal" | "graph";
  direction: "in" | "out" | "mutual";
  occurredAt: string; // ISO
  summary: string; // subject / event title — metadata only, not full bodies
  participants: { type: IdentifierType; value: string; displayName?: string }[];
}

/**
 * Provider fetch. Real implementation pulls new messages/events since the
 * account's last cursor using the OAuth token from the encrypted vault.
 *
 * NOT wired yet: needs GOOGLE_OAUTH credentials + the vault read path (see
 * migrations 0003 and DEPLOY.md). Returns [] so the pipeline below is
 * exercisable end-to-end the moment an account + token exist.
 */
async function fetchNewTouchpoints(account: {
  id: string;
  owner_id: string;
  provider: string;
}): Promise<RawTouchpoint[]> {
  log.info("provider fetch not yet wired; skipping account", {
    account: account.id,
    provider: account.provider,
  });
  return [];
}

/**
 * Persist a touchpoint: resolve every participant to a canonical Person, write
 * the Interaction, then link them via the interaction_person join table. Keyed
 * on (source, external_id) so re-polling is idempotent.
 */
async function persistTouchpoint(ownerId: string, tp: RawTouchpoint): Promise<void> {
  const db = serviceClient();

  const personIds: string[] = [];
  for (const p of tp.participants) {
    personIds.push(await resolvePerson(db, ownerId, p));
  }

  const { data: interaction, error: iErr } = await db
    .from("interaction")
    .upsert(
      {
        owner_id: ownerId,
        source: tp.source,
        external_id: tp.externalId,
        direction: tp.direction,
        occurred_at: tp.occurredAt,
        summary: tp.summary,
      },
      { onConflict: "owner_id,source,external_id" },
    )
    .select("id")
    .single();
  if (iErr) throw iErr;

  if (personIds.length > 0) {
    const rows = personIds.map((pid) => ({
      owner_id: ownerId,
      interaction_id: interaction.id,
      person_id: pid,
    }));
    const { error: linkErr } = await db
      .from("interaction_person")
      .upsert(rows, { onConflict: "interaction_id,person_id" });
    if (linkErr) throw linkErr;

    // Touching a person resets their cadence clock.
    const { error: cadErr } = await db
      .from("cadence")
      .update({ last_contact: tp.occurredAt })
      .in("person_id", personIds)
      .lt("last_contact", tp.occurredAt);
    if (cadErr) throw cadErr;
  }
}

/** Poll every connected account for its owner and ingest new touchpoints. */
export async function runIngestion(): Promise<void> {
  const db = serviceClient();
  const { data: accounts, error } = await db
    .from("account")
    .select("id, owner_id, provider")
    .eq("status", "active");
  if (error) throw error;

  if (!accounts || accounts.length === 0) {
    log.info("no active accounts to ingest");
    return;
  }

  for (const account of accounts) {
    const touchpoints = await fetchNewTouchpoints(account);
    for (const tp of touchpoints) {
      await persistTouchpoint(account.owner_id, tp);
    }
    if (touchpoints.length > 0) {
      log.info("ingested touchpoints", { account: account.id, count: touchpoints.length });
    }
  }
}
