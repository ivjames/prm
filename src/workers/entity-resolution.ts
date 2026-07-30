import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Entity resolution — the differentiating core (architecture.md). Maps a raw
 * handle (email/phone) seen in an ingested touchpoint to a canonical Person,
 * creating the Person + Identifier if this is the first time we've seen them.
 *
 * v1 strategy, in order:
 *   1. deterministic: exact match on a normalized identifier value.
 *   2. (later) fuzzy: name similarity when no identifier matches.
 *
 * Returns the resolved person_id. Uses the service-role client because it runs
 * in the worker across a known owner's data.
 */

export type IdentifierType = "email" | "phone" | "handle";

export function normalizeIdentifier(type: IdentifierType, raw: string): string {
  const v = raw.trim().toLowerCase();
  if (type === "phone") {
    // Keep digits and a leading +, drop formatting.
    const digits = v.replace(/[^\d+]/g, "");
    return digits;
  }
  return v;
}

export async function resolvePerson(
  db: SupabaseClient,
  ownerId: string,
  opts: { type: IdentifierType; value: string; displayName?: string },
): Promise<string> {
  const value = normalizeIdentifier(opts.type, opts.value);

  // 1. Deterministic match on an existing identifier.
  const { data: existing, error: findErr } = await db
    .from("identifier")
    .select("person_id")
    .eq("owner_id", ownerId)
    .eq("type", opts.type)
    .eq("value", value)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing?.person_id) {
    const pid = existing.person_id as string;
    // Backfill a real name onto a contact still named by their raw identifier
    // (early ingests had no display name). Never overwrites a proper name.
    if (opts.displayName && opts.displayName !== value) {
      const { data: p } = await db.from("person").select("name").eq("id", pid).single();
      if (p && typeof p.name === "string" && p.name.toLowerCase() === value.toLowerCase()) {
        await db.from("person").update({ name: opts.displayName }).eq("id", pid);
      }
    }
    return pid;
  }

  // 2. No match — create the canonical Person, then attach the identifier.
  const { data: person, error: pErr } = await db
    .from("person")
    .insert({ owner_id: ownerId, name: opts.displayName ?? value })
    .select("id")
    .single();
  if (pErr) throw pErr;

  const { error: iErr } = await db.from("identifier").insert({
    owner_id: ownerId,
    person_id: person.id,
    type: opts.type,
    value,
  });
  if (iErr) throw iErr;

  return person.id as string;
}
