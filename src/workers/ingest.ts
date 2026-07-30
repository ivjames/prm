import { serviceClient } from "../supabase";
import { logger } from "../lib/logger";
import { resolvePerson, IdentifierType } from "./entity-resolution";
import { GoogleToken, refresh } from "../lib/google-oauth";

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
  summary: string; // subject / title — metadata only, not full bodies
  participants: { type: IdentifierType; value: string; displayName?: string }[];
}

interface Account {
  id: string;
  owner_id: string;
  provider: string;
  external_account_id: string;
  last_cursor: string | null;
}

// ---- token handling ----

/**
 * Return a valid access token for an account, refreshing (and re-storing) it if
 * it's within a minute of expiry. null if there's no usable token.
 */
async function freshAccessToken(account: Account): Promise<string | null> {
  const db = serviceClient();
  const { data, error } = await db.rpc("read_account_token", { p_account_id: account.id });
  if (error) throw error;
  if (!data) {
    log.warn("no stored token for account", { account: account.id });
    return null;
  }
  let token: GoogleToken = JSON.parse(data as string);
  if (Date.now() > token.expiry_ms - 60_000) {
    if (!token.refresh_token) {
      log.warn("token expired and no refresh_token", { account: account.id });
      return null;
    }
    token = await refresh(token.refresh_token);
    const { error: sErr } = await db.rpc("store_account_token", {
      p_account_id: account.id,
      p_token_json: JSON.stringify(token),
    });
    if (sErr) throw sErr;
  }
  return token.access_token;
}

// ---- provider fetch ----

async function gapi(url: string, accessToken: string): Promise<any> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`google api ${res.status} ${url.split("?")[0]}: ${await res.text()}`);
  return res.json();
}

function extractEmails(...headerValues: (string | undefined)[]): string[] {
  const joined = headerValues.filter(Boolean).join(",");
  const matches = joined.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? [];
  return [...new Set(matches.map((e) => e.toLowerCase()))];
}

const DEFAULT_LOOKBACK_S = 7 * 24 * 3600;

async function fetchGmail(account: Account, accessToken: string): Promise<RawTouchpoint[]> {
  const since = account.last_cursor
    ? Number(account.last_cursor)
    : Math.floor(Date.now() / 1000) - DEFAULT_LOOKBACK_S;
  const list = await gapi(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${encodeURIComponent(
      `after:${since}`,
    )}`,
    accessToken,
  );
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
  const out: RawTouchpoint[] = [];
  for (const id of ids) {
    const m = await gapi(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
        `&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`,
      accessToken,
    );
    const headers: Record<string, string> = Object.fromEntries(
      (m.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), h.value]),
    );
    const owner = account.external_account_id.toLowerCase();
    const ownerIsSender = extractEmails(headers.from).includes(owner);
    const participants = extractEmails(headers.from, headers.to, headers.cc)
      .filter((e) => e !== owner)
      .map((value) => ({ type: "email" as IdentifierType, value }));
    out.push({
      externalId: id,
      source: "gmail",
      direction: ownerIsSender ? "out" : "in",
      occurredAt: new Date(Number(m.internalDate)).toISOString(),
      summary: headers.subject ?? "(no subject)",
      participants,
    });
  }
  return out;
}

async function fetchCalendar(account: Account, accessToken: string): Promise<RawTouchpoint[]> {
  const params = new URLSearchParams({ singleEvents: "true", orderBy: "updated", maxResults: "25" });
  if (account.last_cursor) params.set("updatedMin", account.last_cursor);
  else params.set("timeMin", new Date(Date.now() - DEFAULT_LOOKBACK_S * 1000).toISOString());
  const res = await gapi(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    accessToken,
  );
  const owner = account.external_account_id.toLowerCase();
  const out: RawTouchpoint[] = [];
  for (const ev of res.items ?? []) {
    const when: string | undefined = ev.start?.dateTime ?? ev.start?.date;
    if (!when || ev.status === "cancelled") continue;
    const participants = (ev.attendees ?? [])
      .map((a: any) => String(a.email ?? "").toLowerCase())
      .filter((e: string) => e && e !== owner)
      .map((value: string) => ({ type: "email" as IdentifierType, value }));
    out.push({
      externalId: ev.id,
      source: "gcal",
      direction: "mutual",
      occurredAt: new Date(when).toISOString(),
      summary: ev.summary ?? "(untitled event)",
      participants,
    });
  }
  return out;
}

async function fetchTouchpoints(account: Account): Promise<RawTouchpoint[]> {
  const accessToken = await freshAccessToken(account);
  if (!accessToken) return [];
  if (account.provider === "gmail") return fetchGmail(account, accessToken);
  if (account.provider === "gcal") return fetchCalendar(account, accessToken);
  log.warn("no fetcher for provider", { provider: account.provider });
  return [];
}

/** The cursor value to persist after a successful poll of this provider. */
function nextCursor(provider: string): string {
  if (provider === "gmail") return String(Math.floor(Date.now() / 1000)); // epoch seconds for after:
  return new Date().toISOString(); // updatedMin for calendar
}

// ---- persistence ----

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

/**
 * Outcome of one ingestion pass. `failed` counts accounts that errored (and
 * were marked `status: "error"`). The scheduler ignores this — one bad account
 * shouldn't stop the loop — but one-shot callers (`prm ingest`) use `failed` to
 * exit non-zero so a smoke test surfaces the problem instead of reporting "done".
 */
export interface IngestSummary {
  accounts: number;
  ingested: number;
  failed: number;
}

/** Poll every connected account for its owner and ingest new touchpoints. */
export async function runIngestion(): Promise<IngestSummary> {
  const db = serviceClient();
  const { data: accounts, error } = await db
    .from("account")
    .select("id, owner_id, provider, external_account_id, last_cursor")
    .eq("status", "active");
  if (error) throw error;

  if (!accounts || accounts.length === 0) {
    log.info("no active accounts to ingest");
    return { accounts: 0, ingested: 0, failed: 0 };
  }

  let ingested = 0;
  let failed = 0;
  for (const account of accounts as Account[]) {
    try {
      const touchpoints = await fetchTouchpoints(account);
      for (const tp of touchpoints) {
        await persistTouchpoint(account.owner_id, tp);
      }
      // Advance the cursor only after a clean poll, so a mid-run failure re-polls.
      const { error: cErr } = await db
        .from("account")
        .update({ last_cursor: nextCursor(account.provider) })
        .eq("id", account.id);
      if (cErr) throw cErr;
      ingested += touchpoints.length;
      if (touchpoints.length > 0) {
        log.info("ingested touchpoints", {
          account: account.id,
          provider: account.provider,
          count: touchpoints.length,
        });
      }
    } catch (err) {
      // One bad account shouldn't stop the others; mark it and move on. The
      // failure is still reflected in the returned summary for one-shot callers.
      failed++;
      log.error("account ingest failed", { account: account.id, message: (err as Error).message });
      await db.from("account").update({ status: "error" }).eq("id", account.id);
    }
  }
  return { accounts: accounts.length, ingested, failed };
}
