-- 0001_init | version 1.0 | Job tracker phase 1 schema (spec v1.1)

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------- private config (never exposed through the API) ----------
create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table private.app_config (
  key text primary key,
  value text not null
);
insert into private.app_config (key, value)
values ('cron_token', encode(extensions.gen_random_bytes(32), 'hex'));

-- ---------- portals ----------
create table public.portals (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  website_url text not null,
  state text not null check (state in ('supported', 'coming_soon')),
  parser text,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

create table public.portal_senders (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.portals (id) on delete cascade,
  sender_address text not null,
  created_at timestamptz not null default now(),
  unique (portal_id, sender_address)
);

create table public.user_portals (
  user_id uuid not null references auth.users (id) on delete cascade,
  portal_id uuid not null references public.portals (id) on delete cascade,
  added_at timestamptz not null default now(),
  first_synced_at timestamptz,
  primary key (user_id, portal_id)
);

-- ---------- mail connection ----------
create table public.mail_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'gmail' check (provider in ('gmail')),
  email text not null,
  status text not null default 'active' check (status in ('active', 'needs_reconnect', 'error')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (user_id, provider, email)
);

create table public.mail_tokens (
  connection_id uuid primary key references public.mail_connections (id) on delete cascade,
  refresh_token_enc text not null,
  updated_at timestamptz not null default now()
);

create table public.mail_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  connection_id uuid not null references public.mail_connections (id) on delete cascade,
  provider_message_id text not null,
  sender text,
  subject text,
  received_at timestamptz,
  portal_id uuid references public.portals (id),
  parse_status text not null check (parse_status in ('parsed', 'skipped', 'failed')),
  skip_reason text,
  attempts int not null default 1,
  jobs_found int not null default 0,
  error text,
  raw_body text,
  created_at timestamptz not null default now(),
  unique (connection_id, provider_message_id)
);
create index mail_messages_user_status_idx on public.mail_messages (user_id, parse_status);

-- ---------- jobs ----------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  portal_id uuid not null references public.portals (id),
  external_job_id text,
  dedupe_key text not null,
  title text not null,
  company text not null,
  location text,
  job_url text not null,
  raw_url text,
  posted_at date,
  posted_text text,
  easy_apply boolean,
  jd_text text check (jd_text is null or char_length(jd_text) <= 50000),
  mail_message_id uuid references public.mail_messages (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count int not null default 1,
  status text not null default 'new'
    check (status in ('new', 'applied', 'screening', 'offered', 'rejected', 'ghosted', 'not_interested')),
  round_no int check (round_no is null or round_no >= 1),
  round_state text check (round_state is null or round_state in ('in_progress', 'completed')),
  status_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key),
  constraint screening_needs_round check (status <> 'screening' or (round_no is not null and round_state is not null)),
  constraint early_status_has_no_round check (status not in ('new', 'applied', 'not_interested') or (round_no is null and round_state is null))
);
create index jobs_user_status_idx on public.jobs (user_id, status, last_seen_at desc);

create table public.job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  from_status text,
  to_status text not null,
  from_round_no int,
  to_round_no int,
  from_round_state text,
  to_round_state text,
  cause text not null check (cause in ('system', 'user')),
  note text,
  created_at timestamptz not null default now()
);
create index job_events_job_idx on public.job_events (job_id, created_at);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trigger text not null check (trigger in ('first', 'manual', 'schedule', 'settings')),
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  mails_seen int not null default 0,
  mails_parsed int not null default 0,
  mails_skipped int not null default 0,
  mails_failed int not null default 0,
  jobs_added int not null default 0,
  jobs_seen_again int not null default 0,
  error text
);
create index sync_runs_user_idx on public.sync_runs (user_id, started_at desc);

