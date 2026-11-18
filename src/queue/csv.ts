import type { QueueJob } from './types';

// CSV -> queue jobs. Columns (header row, any order, case-insensitive):
//   url (required; also "link", "apply link", "application link"), company, title, profile

/** RFC 4180-ish: quoted fields, "" escapes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const COLUMN: Record<string, keyof Pick<QueueJob, 'url' | 'company' | 'title' | 'profile'>> = {
  url: 'url',
  link: 'url',
  'apply link': 'url',
  'apply url': 'url',
  'application link': 'url',
  'job url': 'url',
  company: 'company',
  employer: 'company',
  title: 'title',
  'job title': 'title',
  role: 'title',
  position: 'title',
  profile: 'profile',
  resume: 'profile',
};

export interface CsvJob {
  url: string;
  company?: string;
  title?: string;
  profile?: string;
}

/** Rows -> jobs. Without a header row, every cell that looks like a link is a job. */
export function jobsFromCsv(text: string): { jobs: CsvJob[]; skipped: number } {
  const rows = parseCsv(text);
  if (!rows.length) return { jobs: [], skipped: 0 };
  const header = rows[0].map((h) => COLUMN[h.trim().toLowerCase()]);
  const jobs: CsvJob[] = [];
  let skipped = 0;
  if (header.includes('url')) {
    for (const r of rows.slice(1)) {
      const j: Partial<CsvJob> = {};
      header.forEach((k, i) => {
        if (k && r[i]?.trim()) j[k] = r[i].trim();
      });
      if (j.url && isLink(j.url)) jobs.push(j as CsvJob);
      else skipped++;
    }
  } else {
    for (const r of rows) for (const c of r) if (isLink(c.trim())) jobs.push({ url: c.trim() });
  }
  return { jobs, skipped };
}

export function isLink(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Same posting? Ignores tracking parameters and trailing slashes. */
export function sameJob(a: string, b: string): boolean {
  const key = (s: string) => {
    try {
      const u = new URL(s);
      for (const p of Array.from(u.searchParams.keys())) if (/^(utm_|ref|source|src|gh_src|trk|refId|trackingId)/i.test(p)) u.searchParams.delete(p);
      return `${u.host}${u.pathname.replace(/\/+$/, '')}?${u.searchParams.toString()}`.toLowerCase();
    } catch {
      return s.toLowerCase();
    }
  };
  return key(a) === key(b);
}
