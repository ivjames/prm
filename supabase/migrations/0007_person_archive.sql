-- 0007_person_archive — reversible hide for contacts.
--
-- Auto-ingestion imported bulk senders as contacts before the junk filter
-- existed. Rather than delete (destructive, and re-ingest would recreate them),
-- we archive: archived_at is set to hide a contact from the list while keeping
-- the row and its history, so it can be restored. The people list skips
-- archived contacts; their history and any cadence row are left intact.

alter table person add column if not exists archived_at timestamptz;
create index if not exists person_active_idx on person (owner_id) where archived_at is null;
