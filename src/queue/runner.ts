import { sameJob } from './csv';
import { accountCreatedOn, getAutopilot, getQueue, getRunner, locked, markAccountCreated, saveQueue, saveRunner, today } from './store';
import { PROBE_RANK, type FillLogEntry, type JobStatus, type Probe, type QueueJob, type RunnerState, type StepOutcome } from './types';
import type { FillReport } from '../types';

// Autopilot, background side. One job at a time, each in its own tab in a
// separate "Autopilot" window:
//   open the link -> ask every frame what it sees -> tell the right frame to
//   take one step (click Apply, sign in, fill up to Submit) -> repeat on each
//   page load -> finish as applied / ready / needs-you / skipped / failed.
// A job that needs you keeps its tab, and Continue picks up in that tab (or
// at its saved link if you closed it). All state lives in storage, so it
// survives the service worker being stopped.

const MAX_STEPS = 40;
const STUCK_REPEATS = 3;
/** How long to keep checking a page with nothing to do (slow to render), and a "redirecting / please wait" page. */
const NOTHING_WAIT_MS = 20000;
const LOADING_WAIT_MS = 45000;
const ALARM_NEXT = 'autopilot-next';
const ALARM_TIMEOUT = 'autopilot-timeout';
const ALARM_STEP = 'autopilot-step';

const HELD: JobStatus[] = ['needs-you', 'ready'];

// ---------- small helpers ----------

const now = () => Date.now();
const rand = (lo: number, hi: number) => lo + Math.random() * Math.max(0, hi - lo);

