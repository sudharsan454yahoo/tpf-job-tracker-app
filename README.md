<!-- README | version 1.0 | 22 Nov 2026 -->
# TPF Job Tracker

Reads job alert mails from your Gmail (read only) and lists every job in one Inbox.

- Live app: https://sudharsan454yahoo.github.io/tpf-job-tracker-app/
- Spec: `docs/job-inbox-spec-v1.1.md`

## What is where

| Part | Location |
|---|---|
| Web app (React + Vite) | `src/` |
| Mail sync and Gmail connection (Supabase Edge Functions) | `supabase/functions/` |
| Mail parsers (fixed rules, no AI) | `supabase/functions/sync-mail/parsers.ts` |
| Database schema, security rules, schedules | `supabase/migrations/` |
| Parser tests | `tests/` |

## Run locally

```
npm install
npm test
npm run dev
```

## Add a job portal

1. Save a real alert mail from the portal as a text fixture in `tests/fixtures/`.
2. Add a parser to `parsers.ts` and a test for it.
3. Add the sender address to `portal_senders` and set the portal's `state` to `supported`.

## Secrets

No secret lives in this repo. The Supabase publishable key in `src/supabase.ts` is public by design.
Google and encryption secrets are Supabase Edge Function secrets.
