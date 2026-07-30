import { serviceClient } from "../supabase";
import { config } from "../config";
import { logger } from "../lib/logger";
import { resolvePerson, IdentifierType } from "./entity-resolution";
import { GoogleToken, refresh } from "../lib/google-oauth";
import { isRoleAddress } from "../lib/addresses";

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

interface ParsedAddress {
  email: string;
  name?: string;
}

/**
 * Parse an RFC-5322 address-list header (From/To/Cc) into { email, name } pairs,
 * keeping the display name so contacts get a real name instead of just an email.
 * Handles `"Doe, Jane" <jane@x>`, `Jane Doe <jane@x>`, and bare `bob@x`.
 */
function parseAddresses(headerValue?: string): ParsedAddress[] {
  if (!headerValue) return [];
  const out: ParsedAddress[] = [];
  const seen = new Set<string>();
  // Named forms: optional "quoted" or unquoted display name, then <email>.
  const named = /(?:"([^"]*)"|([^,<]*))?\s*<\s*([^<>@\s]+@[^<>\s]+?)\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(headerValue))) {
    const email = m[3].trim().toLowerCase();
    const name = (m[1] ?? m[2] ?? "").trim().replace(/^['"]+|['"]+$/g, "").trim();
    if (!seen.has(email)) {
      seen.add(email);
      out.push({ email, name: name || undefined });
    }
  }
  // Bare emails with no angle brackets (deduped against the named ones above).
  for (const bare of headerValue.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []) {
    const email = bare.toLowerCase();
    if (!seen.has(email)) {
      seen.add(email);
      out.push({ email });
    }
  }
  return out;
}

/**
 * Collapse address entries from several headers into one participant list,
 * excluding the owner and preferring an entry that carries a display name.
 */
function toParticipants(owner: string, ...addrs: ParsedAddress[]): RawTouchpoint["participants"] {
  const byEmail = new Map<string, ParsedAddress>();
  for (const a of addrs) {
    if (!a.email || a.email === owner) continue;
    const prev = byEmail.get(a.email);
    if (!prev || (!prev.name && a.name)) byEmail.set(a.email, a);
  }
  return [...byEmail.values()].map((a) => ({
    type: "email" as IdentifierType,
    value: a.email,
    displayName: a.name,
  }));
}

const DEFAULT_LOOKBACK_S = 7 * 24 * 3600;

const GMAIL_META_HEADERS =
  "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject" +
  "&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Id&metadataHeaders=Precedence";
// Exclude Gmail's bulk categories at the query level (keeps Primary + all Sent).
const GMAIL_QUERY_FILTER = "-category:promotions -category:social -category:updates -category:forums";
const INCREMENTAL_MAX = 25; // messages/events per routine poll

/**
 * Convert one fetched Gmail metadata message to a touchpoint, or null if the
 * balanced junk filter rejects it (bulk/list headers, or no human counterpart).
 */
function gmailToTouchpoint(m: any, owner: string): RawTouchpoint | null {
  const headers: Record<string, string> = Object.fromEntries(
    (m.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), h.value]),
  );
  const precedence = (headers["precedence"] ?? "").toLowerCase();
  if (headers["list-unsubscribe"] || headers["list-id"] || ["bulk", "list", "junk"].includes(precedence)) {
    return null;
  }
  const from = parseAddresses(headers.from);
  const ownerIsSender = from.some((a) => a.email === owner);
  const participants = toParticipants(
    owner,
    ...from,
    ...parseAddresses(headers.to),
    ...parseAddresses(headers.cc),
  ).filter((p) => !isRoleAddress(p.value));
  if (participants.length === 0) return null;
  return {
    externalId: m.id,
    source: "gmail",
    direction: ownerIsSender ? "out" : "in",
    occurredAt: new Date(Number(m.internalDate)).toISOString(),
    summary: headers.subject ?? "(no subject)",
    participants,
  };
}

/**
 * Fetch Gmail from `sinceEpoch` (unix seconds), paging until `capMessages`
 * messages are examined, and return the ones that survive the junk filter.
 * capMessages bounds API calls: incremental passes a small cap, backfill a large one.
 */
async function fetchGmailMessages(
  accessToken: string,
  sinceEpoch: number,
  capMessages: number,
  owner: string,
): Promise<RawTouchpoint[]> {
  const out: RawTouchpoint[] = [];
  const q = encodeURIComponent(`after:${sinceEpoch} ${GMAIL_QUERY_FILTER}`);
  let pageToken: string | undefined;
  let fetched = 0;
  do {
    const pageSize = Math.min(100, capMessages - fetched);
    if (pageSize <= 0) break;
    const list = await gapi(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${pageSize}&q=${q}` +
        (pageToken ? `&pageToken=${pageToken}` : ""),
      accessToken,
    );
    for (const msg of (list.messages ?? []) as { id: string }[]) {
      const m = await gapi(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata${GMAIL_META_HEADERS}`,
        accessToken,
      );
      fetched++;
      const tp = gmailToTouchpoint(m, owner);
      if (tp) out.push(tp);
    }
    pageToken = list.nextPageToken;
  } while (pageToken && fetched < capMessages);
  return out;
}