async function tabAlive(tabId?: number): Promise<chrome.tabs.Tab | null> {
  if (tabId === undefined) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function log(job: QueueJob, line: string): void {
  const t = new Date().toTimeString().slice(0, 5);
  job.log = [...(job.log ?? []), `${t} ${line}`].slice(-60);
  job.updatedAt = now();
}

async function update(jobId: string, fn: (j: QueueJob) => void): Promise<QueueJob | undefined> {
  const q = await getQueue();
  const j = q.find((x) => x.id === jobId);
  if (!j) return undefined;
  fn(j);
  j.updatedAt = now();
  await saveQueue(q);
  return j;
}

function notify(title: string, message: string): void {
  chrome.notifications?.create(`autopilot-${now()}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 1 }, () => {
    void chrome.runtime.lastError; // notifications turned off for Chrome: nothing to do
  });
}

async function setBadge(): Promise<void> {
  const q = await getQueue();
  const waiting = q.filter((j) => HELD.includes(j.status)).length;
  chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }).catch(() => {});
  chrome.action.setBadgeText({ text: waiting ? String(waiting) : '' }).catch(() => {});
}

// ---------- start / pause ----------

export function startRunner(): Promise<void> {
  return locked(async () => {
    const st = await getRunner();
    st.running = true;
    st.pausedReason = undefined;
    await saveRunner(st);
  }).then(() => scheduleNext(0));
}

/** Stop now. The job in progress goes back to the front of the queue, keeping its tab. */
export function pauseRunner(reason?: string): Promise<void> {
  return locked(async () => {
    const st = await getRunner();
    st.running = false;
    st.pausedReason = reason;
    const id = st.currentJobId;
    st.currentJobId = undefined;
    st.inFlight = undefined;
    st.step++;
    await saveRunner(st);
    await chrome.alarms.clear(ALARM_NEXT);
    await chrome.alarms.clear(ALARM_TIMEOUT);
    await chrome.alarms.clear(ALARM_STEP);
    if (id) {
      const j = await update(id, (j) => {
        j.status = 'queued';
        j.priority = true;
        log(j, 'Paused — will continue here');
      });
      if (j?.tabId !== undefined) chrome.webNavigation.getAllFrames({ tabId: j.tabId }).then((fs) => fs?.forEach((f) => chrome.tabs.sendMessage(j.tabId!, { type: 'cancel' }, { frameId: f.frameId }).catch(() => {})));
    }
  });
}

// Short waits use a timer while the worker is awake; an alarm (which survives the
// worker being stopped, but fires no sooner than 30 s) is the backstop.
let nextTimer: ReturnType<typeof setTimeout> | undefined;
let stepTimer: ReturnType<typeof setTimeout> | undefined;

async function scheduleNext(delayMs: number): Promise<void> {
  clearTimeout(nextTimer);
  if (delayMs < 25000) {
    nextTimer = setTimeout(() => void nextJob(), Math.max(0, delayMs));
    await chrome.alarms.create(ALARM_NEXT, { when: now() + delayMs + 30000 });
  } else {
    await chrome.alarms.create(ALARM_NEXT, { when: now() + delayMs });
  }
}

async function scheduleStep(delayMs: number): Promise<void> {
  clearTimeout(stepTimer);
  if (delayMs < 25000) {
    stepTimer = setTimeout(() => void doStep(), delayMs);
    await chrome.alarms.create(ALARM_STEP, { when: now() + delayMs + 30000 });
  } else {
    await chrome.alarms.create(ALARM_STEP, { when: now() + delayMs });
  }
}

/** The window jobs open in, created on first use. */
async function runnerWindow(st: RunnerState): Promise<number> {
  if (st.windowId !== undefined) {
    try {
      await chrome.windows.get(st.windowId);
      return st.windowId;
    } catch {
      // closed
    }
  }
  const w = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal', width: 1280, height: 900 });
  st.windowId = w!.id!;
  // Keep the placeholder tab so the window stays open between jobs.
  return st.windowId;
}

// ---------- picking and starting a job ----------

function nextJob(): Promise<void> {
  return locked(async () => {
    const st = await getRunner();
    if (!st.running || st.currentJobId) return;
    const [q, ap] = await Promise.all([getQueue(), getAutopilot()]);

    let held = 0;
    for (const j of q) if (HELD.includes(j.status) && (await tabAlive(j.tabId))) held++;
    if (held >= ap.maxHeldTabs) return pause(st, `${held} jobs are waiting on you — clear some, then press Start`);

    const candidates = q.filter((j) => j.status === 'queued');
    const job = candidates.find((j) => j.priority) ?? candidates[0];
    if (!job) {
      notify('Autopilot finished', 'The queue is empty.');
      return pause(st, 'Queue finished');
    }
    const day = today();
    const fresh = !job.startedAt;
    if (fresh && (st.startedByDay[day] ?? 0) >= ap.dailyCap) return pause(st, `Daily limit reached (${ap.dailyCap}) — raise it in Options or start again tomorrow`);

    // Continue in the tab it stopped in if it's still open; else from its saved link.
    let tab = await tabAlive(job.tabId);
    const windowId = await runnerWindow(st);
    if (!tab) tab = await chrome.tabs.create({ windowId, url: job.resumeUrl ?? job.url, active: true });
    else chrome.tabs.update(tab.id!, { active: true }).catch(() => {});
    // Continuing where you left off: on that page, fill only what's still empty, so your fixes stay.
    st.keepUrl = fresh ? undefined : tab.url;

    if (fresh) st.startedByDay = { [day]: (st.startedByDay[day] ?? 0) + 1 }; // keep only today
    st.currentJobId = job.id;
    st.jobSteps = 0;
    st.seen = [];
    st.waitSince = undefined;
    st.guided = [];
    st.inFlight = undefined;
    st.step++;
    await saveRunner(st);

    job.status = 'running';
    job.priority = false;
    job.tabId = tab.id;
    job.startedAt ??= now();
    job.attempts = (job.attempts ?? 0) + 1;
    log(job, fresh ? `Opened ${job.url}` : `Continuing at ${tab.url || job.resumeUrl || job.url}`);
    await saveQueue(q);
    await setBadge();

    await chrome.alarms.create(ALARM_TIMEOUT, { when: now() + ap.jobTimeoutMin * 60000 });
    // A fresh tab's load event starts the first step; an existing tab gets a nudge.
    await scheduleStep(tab.status === 'complete' && !fresh ? 1500 : 8000);
  });
}

async function pause(st: RunnerState, reason: string): Promise<void> {
  st.running = false;
  st.pausedReason = reason;
  await saveRunner(st);
}

// ---------- one step ----------

async function probeFrames(tabId: number): Promise<{ frameId: number; probe: Probe }[]> {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [{ frameId: 0 }];
  const results = await Promise.all(
    frames.map((f) =>
      Promise.race([
        chrome.tabs.sendMessage(tabId, { type: 'autoProbe' }, { frameId: f.frameId }).catch(() => null) as Promise<Probe | null>,
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]).then((probe) => (probe ? { frameId: f.frameId, probe } : null)),
    ),
  );
  return results.filter((x): x is { frameId: number; probe: Probe } => !!x);
}

export function doStep(): Promise<void> {
  return locked(async () => {
    const st = await getRunner();
    if (!st.running || !st.currentJobId) return;
    const q = await getQueue();
    const job = q.find((j) => j.id === st.currentJobId);
    if (!job) {
      st.currentJobId = undefined;
      await saveRunner(st);
      return void scheduleNext(0);
    }
    const tab = await tabAlive(job.tabId);
    if (!tab) return finish(st, job, 'needs-you', 'The tab was closed — press Continue to pick up at the saved link', { keepTab: false });
    if (tab.status !== 'complete') return void scheduleStep(2000);
    // A step is still working (a long fill); its result or a page load moves things on.
    if (st.inFlight) return void scheduleStep(30000);

    st.jobSteps++;
    if (st.jobSteps > MAX_STEPS) return finish(st, job, 'needs-you', `Took more than ${MAX_STEPS} steps — check where it got to`);

    const probes = await probeFrames(tab.id!);
    const best = probes.sort((a, b) => PROBE_RANK.indexOf(a.probe.kind) - PROBE_RANK.indexOf(b.probe.kind))[0];
    const kind = best?.probe.kind ?? 'none';

    const fp = `${kind}|${best?.probe.sig ?? tab.url}`;
    st.seen = [...st.seen, fp].slice(-12);
    const repeats = st.seen.filter((x) => x === fp).length;

    switch (kind) {
      case 'captcha':
        return finish(st, job, 'needs-you', 'CAPTCHA — solve it, then press Continue');
      case 'verify':
        return finish(st, job, 'needs-you', `Email verification — ${best!.probe.detail ?? 'enter the code or click the link'}, then press Continue`);
      case 'applied':
        return finish(st, job, 'applied', best!.probe.detail ? `Confirmation: "${best!.probe.detail}"` : 'Confirmation page');
      case 'closed':
        return finish(st, job, 'skipped', `Posting closed: "${best!.probe.detail ?? ''}"`);
    }
    let mode: 'guide' | undefined;
    if (kind === 'none' || kind === 'loading') {
      // Redirect / "please wait" pages (Indeed -> company site) move on by themselves: keep looking for a while.
      st.waitSince ??= now();
      if (now() - st.waitSince < (kind === 'loading' ? LOADING_WAIT_MS : NOTHING_WAIT_MS)) {
        st.jobSteps--; // waiting isn't progress
        await saveRunner(st);
        return void scheduleStep(3000);
      }
    } else {
      st.waitSince = undefined;
    }
    if (kind === 'none' || kind === 'loading' || repeats >= STUCK_REPEATS) {
      // The rules don't know what to do here: ask the AI which button moves things on, once per page.
      if ((st.guided ?? []).includes(fp)) {
        return finish(st, job, 'needs-you', kind === 'none' || kind === 'loading' ? "Couldn't find an Apply button or application form here" : `Stuck: same page ${repeats} times (${kind}) — check it, then press Continue`);
      }
      st.guided = [...(st.guided ?? []), fp].slice(-12);
      mode = 'guide';
    }

    // The AI looks at the top page unless a frame had something to show.
    // With nothing recognised anywhere, the AI looks at the frame holding the most form (an
    // embedded iCIMS form), else the top page.
    const formiest = [...probes].sort((a, b) => (b.probe.inputs ?? 0) - (a.probe.inputs ?? 0))[0];
    const frameId = mode === 'guide' && (kind === 'none' || kind === 'loading') ? (formiest?.probe.inputs ? formiest.frameId : 0) : (best?.frameId ?? 0);
    st.step++;
    st.inFlight = { step: st.step, frameId, since: now() };
    await saveRunner(st);
    const ap = await getAutopilot();
    const host = new URL(tab.url ?? job.url).hostname;
    log(
      job,
      mode === 'guide'
        ? 'Not sure what to press here — asking the AI'
        : kind === 'apply'
          ? `Apply button: ${best!.probe.detail ?? ''}`
          : kind === 'blocker'
            ? (best!.probe.detail ?? 'Pop-up')
            : kind === 'account'
              ? 'Sign-in / sign-up page'
              : 'Filling the application',
    );
    await saveQueue(q);
    const sent = await chrome.tabs
      .sendMessage(
        tab.id!,
        {
          type: 'autoStep',
          step: st.step,
          profileId: job.profile,
          autoSubmit: ap.autoSubmit,
          accountKnown: await accountCreatedOn(host),
          mode,
          onlyEmpty: !!st.keepUrl && st.keepUrl === tab.url,
        },
        { frameId },
      )
      .catch(() => null);
    if (!sent) {
      // The page went away under us (navigated); its load event triggers the next step.
      st.inFlight = undefined;
      await saveRunner(st);
      await scheduleStep(5000);
    }
    // Backstop if the result never arrives (e.g. a fill that hangs): the job timeout alarm.
  });
}

/** The page finished a step. */
export function onStepResult(stepId: number, outcome: StepOutcome, tabId?: number): Promise<void> {
  return locked(async () => {
    const st = await getRunner();
    if (!st.running || !st.currentJobId || stepId !== st.step) return; // stale
    const q = await getQueue();
    const job = q.find((j) => j.id === st.currentJobId);
    if (!job || (tabId !== undefined && job.tabId !== tabId)) return;
    st.inFlight = undefined;
    await saveRunner(st);
    switch (outcome.kind) {
      case 'acted': {
        log(job, outcome.action);
        if (outcome.accountCreated) {
          const tab = await tabAlive(job.tabId);
          if (tab?.url) await markAccountCreated(new URL(tab.url).hostname);
        }
        await saveQueue(q);
        if (outcome.navigate && job.tabId !== undefined) await chrome.tabs.update(job.tabId, { url: outcome.navigate });
        // Same-page apps don't fire a load event; check again shortly either way.
        return void scheduleStep(6000);
      }
      case 'nothing':
        return void scheduleStep(3000);
      case 'ready':
        return finish(st, job, 'ready', outcome.reason);
      case 'needs-you':
        return finish(st, job, 'needs-you', outcome.reason);
      case 'applied':
        return finish(st, job, 'applied', outcome.reason);
      case 'skipped':
        return finish(st, job, 'skipped', outcome.reason, { keepTab: false });
      case 'failed':
        return finish(st, job, 'failed', outcome.reason, { keepTab: false });
    }
  });
}

/** Close out the current job and line up the next one after a pause. Call inside locked(). */
async function finish(st: RunnerState, job: QueueJob, status: JobStatus, reason: string, opts: { keepTab?: boolean } = {}): Promise<void> {
  const q = await getQueue();
  const j = q.find((x) => x.id === job.id) ?? job;
  const tab = await tabAlive(j.tabId);
  const keep = opts.keepTab ?? HELD.includes(status);
  j.status = status;
  j.reason = reason;
  if (tab?.url && !tab.url.startsWith('about:')) j.resumeUrl = tab.url;
  if (status === 'applied') j.appliedAt = now();
  log(j, `${status}: ${reason}`);
  if (!keep || status === 'applied') {
    if (tab) chrome.tabs.remove(tab.id!).catch(() => {});
    j.tabId = undefined;
  }
  await saveQueue(q);

  st.currentJobId = undefined;
  st.inFlight = undefined;
  st.step++;
  await saveRunner(st);
  clearTimeout(stepTimer);
  await chrome.alarms.clear(ALARM_TIMEOUT);
  await chrome.alarms.clear(ALARM_STEP);
  await setBadge();
  if (status === 'needs-you') notify(`Needs you: ${j.company ?? j.title ?? new URL(j.url).hostname}`, reason);

  const ap = await getAutopilot();
  if (status === 'ready' && ap.autoSubmitAfterMin > 0) {
    // Review mode with a time limit: if you haven't submitted it by then, it's submitted for you.
    const at = now() + ap.autoSubmitAfterMin * 60000;
    await chrome.alarms.create(`${ALARM_SUBMIT}${j.id}`, { when: at });
    await update(j.id, (x) => {
      x.submitAt = at;
      log(x, `Will submit at ${new Date(at).toTimeString().slice(0, 5)} unless you do first`);
    });
  }
  if (st.running) await scheduleNext(rand(ap.delayMinSec, ap.delayMaxSec) * 1000);
}

// ---------- AI calls, logged on the job they were for ----------

export interface AiCall {
  what: string;
  result: string;
  usage?: { tokensIn: number; tokensOut: number; cost?: number };
  /** For the full AI log. */
  options?: string[];
  note?: string;
  answer?: string;
  confidence?: number;
  decision?: string;
}

const AI_LOG_MAX = 150;

/** Log an AI call on the job whose tab made it, and add it to the job's totals. Calls from tabs outside Autopilot aren't logged. */
export function recordAi(tabId: number, call: AiCall): Promise<void> {
  return locked(async () => {
    const q = await getQueue();
    const j = q.find((x) => x.tabId === tabId);
    if (!j) return;
    const u = call.usage;
    j.aiLog = [
      ...(j.aiLog ?? []),
      {
        at: now(),
        question: call.what,
        options: call.options?.slice(0, 60),
        note: call.note,
        answer: call.answer,
        confidence: call.confidence,
        decision: call.decision,
        tokens: u ? u.tokensIn + u.tokensOut : undefined,
        cost: u?.cost,
      },
    ].slice(-AI_LOG_MAX);
    if (u) {
      const t = (j.ai ??= { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 });
      t.calls++;
      t.tokensIn += u.tokensIn;
      t.tokensOut += u.tokensOut;
      t.cost += u.cost ?? 0;
    }
    const spend = u ? ` · ${u.tokensIn + u.tokensOut} tokens${u.cost !== undefined ? ` · $${u.cost.toFixed(5)}` : ''}` : '';
    log(j, `AI: "${call.what.slice(0, 60)}" → ${call.result.slice(0, 100)}${spend}`);
    await saveQueue(q);
  });
}

/** The page reports what it did with an AI answer: attach it to that question's latest log entry. */
export function aiDecided(tabId: number, question: string, decision: string): Promise<void> {
  return locked(async () => {
    const q = await getQueue();
    const j = q.find((x) => x.tabId === tabId);
    const entry = j?.aiLog?.filter((e) => e.question === question && !e.decision).at(-1);
    if (!j || !entry) return;
    entry.decision = decision;
    await saveQueue(q);
  });
}

/** A finished page fill in a job's tab: keep every field's result for the job's fill log. */
export function recordFill(tabId: number, r: FillReport): Promise<void> {
  return locked(async () => {
    const q = await getQueue();
    const j = q.find((x) => x.tabId === tabId);
    if (!j) return;
    const entry: FillLogEntry = {
      at: now(),
      url: r.url,
      page: r.page,
      message: r.message,
      stop: r.stop,
      fields: r.fields.slice(0, 150).map((f) => ({ label: f.label.slice(0, 160), key: f.key, status: f.status, value: f.value?.slice(0, 160), reason: f.reason?.slice(0, 200) })),
    };
    j.fillLog = [...(j.fillLog ?? []), entry].slice(-40);
    await saveQueue(q);
  });
}

/** Add a line to the log of the job whose tab this is. */
export function noteOnJob(tabId: number, line: string): Promise<void> {
  return locked(async () => {
    const q = await getQueue();
    const j = q.find((x) => x.tabId === tabId);
    if (!j) return;
    log(j, line);
    await saveQueue(q);
  });
}

// ---------- Ready jobs you didn't get to in time ----------

const ALARM_SUBMIT = 'autopilot-submit:';

async function cancelAutoSubmit(j: QueueJob): Promise<void> {
  j.submitAt = undefined;
  await chrome.alarms.clear(`${ALARM_SUBMIT}${j.id}`);
}

/** Time's up on a Ready job: ask the frame with the Submit button to submit it. */
async function submitReady(jobId: string): Promise<void> {
  const job = (await getQueue()).find((j) => j.id === jobId);
  if (!job || job.status !== 'ready') return;
  const tab = await tabAlive(job.tabId);
  if (!tab) {
    await locked(() => update(jobId, (j) => {
      j.status = 'needs-you';
      j.reason = 'Its tab was closed before it could be submitted for you — open it and submit';
      j.submitAt = undefined;
      j.tabId = undefined;
    }));
    return setBadge();
  }
  await locked(() => update(jobId, (j) => {
    j.submitAt = undefined;
    j.reason = 'Submitting for you…';
    log(j, 'Not submitted in time — submitting it for you');
  }));
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id! }).catch(() => null)) ?? [{ frameId: 0 }];
  for (const f of frames) chrome.tabs.sendMessage(tab.id!, { type: 'submitReady', jobId, profileId: job.profile }, { frameId: f.frameId }).catch(() => {});
}

/** What happened when a Ready job was submitted for you. */
export function onReadyResult(jobId: string, outcome: StepOutcome): Promise<void> {
  return locked(async () => {
    const q = await getQueue();
    const j = q.find((x) => x.id === jobId);
    if (!j || j.status !== 'ready') return;
    if (outcome.kind === 'applied') {
      j.status = 'applied';
      j.appliedAt = now();
      j.reason = 'Submitted for you (not reviewed in time)';
      if (j.tabId !== undefined) chrome.tabs.remove(j.tabId).catch(() => {});
      j.tabId = undefined;
    } else if (outcome.kind === 'acted') {
      j.reason = 'Pressed Submit — waiting for the confirmation page';
      // If no confirmation shows up, hand it to you.
      setTimeout(() => void confirmSubmitted(jobId), 15000);
    } else {
      j.status = 'needs-you';
      j.reason = `Couldn't submit it for you: ${'reason' in outcome ? outcome.reason : 'no Submit button'}`;
      notify(`Needs you: ${j.company ?? j.title ?? new URL(j.url).hostname}`, j.reason);
    }
    log(j, j.reason ?? '');
    await saveQueue(q);
    await setBadge();
  });
}

