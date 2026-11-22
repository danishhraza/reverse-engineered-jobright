// Finding jobs with Fantastic.jobs' "Career Site Job Listing API" on Apify:
// postings straight from company career sites (Greenhouse, Workday, Lever…),
// so each link is the real application page the autofill works on.
//
// One search = one actor run: start it, wait for it (long-polling), then read
// its results. Every call sends a spending cap, and your Apify month-to-date
// usage is shown so you can stay inside the free credit.

export const ACTOR = 'fantastic-jobs~career-site-job-listing-api';
const API = 'https://api.apify.com/v2';

/** Career sites the autofill has been tested on (the actor's own names for them). */
export const SUPPORTED_ATS = ['greenhouse', 'lever.co', 'ashby', 'workday', 'icims', 'taleo', 'oraclecloud', 'phenompeople', 'eightfold', 'trakstar'];

export type WorkArrangement = 'onsite' | 'hybrid' | 'remote';
export type Experience = '0-2' | '2-5' | '5-10' | '10+';

export interface JobSearch {
  titles: string[];
  locations: string[];
  /** How recently the job was found: last hour, day or week. */
  timeRange: '1h' | '24h' | '7d';
  count: number;
  work: WorkArrangement[];
  experience: Experience[];
  /** Only career sites the autofill is tested on. */
  supportedOnly: boolean;
  removeAgency: boolean;
  /** Resume profile to apply with (name); blank = the active one. */
  profile?: string;
  /** Most a single search may cost, in US dollars. */
  maxUsd: number;
}

export interface JobSearchSettings {
  token?: string;
  search: JobSearch;
}

export const DEFAULT_SEARCH: JobSearch = {
  titles: [],
  locations: ['United States'],
  timeRange: '24h',
  count: 20,
  work: [],
  experience: ['0-2'],
  supportedOnly: true,
  removeAgency: true,
  maxUsd: 0.5,
};

const WORK: Record<WorkArrangement, string[]> = { onsite: ['On-site'], hybrid: ['Hybrid'], remote: ['Remote OK', 'Remote Solely'] };

/** The actor's input for a search. Empty filters are left out (no filter). */
export function actorInput(s: JobSearch): Record<string, unknown> {
  const input: Record<string, unknown> = {
    timeRange: s.timeRange,
    limit: Math.max(10, Math.min(500, Math.round(s.count))),
    descriptionType: 'text',
    removeAgency: s.removeAgency,
  };
  const list = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  if (list(s.titles).length) input.titleSearch = list(s.titles);
  if (list(s.locations).length) input.locationSearch = list(s.locations);
  if (s.work.length && s.work.length < 3) input.aiWorkArrangementFilter = s.work.flatMap((w) => WORK[w]);
  if (s.experience.length && s.experience.length < 4) input.aiExperienceLevelFilter = s.experience;
  if (s.supportedOnly) input.ats = SUPPORTED_ATS;
  return input;
}

/** One posting as the actor returns it (only the fields we use). */
export interface ApifyJob {
  url?: string;
  title?: string;
  organization?: string;
  source?: string;
  description_text?: string;
  locations_derived?: unknown;
  date_posted?: string;
}

export interface FoundJob {
  url: string;
  title?: string;
  company?: string;
  jd?: string;
  profile?: string;
}

const key = (title?: string, company?: string) => `${(title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}|${(company ?? '').toLowerCase().trim()}`;

/**
 * Results -> queue jobs. The same job is often listed once per city: keep the
 * first. Jobs already in the queue (same title at the same company) are left out.
 */
