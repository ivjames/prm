import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import type { Request, Response } from "express";
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

/**
 * Cookie-based server session client (@supabase/ssr). The session lives in
 * httpOnly cookies that this client reads off the request and writes back onto
 * the response — including silent token refreshes. Like forUser(), it's bound
 * to one end-user and RLS applies, so it's the right client for authed request
 * handlers when the browser holds its session in cookies rather than sending a
 * bearer token.
 *
 * Must be created per-request (it closes over req/res). Any auth call that
 * rotates the session (sign-in, refresh, sign-out) appends Set-Cookie via the
 * adapter below, so call these before the response is sent.
 */
export function serverClient(req: Request, res: Response): SupabaseClient {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error("serverClient() requires SUPABASE_URL and SUPABASE_ANON_KEY");
  }
  return createServerClient(config.supabase.url, config.supabase.anonKey, {
    cookies: {
      getAll() {
        return parseCookieHeader(req.headers.cookie ?? "").map(({ name, value }) => ({
          name,
          value: value ?? "",
        }));
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          res.append("Set-Cookie", serializeCookieHeader(name, value, options));
        }
      },
    },
  });
}
