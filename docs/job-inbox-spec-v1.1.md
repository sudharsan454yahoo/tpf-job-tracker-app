<!-- job-inbox-spec | version 1.1 | 22 Nov 2026 | Phase 1: sign in, read job alert mails, show them in Inbox -->
<!--
CHANGELOG
v1.1 (22 Nov 2026)
  - Removed AI completely. Parsing is fixed rules only.
  - Job portals are now a user setting: multi-select from a portal list.
  - New status model: New, Applied, Screening (with round number and round state), Offered, Rejected, Ghosted. Later and Parked removed. "Not interested" added (see section 6, open point).
  - Scheduler (pg_cron) and token handling confirmed as written in v1.0.
v1.0 (22 Nov 2026)
  - First version.
-->

# Job Inbox: Phase 1 spec (v1.1)

Paste this whole file into Claude Code as the build brief. Save it in the repo as `docs/job-inbox-spec-v1.1.md`. Do not overwrite it on changes. Add `v1.2` next to it.

---

## 1. What we are building

A small web app for job seekers. The user signs in with Google, picks the job portals they use, and the app reads job alert mails from those portals in their Gmail (read only), pulls out each job, and shows all of them in one Inbox.

Phase 1 answers one question only: **can we reliably get every alerted job out of the mailbox and into one clean list?**

### In scope (Phase 1)
1. Sign in with Google.
2. Connect Gmail with read-only access.
3. Settings: pick job portals from a multi-select list.
4. Sync job alert mails: on first sign-in, on a "Sync now" button, and every 2 hours in the background.
5. Parse each mail into one or more jobs, using fixed rules.
6. Inbox screen with list view and card view.
7. A status on every job, set by the user, with a change log.
8. A JD text field on every job. Empty by default. The user can paste into it.

### Out of scope (later phases, do not build)
- Any AI or LLM call.
- Fetching the JD from the portal page.
- Fit scoring, gates, resume decision, streams.
- Telegram or any push message.
- Interview logging, prep, answer bank, post-mortems.
- Automatic status changes from company mails or timers (rejection, interview, offer, ghosted sweeps). In Phase 1 the user sets every status by hand.
- Yahoo, Outlook or any mailbox other than Gmail.
- Auto-apply. The user always clicks apply on the portal.
- Paid services, custom domain, mail forwarding.

---

## 2. Decisions already taken (do not re-open)

| # | Decision | Why |
|---|---|---|
| D1 | Gmail only | Yahoo has no public mail REST API. Not a Phase 1 job. |
| D2 | No AI anywhere | Fetching mail is a plain API call. Parsing is fixed rules per portal. A portal with no parser is simply not supported yet. |
| D3 | Portals are a user setting, chosen from a list we maintain | The user picks names. We own the sender addresses and parsers behind each name. The user never types a link or an address. |
| D4 | Google OAuth app stays in Testing mode | `gmail.readonly` is a restricted scope. Going public needs Google verification plus a yearly security assessment. Testing mode allows up to 100 named test users. |
| D5 | Frontend on GitHub Pages, everything else on Supabase | No paid services, no custom domain. |
| D6 | One sync code path, scheduled by `pg_cron` every 2 hours | The same Edge Function serves first sync, "Sync now" and the schedule. |
| D7 | Refresh token passes through the browser once, then is encrypted server-side | Accepted for Phase 1. |
| D8 | No mail bodies stored, except for failed parses | Privacy. Failed mails keep their HTML for 30 days so the parser can be fixed and re-run. |

---

## 3. Stack

- **Frontend:** React + Vite + TypeScript, static build, deployed to GitHub Pages by a GitHub Actions workflow. Mobile first.
- **Backend:** Supabase project `ytqglyyzmoceymnqrcxc` (region ap-southeast-2, Postgres 17).
  - Supabase Auth with the Google provider.
  - Postgres with Row Level Security on every table.
  - Edge Functions (Deno, TypeScript) for token storage and mail sync.
  - `pg_cron` + `pg_net` to call the sync function every 2 hours.
- **Secrets:** Edge Function secrets only. Nothing secret in the frontend bundle or the repo. The Supabase anon/publishable key is the only key allowed in the browser.

Before using any Supabase or Google API, read the current docs. Do not guess function names, parameters or routes.

---

## 4. Sign-in and Gmail connection

