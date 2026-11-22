// sync-mail | version 1.0
// Reads job alert mails from Gmail (read only), parses them with fixed rules, saves jobs.
// Called by: the signed-in user (first sync, Sync now, settings change) and the 2-hour schedule.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { dedupeKey, PARSERS } from "./parsers.ts";

const ALLOWED_ORIGINS = ["https://sudharsan454yahoo.github.io", "http://localhost:5173"];
const BATCH = 50; // mails per invocation
const MAX_PER_SYNC = 500;
const LOOKBACK_DAYS = 14;
const MAX_ATTEMPTS = 3;

function cors(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const dict = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  return Object.values(dict)[0] as string;
}

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function decrypt(stored: string): Promise<string> {
  const [, ivB64, ctB64] = stored.split(":");
  const secret = Deno.env.get("TOKEN_ENC_KEY");
  if (!secret) throw new Error("TOKEN_ENC_KEY is not set");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB64) }, key, unb64(ctB64));
  return new TextDecoder().decode(plain);
}

class ReconnectNeeded extends Error {}

async function googleAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const tok = await res.json();
  if (!res.ok) {
    if (tok.error === "invalid_grant") throw new ReconnectNeeded("Google access expired or was removed");
    throw new Error(`Google token error: ${tok.error ?? res.status}`);
  }
  return tok.access_token as string;
}

async function gmail(accessToken: string, path: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.status ?? res.status;
    if (res.status === 401 || reason === "PERMISSION_DENIED") {
      throw new ReconnectNeeded(`Gmail refused access (${reason})`);
    }
    throw new Error(`Gmail error ${reason}`);
  }
  if (!res.ok) throw new Error(`Gmail error ${res.status}`);
  return res.json();
}

