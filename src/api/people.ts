import { Router, Response } from "express";
import { AuthedRequest, requireUser } from "./auth";
import { aiConfigured, summarizeRelationship } from "../lib/anthropic";

/**
 * People + their timeline. Everything goes through req.db (RLS-scoped to the
 * caller), so no handler here needs to filter by owner_id — the database does.
 */
export const peopleRouter = Router();

peopleRouter.use(requireUser);

// GET /api/people — list the caller's contacts. Active only by default;
// ?archived=1 returns the archived (hidden) ones so they can be reviewed/restored.
peopleRouter.get("/", async (req: AuthedRequest, res: Response, next) => {
  try {
    const archived = req.query.archived === "1";
    let q = req
      .db!.from("person")
      .select("id, name, tags, next_due:cadence(next_due)")
      .order("name", { ascending: true });
    q = archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ people: data ?? [] });
  } catch (err) {
    next(err);
  }
});

// GET /api/people/:id — one contact plus their interaction timeline.
peopleRouter.get("/:id", async (req: AuthedRequest, res: Response, next) => {
  try {
    const { id } = req.params;
    const { data: person, error: pErr } = await req
      .db!.from("person")
      .select("id, name, tags, notes, details, summary, archived_at, cadence(interval_days, next_due, last_contact)")
      .eq("id", id)
      .single();
    if (pErr) throw pErr;

    // Timeline joins through interaction_person (a single interaction can name
    // more than one person, so this is a join table, not an FK on interaction).
    const { data: timeline, error: tErr } = await req
      .db!.from("interaction")
      .select("id, source, direction, occurred_at, summary, link, interaction_person!inner(person_id)")
      .eq("interaction_person.person_id", id)
      .order("occurred_at", { ascending: false })
      .limit(100);
    if (tErr) throw tErr;

    res.json({ person, timeline: timeline ?? [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/people — create a contact by hand. owner_id is set by a DB default
// (auth.uid()), so the client never supplies it.
peopleRouter.post("/", async (req: AuthedRequest, res: Response, next) => {
  try {
    const { name, tags, notes } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    const { data, error } = await req
      .db!.from("person")
      .insert({ name, tags: tags ?? [], notes: notes ?? null })
      .select("id, name, tags")
      .single();
    if (error) throw error;
    res.status(201).json({ person: data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/people/:id/cadence { interval_days } — set/change how often to keep
// in touch. Seeds last_contact from the most recent interaction and computes
// next_due right away so the overdue/soon badge reflects it without waiting for
// the hourly cadence cron. RLS scopes everything to the caller.
peopleRouter.put("/:id/cadence", async (req: AuthedRequest, res: Response, next) => {
  try {
    const { id } = req.params;
    const interval = Number(req.body?.interval_days);
    if (!Number.isInteger(interval) || interval <= 0) {
      return res.status(400).json({ error: "interval_days must be a positive integer" });
    }

    // Confirm the person is the caller's (RLS would also block, but 404 is clearer).
    const { data: person, error: pErr } = await req.db!.from("person").select("id").eq("id", id).maybeSingle();
    if (pErr) throw pErr;
    if (!person) return res.status(404).json({ error: "person not found" });

    // Most recent touchpoint seeds the cadence clock.
    const { data: last, error: lErr } = await req
      .db!.from("interaction")
      .select("occurred_at, interaction_person!inner(person_id)")
      .eq("interaction_person.person_id", id)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lErr) throw lErr;

    const lastContact: string | null = last?.occurred_at ?? null;
    const base = lastContact ? new Date(lastContact).getTime() : Date.now();
    const nextDue = new Date(base + interval * 86_400_000).toISOString();

    const { data, error } = await req
      .db!.from("cadence")
      .upsert(
        { person_id: id, interval_days: interval, last_contact: lastContact, next_due: nextDue },
        { onConflict: "person_id" },
      )
      .select("interval_days, next_due, last_contact")
      .single();
    if (error) throw error;
    res.json({ cadence: data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/people/:id/cadence — stop tracking a contact's cadence.
peopleRouter.delete("/:id/cadence", async (req: AuthedRequest, res: Response, next) => {
  try {
    const { id } = req.params;
    const { error } = await req.db!.from("cadence").delete().eq("person_id", id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/people/:id/archive — hide a contact (reversible). POST .../unarchive
// restores it. Junk that slipped in can be tucked away without losing history.
peopleRouter.post("/:id/archive", async (req: AuthedRequest, res: Response, next) => {
  try {
    const { error } = await req
      .db!.from("person")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

peopleRouter.post("/:id/unarchive", async (req: AuthedRequest, res: Response, next) => {
  try {
    const { error } = await req.db!.from("person").update({ archived_at: null }).eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/people/:id/summarize — (re)generate the cached Haiku relationship
// summary from this contact's interaction metadata. Explicit user action so
// there's no surprise API cost; the result is cached on the person row and the
// GET endpoint serves it without re-calling the model (summarize once, cache).
peopleRouter.post("/:id/summarize", async (req: AuthedRequest, res: Response, next) => {
  try {
    if (!aiConfigured()) {
      return res.status(503).json({ error: "AI summarization not configured (set ANTHROPIC_API_KEY)" });
    }
    const { id } = req.params;
    const { data: person, error: pErr } = await req
      .db!.from("person")
      .select("id, name")
      .eq("id", id)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!person) return res.status(404).json({ error: "person not found" });

    const { data: rows, error: rErr } = await req
      .db!.from("interaction")
      .select("source, direction, occurred_at, summary, interaction_person!inner(person_id)")
      .eq("interaction_person.person_id", id)
      .order("occurred_at", { ascending: false })
      .limit(40);
    if (rErr) throw rErr;
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: "no interactions to summarize yet" });
    }

    const summary = await summarizeRelationship(person.name as string, rows as any);

    const { data, error } = await req
      .db!.from("person")
      .update({
        summary,
        summary_updated_at: new Date().toISOString(),
        summary_basis: rows.length,
      })
      .eq("id", id)
      .select("summary, summary_updated_at, summary_basis")
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});