async function confirmSubmitted(jobId: string): Promise<void> {
  const job = (await getQueue()).find((j) => j.id === jobId);
  if (!job || job.status !== 'ready') return; // already marked (the confirmation page loaded)
  const tab = await tabAlive(job.tabId);
  const applied = tab ? (await probeFrames(tab.id!)).some((p) => p.probe.kind === 'applied') : false;
  await onReadyResult(jobId, applied ? { kind: 'applied', reason: 'Confirmation page' } : { kind: 'needs-you', reason: "Pressed Submit but couldn't see a confirmation — check it" });
}

// ---------- events from the browser ----------

export async function onAlarm(name: string): Promise<void> {
  if (name.startsWith(ALARM_SUBMIT)) return submitReady(name.slice(ALARM_SUBMIT.length));
  if (name === ALARM_NEXT) return nextJob();
  if (name === ALARM_STEP) return doStep();
  if (name === ALARM_TIMEOUT) {
    return locked(async () => {
      const st = await getRunner();
      const job = (await getQueue()).find((j) => j.id === st.currentJobId);
      if (!st.running || !job) return;
      const ap = await getAutopilot();
      // Stop whatever the page is doing before handing the tab over.
      if (job.tabId !== undefined) {
        const frames = (await chrome.webNavigation.getAllFrames({ tabId: job.tabId }).catch(() => null)) ?? [];
        for (const f of frames) chrome.tabs.sendMessage(job.tabId, { type: 'cancel' }, { frameId: f.frameId }).catch(() => {});
      }
      await finish(st, job, 'needs-you', `Took longer than ${ap.jobTimeoutMin} min — check where it got to, then press Continue`);
    });
  }
}

