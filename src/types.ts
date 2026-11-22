// types.ts | version 1.0
export type Status =
  | "new"
  | "applied"
  | "screening"
  | "offered"
  | "rejected"
  | "ghosted"
  | "not_interested";

export type RoundState = "in_progress" | "completed";

export type Portal = {
  id: string;
  key: string;
  name: string;
  website_url: string;
  state: "supported" | "coming_soon";
  sort_order: number;
};

export type Job = {
  id: string;
  portal_id: string;
  title: string;
  company: string;
  location: string | null;
  job_url: string;
  posted_at: string | null;
  posted_text: string | null;
  easy_apply: boolean | null;
  jd_text: string | null;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  status: Status;
  round_no: number | null;
  round_state: RoundState | null;
  status_changed_at: string;
};

export type JobEvent = {
  id: string;
  from_status: Status | null;
  to_status: Status;
  from_round_no: number | null;
  to_round_no: number | null;
  from_round_state: RoundState | null;
  to_round_state: RoundState | null;
  cause: "system" | "user";
  created_at: string;
};

export type Connection = {
  id: string;
  email: string;
  status: "active" | "needs_reconnect" | "error";
  last_synced_at: string | null;
  last_error: string | null;
};

export type SyncRun = {
  id: string;
  status: "running" | "ok" | "partial" | "failed";
  started_at: string;
  finished_at: string | null;
  mails_seen: number;
  mails_parsed: number;
  mails_skipped: number;
  mails_failed: number;
  jobs_added: number;
  jobs_seen_again: number;
  error: string | null;
};

export type FailedMail = {
  id: string;
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  error: string | null;
  attempts: number;
};

export const STATUS_LABEL: Record<Status, string> = {
  new: "New",
  applied: "Applied",
  screening: "Screening",
  offered: "Offered",
  rejected: "Rejected",
  ghosted: "Ghosted",
  not_interested: "Not interested",
};

export function statusText(j: Pick<Job, "status" | "round_no" | "round_state">): string {
  if (j.status === "screening") {
    return `Screening ${j.round_no ?? 1} ${j.round_state === "completed" ? "completed" : "in progress"}`;
  }
  if ((j.status === "rejected" || j.status === "ghosted") && j.round_no) {
    return `${STATUS_LABEL[j.status]} after Screening ${j.round_no}`;
  }
  return STATUS_LABEL[j.status];
}

export function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function dateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
