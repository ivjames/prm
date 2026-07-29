-- 0004_cadence — set-based recompute of "overdue" for the reminder engine.
--
-- next_due = last_contact + interval_days. Done in SQL so the worker recomputes
-- every cadence row in a single round trip instead of row-by-row. A person with
-- no recorded contact yet (last_contact is null) is due immediately, so a brand
-- new contact with a cadence surfaces as a reminder right away.

create or replace function recompute_cadence_due()
returns void
language sql
security definer
set search_path = public
as $$
  update cadence
     set next_due = case
                      when last_contact is null then now()
                      else last_contact + make_interval(days => interval_days)
                    end,
         updated_at = now();
$$;

-- Worker-only: the service role calls this on the cadence cron.
revoke all on function recompute_cadence_due() from public, anon, authenticated;
grant execute on function recompute_cadence_due() to service_role;
