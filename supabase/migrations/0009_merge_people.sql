-- 0009_merge_people — atomically merge a duplicate person into a canonical one.
--
-- Fuzzy entity resolution surfaces likely-duplicate contacts (same human, two
-- email addresses); the owner confirms, then this repoints every reference from
-- the source person onto the target and deletes the source — all in one
-- transaction so there's never a half-merged state. Identifier values are unique
-- per owner, so repointing them never collides; interaction and cadence links
-- are de-duplicated on the way over.

create or replace function merge_people(p_target uuid, p_source uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_owner uuid;
  v_source_owner uuid;
begin
  if p_target = p_source then
    return;
  end if;

  select owner_id into v_target_owner from person where id = p_target;
  select owner_id into v_source_owner from person where id = p_source;
  if v_target_owner is null or v_source_owner is null then
    raise exception 'person not found';
  end if;
  if v_target_owner <> v_source_owner then
    raise exception 'cannot merge people across owners';
  end if;

  -- Identifiers: values are globally unique per owner, so no collision possible.
  update identifier set person_id = p_target where person_id = p_source;

  -- Interaction links: move, skipping interactions already linked to the target
  -- (would violate the (interaction_id, person_id) primary key), then drop dupes.
  update interaction_person ip
     set person_id = p_target
   where ip.person_id = p_source
     and not exists (
       select 1 from interaction_person t
        where t.interaction_id = ip.interaction_id and t.person_id = p_target
     );
  delete from interaction_person where person_id = p_source;

  update note set person_id = p_target where person_id = p_source;

  -- Cadence is one-per-person: keep the target's if it has one, else move source's.
  if exists (select 1 from cadence where person_id = p_target) then
    delete from cadence where person_id = p_source;
  else
    update cadence set person_id = p_target where person_id = p_source;
  end if;

  -- Prefer a real name: if the target is still named by an email but the source
  -- has a proper name, adopt it.
  update person tgt
     set name = src.name
    from person src
   where tgt.id = p_target and src.id = p_source
     and tgt.name like '%@%' and src.name not like '%@%';

  -- Union tags onto the target.
  update person tgt
     set tags = (select array(select distinct unnest(tgt.tags || src.tags))
                   from person src where src.id = p_source)
   where tgt.id = p_target;

  delete from person where id = p_source;
end;
$$;

revoke all on function merge_people(uuid, uuid) from public, anon, authenticated;
grant execute on function merge_people(uuid, uuid) to service_role;
