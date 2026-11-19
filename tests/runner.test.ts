import { readFileSync } from 'node:fs';
import type { Probe, QueueJob, RunnerState, StepOutcome } from '../src/queue/types';

// The autopilot runner against a fake browser: in-memory storage, fake tabs,
// and a fake page that answers probes and steps the way a content script would.

const local: Record<string, unknown> = {};
const tabs = new Map<number, { id: number; url: string; status: string; windowId: number }>();
let nextTabId = 100;
const sentSteps: { tabId: number; msg: any }[] = [];
const alarms = new Set<string>();
const submitAsks: number[] = [];
let page: (tabId: number, msg: any) => unknown = () => null;

const clone = <T,>(v: T): T => (v === undefined ? v : structuredClone(v));

(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (k: string) => ({ [k]: clone(local[k]) }),
      set: async (o: Record<string, unknown>) => void Object.assign(local, clone(o)),
      remove: async (k: string) => void delete local[k],
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} },
  },
  runtime: { getURL: (p: string) => `chrome-extension://test/${p}`, sendMessage: async () => ({}), lastError: undefined },
  tabs: {
    get: async (id: number) => {
      const t = tabs.get(id);
      if (!t) throw new Error('No tab');
      return { ...t };
    },
    create: async ({ url, windowId }: { url: string; windowId?: number }) => {
      const t = { id: nextTabId++, url, status: 'complete', windowId: windowId ?? 1 };
      tabs.set(t.id, t);
      return { ...t };
    },
    update: async (id: number, p: { url?: string }) => {
      const t = tabs.get(id)!;
      if (p.url) t.url = p.url;
      return { ...t };
    },
    remove: async (id: number) => void tabs.delete(id),
    sendMessage: async (tabId: number, msg: any) => {
      if (msg.type === 'autoStep') sentSteps.push({ tabId, msg });
      if (msg.type === 'submitReady') submitAsks.push(tabId);
      return page(tabId, msg);
    },
  },
  windows: { get: async (id: number) => ({ id }), create: async () => ({ id: 1 }), update: async () => {} },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
  alarms: { create: async (name: string) => void alarms.add(name), clear: async (name: string) => alarms.delete(name) },
  notifications: { create: (_i: string, _o: unknown, cb?: () => void) => cb?.() },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};

const runner = await import('../src/queue/runner');
const store = await import('../src/queue/store');

const queue = () => local.queue as QueueJob[];
const state = () => local.runner as RunnerState;
const job = (i = 0) => queue()[i];

/** What the fake page says it is, per tab. */
const probes = new Map<number, Probe>();
const setPage = (tabId: number, kind: Probe['kind'], detail?: string) => probes.set(tabId, { kind, detail, sig: `${kind}-${tabs.get(tabId)?.url}` });