function decodeBody(data: string): string {
  const bytes = unb64(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8").decode(bytes);
}

// deno-lint-ignore no-explicit-any
function findPart(payload: any, mime: string): string | null {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body?.data) return decodeBody(payload.body.data);
  for (const p of payload.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

// deno-lint-ignore no-explicit-any
function mailText(payload: any): string {
  const plain = findPart(payload, "text/plain");
  if (plain && plain.trim()) return plain;
  const html = findPart(payload, "text/html");
  return html ? htmlToText(html) : "";
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

type Counts = {
  mails_parsed: number;
  mails_skipped: number;
  mails_failed: number;
  jobs_added: number;
  jobs_seen_again: number;
};

function selfCall(body: unknown, cronToken: string) {
  const p = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-mail`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-token": cronToken },
    body: JSON.stringify(body),
  }).then((r) => r.text()).catch((e) => console.error("self call failed", e.message));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
  return p;
}

async function cronToken(admin: SupabaseClient): Promise<string> {
  // Only used for continuation calls started by a signed-in user.
  const { data, error } = await admin.rpc("get_cron_token");
  if (error) throw error;
  return data as string;
}

async function syncUser(
  admin: SupabaseClient,
  userId: string,
  trigger: string,
  runId: string | null,
) {
  const { data: conn } = await admin
    .from("mail_connections")
    .select("id, status, last_synced_at")
    .eq("user_id", userId)
    .eq("provider", "gmail")
    .maybeSingle();
  if (!conn) return { status: "no_connection" };

  // deno-lint-ignore no-explicit-any
  let run: any;
  if (runId) {
    const { data } = await admin.from("sync_runs").select("*").eq("id", runId).eq("user_id", userId).maybeSingle();
    if (!data || data.status !== "running") return { status: "run_not_found" };
    run = data;
  } else {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: active } = await admin
      .from("sync_runs")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "running")
      .gte("started_at", tenMinAgo)
      .limit(1);
    if (active?.length) return { status: "already_running", run_id: active[0].id };
    const { data, error } = await admin
      .from("sync_runs")
      .insert({ user_id: userId, trigger })
      .select("*")
      .single();
    if (error) throw error;
    run = data;
  }

  const finish = async (status: string, patch: Record<string, unknown> = {}) => {
    await admin.from("sync_runs").update({
      status,
      finished_at: new Date().toISOString(),
      ...patch,
    }).eq("id", run.id);
  };

  try {
    const { data: tok } = await admin
      .from("mail_tokens")
      .select("refresh_token_enc")
      .eq("connection_id", conn.id)
      .maybeSingle();
    if (!tok) throw new ReconnectNeeded("No stored Gmail access");
    const accessToken = await googleAccessToken(await decrypt(tok.refresh_token_enc));

    const { data: picks, error: picksErr } = await admin
      .from("user_portals")
      .select("portal_id, first_synced_at, portals!inner(id, key, parser, state)")
      .eq("user_id", userId);
    if (picksErr) throw picksErr;
    // deno-lint-ignore no-explicit-any
    const active = (picks ?? []).filter((p: any) => p.portals.state === "supported" && PARSERS[p.portals.parser]);
    if (!active.length) {
      await finish("ok");
      return { status: "ok", run_id: run.id, note: "no_portals" };
    }
    const { data: senders } = await admin
      .from("portal_senders")
      .select("portal_id, sender_address")
      // deno-lint-ignore no-explicit-any
      .in("portal_id", active.map((p: any) => p.portal_id));

    // 1. List candidate mails per portal.
    const now = Date.now();
    const fullLookback = Math.floor((now - LOOKBACK_DAYS * 86400_000) / 1000);
    const incremental = conn.last_synced_at
      ? Math.floor((new Date(conn.last_synced_at).getTime() - 86400_000) / 1000)
      : fullLookback;
    const candidates: { id: string; portalId: string; parser: string; key: string }[] = [];
    // deno-lint-ignore no-explicit-any
    for (const p of active as any[]) {
      const addrs = (senders ?? []).filter((s) => s.portal_id === p.portal_id).map((s) => s.sender_address);
      if (!addrs.length) continue;
      const after = p.first_synced_at ? Math.max(incremental, fullLookback) : fullLookback;
      const q = `from:(${addrs.join(" OR ")}) after:${after}`;
      let pageToken = "";
      do {
        const page = await gmail(
          accessToken,
          `messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ""}`,
        );
        for (const m of page.messages ?? []) {
          candidates.push({ id: m.id, portalId: p.portal_id, parser: p.portals.parser, key: p.portals.key });
        }
        pageToken = page.nextPageToken ?? "";
      } while (pageToken && candidates.length < MAX_PER_SYNC);
    }

    // 2. Drop mails already handled.
    const known = new Map<string, { parse_status: string; attempts: number }>();
    for (let i = 0; i < candidates.length; i += 200) {
      const { data } = await admin
        .from("mail_messages")
        .select("provider_message_id, parse_status, attempts")
        .eq("connection_id", conn.id)
        .in("provider_message_id", candidates.slice(i, i + 200).map((c) => c.id));
      for (const r of data ?? []) known.set(r.provider_message_id, r);
    }
    const todo = candidates.filter((c) => {
      const k = known.get(c.id);
      if (!k) return true;
      return k.parse_status === "failed" && k.attempts < MAX_ATTEMPTS;
    });
    const batch = todo.slice(0, BATCH);

    const counts: Counts = { mails_parsed: 0, mails_skipped: 0, mails_failed: 0, jobs_added: 0, jobs_seen_again: 0 };

    // 3. Fetch, classify, parse, save.
    await pool(batch, 5, async (c) => {
      const prevAttempts = known.get(c.id)?.attempts ?? 0;
      const base = {
        user_id: userId,
        connection_id: conn.id,
        provider_message_id: c.id,
        portal_id: c.portalId,
      };
      try {
        const msg = await gmail(accessToken, `messages/${c.id}?format=full`);
        // deno-lint-ignore no-explicit-any
        const headers: any[] = msg.payload?.headers ?? [];
        const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value ?? "";
        const subject = h("subject");
        const sender = (h("from").match(/<([^>]+)>/)?.[1] ?? h("from")).toLowerCase();
        const receivedAt = new Date(Number(msg.internalDate)).toISOString();
        const text = mailText(msg.payload);
        const meta = { ...base, sender, subject, received_at: receivedAt };
        const parser = PARSERS[c.parser];

        const cls = parser.classify({ sender, subject, text });
        if (cls.kind === "not_alert") {
          await admin.from("mail_messages").upsert(
            { ...meta, parse_status: "skipped", skip_reason: cls.reason, attempts: prevAttempts + 1, raw_body: null, error: null },
            { onConflict: "connection_id,provider_message_id" },
          );
          counts.mails_skipped++;
          return;
        }

        const { jobs, dropped } = parser.parse({ sender, subject, text });
        if (!jobs.length) {
          await admin.from("mail_messages").upsert(
            {
              ...meta,
              parse_status: "failed",
              attempts: prevAttempts + 1,
              jobs_found: 0,
              error: dropped ? `${dropped} job(s) found but none could be read` : "No jobs could be read from this alert mail",
              raw_body: text.slice(0, 200_000),
            },
            { onConflict: "connection_id,provider_message_id" },
          );
          counts.mails_failed++;
          return;
        }

        const { data: saved, error: saveErr } = await admin.from("mail_messages").upsert(
          {
            ...meta,
            parse_status: "parsed",
            attempts: prevAttempts + 1,
            jobs_found: jobs.length,
            error: dropped ? `${dropped} job(s) in this mail could not be read` : null,
            raw_body: null,
          },
          { onConflict: "connection_id,provider_message_id" },
        ).select("id").single();
        if (saveErr) throw saveErr;

        for (const j of jobs) {
          const { data: inserted, error } = await admin.rpc("upsert_job", {
            p_user_id: userId,
            p_portal_id: c.portalId,
            p_external_job_id: j.external_job_id,
            p_dedupe_key: dedupeKey(c.key, j),
            p_title: j.title,
            p_company: j.company,
            p_location: j.location,
            p_job_url: j.job_url,
            p_raw_url: j.raw_url,
            p_posted_at: j.posted_at,
            p_posted_text: j.posted_text,
            p_easy_apply: j.easy_apply,
            p_mail_message_id: saved.id,
            p_seen_at: receivedAt,
          });
          if (error) throw error;
          if (inserted) counts.jobs_added++;
          else counts.jobs_seen_again++;
        }
        counts.mails_parsed++;
      } catch (e) {
        if (e instanceof ReconnectNeeded) throw e;
        console.error("mail failed", c.id, (e as Error).message);
        await admin.from("mail_messages").upsert(
          {
            ...base,
            parse_status: "failed",
            attempts: prevAttempts + 1,
            error: String((e as Error).message ?? e).slice(0, 500),
          },
          { onConflict: "connection_id,provider_message_id" },
        );
        counts.mails_failed++;
      }
    });

    // 4. Update the run. Continue in a new invocation if more mails remain.
    const totals = {
      mails_seen: runId ? run.mails_seen : candidates.length,
      mails_parsed: run.mails_parsed + counts.mails_parsed,
      mails_skipped: run.mails_skipped + counts.mails_skipped,
      mails_failed: run.mails_failed + counts.mails_failed,
      jobs_added: run.jobs_added + counts.jobs_added,
      jobs_seen_again: run.jobs_seen_again + counts.jobs_seen_again,
    };
    const handled = totals.mails_parsed + totals.mails_skipped + totals.mails_failed;
    const remaining = todo.length - batch.length;

    if (remaining > 0 && handled < MAX_PER_SYNC && batch.length > 0) {
      await admin.from("sync_runs").update(totals).eq("id", run.id);
      selfCall({ user_id: userId, run_id: run.id, trigger }, await cronToken(admin));
      return { status: "running", run_id: run.id, remaining };
    }

    const stamp = run.started_at;
    await admin.from("user_portals").update({ first_synced_at: stamp })
      .eq("user_id", userId).is("first_synced_at", null)
      // deno-lint-ignore no-explicit-any
      .in("portal_id", active.map((p: any) => p.portal_id));
    await admin.from("mail_connections")
      .update({ last_synced_at: stamp, status: "active", last_error: null })
      .eq("id", conn.id);
    const status = remaining > 0 ? "partial" : "ok";
    await finish(status, totals);
    return { status, run_id: run.id, ...totals };
  } catch (e) {
    const message = String((e as Error).message ?? e).slice(0, 500);
    if (e instanceof ReconnectNeeded) {
      await admin.from("mail_connections")
        .update({ status: "needs_reconnect", last_error: message })
        .eq("id", conn.id);
      await finish("failed", { error: "Gmail needs to be connected again" });
      return { status: "needs_reconnect", run_id: run.id };
    }
    console.error("sync failed", message);
    await admin.from("mail_connections").update({ last_error: message }).eq("id", conn.id);
    await finish("failed", { error: message });
    return { status: "failed", run_id: run.id };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
      auth: { persistSession: false },
    });
    const body = await req.json().catch(() => ({}));
    const token = req.headers.get("x-cron-token");

    if (token) {
      const { data: ok } = await admin.rpc("check_cron_token", { p_token: token });
      if (!ok) return json(req, { error: "forbidden" }, 403);

      if (body.all === true) {
        const { data: conns } = await admin
          .from("mail_connections")
          .select("user_id")
          .eq("status", "active");
        for (const c of conns ?? []) selfCall({ user_id: c.user_id, trigger: "schedule" }, token);
        return json(req, { started: conns?.length ?? 0 });
      }
      if (typeof body.user_id === "string") {
        const trigger = ["first", "manual", "schedule", "settings"].includes(body.trigger) ? body.trigger : "schedule";
        const result = await syncUser(admin, body.user_id, trigger, body.run_id ?? null);
        return json(req, result);
      }
      return json(req, { error: "bad_request" }, 400);
    }

    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json(req, { error: "not_signed_in" }, 401);
    const trigger = ["first", "manual", "settings"].includes(body.trigger) ? body.trigger : "manual";
    const result = await syncUser(admin, userData.user.id, trigger, null);
    return json(req, result);
  } catch (e) {
    console.error("sync-mail error", (e as Error).message);
    return json(req, { error: "server_error" }, 500);
  }
});