export function toJobs(items: ApifyJob[], profile: string | undefined, queued: { title?: string; company?: string }[]): { jobs: FoundJob[]; repeats: number } {
  const seen = new Set(queued.filter((j) => j.title && j.company).map((j) => key(j.title, j.company)));
  const jobs: FoundJob[] = [];
  let repeats = 0;
  for (const it of items) {
    if (!it.url || !/^https?:\/\//.test(it.url)) continue;
    const k = key(it.title, it.organization);
    if (it.title && it.organization && seen.has(k)) {
      repeats++;
      continue;
    }
    seen.add(k);
    jobs.push({
      url: it.url,
      title: it.title?.trim() || undefined,
      company: it.organization?.trim() || undefined,
      jd: it.description_text?.slice(0, 20000) || undefined,
      ...(profile ? { profile } : {}),
    });
  }
  return { jobs, repeats };
}

type Fetch = typeof fetch;

export interface RunResult {
  items: ApifyJob[];
  status: string;
  /** What Apify reports the run cost, when it does. */
  costUsd?: number;
}

export class ApifyError extends Error {}

async function call<T>(f: Fetch, token: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await f(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  } catch {
    throw new ApifyError("Couldn't reach Apify. Check your internet connection.");
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string; type?: string } } | unknown[] | null;
  if (!res.ok) {
    const err = body && !Array.isArray(body) ? body.error : undefined;
    if (res.status === 401) throw new ApifyError('Apify turned down the API token. Copy it again from Apify → Settings → API & Integrations.');
    if (res.status === 402 || /limit|credit|usage/i.test(err?.type ?? '')) throw new ApifyError(`Apify says you're out of credit for this month: ${err?.message ?? res.statusText}`);
    throw new ApifyError(`Apify said: ${err?.message ?? `${res.status} ${res.statusText}`}`);
  }
  return (Array.isArray(body) ? body : (body as { data?: unknown })?.data ?? body) as T;
}

interface Run {
  id: string;
  status: string;
  defaultDatasetId: string;
  usageTotalUsd?: number;
}

const FINISHED = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'];

/** Start the actor, wait for it to finish (up to `maxWaitSec`), and read its results. */
export async function runSearch(
  token: string,
  search: JobSearch,
  opts: { fetch?: Fetch; onStatus?: (text: string) => void; maxWaitSec?: number } = {},
): Promise<RunResult> {
  const f = opts.fetch ?? fetch.bind(globalThis);
  const say = opts.onStatus ?? (() => {});
  const cap = Math.max(0.05, search.maxUsd);
  say('Starting the search on Apify…');
  let run = await call<Run>(f, token, `/acts/${ACTOR}/runs?waitForFinish=60&maxTotalChargeUsd=${cap}&timeout=300`, {
    method: 'POST',
    body: JSON.stringify(actorInput(search)),
  });
  const started = Date.now();
  const maxWait = (opts.maxWaitSec ?? 360) * 1000;
  while (!FINISHED.includes(run.status)) {
    if (Date.now() - started > maxWait) throw new ApifyError(`The search is still running on Apify after ${Math.round(maxWait / 60000)} minutes. Its results will be in your Apify console under Runs.`);
    say(`Searching… (${Math.round((Date.now() - started) / 1000)}s)`);
    run = await call<Run>(f, token, `/actor-runs/${run.id}?waitForFinish=60`);
  }
  say('Reading the results…');
  const items = await call<ApifyJob[]>(f, token, `/datasets/${run.defaultDatasetId}/items?clean=true&format=json`);
  if (run.status !== 'SUCCEEDED' && !items.length) throw new ApifyError(`The search ${run.status.toLowerCase().replace('-', ' ')} on Apify with no results.`);
  return { items, status: run.status, costUsd: typeof run.usageTotalUsd === 'number' ? run.usageTotalUsd : undefined };
}

export interface Usage {
  usedUsd: number;
  limitUsd?: number;
}

/** Your Apify spending this month, and your monthly limit, when Apify reports them. */
export async function monthlyUsage(token: string, f: Fetch = fetch.bind(globalThis)): Promise<Usage | null> {
  try {
    const d = await call<{ current?: { monthlyUsageUsd?: number }; limits?: { maxMonthlyUsageUsd?: number } }>(f, token, '/users/me/limits');
    const used = d?.current?.monthlyUsageUsd;
    if (typeof used !== 'number') return null;
    const limit = d?.limits?.maxMonthlyUsageUsd;
    return { usedUsd: used, limitUsd: typeof limit === 'number' ? limit : undefined };
  } catch {
    return null;
  }
}