### Flow
1. User clicks "Continue with Google".
2. Call `supabase.auth.signInWithOAuth` with provider `google`, scope `https://www.googleapis.com/auth/gmail.readonly`, and query params `access_type=offline` and `prompt=consent`.
3. On return, the session holds `provider_refresh_token` once. Supabase does not keep it. The frontend must immediately POST it to the Edge Function `connect-mail`.
4. `connect-mail` checks the user's JWT, encrypts the refresh token (AES-GCM, key in secret `TOKEN_ENC_KEY`), stores it in `mail_tokens`, and upserts `mail_connections`.
5. Frontend removes the token from memory.
6. First time only: show the portal picker (section 5). On save, start the first sync and open the Inbox with a "Syncing your mail" state.

### Rules
- Ask for `gmail.readonly` and nothing more. The app never sends, deletes, labels or marks mail as read.
- The refresh token is never written to localStorage, logs or any table the browser can read.
- If Google returns no refresh token, show "Connect Gmail again" and re-run consent.
- If a token refresh fails with `invalid_grant`, set the connection to `needs_reconnect` and show a banner. In Testing mode Google expires refresh tokens after 7 days, so this will happen weekly. Build the banner, do not treat it as an edge case.
- A user who is not on the Google test-user list gets `access_denied`. Show a plain message: "This app is in private testing. Ask for access."
- GitHub Pages serves a static site. Use hash routing or a `404.html` fallback so the OAuth redirect lands correctly. Add the Pages URL and `http://localhost:5173` to Supabase Auth redirect URLs.

---

## 5. Job portals (setting)

### How it works
- We keep a **portal list** in the database. Each portal has a name, a website link, one or more sender addresses, a parser, and a state: `supported` or `coming_soon`.
- The user sees a multi-select dropdown of portal names in Settings and on first sign-in.
- `supported` portals can be ticked. `coming_soon` portals are shown greyed out with the label "Coming soon" and cannot be ticked.
- On first sign-in, all supported portals are ticked by default. The user must keep at least one.
- The sync reads mail only from the sender addresses of the portals the user ticked.

### Changing the selection
- **Adding a portal:** the next sync looks back 14 days for that portal only.
- **Removing a portal:** no more mail is read from it. Jobs already in the Inbox stay.
- Saving the setting with a change starts a sync straight away.

### Portal list (seed data)
Sender addresses below were read from a real inbox on 22 Nov 2026. Confirm each against the fixtures before relying on it.

| Portal | Website | Sender addresses | State |
|---|---|---|---|
| LinkedIn | linkedin.com/jobs | `jobalerts-noreply@linkedin.com`, `jobs-noreply@linkedin.com` | supported |
| Cutshort | cutshort.io | `notify@cutshort.io` | supported |
| Naukri | naukri.com | not confirmed | coming_soon |
| Indeed | indeed.com | not confirmed | coming_soon |
| Instahyre | instahyre.com | not confirmed | coming_soon |
| Wellfound | wellfound.com | not confirmed | coming_soon |
| Foundit | foundit.in | not confirmed | coming_soon |
| iimjobs | iimjobs.com | not confirmed | coming_soon |
| Hirist | hirist.tech | not confirmed | coming_soon |

Do not invent a sender address. A portal moves to `supported` only when three things exist: a captured fixture mail, the confirmed sender address, and a parser that passes its tests. That is one database row plus one parser file, no other code change.

---

## 6. Job status

### Statuses
| Status | Meaning | Extra fields |
|---|---|---|
| New | Came in from an alert. Nothing done yet. | |
| Applied | User applied on the portal. | |
| Screening | In the interview process. | `round_no` (1, 2, 3 ...) and `round_state` (`in_progress` or `completed`) |
| Offered | Offer received. | |
| Rejected | Company said no. | keeps the last `round_no`, so "rejected after Screening 2" is visible |
| Ghosted | No reply. | keeps the last `round_no` |
| Not interested | User dismissed the job. | |

On screen, Screening reads as "Screening 1 in progress", "Screening 1 completed", "Screening 2 in progress" and so on.

