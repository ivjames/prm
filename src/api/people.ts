import { Router, Response } from "express";
import { AuthedRequest, requireUser } from "./auth";

/**
 * People + their timeline. Everything goes through req.db (RLS-scoped to the
 * caller), so no handler here needs to filter by owner_id — the database does.
 */
export const peopleRouter = Router();

peopleRouter.use(requireUser);

// GET /api/people — list the caller's contacts, most-overdue first.
peopleRouter.get("/", async (req: AuthedRequest, res: Response, next) => {
  try {
    const { data, error } = await req
      .db!.from("person")
      .select("id, name, tags, next_due:cadence(next_due)")
      .order("name", { ascending: true });
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
      .select("id, name, tags, notes, details")
      .eq("id", id)
      .single();
    if (pErr) throw pErr;

    // Timeline joins through interaction_person (a single interaction can name
    // more than one person, so this is a join table, not an FK on interaction).
    const { data: timeline, error: tErr } = await req
      .db!.from("interaction")
      .select("id, source, direction, occurred_at, summary, interaction_person!inner(person_id)")
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