/** Convert one calendar event to a touchpoint, or null if solo/cancelled. */
function calendarEventToTouchpoint(ev: any, owner: string): RawTouchpoint | null {
  const when: string | undefined = ev.start?.dateTime ?? ev.start?.date;
  if (!when || ev.status === "cancelled") return null;
  const attendees: ParsedAddress[] = (ev.attendees ?? []).map((a: any) => ({
    email: String(a.email ?? "").toLowerCase(),
    name: a.displayName || undefined,
  }));
  if (ev.organizer?.email) {
    attendees.push({ email: String(ev.organizer.email).toLowerCase(), name: ev.organizer.displayName || undefined });
  }
  const participants = toParticipants(owner, ...attendees).filter((p) => !isRoleAddress(p.value));
  if (participants.length === 0) return null;
  return {
    externalId: ev.id,
    source: "gcal",
    direction: "mutual",
    occurredAt: new Date(when).toISOString(),
    summary: ev.summary ?? "(untitled event)",
    participants,
  };
}

/** Incremental calendar poll — delta by updatedMin (cursor), single page. */
async function fetchCalendarIncremental(account: Account, accessToken: string): Promise<RawTouchpoint[]> {
  const params = new URLSearchParams({ singleEvents: "true", orderBy: "updated", maxResults: String(INCREMENTAL_MAX) });
  if (account.last_cursor) params.set("updatedMin", account.last_cursor);
  else params.set("timeMin", new Date(Date.now() - DEFAULT_LOOKBACK_S * 1000).toISOString());
  const res = await gapi(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    accessToken,
  );
  const owner = account.external_account_id.toLowerCase();
  return (res.items ?? [])
    .map((ev: any) => calendarEventToTouchpoint(ev, owner))
    .filter((tp: RawTouchpoint | null): tp is RawTouchpoint => tp !== null);
}

/** Paginate calendar events by start time from `timeMinIso`, up to `capEvents`. */
async function fetchCalendarSince(
  accessToken: string,
  timeMinIso: string,
  capEvents: number,
  owner: string,
): Promise<RawTouchpoint[]> {
  const out: RawTouchpoint[] = [];
  let pageToken: string | undefined;
  let fetched = 0;
  do {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(250, capEvents - fetched)),
      timeMin: timeMinIso,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await gapi(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      accessToken,
    );
    for (const ev of res.items ?? []) {
      fetched++;
      const tp = calendarEventToTouchpoint(ev, owner);
      if (tp) out.push(tp);
    }
    pageToken = res.nextPageToken;
  } while (pageToken && fetched < capEvents);
  return out;
}

async function fetchTouchpoints(account: Account): Promise<RawTouchpoint[]> {
  const accessToken = await freshAccessToken(account);
  if (!accessToken) return [];
  const owner = account.external_account_id.toLowerCase();
  if (account.provider === "gmail") {
    const since = account.last_cursor
      ? Number(account.last_cursor)
      : Math.floor(Date.now() / 1000) - DEFAULT_LOOKBACK_S;
    return fetchGmailMessages(accessToken, since, INCREMENTAL_MAX, owner);
  }
  if (account.provider === "gcal") return fetchCalendarIncremental(account, accessToken);
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

/**
 * One-shot historical backfill: pull a deep time window (config.backfill.days)
 * with pagination and the same junk filters, so past relationships populate.
 * Idempotent (interactions upsert on external_id), so it's safe to re-run and
 * it doesn't disturb the incremental cursor — routine polling continues from
 * wherever it was. Sequential per-message fetches mean a large window can take
 * a few minutes.
 */
export async function runBackfill(): Promise<void> {
  const db = serviceClient();
  const days = Math.max(1, config.backfill.days || 180);
  const cap = Math.max(1, config.backfill.maxPerSource || 2000);
  const sinceEpoch = Math.floor(Date.now() / 1000) - days * 86_400;
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data: accounts, error } = await db
    .from("account")
    .select("id, owner_id, provider, external_account_id, last_cursor")
    .eq("status", "active");
  if (error) throw error;
  if (!accounts || accounts.length === 0) {
    log.info("backfill: no active accounts");
    return;
  }

  log.info("backfill starting", { days, maxPerSource: cap });
  for (const account of accounts as Account[]) {
    try {
      const token = await freshAccessToken(account);
      if (!token) continue;
      const owner = account.external_account_id.toLowerCase();
      let tps: RawTouchpoint[] = [];
      if (account.provider === "gmail") tps = await fetchGmailMessages(token, sinceEpoch, cap, owner);
      else if (account.provider === "gcal") tps = await fetchCalendarSince(token, sinceIso, cap, owner);
      for (const tp of tps) await persistTouchpoint(account.owner_id, tp);
      log.info("backfill ingested", { account: account.id, provider: account.provider, count: tps.length });
    } catch (err) {
      log.error("backfill failed for account", { account: account.id, message: (err as Error).message });
    }
  }
  log.info("backfill done", { days });
}

/**
 * Bulk-archive contacts that are clearly automated/bulk senders — every one of
 * their identifiers looks like a role address (no-reply, notifications,
 * newsletters, receipts). Reversible: it sets archived_at, never deletes, and
 * leaves manually-added contacts (which have no identifiers) untouched.
 */
export async function runCleanup(): Promise<void> {
  const db = serviceClient();
  const { data: people, error } = await db
    .from("person")
    .select("id, name, identifier(value)")
    .is("archived_at", null);
  if (error) throw error;

  const junkIds = (people ?? [])
    .filter((p: any) => {
      const values: string[] = (p.identifier ?? []).map((i: any) => i.value);
      return values.length > 0 && values.every((v) => isRoleAddress(v));
    })
    .map((p: any) => p.id as string);

  if (junkIds.length === 0) {
    log.info("cleanup: no junk contacts to archive");
    return;
  }
  const { error: uErr } = await db
    .from("person")
    .update({ archived_at: new Date().toISOString() })
    .in("id", junkIds);
  if (uErr) throw uErr;
  log.info("cleanup: archived junk contacts", { count: junkIds.length });
}
