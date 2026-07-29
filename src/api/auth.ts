import { NextFunction, Request, Response } from "express";
import { forUser } from "../supabase";
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
 * Verifies the Supabase access token from the Authorization header and attaches
 * a user-scoped client. 401s if the token is missing or invalid.
 */
export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.header("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return res.status(401).json({ error: "missing bearer token" });
  }
  try {
    const db = forUser(token);
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) {
      return res.status(401).json({ error: "invalid token" });
    }
    req.userId = data.user.id;
    req.db = db;
    next();
  } catch (err) {
    next(err);
  }
}