/** A frame finished loading in some tab. */
export async function onPageLoaded(tabId: number, frameId: number): Promise<void> {
  const q = await getQueue();
  const job = q.find((j) => j.tabId === tabId);
  if (!job) return;
  const st = await getRunner();
  if (st.running && st.currentJobId === job.id) {
    // The page (or the frame a step was running in) reloaded: that step is over.
    if (frameId !== 0 && st.inFlight?.frameId !== frameId) return;
    await locked(async () => {
      const s = await getRunner();
      if (s.currentJobId !== job.id) return;
      s.inFlight = undefined;
      await saveRunner(s);
    });
    return scheduleStep(1500);
  }
  // A tab waiting on you: if you submitted there, mark it applied.
  if (frameId === 0 && HELD.includes(job.status)) {
    setTimeout(async () => {
      const probes = await probeFrames(tabId);
      if (!probes.some((p) => p.probe.kind === 'applied')) return;
      await locked(async () => {
        await update(job.id, (j) => {
          j.status = 'applied';
          j.appliedAt = now();
          j.reason = j.reason?.startsWith('Pressed Submit') ? 'Submitted for you (not reviewed in time)' : 'You submitted it';
          j.tabId = undefined;
          j.submitAt = undefined;
          log(j, `applied: ${j.reason}`);
        });
        await chrome.alarms.clear(`${ALARM_SUBMIT}${job.id}`);
      });
      await setBadge();
    }, 2000);
  }
}