### Rules
- The user sets every status by hand. Nothing changes a status automatically in Phase 1.
- Any status can be changed to any other. People make mistakes and processes skip steps.
- Choosing Screening for the first time sets round 1, in progress. From there the user can mark the round completed, or start the next round (round number plus 1, in progress).
- `round_no` and `round_state` are empty for New, Applied and Not interested.
- Every change of status, round number or round state writes one row to `job_events` through a database trigger, so the log cannot be skipped by the frontend. The row created at insert is `null -> new`, cause `system`.
- Undo puts the previous values back and writes its own event. Nothing is deleted.

### Open point for the owner
"Not interested" was not in the owner's list. It is added because, without it, a job the user does not want can never leave the New tab, and New stops being useful within days. If the owner says no, remove this status and nothing else changes.

---

## 7. Mail sync

### Edge Function `sync-mail`
Input: a user JWT (syncs that user) or the service key with a `user_id` (used by the scheduler).

Steps per user:
1. Open a `sync_runs` row.
2. Get a Gmail access token from the stored refresh token.
3. Build the sender list from the user's ticked portals. List messages with a Gmail search query:
   - First sync, or a portal just added: `from:(<sender addresses>) newer_than:14d`
   - Later syncs: same senders, `after:<last_synced_at minus 1 day>` as a safety overlap.
4. Skip any message id already in `mail_messages` with status `parsed` or `skipped`.
5. For each new message: fetch it, pick the HTML part, classify it, parse it, upsert jobs, write the `mail_messages` row.
6. Close the `sync_runs` row with counts.

Limits:
- Process at most 50 mails per invocation. If more remain, the function calls itself again for the same user until done or 500 mails per sync.
- One sync per user at a time. If a run is already `running` and under 10 minutes old, return it instead of starting another.
- Retry a failed mail on the next sync, up to 3 attempts. After that it stays `failed`.

### Scheduler
A `pg_cron` job every 2 hours calls a function `sync-all` that loops over `mail_connections` with status `active` and invokes `sync-mail` for each.

### Classify, then parse
- **Classify** each mail by sender plus subject pattern into `alert` or `not_alert`. Sender alone is not enough. `jobs-noreply@linkedin.com` sends both "X is hiring for Y" (an alert) and "Your application to Y at X" (an application confirmation, skip it). `not_alert` mails get `parse_status = skipped` and a `skip_reason`.
- LinkedIn alerts come in two shapes: one job per mail, and many jobs per mail ("X and 8 other jobs you may be interested in"). Both must be handled.
- **Parse** with the parser registered for that portal. Contract:

```ts
type ParsedJob = {
  title: string;            // required
  company: string;          // required
  location: string | null;
  job_url: string;          // required, canonical
  raw_url: string;          // the link exactly as in the mail
  external_job_id: string | null;
  posted_at: string | null;   // ISO date, only if the mail states it
  posted_text: string | null; // e.g. "2 days ago", as written
  easy_apply: boolean | null; // null = mail does not say
};
type Parser = (mail: { subject: string; html: string; receivedAt: string }) => ParsedJob[];
```

Parser rules:
- A mail classified as an alert with zero jobs found is a failure, not a success.
- A job missing title, company or URL is dropped and counted. If every job in the mail is dropped, the mail is `failed`.
- Never guess a field. If the mail does not state it, return null.
- LinkedIn links are tracking links. Pull the numeric job id and store `https://www.linkedin.com/jobs/view/<id>` as `job_url`. Keep the original in `raw_url`.
- For other portals, follow no redirects in Phase 1. Strip tracking query params where the job id is visible in the path. Otherwise `job_url = raw_url`.
- Most alert mails do not state the posting date. Leave `posted_at` null and let the UI show the alert date instead.

### Duplicates
- `dedupe_key` = `portal:external_job_id` when the id exists. Otherwise `portal:` + lowercased, trimmed `title|company|location`.
- Unique on `(user_id, dedupe_key)`.
- When a job is seen again in a later mail: update `last_seen_at`, add 1 to `seen_count`, fill any field that was null. Do not create a new row. Do not change its status.
- The same job arriving from two different portals stays as two rows in Phase 1.

---

## 8. Data model

All tables have `id uuid primary key default gen_random_uuid()` and `created_at timestamptz default now()` unless noted. All have RLS on. Policy for user-facing tables: a user can only read and write rows where `user_id = auth.uid()`.

