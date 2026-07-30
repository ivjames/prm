import { NextFunction, Request, Response } from "express";
import { forUser, serverClient } from "../supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Express request augmented with the authenticated user and an RLS-scoped
 * Supabase client for that user. Handlers should read/write through req.db so
 * row-level security enforces per-user isolation automatically.
 */
export interface AuthedRequest extends Request {
  userId?: string;
  db?: SupabaseClient;
}

/**
 * Authenticates the request and attaches a user-scoped Supabase client (RLS
 * applies). Two supported credentials, cookie session preferred:
 *   1. cookie session (@supabase/ssr) — the browser's httpOnly session cookies.
 *   2. Authorization: Bearer <jwt> — for non-browser clients / API callers.
 * getUser() validates against the Auth server (not just a local decode), and
 * the cookie client refreshes + rewrites cookies on the response as needed.
 * 401s if neither credential is present or valid.
 */
export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.header("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  try {
    const db = bearer ? forUser(bearer) : serverClient(req, res);
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) {
      return res.status(401).json({ error: "not authenticated" });
    }
    req.userId = data.user.id;
    req.db = db;
    next();
  } catch (err) {
    next(err);
  }
}
