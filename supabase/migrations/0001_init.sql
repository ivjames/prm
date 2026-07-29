-- 0001_init — core schema.
--
-- Data model (locked in, see HANDOFF.md / docs/architecture.md):
--   account · person · identifier · interaction · interaction_person · note · cadence
--
-- Every table carries owner_id (the Supabase auth user who owns the row) so the
-- same schema serves a single owner today and a few private users later with no
-- rework. owner_id defaults to auth.uid() for client inserts; the service-role
-- worker supplies it explicitly (auth.uid() is null under the service role).
-- RLS policies live in 0002.

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- Keep updated_at honest without app-side bookkeeping.
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---- account: a connected source (Gmail, Calendar, later MS Graph) ----
create table if not exists account (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider             text not null check (provider in ('gmail', 'gcal', 'graph')),
  external_account_id  text not null,               -- provider's account id / email
  status               text not null default 'active' check (status in ('active', 'paused', 'error')),
  token_secret_id      uuid,                         -- -> vault secret (set in 0003)
  last_cursor          text,                         -- sync cursor / historyId
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (owner_id, provider, external_account_id)
);
create trigger account_set_updated_at before update on account
  for each row execute function set_updated_at();

-- ---- person: the canonical human ----
create table if not exists person (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  tags        text[] not null default '{}',
  notes       text,
  details     jsonb not null default '{}',           -- freeform personal details
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger person_set_updated_at before update on person
  for each row execute function set_updated_at();
create index if not exists person_owner_idx on person (owner_id);

-- ---- identifier: handles that resolve to a person ----
create table if not exists identifier (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  person_id   uuid not null references person(id) on delete cascade,
  type        text not null check (type in ('email', 'phone', 'handle')),
  value       text not null,                          -- stored normalized (lowercased, etc.)
  created_at  timestamptz not null default now(),
  unique (owner_id, type, value)                      -- deterministic resolution key
);
create index if not exists identifier_person_idx on identifier (person_id);

-- ---- interaction: one touchpoint (auto-ingested or manual) ----
create table if not exists interaction (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source       text not null check (source in ('gmail', 'gcal', 'graph', 'manual', 'voice')),
  external_id  text,                                  -- provider id; null for manual/voice
  direction    text not null default 'mutual' check (direction in ('in', 'out', 'mutual')),
  occurred_at  timestamptz not null,
  summary      text,                                  -- subject / title / one-liner (metadata, not bodies)
  created_at   timestamptz not null default now()
);
create index if not exists interaction_owner_time_idx on interaction (owner_id, occurred_at desc);
-- Idempotent re-polling: a provider touchpoint is unique per (owner, source, external_id).
create unique index if not exists interaction_external_uniq
  on interaction (owner_id, source, external_id) where external_id is not null;

-- ---- interaction_person: join (an interaction can name multiple people) ----
-- Deliberately a join table, not a person_id FK on interaction — a single voice
-- capture can name several people. Built in from day one on purpose.
create table if not exists interaction_person (
  interaction_id  uuid not null references interaction(id) on delete cascade,
  person_id       uuid not null references person(id) on delete cascade,
  owner_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  primary key (interaction_id, person_id)
);
create index if not exists interaction_person_person_idx on interaction_person (person_id);

-- ---- note: free / voice-captured context ----
-- person_id is nullable: capture-flow.md's "no identifiable person" path can
-- produce a note attached to nobody (pending the owner's confirmation of that
-- escape hatch — see HANDOFF open items).
create table if not exists note (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  person_id   uuid references person(id) on delete cascade,
  body        text not null,
  source      text not null default 'manual' check (source in ('voice', 'manual')),
  created_at  timestamptz not null default now()
);
create index if not exists note_person_idx on note (person_id);

-- ---- cadence: desired contact frequency per person ----
create table if not exists cadence (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  person_id     uuid not null references person(id) on delete cascade,
  interval_days int not null check (interval_days > 0),
  last_contact  timestamptz,
  next_due      timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (person_id)                                  -- one cadence per person
);
create trigger cadence_set_updated_at before update on cadence
  for each row execute function set_updated_at();
create index if not exists cadence_owner_due_idx on cadence (owner_id, next_due);
