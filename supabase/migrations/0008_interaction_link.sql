-- 0008_interaction_link — deep link to open a touchpoint in its provider.
--
-- The timeline stores metadata only, but each interaction has a stable
-- provider id, so we can keep a direct link to open the original message/event:
-- Gmail messages resolve via mail.google.com/#all/<id>, calendar events via the
-- API's htmlLink. Populated at ingestion; the web timeline makes each row a link.

alter table interaction add column if not exists link text;

-- Backfill links for already-ingested Gmail interactions (constructible from the
-- stored message id). Calendar htmlLinks are filled in on the next poll/backfill.
update interaction
   set link = 'https://mail.google.com/mail/u/0/#all/' || external_id
 where source = 'gmail' and external_id is not null and link is null;
