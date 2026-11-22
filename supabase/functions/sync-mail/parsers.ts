// parsers.ts | version 1.0 | Rule-based parsers for job alert mails. No AI.
// Works on the plain-text part of the mail, which is far more stable than the HTML.

export type ParsedJob = {
  title: string;
  company: string;
  location: string | null;
  job_url: string;
  raw_url: string;
  external_job_id: string | null;
  posted_at: string | null;
  posted_text: string | null;
  easy_apply: boolean | null;
};

export type MailInput = { sender: string; subject: string; text: string };

export type Classification =
  | { kind: "alert" }
  | { kind: "not_alert"; reason: string };

export type ParseResult = { jobs: ParsedJob[]; dropped: number };

const clean = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// ---------- LinkedIn ----------

const LI_VIEW_JOB = /^View job:\s*(https?:\/\/\S+)/i;
const LI_JOB_ID = /\/jobs\/view\/(\d+)/;

export function classifyLinkedIn(mail: MailInput): Classification {
  const subject = mail.subject.trim();
  if (/^your application/i.test(subject)) {
    return { kind: "not_alert", reason: "Application confirmation, not a job alert" };
  }
  if (!/^View job:/im.test(mail.text)) {
    return { kind: "not_alert", reason: "No job listings in this mail" };
  }
  return { kind: "alert" };
}

export function parseLinkedIn(mail: MailInput): ParseResult {
  const jobs: ParsedJob[] = [];
  let dropped = 0;
  const blocks = mail.text.replace(/\r\n/g, "\n").split(/^\s*-{10,}\s*$/m);

  for (const block of blocks) {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => LI_VIEW_JOB.test(l.trim()));
    if (idx === -1) continue;

    const rawUrl = lines[idx].trim().match(LI_VIEW_JOB)![1];
    const idMatch = rawUrl.match(LI_JOB_ID);

    // Group the lines above "View job" into paragraphs split by blank lines.
    const paragraphs: string[][] = [[]];
    for (const l of lines.slice(0, idx)) {
      if (l.trim() === "") {
        if (paragraphs[paragraphs.length - 1].length) paragraphs.push([]);
      } else {
        paragraphs[paragraphs.length - 1].push(clean(l));
      }
    }
    const nonEmpty = paragraphs.filter((p) => p.length);
    const endedWithBlank = paragraphs[paragraphs.length - 1].length === 0;

    // The paragraph touching "View job" is either the job card itself (3 lines)
    // or a one-line note such as "2 connections". In the second case the job
    // card is the paragraph before it.
    let card: string[] | undefined;
    let note: string[] = [];
    const last = nonEmpty[nonEmpty.length - 1];
    if (!last) {
      dropped++;
      continue;
    }
    if (!endedWithBlank && last.length <= 1 && nonEmpty.length >= 2) {
      note = last;
      card = nonEmpty[nonEmpty.length - 2];
    } else {
      card = last;
    }

    card = card.filter(
      (l) =>
        !/^your job alert for/i.test(l) &&
        !/^recommendations based on/i.test(l) &&
        !/^expand your search/i.test(l),
    );
    const fields = card.slice(-3);
    const [title, company, location] = fields;

    if (!title || !company || !idMatch) {
      dropped++;
      continue;
    }

    const blockText = block.toLowerCase();
    jobs.push({
      title,
      company,
      location: location ?? null,
      job_url: `https://www.linkedin.com/jobs/view/${idMatch[1]}`,
      raw_url: rawUrl,
      external_job_id: idMatch[1],
      posted_at: null,
      posted_text: null,
      easy_apply: /easy apply/.test(blockText) || note.some((n) => /easy apply/i.test(n))
        ? true
        : null,
    });
  }
  return { jobs, dropped };
}

// ---------- Cutshort ----------

const CS_HEAD = /^\s*\d+\.\s+(.+)\s+\|\s+(.+)$/;
const CS_APPLY = /^\s*Apply:\s*(https?:\/\/\S+)/i;

export function classifyCutshort(mail: MailInput): Classification {
  if (!/^\s*Apply:\s*https?:\/\/cutshort\.io\/job\//im.test(mail.text)) {
    return { kind: "not_alert", reason: "No job listings in this mail" };
  }
  return { kind: "alert" };
}

export function parseCutshort(mail: MailInput): ParseResult {
  const jobs: ParsedJob[] = [];
  let dropped = 0;
  const lines = mail.text.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const apply = lines[i].match(CS_APPLY);
    if (!apply) continue;
    const rawUrl = apply[1];

    // Walk back to the numbered heading for this job.
    let head: RegExpMatchArray | null = null;
    for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
      const m = clean(lines[j]).match(/^\d+\.\s+(.+)$/);
      if (m) {
        head = clean(lines[j]).match(CS_HEAD);
        if (!head) head = [m[0], m[1], ""] as unknown as RegExpMatchArray;
        break;
      }
    }
    if (!head) {
      dropped++;
      continue;
    }
    const left = head[1];
    const right = head[2] ?? "";
    const at = left.lastIndexOf(" at ");
    const title = at > 0 ? left.slice(0, at).trim() : "";
    const company = at > 0 ? left.slice(at + 4).trim() : "";
    const location = right ? right.split("•")[0].trim() || null : null;

    let jobUrl = rawUrl;
    let externalId: string | null = null;
    try {
      const u = new URL(rawUrl);
      jobUrl = `${u.origin}${u.pathname}`;
      const slug = u.pathname.split("/").filter(Boolean).pop() ?? "";
      externalId = slug.split("-").pop() || null;
    } catch (_) { /* keep raw url */ }

    if (!title || !company) {
      dropped++;
      continue;
    }
    jobs.push({
      title,
      company,
      location,
      job_url: jobUrl,
      raw_url: rawUrl,
      external_job_id: externalId,
      posted_at: null,
      posted_text: null,
      easy_apply: null,
    });
  }
  return { jobs, dropped };
}

// ---------- Registry ----------

export const PARSERS: Record<
  string,
  { classify: (m: MailInput) => Classification; parse: (m: MailInput) => ParseResult }
> = {
  linkedin: { classify: classifyLinkedIn, parse: parseLinkedIn },
  cutshort: { classify: classifyCutshort, parse: parseCutshort },
};

export function dedupeKey(portalKey: string, job: ParsedJob): string {
  if (job.external_job_id) return `${portalKey}:${job.external_job_id}`;
  const norm = [job.title, job.company, job.location ?? ""]
    .map((s) => s.toLowerCase().trim())
    .join("|");
  return `${portalKey}:${norm}`;
}