/** Let queued promise chains (the runner's lock) settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0); // runs zero-delay timers (scheduleNext(0)), not the step timers
    for (let j = 0; j < 20; j++) await Promise.resolve();
  }
};

beforeEach(async () => {
  for (const k of Object.keys(local)) delete local[k];
  tabs.clear();
  probes.clear();
  sentSteps.length = 0;
  alarms.clear();
  submitAsks.length = 0;
  page = (tabId, msg) => (msg.type === 'autoProbe' ? (probes.get(tabId) ?? { kind: 'none', sig: '' }) : msg.type === 'autoStep' ? { ok: true } : null);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  await runner.queueAction({ action: 'add', jobs: [{ url: 'https://jobs.example.com/1', company: 'Acme' }, { url: 'https://jobs.example.com/2?utm_source=x', company: 'Globex' }] });
});

afterEach(() => vi.useRealTimers());

async function start(): Promise<number> {
  await runner.startRunner();
  await settle();
  return job().tabId!;
}

async function result(outcome: StepOutcome): Promise<void> {
  const last = sentSteps.at(-1)!;
  await runner.onStepResult(last.msg.step, outcome, last.tabId);
  await settle();
}

describe('queue', () => {
  it('drops duplicates, ignoring tracking parameters', async () => {
    const r = await runner.queueAction({ action: 'add', jobs: [{ url: 'https://jobs.example.com/2' }, { url: 'https://jobs.example.com/3' }] });
    expect(r).toMatchObject({ added: 1, duplicates: 1 });
    expect(queue()).toHaveLength(3);
  });
});

describe('a job, start to finish', () => {
  it('Apply -> create account -> email code (needs you) -> Continue -> form -> ready', async () => {
    const tab = await start();
    expect(job()).toMatchObject({ status: 'running', attempts: 1 });
    expect(tabs.get(tab)!.url).toBe('https://jobs.example.com/1');

    // Job posting: the page is told to take a step; it opens the Apply link.
    setPage(tab, 'apply', 'Apply now');
    await runner.doStep();
    expect(sentSteps.at(-1)!.msg).toMatchObject({ type: 'autoStep', accountKnown: false, autoSubmit: false });
    await result({ kind: 'acted', action: 'Opened "Apply now"', navigate: 'https://acme.wd1.myworkdayjobs.com/apply' });
    expect(tabs.get(tab)!.url).toBe('https://acme.wd1.myworkdayjobs.com/apply');

    // A step still running blocks a second one (no double fills).
    setPage(tab, 'account');
    await runner.doStep();
    await runner.doStep();
    expect(sentSteps.filter((s) => s.msg.type === 'autoStep')).toHaveLength(2);
    await result({ kind: 'acted', action: 'Created account', accountCreated: true });
    expect(await store.accountCreatedOn('acme.wd1.myworkdayjobs.com')).toBe(true);

    // Email verification: hand it to you, keep the tab, remember where it was.
    tabs.get(tab)!.url = 'https://acme.wd1.myworkdayjobs.com/verify';
    setPage(tab, 'verify', 'Verify your email');
    await runner.doStep();
    expect(job()).toMatchObject({ status: 'needs-you', tabId: tab, resumeUrl: 'https://acme.wd1.myworkdayjobs.com/verify' });
    expect(job().reason).toMatch(/Email verification/);
    expect(state().currentJobId).toBeUndefined();

    // The next job starts after the pause, in its own tab.
    await runner.onAlarm('autopilot-next'); // the pause between jobs is an alarm
    await settle();
    expect(job(1).status).toBe('running');
    const tab2 = job(1).tabId!;
    expect(tab2).not.toBe(tab);
    setPage(tab2, 'closed', 'no longer accepting applications');
    await runner.doStep();
    expect(job(1)).toMatchObject({ status: 'skipped', tabId: undefined });
    expect(tabs.has(tab2)).toBe(false);

    // You entered the code and pressed Continue: it picks up in the same tab, ahead of the queue.
    await runner.queueAction({ action: 'continue', id: job().id });
    await runner.onAlarm('autopilot-next'); // the pause between jobs is an alarm
    await settle();
    expect(job()).toMatchObject({ status: 'running', tabId: tab, attempts: 2 });
    setPage(tab, 'form');
    await runner.doStep();
    expect(sentSteps.at(-1)!.msg.accountKnown).toBe(true);
    await result({ kind: 'ready', reason: 'Ready to submit — review and press Submit' });
    expect(job()).toMatchObject({ status: 'ready', tabId: tab });
    // Two jobs started today (a Continue doesn't count again).
    expect(Object.values(state().startedByDay)[0]).toBe(2);
  });

  it('on a page that keeps coming back, asks the AI once, then hands it to you', async () => {
    const tab = await start();
    setPage(tab, 'apply', 'Apply');
    for (let i = 0; i < 3; i++) {
      await runner.doStep();
      await result({ kind: 'acted', action: 'Clicked "Apply"' });
    }
    // Third time on the same page: the AI gets a go instead of the same click again.
    expect(sentSteps.at(-1)!.msg.mode).toBe('guide');
    await runner.doStep();
    expect(job()).toMatchObject({ status: 'needs-you', reason: expect.stringMatching(/Stuck/) });
  });

  it('waits out a redirect page before deciding anything', async () => {
    const tab = await start();
    setPage(tab, 'loading');
    await runner.doStep();
    vi.setSystemTime(Date.now() + 30000);
    await runner.doStep();
    expect(sentSteps).toHaveLength(0); // still within the 45 s for loading pages
    setPage(tab, 'apply', 'Apply on company site');
    await runner.doStep();
    expect(sentSteps.at(-1)!.msg.mode).toBeUndefined();
  });

  it('a page with nothing to do: waits, asks the AI, then hands it to you', async () => {
    const tab = await start();
    setPage(tab, 'none');
    await runner.doStep();
    expect(sentSteps).toHaveLength(0);
    vi.setSystemTime(Date.now() + 21000);
    await runner.doStep();
    expect(sentSteps.at(-1)!.msg).toMatchObject({ mode: 'guide' });
    await result({ kind: 'acted', action: 'AI: Clicked "Apply Manually"' });
    await runner.doStep();
    expect(job()).toMatchObject({ status: 'needs-you', reason: expect.stringMatching(/Couldn't find/) });
  });

  it('ignores a late result from an old step', async () => {
    const tab = await start();
    setPage(tab, 'form');
    await runner.doStep();
    const old = sentSteps.at(-1)!.msg.step;
    await runner.onPageLoaded(tab, 0); // the page reloaded: that step is over
    await runner.doStep();
    await runner.onStepResult(old, { kind: 'failed', reason: 'old' }, tab);
    expect(job().status).toBe('running');
  });

  it('a closed tab hands the job to you with its link saved', async () => {
    const tab = await start();
    tabs.get(tab)!.url = 'https://jobs.example.com/1/apply/step2';
    setPage(tab, 'form');
    await runner.doStep();
    tabs.delete(tab);
    await runner.onTabRemoved(tab);
    await settle();
    expect(job()).toMatchObject({ status: 'needs-you', tabId: undefined });
  });

  it('respects the daily limit', async () => {
    await store.setAutopilot({ dailyCap: 1 });
    const tab = await start();
    setPage(tab, 'applied', 'Thank you for applying');
    await runner.doStep();
    expect(job().status).toBe('applied');
    await runner.onAlarm('autopilot-next'); // the pause between jobs is an alarm
    await settle();
    expect(job(1).status).toBe('queued');
    expect(state()).toMatchObject({ running: false, pausedReason: expect.stringMatching(/Daily limit/) });
  });

  it('pauses when too many tabs are waiting on you', async () => {
    await store.setAutopilot({ maxHeldTabs: 1 });
    const tab = await start();
    setPage(tab, 'captcha');
    await runner.doStep();
    expect(job().status).toBe('needs-you');
    await runner.onAlarm('autopilot-next'); // the pause between jobs is an alarm
    await settle();
    expect(job(1).status).toBe('queued');
    expect(state().pausedReason).toMatch(/waiting on you/);
  });

  it('Continue starts the runner again and fills only empty fields on that page', async () => {
    const tab = await start();
    tabs.get(tab)!.url = 'https://acme.com/apply/contact';
    setPage(tab, 'form');
    await runner.doStep();
    await result({ kind: 'needs-you', reason: '1 required question(s) need you' });
    await runner.pauseRunner('Queue finished');
    expect(state().running).toBe(false);

    await runner.queueAction({ action: 'continue', id: job().id });
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(state().running).toBe(true);
    expect(job()).toMatchObject({ status: 'running', tabId: tab });
    await runner.doStep();
    expect(sentSteps.at(-1)!.msg).toMatchObject({ onlyEmpty: true });
    // A later page in the same job gets a full fill again.
    await result({ kind: 'acted', action: 'Pressed Next' });
    tabs.get(tab)!.url = 'https://acme.com/apply/questions';
    await runner.doStep();
    expect(sentSteps.at(-1)!.msg).toMatchObject({ onlyEmpty: false });
  });

  it('submits a Ready job for you when you have not got to it in time', async () => {
    await store.setAutopilot({ autoSubmitAfterMin: 30 });
    const tab = await start();
    setPage(tab, 'form');
    await runner.doStep();
    await result({ kind: 'ready', reason: 'Ready to submit' });
    const id = job().id;
    expect(job().submitAt).toBeGreaterThan(Date.now() + 29 * 60000);
    expect(alarms.has(`autopilot-submit:${id}`)).toBe(true);

    await runner.onAlarm(`autopilot-submit:${id}`);
    await settle();
    expect(submitAsks).toEqual([tab]);
    await runner.onReadyResult(id, { kind: 'applied', reason: 'Submitted' });
    expect(job()).toMatchObject({ status: 'applied', reason: expect.stringMatching(/not reviewed in time/), tabId: undefined });
    expect(tabs.has(tab)).toBe(false);
  });

  it('no auto-submit once you have dealt with it yourself', async () => {
    await store.setAutopilot({ autoSubmitAfterMin: 30 });
    const tab = await start();
    setPage(tab, 'form');
    await runner.doStep();
    await result({ kind: 'ready', reason: 'Ready to submit' });
    const id = job().id;
    await runner.queueAction({ action: 'markApplied', id });
    expect(alarms.has(`autopilot-submit:${id}`)).toBe(false);
    await runner.onAlarm(`autopilot-submit:${id}`);
    await settle();
    expect(submitAsks).toEqual([]);
  });

  it('logs each AI call on the job and adds up tokens and cost', async () => {
    const tab = await start();
    await runner.recordAi(tab, { what: 'Field of Study', result: '"Computer and Information Science" (0.9)', usage: { tokensIn: 1200, tokensOut: 40, cost: 0.00014 } });
    await runner.recordAi(tab, { what: 'Do you have relatives at Trane?', result: '"No" (0.95)', usage: { tokensIn: 1100, tokensOut: 30, cost: 0.00012 } });
    await runner.recordAi(tab, { what: 'Same question again', result: '"No" (0.95, reused)' });
    expect(job().ai).toEqual({ calls: 2, tokensIn: 2300, tokensOut: 70, cost: expect.closeTo(0.00026, 8) });
    expect(job().log.filter((l) => l.includes('AI:'))).toHaveLength(3);
    expect(job().log.find((l) => l.includes('Field of Study'))).toMatch(/1240 tokens · \$0\.00014/);
  });

  it('keeps a full AI log: question, options, answer, and what was done with it', async () => {
    const tab = await start();
    await runner.recordAi(tab, {
      what: 'Have you previously worked in any capacity with Micron?',
      result: '"No" (0.95)',
      options: ['Yes', 'No'],
      answer: 'No',
      confidence: 0.95,
      usage: { tokensIn: 1300, tokensOut: 20, cost: 0.0002 },
    });
    await runner.aiDecided(tab, 'Have you previously worked in any capacity with Micron?', 'Filled in');
    expect(job().aiLog).toEqual([
      expect.objectContaining({ question: 'Have you previously worked in any capacity with Micron?', options: ['Yes', 'No'], answer: 'No', confidence: 0.95, decision: 'Filled in', tokens: 1320, cost: 0.0002 }),
    ]);
  });

  it('keeps a fill log of every page: each field, its value and why', async () => {
    const tab = await start();
    await runner.recordFill(tab, {
      url: 'https://x.icims.com/jobs/1/candidate',
      ats: 'Generic',
      page: 1,
      done: true,
      message: 'Filled 2, 1 need you',
      fields: [
        { id: 'a', label: 'Address', key: 'address1', status: 'filled', confidence: 0.9, value: '3625 Duval Road' },
        { id: 'b', label: 'Password', key: 'password', status: 'filled', confidence: 0.95, value: '••••••••' },
        { id: 'c', label: 'State/Province', key: 'state', status: 'flagged', confidence: 0, reason: 'Dropdown options never appeared' },
      ],
    });
    expect(job().fillLog).toHaveLength(1);
    expect(job().fillLog![0]).toMatchObject({ page: 1, message: 'Filled 2, 1 need you' });
    expect(job().fillLog![0].fields.map((f) => f.status)).toEqual(['filled', 'filled', 'flagged']);
    expect(JSON.stringify(job().fillLog)).not.toContain('pa55-word!');
  });

  it('reads an old model setting without the stray "[1m]"', async () => {
    local.llm = { model: 'anthropic/claude-haiku-5.5[1m]' };
    expect((await store.getLlm()).model).toBe('anthropic/claude-haiku-5.5');
  });

  it('Pause puts the running job back at the front, keeping its tab', async () => {
    const tab = await start();
    await runner.pauseRunner('Paused by you');
    expect(job()).toMatchObject({ status: 'queued', priority: true, tabId: tab });
    expect(state().running).toBe(false);
  });
});

describe('the sample CSV', () => {
  it('parses into jobs with profiles', async () => {
    const { jobsFromCsv } = await import('../src/queue/csv');
    const { jobs } = jobsFromCsv(readFileSync('static/sample-jobs.csv', 'utf8'));
    expect(jobs.length).toBeGreaterThan(3);
    expect(jobs.every((j) => j.url.startsWith('https://') && j.profile)).toBe(true);
  });
});
