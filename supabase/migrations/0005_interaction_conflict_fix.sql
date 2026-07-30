-- 0005_interaction_conflict_fix — make the interaction dedupe index a valid
-- ON CONFLICT target.
--
-- 0001 created interaction_external_uniq as a PARTIAL unique index
-- (... where external_id is not null). The ingestion upsert infers its conflict
-- target by column list only (supabase-js `onConflict: "owner_id,source,external_id"`),
-- and Postgres will not match a partial index from a column-only ON CONFLICT
-- unless the index predicate is repeated — which the client can't express. So
-- every touchpoint insert failed with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- Fix: drop the partial index and recreate it non-partial. NULLs are distinct in
-- a unique index, so rows with a null external_id (manual/voice interactions)
-- still never collide — the original "only dedupe provider touchpoints" behavior
-- is preserved, while the index is now a valid column-only ON CONFLICT target.

drop index if exists interaction_external_uniq;
create unique index if not exists interaction_external_uniq
  on interaction (owner_id, source, external_id);
