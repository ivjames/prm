import { Router, Response } from "express";
import type { Provider } from "@supabase/supabase-js";
import { AuthedRequest } from "./auth";
import { serverClient } from "../supabase";
import { config } from "../config";

/**
 * Cookie-session endpoints. Each builds a per-request @supabase/ssr client;
 * any successful auth call writes the session into httpOnly cookies via the
 * cookie adapter (see supabase.ts), so the browser is authenticated by cookie
 * from then on and handlers can use requireUser without a bearer token.
 */
export const sessionRouter = Router();

// POST /api/auth/signin { email, password } — password sign-in; sets cookies.
sessionRouter.post("/signin", async (req: AuthedRequest, res: Response, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const db = serverClient(req, res);
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    res.json({ user: { id: data.user?.id, email: data.user?.email } });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/login/:provider — start a login-OAuth flow (e.g. Google) from
// the server. The @supabase/ssr client generates the PKCE verifier and stashes
// it in a cookie (via the adapter) before we 302 to the provider; the verifier
// comes back on /callback for the code exchange. Login only — data-access
// scopes for Gmail/Calendar ingestion are a separate flow (see /api/connect).
const LOGIN_PROVIDERS = new Set<Provider>(["google"]);
sessionRouter.get("/login/:provider", async (req: AuthedRequest, res: Response, next) => {
  try {
    const provider = req.params.provider as Provider;
    if (!LOGIN_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: `unsupported provider: ${req.params.provider}` });
    }
    const db = serverClient(req, res);
    const { data, error } = await db.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${config.publicOrigin}/api/auth/callback`,
        skipBrowserRedirect: true,
      },
    });
    if (error || !data?.url) {
      return res.status(500).json({ error: error?.message ?? "could not start OAuth" });
    }
    res.redirect(data.url);
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/callback?code=…&next=/ — OAuth (e.g. Google) code exchange.
// Supabase redirects here after consent; we swap the code for a session,
// which sets the cookies, then bounce to an app-local path.
sessionRouter.get("/callback", async (req: AuthedRequest, res: Response, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const nextPath = typeof req.query.next === "string" && req.query.next.startsWith("/")
      ? req.query.next
      : "/";
    if (!code) return res.status(400).json({ error: "missing code" });
    const db = serverClient(req, res);
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (error) return res.status(401).json({ error: error.message });
    res.redirect(nextPath);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/signout — clears the session cookies.
sessionRouter.post("/signout", async (req: AuthedRequest, res: Response, next) => {
  try {
    const db = serverClient(req, res);
    await db.auth.signOut();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — current user from the cookie session (or 401).
sessionRouter.get("/me", async (req: AuthedRequest, res: Response, next) => {
  try {
    const db = serverClient(req, res);
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) return res.status(401).json({ error: "not authenticated" });
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    next(err);
  }
});