```
portals               (browser: read only)
  key ('linkedin', 'cutshort', ...), name, website_url,
  state ('supported'|'coming_soon'), parser, sort_order

portal_senders        (browser: no access. Service role only.)
  portal_id -> portals, sender_address

user_portals          (browser: read and write own rows)
  user_id, portal_id -> portals, added_at, first_synced_at
  unique (user_id, portal_id)
  A row can only point to a portal whose state is 'supported' (enforce in the database).

mail_connections      (browser: read own rows only)
  user_id, provider ('gmail'), email, status ('active'|'needs_reconnect'|'error'),
  last_synced_at, last_error
  unique (user_id, provider, email)

mail_tokens           (browser: no access at all. Service role only.)
  connection_id -> mail_connections, refresh_token_enc, updated_at

mail_messages         (browser: read own rows, no raw_html column exposed)
  user_id, connection_id, provider_message_id, sender, subject, received_at,
  portal_id, parse_status ('parsed'|'skipped'|'failed'), skip_reason, attempts,
  jobs_found, error, raw_html (only when failed, deleted after 30 days)
  unique (connection_id, provider_message_id)

jobs                  (browser: read own rows; update status, round_no, round_state, jd_text only)
  user_id, portal_id, external_job_id, dedupe_key,
  title, company, location, job_url, raw_url,
  posted_at, posted_text, easy_apply, jd_text,
  mail_message_id, first_seen_at, last_seen_at, seen_count,
  status ('new'|'applied'|'screening'|'offered'|'rejected'|'ghosted'|'not_interested'),
  round_no (int, null), round_state ('in_progress'|'completed', null),
  status_changed_at
  unique (user_id, dedupe_key)
  check: status = 'screening' requires round_no >= 1 and round_state not null
  check: status in ('new','applied','not_interested') requires round_no and round_state null

job_events            (browser: read own rows. Inserted by trigger only.)
  job_id, user_id,
  from_status, to_status, from_round_no, to_round_no, from_round_state, to_round_state,
  cause ('system'|'user'), note

sync_runs             (browser: read own rows)
  user_id, trigger ('first'|'manual'|'schedule'|'settings'), status ('running'|'ok'|'partial'|'failed'),
  started_at, finished_at, mails_seen, mails_parsed, mails_skipped, mails_failed,
  jobs_added, jobs_seen_again, error
```

---

## 9. Screens

### 9.1 Sign in
Product name, one line on what it does, "Continue with Google", and one plain sentence: "We only read job alert mails. We never send, delete or change anything in your mailbox."

### 9.2 Settings
- **Job portals:** multi-select dropdown of portal names, as in section 5. Ticked portals show as chips. "Coming soon" portals are greyed out. Save is blocked with a message if nothing is ticked.
- **Gmail:** connected address, last sync time, "Connect again" button.
- **Sign out.**

The same portal picker is shown once as the first step after the first sign-in.

### 9.3 Inbox (the main screen)
- **Top bar:** last sync time, counts from the last run ("12 new, 3 seen again, 1 could not be read"), "Sync now" button, link to Settings.
- **Banners:** "Connect Gmail again" when the connection needs it. "Syncing your mail" during a run.
- **View toggle:** List (default on desktop) and Card (default on mobile). Remember the choice per browser.
- **Tabs:** New, Applied, Screening, Offered, Closed (Rejected and Ghosted), All. Not interested jobs show only under All, with a filter. Default tab is New, newest first.
- **Filters:** portal, and a text search over role and company.
- **Each job shows:**
  - Role
  - Company
  - Location (or "Not stated")
  - Portal (LinkedIn, Cutshort, ...)
  - Posted date if the mail stated it, otherwise "Alert received <date>"
  - Easy apply: Yes, No, or blank when the mail does not say
  - "Open job" link to `job_url` in a new tab
  - Status, with the round text when in Screening
  - "Seen in N alerts" when `seen_count > 1`
- **Actions per job:**
  - On New: two quick buttons, "Applied" and "Not interested".
  - Everywhere: a status dropdown with all statuses.
  - In Screening: "Mark round completed" and "Start next round".
  - A toast with Undo for 5 seconds after every change.
- **Job detail (drawer or page):** all fields above, the status history from `job_events`, and the JD text box (plain text, saved on blur, up to 50,000 characters).
- **Empty states:** no portal ticked, first sync running, sync finished with zero jobs ("No job alert mails found in the last 14 days from <ticked portal names>"), and a tab or filter with no results.
- **Could not read:** a small link that opens a list of failed mails (sender, subject, date, error). Read only.

