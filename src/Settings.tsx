// Settings.tsx | version 1.0 | Portal multi-select and account settings.
import { useEffect, useMemo, useRef, useState } from "react";
import { signInWithGoogle, supabase } from "./supabase";
import type { Connection, Portal } from "./types";
import { dateTime } from "./types";

export function PortalPicker(props: {
  portals: Portal[];
  initial: Set<string>;
  saveLabel: string;
  onSave: (next: Set<string>) => Promise<string | null>;
}) {
  const { portals, initial, saveLabel, onSave } = props;
  const [sel, setSel] = useState<Set<string>>(new Set(initial));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const chosen = useMemo(() => portals.filter((p) => sel.has(p.id)), [portals, sel]);
  const changed = sel.size !== initial.size || [...sel].some((id) => !initial.has(id));

  const toggle = (p: Portal) => {
    if (p.state !== "supported") return;
    setMsg(null);
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
  };

  const save = async () => {
    if (sel.size === 0) {
      setMsg({ kind: "error", text: "Pick at least one portal." });
      return;
    }
    setBusy(true);
    const err = await onSave(sel);
    setBusy(false);
    setMsg(err ? { kind: "error", text: err } : { kind: "ok", text: "Saved. Checking your mail now." });
  };

  return (
    <div className="picker">
      <label className="field-label" id="portal-label">
        Job portals
      </label>
      <div className="multi" ref={boxRef}>
        <button
          type="button"
          className="multi-control"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby="portal-label"
          onClick={() => setOpen((o) => !o)}
        >
          {chosen.length ? (
            <span className="chips">
              {chosen.map((p) => (
                <span className="chip" key={p.id}>
                  {p.name}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">Select portals</span>
          )}
          <span className="caret" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <ul className="multi-menu" role="listbox" aria-multiselectable="true">
            {portals.map((p) => {
              const disabled = p.state !== "supported";
              return (
                <li key={p.id} role="option" aria-selected={sel.has(p.id)} aria-disabled={disabled}>
                  <label className={disabled ? "opt disabled" : "opt"}>
                    <input type="checkbox" checked={sel.has(p.id)} disabled={disabled} onChange={() => toggle(p)} />
                    <span>{p.name}</span>
                    {disabled && <span className="soon">Coming soon</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {msg && <div className={`banner ${msg.kind}`}>{msg.text}</div>}
      <button className="btn primary" disabled={busy || (!changed && saveLabel === "Save changes")} onClick={() => void save()}>
        {busy ? "Saving…" : saveLabel}
      </button>
    </div>
  );
}

export function SettingsScreen(props: {
  portals: Portal[];
  picks: Set<string>;
  conn: Connection;
  onSave: (next: Set<string>) => Promise<string | null>;
  onBack: () => void;
}) {
  const { portals, picks, conn, onSave, onBack } = props;
  return (
    <div className="page">
      <header className="topbar">
        <button className="btn link" onClick={onBack}>
          ← Back to Inbox
        </button>
        <div className="brand">Settings</div>
      </header>
      <section className="panel">
        <h2>Job portals</h2>
        <p className="muted">
          We read alert mails only from the portals you tick. Adding one looks back 14 days. Removing one keeps the jobs
          already in your Inbox.
        </p>
        <PortalPicker key={[...picks].sort().join(",")} portals={portals} initial={picks} saveLabel="Save changes" onSave={onSave} />
      </section>
      <section className="panel">
        <h2>Gmail</h2>
        <dl className="kv">
          <dt>Connected address</dt>
          <dd>{conn.email}</dd>
          <dt>Status</dt>
          <dd>{conn.status === "active" ? "Connected" : "Needs to be connected again"}</dd>
          <dt>Last checked</dt>
          <dd>{conn.last_synced_at ? dateTime(conn.last_synced_at) : "Not yet"}</dd>
        </dl>
        <button className="btn" onClick={() => void signInWithGoogle()}>
          Connect Gmail again
        </button>
      </section>
      <section className="panel">
        <h2>Account</h2>
        <button className="btn" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </section>
    </div>
  );
}
