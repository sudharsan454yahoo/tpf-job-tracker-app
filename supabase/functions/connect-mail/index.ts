// connect-mail | version 1.0
// Stores the user's Gmail refresh token (encrypted) right after Google sign-in.
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://sudharsan454yahoo.github.io", "http://localhost:5173"];
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

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

async function encKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("TOKEN_ENC_KEY");
  if (!secret) throw new Error("TOKEN_ENC_KEY is not set");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
}

async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encKey(),
    new TextEncoder().encode(plain),
  );
  return `v1:${b64(iv)}:${b64(ct)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
      auth: { persistSession: false },
    });
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json(req, { error: "not_signed_in" }, 401);
    const user = userData.user;

    const body = await req.json().catch(() => ({}));
    const refreshToken = typeof body.provider_refresh_token === "string"
      ? body.provider_refresh_token
      : "";
    if (!refreshToken) return json(req, { error: "missing_refresh_token" }, 400);

    // Prove the token works and really carries Gmail read access before storing it.
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
      console.error("google token check failed", tok.error);
      return json(req, { error: "google_rejected_token", detail: tok.error ?? null }, 400);
    }
    if (!String(tok.scope ?? "").includes("gmail.readonly")) {
      return json(req, { error: "gmail_permission_missing" }, 400);
    }

    const email = user.email ?? "unknown";
    const { data: conn, error: connErr } = await admin
      .from("mail_connections")
      .upsert(
        { user_id: user.id, provider: "gmail", email, status: "active", last_error: null },
        { onConflict: "user_id,provider,email" },
      )
      .select("id")
      .single();
    if (connErr) throw connErr;

    const { error: tokErr } = await admin.from("mail_tokens").upsert({
      connection_id: conn.id,
      refresh_token_enc: await encrypt(refreshToken),
      updated_at: new Date().toISOString(),
    });
    if (tokErr) throw tokErr;

    return json(req, { ok: true, email });
  } catch (e) {
    console.error("connect-mail error", (e as Error).message);
    return json(req, { error: "server_error" }, 500);
  }
});
