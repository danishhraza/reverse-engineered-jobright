import { actorInput, DEFAULT_SEARCH, monthlyUsage, runSearch, SUPPORTED_ATS, toJobs, type JobSearch } from '../src/jobs/apify';

// Find jobs: Fantastic.jobs' Career Site Job Listing API on Apify, through its REST API.

const search = (patch: Partial<JobSearch> = {}): JobSearch => ({ ...DEFAULT_SEARCH, titles: ['Software Engineer'], ...patch });

describe('what is sent to Apify', () => {
  it('maps the form to the actor input, leaving out filters that filter nothing', () => {
    expect(actorInput(search())).toEqual({
      timeRange: '24h',
      limit: 20,
      descriptionType: 'text',
      removeAgency: true,
      titleSearch: ['Software Engineer'],
      locationSearch: ['United States'],
      aiExperienceLevelFilter: ['0-2'],
      ats: SUPPORTED_ATS,
    });
    const wide = actorInput(search({ work: ['onsite', 'hybrid', 'remote'], experience: [], supportedOnly: false, locations: [], count: 3 }));
    expect(wide).not.toHaveProperty('aiWorkArrangementFilter');
    expect(wide).not.toHaveProperty('aiExperienceLevelFilter');
    expect(wide).not.toHaveProperty('ats');
    expect(wide).not.toHaveProperty('locationSearch');
    expect(wide.limit).toBe(10); // the actor's minimum
    expect(actorInput(search({ work: ['remote'] })).aiWorkArrangementFilter).toEqual(['Remote OK', 'Remote Solely']);
  });
});

describe('results into the queue', () => {
  it('keeps one per job, skips ones already queued, and carries the description and profile', () => {
    const items = [
      { url: 'https://job-boards.greenhouse.io/acme/jobs/1', title: 'Software Engineer', organization: 'Acme', description_text: 'Build rockets. $95,000 - $120,000.' },
      { url: 'https://job-boards.greenhouse.io/acme/jobs/1?city=2', title: 'Software Engineer', organization: 'Acme' }, // same job, another city
      { url: 'https://jobs.lever.co/beta/9', title: 'Backend Engineer', organization: 'Beta' }, // already queued
      { url: 'https://acme.wd1.myworkdayjobs.com/x/job/3', title: 'Data Engineer', organization: 'Gamma' },
      { title: 'No link', organization: 'Delta' },
    ];
    const { jobs, repeats } = toJobs(items, 'SWE', [{ title: 'backend engineer', company: 'beta' }]);
    expect(jobs).toEqual([
      { url: 'https://job-boards.greenhouse.io/acme/jobs/1', title: 'Software Engineer', company: 'Acme', jd: 'Build rockets. $95,000 - $120,000.', profile: 'SWE' },
      { url: 'https://acme.wd1.myworkdayjobs.com/x/job/3', title: 'Data Engineer', company: 'Gamma', profile: 'SWE' },
    ]);
    expect(repeats).toBe(2);
  });
});

/** A fake Apify: the run is still going on the first answer, done on the next. */
function fakeApify(opts: { status?: number; finalStatus?: string; items?: unknown[] } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (opts.status) return json({ error: { type: 'x', message: 'nope' } }, opts.status);
    if (url.includes('/acts/')) return json({ data: { id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' } }, 201);
    if (url.includes('/actor-runs/')) return json({ data: { id: 'run1', status: opts.finalStatus ?? 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.12 } });
    if (url.includes('/datasets/')) return json(opts.items ?? [{ url: 'https://jobs.lever.co/a/1', title: 'SWE', organization: 'A' }]);
    if (url.includes('/users/me/limits')) return json({ data: { current: { monthlyUsageUsd: 1.25 }, limits: { maxMonthlyUsageUsd: 5 } } });
    return json({}, 404);
  }) as typeof fetch;
  return { f, calls };
}

describe('running the search', () => {
  it('starts the run with a spending cap, waits for it, and reads its results', async () => {
    const { f, calls } = fakeApify();
    const status: string[] = [];
    const r = await runSearch('tok', search({ maxUsd: 0.3 }), { fetch: f, onStatus: (t) => status.push(t) });
    expect(r.items).toHaveLength(1);
    expect(r.costUsd).toBe(0.12);
    const start = calls[0];
    expect(start.url).toBe('https://api.apify.com/v2/acts/fantastic-jobs~career-site-job-listing-api/runs?waitForFinish=60&maxTotalChargeUsd=0.3&timeout=300');
    expect(start.init?.method).toBe('POST');
    expect((start.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(start.init?.body as string).titleSearch).toEqual(['Software Engineer']);
    expect(calls[1].url).toContain('/actor-runs/run1?waitForFinish=60');
    expect(calls[2].url).toContain('/datasets/ds1/items?clean=true');
    expect(status[0]).toMatch(/Starting/);
  });

  it('says plainly when the token is wrong', async () => {
    const { f } = fakeApify({ status: 401 });
    await expect(runSearch('bad', search(), { fetch: f })).rejects.toThrow(/turned down the API token/);
  });

  it('a failed run with no results is an error; with results, they are used', async () => {
    await expect(runSearch('tok', search(), { fetch: fakeApify({ finalStatus: 'FAILED', items: [] }).f })).rejects.toThrow(/failed on Apify/);
    const r = await runSearch('tok', search(), { fetch: fakeApify({ finalStatus: 'ABORTED' }).f });
    expect(r.items).toHaveLength(1);
  });

  it('reads this month\'s usage, and shrugs when it can\'t', async () => {
    expect(await monthlyUsage('tok', fakeApify().f)).toEqual({ usedUsd: 1.25, limitUsd: 5 });
    expect(await monthlyUsage('tok', fakeApify({ status: 500 }).f)).toBeNull();
  });
});
