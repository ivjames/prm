import { Router, Response } from "express";
import { randomUUID } from "node:crypto";
import { parseCookieHeader } from "@supabase/ssr";
import { AuthedRequest, requireUser } from "./auth";
import { serviceClient } from "../supabase";
import { authUrl, exchangeCode, userinfoEmail, isConfigured } from "../lib/google-oauth";

/**
 * Data-access connect flow: grant the app background read access to a user's
 * Gmail + Calendar. Distinct from login (that's Supabase Auth). The resulting
 * refresh token is stored encrypted in the vault via store_account_token
 * (service-role only), and account rows are created so the ingestion worker
 * knows what to poll.
 *
 * One Google consent grants both Gmail and Calendar, but they're separate
 * sources with independent sync cursors, so we create one account row per
 * provider (gmail, gcal) and store the token for each.
 */
export const connectRouter = Router();

const STATE_COOKIE = "prm_oauth_state";
const STATE_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/api/connect",
  maxAge: 10 * 60 * 1000, // 10 min
};

connectRouter.use(requireUser);

// GET /api/connect/google — kick off consent. CSRF-guarded via a state cookie.
connectRouter.get("/google", (req: AuthedRequest, res: Response) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: "google data-access OAuth not configured" });
  }
  const state = randomUUID();
  res.cookie(STATE_COOKIE, state, STATE_COOKIE_OPTS);
  res.redirect(authUrl(state));
});

// GET /api/connect/google/callback?code=…&state=… — finish consent.
connectRouter.get("/google/callback", async (req: AuthedRequest, res: Response, next) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: "google data-access OAuth not configured" });
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const cookies = parseCookieHeader(req.headers.cookie ?? "");
    const saved = cookies.find((c) => c.name === STATE_COOKIE)?.value;
    res.clearCookie(STATE_COOKIE, { path: "/api/connect" });

    if (!code) return res.status(400).json({ error: "missing code" });
    if (!state || state !== saved) return res.status(400).json({ error: "state mismatch" });

    const token = await exchangeCode(code);
    if (!token.refresh_token) {
      // Without offline access we can't ingest in the background. Usually means
      // a prior grant already issued the refresh token; prompt=consent avoids it.
      return res.status(400).json({
        error: "no refresh_token returned — revoke prior access at myaccount.google.com and retry",
      });
    }
    const email = await userinfoEmail(token.access_token);
    if (!email) return res.status(400).json({ error: "could not read account email" });

    // Upsert account rows + stash the token in the vault. Service-role: sets
    // owner_id explicitly and can call the vault RPC (denied to end users).
    const db = serviceClient();
    for (const provider of ["gmail", "gcal"] as const) {
      const { data: acct, error: aErr } = await db
        .from("account")
        .upsert(
          { owner_id: req.userId, provider, external_account_id: email, status: "active" },
          { onConflict: "owner_id,provider,external_account_id" },
        )
        .select("id")
        .single();
      if (aErr) throw aErr;
      const { error: tErr } = await db.rpc("store_account_token", {
        p_account_id: acct.id,
        p_token_json: JSON.stringify(token),
      });
      if (tErr) throw tErr;
    }

    res.redirect("/?connected=google");
  } catch (err) {
    next(err);
  }
});