Loading, error and empty states are part of the work, not polish.

---

## 10. Build order

Stop after each step, show what works, then continue.

1. **Fixtures first.** Write `scripts/capture-fixtures` that, with a developer's own Google token, saves 5 recent mails per sender into `fixtures/` as HTML plus a small JSON of headers. `fixtures/` is gitignored because the mails hold personal data. Build every parser test-first against these files. Do not write a parser from memory of what a LinkedIn mail looks like.
2. Database migrations, RLS policies, the status trigger, seed `portals` and `portal_senders`.
3. Sign in, `connect-mail`, token storage.
4. Portal picker (first sign-in step and Settings).
5. `sync-mail` with the LinkedIn parsers (single-job and multi-job), classification and duplicates.
6. Inbox screen wired to real data, including status changes.
7. Cutshort parser.
8. Scheduler (`sync-all` + `pg_cron`).
9. GitHub Pages deploy workflow.

---

## 11. Acceptance checks

1. A test user signs in, grants read-only Gmail access, picks portals and sees their jobs without any other manual step.
2. For 20 real LinkedIn alert mails, every job in each mail appears in the Inbox once, with the right role, company, location and a link that opens the correct job.
3. With only LinkedIn ticked, no Cutshort mail is fetched. After ticking Cutshort and saving, Cutshort jobs from the last 14 days appear.
4. Unticking a portal keeps its existing jobs and stops new ones.
5. A "coming soon" portal cannot be ticked from the screen, and cannot be saved by calling the API directly either.
6. Running sync twice in a row adds zero new jobs the second time.
7. A job seen in three alert mails is one row with `seen_count = 3`, and its status is unchanged.
8. "Your application to ..." mails create no job and are listed as skipped with a reason.
9. A mail the parser cannot read shows up under "could not read" and is retried on the next two syncs.
10. A job can go New, Applied, Screening 1 in progress, Screening 1 completed, Screening 2 in progress, Rejected. The Closed tab shows it as rejected after Screening 2, and `job_events` holds one row per step.
11. Undo after any change restores the previous status and round values and adds its own event.
12. User A cannot read user B's jobs, mails, portal choices or sync runs through the API with their own JWT. Test this with two real accounts, not by reading the policy.
13. No table or API reachable with the browser key returns a refresh token, a mail body or a sender address.
14. Revoking access in the Google account leads to the reconnect banner at the next sync, not a silent failure.
15. The Inbox and Settings are usable at 360px width.
16. The repo and the deployed app contain no AI or LLM dependency, key or call.

---

## 12. Rules for Claude Code

- Read the Supabase and Gmail API docs before writing a call. Do not guess identifiers.
- After every migration or deploy, read the result back and confirm it. A success response is not proof.
- Never log mail bodies, tokens or full URLs with tracking params.
- Run the Supabase security advisors after the migrations and fix what they flag.
- Version every doc and prompt file. Never overwrite a prior version.
- If something in this spec cannot be built as written, stop and say which line and why. Do not swap in a different design quietly.

---

## 13. Setup the owner must do by hand

- Create a Google Cloud project with a Google account, enable the Gmail API, set the OAuth consent screen to External + Testing, add the `gmail.readonly` scope, and add each tester's Gmail address as a test user.
- Create an OAuth client (Web). Authorised redirect URI is the Supabase Auth callback URL for project `ytqglyyzmoceymnqrcxc`.
- Put the client id and secret into Supabase Auth > Google provider.
- Add Edge Function secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENC_KEY`.
- Create the GitHub repo and turn on GitHub Pages from Actions.

---

## 14. Known limits of Phase 1 (accepted)

- Two portals work on day one: LinkedIn and Cutshort. Every other portal needs a sample mail and a parser before it can be ticked.
- With no AI, a portal that changes its mail layout breaks its parser until the rules are fixed. Those mails land in "could not read", they are not lost.
- 100 test users at most, and each must be added by hand in Google Cloud. Test-user slots cannot be reused.
- Testers must reconnect Gmail about once a week.
- The posting date and easy apply are blank for most jobs, because most alert mails do not carry them. They become reliable only when the JD page is fetched in a later phase.
- Going public needs Google verification and the security assessment. Start that before promising the app to anyone outside the test list.
