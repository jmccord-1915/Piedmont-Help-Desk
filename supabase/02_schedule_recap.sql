-- =====================================================================
-- Daily recap email at 5:00 AM Eastern.
-- Run AFTER the daily-recap Edge Function is deployed (see SETUP.md).
-- Replace the two placeholders before running.
--
-- pg_cron runs in UTC, so this fires at 09:00 and 10:00 UTC. The function
-- itself only sends when it is 5 AM in America/New_York, so exactly one
-- email goes out year-round (daylight saving included).
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('help-desk-daily-recap')
where exists (select 1 from cron.job where jobname = 'help-desk-daily-recap');

select cron.schedule(
  'help-desk-daily-recap',
  '0 9,10 * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/daily-recap',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body    := '{}'::jsonb
  );
  $$
);
