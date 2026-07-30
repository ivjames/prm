import { Router, Response } from "express";
import { AuthedRequest } from "./auth";
import { serverClient } from "../supabase";

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
