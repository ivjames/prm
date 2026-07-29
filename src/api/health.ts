import { Router } from "express";
import { serviceClient } from "../supabase";
import { config } from "../config";

export const healthRouter = Router();

// Liveness — no dependencies, always answers if the process is up.
healthRouter.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "prm-web" });
});

// Readiness — confirms the backend (Supabase) is reachable. Used by deploy
// smoke checks; degrades to 503 rather than throwing so nginx sees a clean
// status.
healthRouter.get("/readyz", async (_req, res) => {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    return res.status(503).json({ ok: false, reason: "supabase not configured" });
  }
  try {
    // Cheap round-trip: HEAD-style count on a small table.
    const { error } = await serviceClient().from("person").select("id", { count: "exact", head: true });
    if (error) throw error;
    res.json({ ok: true, backend: "supabase" });
  } catch (err) {
    res.status(503).json({ ok: false, reason: (err as Error).message });
  }
});
