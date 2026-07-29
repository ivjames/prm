-- 0002_rls — row-level security, on from day one.
--
-- Rationale (HANDOFF locked-in decision): per-user isolation is cheap now and
-- expensive to retrofit. Even as a single-owner tool, every table is RLS-gated
-- so "just me" and "a few private users" are the same schema.
--
-- Model: a row is visible/writable only to its owner. owner_id = auth.uid().
-- The service-role client (workers) bypasses RLS entirely, which is why the
-- worker code always sets owner_id explicitly.

alter table account            enable row level security;
alter table person             enable row level security;
alter table identifier         enable row level security;
alter table interaction        enable row level security;
alter table interaction_person enable row level security;
alter table note               enable row level security;
alter table cadence            enable row level security;

-- One owner-scoped policy per table covering all commands. USING gates
-- read/update/delete visibility; WITH CHECK gates what INSERT/UPDATE may write.
do $$
declare t text;
begin
  foreach t in array array[
    'account', 'person', 'identifier', 'interaction',
    'interaction_person', 'note', 'cadence'
  ]
  loop
    execute format('drop policy if exists owner_all on %I', t);
    execute format(
      'create policy owner_all on %I
         for all
         to authenticated
         using (owner_id = auth.uid())
         with check (owner_id = auth.uid())',
      t
    );
  end loop;
end $$;