/** Apply links that open a new tab: follow the job into it. */
export async function onTabCreated(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.openerTabId === undefined) return;
  await locked(async () => {
    const st = await getRunner();
    if (!st.running || !st.currentJobId) return;
    const q = await getQueue();
    const job = q.find((j) => j.id === st.currentJobId);
    if (!job || job.tabId !== tab.openerTabId) return;
    const old = job.tabId;
    job.tabId = tab.id;
    log(job, 'Apply opened a new tab — following it');
    await saveQueue(q);
    if (old !== undefined) chrome.tabs.remove(old).catch(() => {});
  });
  await scheduleStep(8000);
}

export async function onTabRemoved(tabId: number): Promise<void> {
  const st = await getRunner();
  if (st.running && st.currentJobId) {
    const job = (await getQueue()).find((j) => j.id === st.currentJobId);
    if (job?.tabId === tabId) return doStep(); // finishes it as "tab was closed"
  }
  await locked(async () => {
    const q = await getQueue();
    const job = q.find((j) => j.tabId === tabId);
    if (!job) return;
    job.tabId = undefined;
    await saveQueue(q);
  });
}

/** After the browser restarts or the worker wakes with a job half done. */
export async function recover(): Promise<void> {
  const st = await getRunner();
  if (!st.running) return;
  if (st.currentJobId) return scheduleStep(3000);
  return scheduleNext(3000);
}

