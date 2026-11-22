-- 0002_get_cron_token | version 1.0
create or replace function public.get_cron_token()
returns text
language sql
security definer
set search_path = ''
as $$
  select value from private.app_config where key = 'cron_token';
$$;
revoke all on function public.get_cron_token() from public, anon, authenticated;
grant execute on function public.get_cron_token() to service_role;