-- ---------- job status rules and change log ----------
create or replace function public.jobs_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'screening' then
    if new.round_no is null then new.round_no := 1; end if;
    if new.round_state is null then new.round_state := 'in_progress'; end if;
  elsif new.status in ('new', 'applied', 'not_interested') then
    new.round_no := null;
    new.round_state := null;
  end if;

  if tg_op = 'UPDATE' and (
    new.status is distinct from old.status
    or new.round_no is distinct from old.round_no
    or new.round_state is distinct from old.round_state
  ) then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger jobs_before_write
before insert or update on public.jobs
for each row execute function public.jobs_before_write();

create or replace function public.jobs_log_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cause text := case when auth.uid() is null then 'system' else 'user' end;
begin
  if tg_op = 'INSERT' then
    insert into public.job_events (job_id, user_id, from_status, to_status, to_round_no, to_round_state, cause)
    values (new.id, new.user_id, null, new.status, new.round_no, new.round_state, 'system');
  elsif new.status is distinct from old.status
     or new.round_no is distinct from old.round_no
     or new.round_state is distinct from old.round_state then
    insert into public.job_events (
      job_id, user_id, from_status, to_status,
      from_round_no, to_round_no, from_round_state, to_round_state, cause
    ) values (
      new.id, new.user_id, old.status, new.status,
      old.round_no, new.round_no, old.round_state, new.round_state, v_cause
    );
  end if;
  return null;
end;
$$;

create trigger jobs_log_event
after insert or update on public.jobs
for each row execute function public.jobs_log_event();

-- ---------- functions used only by the mail sync (service role) ----------
create or replace function public.upsert_job(
  p_user_id uuid, p_portal_id uuid, p_external_job_id text, p_dedupe_key text,
  p_title text, p_company text, p_location text, p_job_url text, p_raw_url text,
  p_posted_at date, p_posted_text text, p_easy_apply boolean,
  p_mail_message_id uuid, p_seen_at timestamptz
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_inserted boolean;
begin
  insert into public.jobs (
    user_id, portal_id, external_job_id, dedupe_key, title, company, location,
    job_url, raw_url, posted_at, posted_text, easy_apply, mail_message_id,
    first_seen_at, last_seen_at
  ) values (
    p_user_id, p_portal_id, p_external_job_id, p_dedupe_key, p_title, p_company, p_location,
    p_job_url, p_raw_url, p_posted_at, p_posted_text, p_easy_apply, p_mail_message_id,
    coalesce(p_seen_at, now()), coalesce(p_seen_at, now())
  )
  on conflict (user_id, dedupe_key) do update set
    last_seen_at = greatest(public.jobs.last_seen_at, excluded.last_seen_at),
    first_seen_at = least(public.jobs.first_seen_at, excluded.first_seen_at),
    seen_count = public.jobs.seen_count + 1,
    location = coalesce(public.jobs.location, excluded.location),
    posted_at = coalesce(public.jobs.posted_at, excluded.posted_at),
    posted_text = coalesce(public.jobs.posted_text, excluded.posted_text),
    easy_apply = coalesce(public.jobs.easy_apply, excluded.easy_apply)
  returning (xmax = 0) into v_inserted;
  return v_inserted;
end;
$$;

create or replace function public.check_cron_token(p_token text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.app_config where key = 'cron_token' and value = p_token
  );
$$;

revoke all on function public.upsert_job(uuid, uuid, text, text, text, text, text, text, text, date, text, boolean, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.check_cron_token(text) from public, anon, authenticated;
revoke all on function public.jobs_before_write() from public, anon, authenticated;
revoke all on function public.jobs_log_event() from public, anon, authenticated;
grant execute on function public.upsert_job(uuid, uuid, text, text, text, text, text, text, text, date, text, boolean, uuid, timestamptz) to service_role;
grant execute on function public.check_cron_token(text) to service_role;

-- ---------- row level security ----------
alter table public.portals enable row level security;
alter table public.portal_senders enable row level security;
alter table public.user_portals enable row level security;
alter table public.mail_connections enable row level security;
alter table public.mail_tokens enable row level security;
alter table public.mail_messages enable row level security;
alter table public.jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.sync_runs enable row level security;

-- Start from nothing for browser roles, then grant exactly what the app needs.
revoke all on public.portals, public.portal_senders, public.user_portals, public.mail_connections,
  public.mail_tokens, public.mail_messages, public.jobs, public.job_events, public.sync_runs
  from anon, authenticated;

grant select on public.portals to authenticated;
create policy "portals readable by signed-in users" on public.portals
  for select to authenticated using (true);

-- portal_senders and mail_tokens: no grants, no policies. Service role only.

grant select, insert, delete on public.user_portals to authenticated;
create policy "own portal choices: read" on public.user_portals
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own portal choices: add supported only" on public.user_portals
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.portals p where p.id = portal_id and p.state = 'supported')
  );