// ---------- actions from the queue page ----------

export type QueueAction =
  | { action: 'add'; jobs: { url: string; company?: string; title?: string; profile?: string }[] }
  | { action: 'continue'; id: string }
  | { action: 'markApplied'; id: string }
  | { action: 'skip'; id: string }
  | { action: 'retry'; id: string }
  | { action: 'remove'; id: string }
  | { action: 'clearFinished' }
  | { action: 'open'; id: string };

export function queueAction(a: QueueAction): Promise<{ ok: boolean; added?: number; duplicates?: number }> {
  return locked(async () => {
    const q = await getQueue();
    const st = await getRunner();
    if (a.action === 'add') {
      let added = 0;
      let duplicates = 0;
      for (const n of a.jobs) {
        if (q.some((j) => sameJob(j.url, n.url))) {
          duplicates++;
          continue;
        }
        q.push({ id: crypto.randomUUID(), ...n, status: 'queued', attempts: 0, addedAt: now(), updatedAt: now(), log: [] });
        added++;
      }
      await saveQueue(q);
      return { ok: true, added, duplicates };
    }
    if (a.action === 'clearFinished') {
      await saveQueue(q.filter((j) => !['applied', 'skipped'].includes(j.status)));
      return { ok: true };
    }
    const j = q.find((x) => x.id === a.id);
    if (!j) return { ok: false };
    const busy = st.currentJobId === j.id;
    // You dealt with it: no auto-submit (Open is just a look).
    if (a.action !== 'open') await cancelAutoSubmit(j);
    switch (a.action) {
      case 'open': {
        const tab = await tabAlive(j.tabId);
        if (tab) {
          await chrome.tabs.update(tab.id!, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        } else {
          const t = await chrome.tabs.create({ url: j.resumeUrl ?? j.url });
          j.tabId = t.id;
        }
        break;
      }
      case 'continue':
        if (busy) return { ok: false };
        j.status = 'queued';
        j.priority = true;
        j.reason = undefined;
        log(j, 'You pressed Continue');
        break;
      case 'markApplied':
        j.status = 'applied';
        j.appliedAt = now();
        j.reason = 'Marked applied by you';
        if (j.tabId !== undefined && !busy) chrome.tabs.remove(j.tabId).catch(() => {});
        j.tabId = undefined;
        break;
      case 'skip':
        j.status = 'skipped';
        j.reason = 'Skipped by you';
        if (j.tabId !== undefined && !busy) chrome.tabs.remove(j.tabId).catch(() => {});
        j.tabId = undefined;
        break;
      case 'retry':
        j.status = 'queued';
        j.priority = false;
        j.reason = undefined;
        j.resumeUrl = undefined;
        j.startedAt = undefined;
        log(j, 'Retry from the start');
        break;
      case 'remove':
        if (busy) return { ok: false };
        if (j.tabId !== undefined && HELD.includes(j.status)) chrome.tabs.remove(j.tabId).catch(() => {});
        q.splice(q.indexOf(j), 1);
        break;
    }
    j.updatedAt = now();
    await saveQueue(q);
    await setBadge();
    if (busy && (a.action === 'markApplied' || a.action === 'skip')) {
      st.currentJobId = undefined;
      st.step++;
      await saveRunner(st);
      await chrome.alarms.clear(ALARM_TIMEOUT);
      if (st.running) await scheduleNext(2000);
    }
    // Continue means "go": start the runner if it was stopped (queue finished, paused…).
    // Clearing a job that was waiting on you frees a slot if that's why it paused.
    const freedSlot = (a.action === 'markApplied' || a.action === 'skip' || a.action === 'remove') && /waiting on you/.test(st.pausedReason ?? '');
    if (a.action === 'continue' || freedSlot) {
      if (!st.running) {
        st.running = true;
        st.pausedReason = undefined;
        await saveRunner(st);
      }
      if (!st.currentJobId) await scheduleNext(1000);
    }
    return { ok: true };
  });
}
