import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";

/**
 * Two clients, two trust levels:
 *
 *  - service-role: SERVER ONLY. Bypasses RLS. Used by workers (ingestion,
 *    cadence) and any API path that legitimately acts across users. Never
 *    hand this key or a client built from it to the browser.
 *
 *  - anon: the key the web client uses. RLS does the per-user isolation, so
 *    this is safe to expose. On the server we mostly use it to act *as a
 *    specific user* by attaching their access token (see forUser).
 *
 * Caveat from architecture.md: this app is server-heavy, so most backend work
 * goes through the service-role client and bypasses the RLS/PostgREST value
 * prop. That's expected here — Supabase is buying us managed Postgres + auth.
 */

let _service: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error("serviceClient() requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!_service) {
    _service = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _service;
}

/**
 * A client scoped to a single end-user's JWT — RLS applies, so it can only
 * touch that user's rows. This is the right client for request handlers acting
 * on behalf of a logged-in user.
 */
export function forUser(accessToken: string): SupabaseClient {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error("forUser() requires SUPABASE_URL and SUPABASE_ANON_KEY");
  }
  return createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