create policy "own portal choices: remove" on public.user_portals
  for delete to authenticated using (user_id = (select auth.uid()));

grant select on public.mail_connections to authenticated;
create policy "own mail connection: read" on public.mail_connections
  for select to authenticated using (user_id = (select auth.uid()));

-- mail_messages: every column except raw_body
grant select (id, user_id, connection_id, provider_message_id, sender, subject, received_at,
  portal_id, parse_status, skip_reason, attempts, jobs_found, error, created_at)
  on public.mail_messages to authenticated;
create policy "own mails: read" on public.mail_messages
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.jobs to authenticated;
grant update (status, round_no, round_state, jd_text) on public.jobs to authenticated;
create policy "own jobs: read" on public.jobs
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own jobs: update" on public.jobs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select on public.job_events to authenticated;
create policy "own job events: read" on public.job_events
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.sync_runs to authenticated;
create policy "own sync runs: read" on public.sync_runs
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------- seed portals ----------
insert into public.portals (key, name, website_url, state, parser, sort_order) values
  ('linkedin', 'LinkedIn', 'https://www.linkedin.com/jobs', 'supported', 'linkedin', 10),
  ('cutshort', 'Cutshort', 'https://cutshort.io', 'supported', 'cutshort', 20),
  ('naukri', 'Naukri', 'https://www.naukri.com', 'coming_soon', null, 30),
  ('indeed', 'Indeed', 'https://www.indeed.com', 'coming_soon', null, 40),
  ('instahyre', 'Instahyre', 'https://www.instahyre.com', 'coming_soon', null, 50),
  ('wellfound', 'Wellfound', 'https://wellfound.com', 'coming_soon', null, 60),
  ('foundit', 'Foundit', 'https://www.foundit.in', 'coming_soon', null, 70),
  ('iimjobs', 'iimjobs', 'https://www.iimjobs.com', 'coming_soon', null, 80),
  ('hirist', 'Hirist', 'https://www.hirist.tech', 'coming_soon', null, 90);

insert into public.portal_senders (portal_id, sender_address)
select id, s from public.portals, unnest(array['jobalerts-noreply@linkedin.com', 'jobs-noreply@linkedin.com']) s
where key = 'linkedin';
insert into public.portal_senders (portal_id, sender_address)
select id, 'notify@cutshort.io' from public.portals where key = 'cutshort';

-- ---------- schedules ----------
select cron.schedule(
  'job-tracker-sync-all',
  '7 */2 * * *',
  $cron$
  select net.http_post(
    url := 'https://ytqglyyzmoceymnqrcxc.supabase.co/functions/v1/sync-mail',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-token', (select value from private.app_config where key = 'cron_token')
    ),
    body := '{"all": true}'::jsonb,
    timeout_milliseconds := 10000
  );
  $cron$
);

select cron.schedule(
  'job-tracker-purge-raw-mail',
  '23 3 * * *',
  $cron$
  update public.mail_messages set raw_body = null
  where raw_body is not null and created_at < now() - interval '30 days';
  $cron$
);
