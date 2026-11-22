// Inbox.tsx | version 1.1 | The main screen: jobs from alert mails, with status, filters and detail.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signInWithGoogle, supabase } from "./supabase";
import type { Connection, FailedMail, Job, JobEvent, Portal, RoundState, Status, SyncRun } from "./types";
import { STATUS_LABEL, dateTime, shortDate, statusText } from "./types";

type Tab = "new" | "applied" | "screening" | "offered" | "closed" | "all";
const TABS: { key: Tab; label: string }[] = [
  { key: "new", label: "New" },
  { key: "applied", label: "Applied" },
  { key: "screening", label: "Screening" },
  { key: "offered", label: "Offered" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];
const ALL_STATUSES: Status[] = ["new", "applied", "screening", "offered", "rejected", "ghosted", "not_interested"];
const JOB_COLS =
  "id, portal_id, title, company, location, job_url, posted_at, posted_text, easy_apply, jd_text, first_seen_at, last_seen_at, seen_count, status, round_no, round_state, status_changed_at";

type Snapshot = { status: Status; round_no: number | null; round_state: RoundState | null };
type Toast = { text: string; jobId?: string; prev?: Snapshot };

function inTab(j: Job, tab: Tab, showHidden: boolean): boolean {
  switch (tab) {
    case "closed":
      return j.status === "rejected" || j.status === "ghosted";
    case "all":
      return showHidden || j.status !== "not_interested";
    default:
      return j.status === tab;
  }
}

function readPref(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export default function Inbox(props: {
  portals: Portal[];
  picks: Set<string>;
  conn: Connection;
  syncTick: number;
  onSyncNow: () => void;
  onOpenSettings: () => void;
  onConnChanged: () => Promise<void>;
}) {
  const { portals, picks, conn, syncTick, onSyncNow, onOpenSettings, onConnChanged } = props;
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [run, setRun] = useState<SyncRun | null>(null);
  const [tab, setTab] = useState<Tab>("new");
  const [portalFilter, setPortalFilter] = useState("");
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [view, setView] = useState<"list" | "card">(
    () => readPref("jt.view", window.matchMedia("(max-width: 720px)").matches ? "card" : "list") as "list" | "card",
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [failed, setFailed] = useState<FailedMail[] | null>(null);
  const [showFailed, setShowFailed] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);
  const lastRunStatus = useRef<string | null>(null);

  const portalName = useMemo(() => new Map(portals.map((p) => [p.id, p.name])), [portals]);

  const loadJobs = useCallback(async () => {
    const { data, error } = await supabase
      .from("jobs")
      .select(JOB_COLS)
      .order("last_seen_at", { ascending: false })
      .limit(2000);
    if (error) setLoadErr("Could not load your jobs. Check your connection and reload.");
    else {
      setLoadErr(null);
      setJobs((data ?? []) as Job[]);
    }
  }, []);

  const loadFailed = useCallback(async () => {
    const { data } = await supabase
      .from("mail_messages")
      .select("id, sender, subject, received_at, error, attempts")
      .eq("parse_status", "failed")
      .order("received_at", { ascending: false })
      .limit(100);
    setFailed((data ?? []) as FailedMail[]);
  }, []);

  const loadRun = useCallback(async (): Promise<SyncRun | null> => {
    const { data } = await supabase
      .from("sync_runs")
      .select("id, status, started_at, finished_at, mails_seen, mails_parsed, mails_skipped, mails_failed, jobs_added, jobs_seen_again, error")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const r = (data as SyncRun) ?? null;
    setRun(r);
    return r;
  }, []);

  useEffect(() => {
    void loadJobs();
    void loadFailed();
  }, [loadJobs, loadFailed]);

  // Follow the latest sync run. While one is running, poll every 3 seconds.
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      const r = await loadRun();
      if (stop) return;
      const status = r?.status ?? null;
      if (lastRunStatus.current === "running" && status !== "running") {
        await Promise.all([loadJobs(), loadFailed(), onConnChanged()]);
      }
      lastRunStatus.current = status;
      if (status === "running") {
        void loadJobs();
        timer = window.setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [syncTick, loadRun, loadJobs, loadFailed, onConnChanged]);

  const syncing = run?.status === "running" && Date.now() - new Date(run.started_at).getTime() < 10 * 60 * 1000;

  const showToast = (t: Toast) => {
    setToast(t);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  };

  const applyChange = useCallback(
    async (job: Job, patch: Partial<Snapshot>, undoable = true) => {
      const prev: Snapshot = { status: job.status, round_no: job.round_no, round_state: job.round_state };
      const { data, error } = await supabase.from("jobs").update(patch).eq("id", job.id).select(JOB_COLS).single();
      if (error || !data) {
        const stale = error?.code === "PGRST116"; if (stale) await loadJobs(); showToast({ text: stale ? "This list was out of date and has been refreshed. Please try again." : "Could not save that change. Please try again." });
        return;
      }
      const saved = data as Job;
      setJobs((list) => (list ?? []).map((j) => (j.id === saved.id ? saved : j)));
      showToast(
        undoable
          ? { text: `${saved.title}: ${statusText(saved)}`, jobId: saved.id, prev }
          : { text: `Restored: ${statusText(saved)}` },
      );
    },
    [],
  );

  const setStatus = (job: Job, status: Status) => {
    if (status === job.status) return;
    if (status === "screening") {
      return applyChange(job, { status, round_no: job.round_no ?? 1, round_state: "in_progress" });
    }
    return applyChange(job, { status });
  };
  const completeRound = (job: Job) => applyChange(job, { round_state: "completed" });
  const nextRound = (job: Job) => applyChange(job, { round_no: (job.round_no ?? 1) + 1, round_state: "in_progress" });

  const undo = () => {
    if (!toast?.jobId || !toast.prev) return;
    const job = (jobs ?? []).find((j) => j.id === toast.jobId);
    if (job) void applyChange(job, toast.prev, false);
  };

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { new: 0, applied: 0, screening: 0, offered: 0, closed: 0, all: 0 };
    for (const j of jobs ?? []) for (const t of TABS) if (inTab(j, t.key, showHidden)) c[t.key]++;
    return c;
  }, [jobs, showHidden]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (jobs ?? []).filter(
      (j) =>
        inTab(j, tab, showHidden) &&
        (!portalFilter || j.portal_id === portalFilter) &&
        (!q || j.title.toLowerCase().includes(q) || j.company.toLowerCase().includes(q)),
    );
  }, [jobs, tab, showHidden, portalFilter, search]);

  const openJob = (jobs ?? []).find((j) => j.id === openId) ?? null;
  const pickedNames = portals.filter((p) => picks.has(p.id)).map((p) => p.name);

  const runSummary = () => {
    if (!run) return "Not checked yet";
    if (syncing) return "Checking your mail…";
    if (run.status === "failed") return run.error ?? "The last check failed";
    const parts = [`${run.jobs_added} new`, `${run.jobs_seen_again} seen again`];
    if (run.mails_failed) parts.push(`${run.mails_failed} could not be read`);
    return `Last checked ${dateTime(run.finished_at ?? run.started_at)} · ${parts.join(", ")}`;
  };

  let empty: string | null = null;
  if (jobs && visible.length === 0) {
    if (jobs.length === 0) {
      if (syncing) empty = "Reading your alert mails. Jobs will appear here in a moment.";
      else if (!run) empty = "Your mail has not been checked yet. Press Sync now.";
      else empty = `No job alert mails found in the last 14 days from ${pickedNames.join(" or ") || "your portals"}.`;
    } else if (search || portalFilter) empty = "No jobs match this filter.";
    else if (tab === "new") empty = "Nothing new. You are all caught up.";
    else empty = `No jobs under ${TABS.find((t) => t.key === tab)!.label} yet.`;
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">TPF Job Tracker</div>
        <div className="sync-line" aria-live="polite">
          {runSummary()}
        </div>
        <div className="topbar-actions">
          <button className="btn primary" onClick={onSyncNow} disabled={syncing || conn.status !== "active"}>
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button className="btn" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      </header>

      {conn.status !== "active" && (
        <div className="banner error row">
          <span>Gmail access has expired. Connect it again to keep getting new jobs.</span>
          <button className="btn primary" onClick={() => void signInWithGoogle()}>
            Connect Gmail again
          </button>
        </div>
      )}
      {loadErr && <div className="banner error">{loadErr}</div>}

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? "tab active" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label} <span className="count">{counts[t.key]}</span>
          </button>
        ))}
      </nav>

      <div className="filters">
        <input
          className="input"
          type="search"
          placeholder="Search role or company"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search role or company"
        />
        <select className="input" value={portalFilter} onChange={(e) => setPortalFilter(e.target.value)} aria-label="Portal">
          <option value="">All portals</option>
          {portals
            .filter((p) => p.state === "supported")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        {tab === "all" && (
          <label className="check">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show not interested
          </label>
        )}
        <div className="seg" role="group" aria-label="View">
          {(["list", "card"] as const).map((v) => (
            <button
              key={v}
              className={view === v ? "seg-btn active" : "seg-btn"}
              aria-pressed={view === v}
              onClick={() => {
                setView(v);
                writePref("jt.view", v);
              }}
            >
              {v === "list" ? "List" : "Cards"}
            </button>
          ))}
        </div>
      </div>

      {jobs === null && !loadErr && <div className="empty">Loading jobs…</div>}
      {empty && <div className="empty">{empty}</div>}

      {jobs && visible.length > 0 && view === "list" && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Company</th>
                <th>Location</th>
                <th>Portal</th>
                <th>Date</th>
                <th>Easy apply</th>
                <th>Status</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((j) => (
                <tr key={j.id}>
                  <td>
                    <button className="title-link" onClick={() => setOpenId(j.id)}>
                      {j.title}
                    </button>
                    {j.seen_count > 1 && <span className="seen">Seen in {j.seen_count} alerts</span>}
                  </td>
                  <td>{j.company}</td>
                  <td>{j.location ?? <span className="muted">Not stated</span>}</td>
                  <td>{portalName.get(j.portal_id) ?? ""}</td>
                  <td>{dateCell(j)}</td>
                  <td>{j.easy_apply === null ? "" : j.easy_apply ? "Yes" : "No"}</td>
                  <td>
                    <StatusSelect job={j} onChange={(s) => void setStatus(j, s)} />
                  </td>
                  <td className="actions">
                    <RowActions job={j} onStatus={setStatus} onComplete={completeRound} onNext={nextRound} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {jobs && visible.length > 0 && view === "card" && (
        <div className="cards">
          {visible.map((j) => (
            <article className="card" key={j.id}>
              <button className="title-link" onClick={() => setOpenId(j.id)}>
                {j.title}
              </button>
              <div className="card-company">{j.company}</div>
              <div className="card-meta">
                <span>{j.location ?? "Location not stated"}</span>
                <span>{portalName.get(j.portal_id) ?? ""}</span>
                <span>{dateCell(j)}</span>
                {j.easy_apply && <span>Easy apply</span>}
                {j.seen_count > 1 && <span>Seen in {j.seen_count} alerts</span>}
              </div>
              <div className="card-row">
                <StatusSelect job={j} onChange={(s) => void setStatus(j, s)} />
                <RowActions job={j} onStatus={setStatus} onComplete={completeRound} onNext={nextRound} />
              </div>
            </article>
          ))}
        </div>
      )}

      {failed && failed.length > 0 && (
        <div className="failed">
          <button className="btn link" onClick={() => setShowFailed((s) => !s)}>
            {failed.length} mail{failed.length === 1 ? "" : "s"} could not be read {showFailed ? "▴" : "▾"}
          </button>
          {showFailed && (
            <ul className="failed-list">
              {failed.map((m) => (
                <li key={m.id}>
                  <strong>{m.subject ?? "(no subject)"}</strong>
                  <span className="muted">
                    {m.sender} · {shortDate(m.received_at)} · tried {m.attempts} time{m.attempts === 1 ? "" : "s"}
                  </span>
                  <span>{m.error}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {openJob && (
        <JobDrawer
          job={openJob}
          portal={portalName.get(openJob.portal_id) ?? ""}
          onClose={() => setOpenId(null)}
          onStatus={setStatus}
          onComplete={completeRound}
          onNext={nextRound}
          onSaved={(saved) => setJobs((list) => (list ?? []).map((x) => (x.id === saved.id ? saved : x)))}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.prev && (
            <button className="btn link" onClick={undo}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function dateCell(j: Job): string {
  if (j.posted_at) return `Posted ${shortDate(j.posted_at)}`;
  if (j.posted_text) return `Posted ${j.posted_text}`;
  return `Alert received ${shortDate(j.last_seen_at)}`;
}

function StatusSelect({ job, onChange }: { job: Job; onChange: (s: Status) => void }) {
  return (
    <span className="status-wrap">
      <select
        className={`status status-${job.status}`}
        value={job.status}
        onChange={(e) => onChange(e.target.value as Status)}
        aria-label={`Status for ${job.title}`}
      >
        {ALL_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      {(job.status === "screening" || ((job.status === "rejected" || job.status === "ghosted") && job.round_no)) && (
        <span className="round">{statusText(job)}</span>
      )}
    </span>
  );
}

type ActionProps = {
  job: Job;
  onStatus: (job: Job, s: Status) => void;
  onComplete: (job: Job) => void;
  onNext: (job: Job) => void;
};

function RowActions({ job, onStatus, onComplete, onNext }: ActionProps) {
  return (
    <span className="row-actions">
      <a className="btn small" href={job.job_url} target="_blank" rel="noopener noreferrer">
        Open job
      </a>
      {job.status === "new" && (
        <>
          <button className="btn small primary" onClick={() => onStatus(job, "applied")}>
            Applied
          </button>
          <button className="btn small" onClick={() => onStatus(job, "not_interested")}>
            Not interested
          </button>
        </>
      )}
      {job.status === "screening" && job.round_state === "in_progress" && (
        <button className="btn small primary" onClick={() => onComplete(job)}>
          Mark round completed
        </button>
      )}
      {job.status === "screening" && job.round_state === "completed" && (
        <button className="btn small primary" onClick={() => onNext(job)}>
          Start next round
        </button>
      )}
    </span>
  );
}

function eventText(e: JobEvent): string {
  const to = statusText({ status: e.to_status, round_no: e.to_round_no, round_state: e.to_round_state });
  if (!e.from_status) return "Added from an alert mail";
  return `Changed to ${to}`;
}

function JobDrawer(
  props: ActionProps & { portal: string; onClose: () => void; onSaved: (job: Job) => void },
) {
  const { job, portal, onClose, onSaved } = props;
  const [events, setEvents] = useState<JobEvent[] | null>(null);
  const [jd, setJd] = useState(job.jd_text ?? "");
  const [jdState, setJdState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setJd(job.jd_text ?? "");
    setJdState("idle");
  }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    void supabase
      .from("job_events")
      .select("id, from_status, to_status, from_round_no, to_round_no, from_round_state, to_round_state, cause, created_at")
      .eq("job_id", job.id)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (live) setEvents((data ?? []) as JobEvent[]);
      });
    return () => {
      live = false;
    };
  }, [job.id, job.status_changed_at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saveJd = async () => {
    const value = jd.trim() === "" ? null : jd;
    if (value === (job.jd_text ?? null)) return;
    setJdState("saving");
    const { data, error } = await supabase.from("jobs").update({ jd_text: value }).eq("id", job.id).select(JOB_COLS).single();
    if (error || !data) setJdState("error");
    else {
      setJdState("saved");
      onSaved(data as Job);
    }
  };

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={job.title}>
        <div className="drawer-head">
          <div>
            <h2>{job.title}</h2>
            <div className="card-company">{job.company}</div>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <dl className="kv">
          <dt>Location</dt>
          <dd>{job.location ?? "Not stated"}</dd>
          <dt>Portal</dt>
          <dd>{portal}</dd>
          <dt>Date</dt>
          <dd>{dateCell(job)}</dd>
          <dt>Easy apply</dt>
          <dd>{job.easy_apply === null ? "Not stated in the alert" : job.easy_apply ? "Yes" : "No"}</dd>
          <dt>Seen in</dt>
          <dd>
            {job.seen_count} alert{job.seen_count === 1 ? "" : "s"}, first on {shortDate(job.first_seen_at)}
          </dd>
        </dl>
        <div className="card-row">
          <StatusSelect job={job} onChange={(s) => props.onStatus(job, s)} />
          <RowActions job={job} onStatus={props.onStatus} onComplete={props.onComplete} onNext={props.onNext} />
        </div>

        <h3>Job description</h3>
        <textarea
          className="input jd"
          value={jd}
          maxLength={50000}
          placeholder="Paste the job description here."
          onChange={(e) => {
            setJd(e.target.value);
            setJdState("idle");
          }}
          onBlur={() => void saveJd()}
        />
        <div className="muted small-text">
          {jdState === "saving" && "Saving…"}
          {jdState === "saved" && "Saved"}
          {jdState === "error" && "Could not save. Click outside the box to try again."}
          {jdState === "idle" && "Saved automatically when you click outside the box."}
        </div>

        <h3>History</h3>
        {events === null ? (
          <div className="muted">Loading…</div>
        ) : (
          <ul className="history">
            {events.map((e) => (
              <li key={e.id}>
                <span>{eventText(e)}</span>
                <span className="muted">{dateTime(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
