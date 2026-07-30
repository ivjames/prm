-- 0006_person_summary — cached AI relationship summary per person.
--
-- The priority-digest/summarization work (architecture.md) is a real AI-cost
-- lever: summarize once and cache, never on every view. We cache a short Haiku
-- summary on the person row and only regenerate when new interactions arrive —
-- summary_basis records how many interactions the cached summary was built from,
-- so the app can tell when it's stale.

alter table person
  add column if not exists summary            text,
  add column if not exists summary_updated_at timestamptz,
  add column if not exists summary_basis      int;
