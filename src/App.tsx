// App.tsx | version 1.0 | Sign-in, Gmail connection, first-time portal pick, then Inbox / Settings.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { signInWithGoogle, supabase } from "./supabase";
import type { Connection, Portal } from "./types";
import Inbox from "./Inbox";
import { PortalPicker, SettingsScreen } from "./Settings";

const CONNECT_ERRORS: Record<string, string> = {
  gmail_permission_missing:
    "Gmail access was not granted. On the Google screen, tick the box that lets this app view your email messages, then try again.",
  google_rejected_token: "Google did not accept the connection. Please connect Gmail again.",
  missing_refresh_token: "Google did not send the access we need. Please connect Gmail again.",
  not_signed_in: "Your sign-in expired. Please sign in again.",
};

function readUrlError(): string | null {
  const q = new URLSearchParams(window.location.search);
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const code = q.get("error") ?? h.get("error");
  if (!code) return null;
  const desc = q.get("error_description") ?? h.get("error_description") ?? "";
  window.history.replaceState({}, "", window.location.pathname);
  if (code === "access_denied") {
    return "Sign-in was not completed. This app is in private testing, so your Google account must be added as a tester first. Ask for access.";
  }
  return desc || "Sign-in did not complete. Please try again.";
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [urlError] = useState<string | null>(() => readUrlError());
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [portals, setPortals] = useState<Portal[]>([]);
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [conn, setConn] = useState<Connection | null>(null);
  const [view, setView] = useState<"inbox" | "settings">("inbox");
  const [syncTick, setSyncTick] = useState(0);
  const tokenSent = useRef(false);
  const userId = session?.user?.id;

  const loadBase = useCallback(async () => {
    const [p, up, c] = await Promise.all([
      supabase.from("portals").select("id, key, name, website_url, state, sort_order").order("sort_order"),
      supabase.from("user_portals").select("portal_id"),
      supabase.from("mail_connections").select("id, email, status, last_synced_at, last_error").maybeSingle(),
    ]);
    const err = p.error ?? up.error ?? c.error;
    if (err) {
      setLoadError("Could not load your account. Check your connection and reload.");
    } else {
      setLoadError(null);
      setPortals((p.data ?? []) as Portal[]);
      setPicks(new Set((up.data ?? []).map((r) => r.portal_id as string)));
      setConn((c.data as Connection) ?? null);
    }
    setLoaded(true);
  }, []);

  const connectMail = useCallback(
    async (refreshToken: string) => {
      setConnecting(true);
      setConnectError(null);
      const { error } = await supabase.functions.invoke("connect-mail", {
        body: { provider_refresh_token: refreshToken },
      });
      if (error) {
        let code = "";
        try {
          // deno-style FunctionsHttpError keeps the response on .context
          const body = await (error as { context?: Response }).context?.json();
          code = body?.error ?? "";
        } catch {
          /* ignore */
        }
        setConnectError(CONNECT_ERRORS[code] ?? "Could not connect Gmail. Please try again.");
      }
      await loadBase();
      setConnecting(false);
    },
    [loadBase],
  );

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      const token = s?.provider_refresh_token;
      if (token && !tokenSent.current) {
        tokenSent.current = true;
        // Hand the Google token to the server once. It is never stored in the browser.
        setTimeout(() => void connectMail(token), 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [connectMail]);

  useEffect(() => {
    if (!userId) {
      setLoaded(false);
      return;
    }
    void loadBase();
  }, [userId, loadBase]);

  const startSync = useCallback((trigger: "first" | "manual" | "settings") => {
    // Fire and let the Inbox follow progress through sync_runs.
    void supabase.functions.invoke("sync-mail", { body: { trigger } }).then(() => setSyncTick((t) => t + 1));
    setTimeout(() => setSyncTick((t) => t + 1), 800);
  }, []);

  const savePicks = useCallback(
    async (next: Set<string>, first: boolean): Promise<string | null> => {
      if (!userId) return "Not signed in.";
      const add = [...next].filter((id) => !picks.has(id));
      const remove = [...picks].filter((id) => !next.has(id));
      if (add.length) {
        const { error } = await supabase
          .from("user_portals")
          .insert(add.map((portal_id) => ({ user_id: userId, portal_id })));
        if (error) return "Could not save your portals. Please try again.";
      }
      if (remove.length) {
        const { error } = await supabase.from("user_portals").delete().in("portal_id", remove);
        if (error) return "Could not save your portals. Please try again.";
      }
      // Read back what is stored and trust only that.
      const { data, error } = await supabase.from("user_portals").select("portal_id");
      if (error) return "Saved, but could not confirm. Please reload.";
      setPicks(new Set((data ?? []).map((r) => r.portal_id as string)));
      if (first || add.length || remove.length) startSync(first ? "first" : "settings");
      return null;
    },
    [picks, startSync, userId],
  );

  if (session === undefined) return <Center>Loading…</Center>;

  if (!session) {
    return (
      <main className="signin">
        <div className="signin-card">
          <div className="brand">TPF Job Tracker</div>
          <h1>Every job alert, in one list.</h1>
          <p className="muted">
            Sign in with Google. We find the job alert mails from the portals you choose and list each job here.
          </p>
          {urlError && <div className="banner error">{urlError}</div>}
          <button className="btn primary big" onClick={() => void signInWithGoogle()}>
            Continue with Google
          </button>
          <p className="fineprint">
            We only read job alert mails. We never send, delete or change anything in your mailbox.
          </p>
        </div>
      </main>
    );
  }

  if (connecting || !loaded) return <Center>{connecting ? "Connecting your Gmail…" : "Loading your account…"}</Center>;

  if (loadError) {
    return (
      <Center>
        <div className="banner error">{loadError}</div>
        <button className="btn" onClick={() => void loadBase()}>
          Try again
        </button>
      </Center>
    );
  }

  if (!conn) {
    return (
      <main className="signin">
        <div className="signin-card">
          <div className="brand">TPF Job Tracker</div>
          <h1>Connect your Gmail</h1>
          <p className="muted">
            You are signed in as {session.user.email}, but Gmail is not connected yet. On the Google screen, tick the
            box to let this app view your email messages.
          </p>
          {connectError && <div className="banner error">{connectError}</div>}
          <button className="btn primary big" onClick={() => void signInWithGoogle()}>
            Connect Gmail
          </button>
          <button className="btn link" onClick={() => void supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  if (picks.size === 0) {
    return (
      <main className="signin">
        <div className="signin-card wide">
          <div className="brand">TPF Job Tracker</div>
          <h1>Which job portals send you alerts?</h1>
          <p className="muted">We will read alert mails only from the portals you pick. You can change this later.</p>
          <PortalPicker
            portals={portals}
            initial={new Set(portals.filter((p) => p.state === "supported").map((p) => p.id))}
            saveLabel="Save and find my jobs"
            onSave={(next) => savePicks(next, true)}
          />
        </div>
      </main>
    );
  }

  return view === "settings" ? (
    <SettingsScreen
      portals={portals}
      picks={picks}
      conn={conn}
      onSave={(next) => savePicks(next, false)}
      onBack={() => setView("inbox")}
    />
  ) : (
    <Inbox
      portals={portals}
      picks={picks}
      conn={conn}
      syncTick={syncTick}
      onSyncNow={() => startSync("manual")}
      onOpenSettings={() => setView("settings")}
      onConnChanged={loadBase}
    />
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <main className="center">{children}</main>;
}
