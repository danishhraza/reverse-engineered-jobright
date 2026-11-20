import { jobsFromCsv } from '../queue/csv';
import { getAutopilot, getQueue, getRunner, setAutopilot, today } from '../queue/store';
import type { AutopilotSettings, JobStatus, QueueJob } from '../queue/types';
import { detailsRow, esc, firstTab, summaryChips, type Tab } from './job-details';

// The Autopilot page: queue, Start/Pause, per-job actions, and settings.
// It only reads storage; every change goes through the background.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const msgEl = $('msg');
let filter: JobStatus | 'all' | 'done' = 'all';
/** Jobs with their details open, and which tab. */
const details = new Map<string, Tab>();

function say(text: string): void {
  msgEl.textContent = text;
}

const send = (payload: object) => chrome.runtime.sendMessage({ type: 'queue', payload });

const LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  'needs-you': 'Needs you',
  ready: 'Ready to submit',
  applied: 'Applied',
  skipped: 'Skipped',
  failed: 'Failed',
};

const ACTIONS: Record<JobStatus, [string, string, string?][]> = {
  queued: [['remove', 'Remove', 'danger']],
  running: [['open', 'Show']],
  'needs-you': [
    ['open', 'Open'],
    ['continue', 'Done — continue', 'primary'],
    ['markApplied', 'Mark applied'],
    ['skip', 'Skip'],
  ],
  ready: [
    ['open', 'Open'],
    ['markApplied', 'Mark applied', 'primary'],
    ['continue', 'Continue'],
    ['skip', 'Skip'],
  ],
  applied: [['remove', 'Remove']],
  skipped: [
    ['retry', 'Retry'],
    ['remove', 'Remove'],
  ],
  failed: [
    ['open', 'Open'],
    ['retry', 'Retry'],
    ['skip', 'Skip'],
  ],
};

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** In the list you're looking at (the status filter at the top). */
function inFilter(j: QueueJob): boolean {
  if (filter === 'all') return true;
  if (filter === 'done') return j.status === 'skipped' || j.status === 'failed';
  if (filter === 'queued') return j.status === 'queued' || j.status === 'running';
  return j.status === filter;
}

const hasLogs = (j: QueueJob) => !!(j.log.length || j.fillLog?.length || j.aiLog?.length);

/** One job's logs, as in its "Download log" file. */
function jobLog(j: QueueJob) {
  const { url, company, title, profile, status, reason, resumeUrl, attempts, log, fillLog, aiLog, ai, jd } = j;
  return { url, company, title, profile, status, reason, resumeUrl, attempts, ai, log, fillLog, aiLog, jd };
}

function download(text: string, type: string, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

type FramePart = { url: string; title: string; top: boolean; fields: unknown[]; html: string };
let saving = false;

/**
 * Every job in the list you're looking at, with its logs (and a snapshot of each
 * page still open, if asked), as one JSON file — to hand over for fixing in one go.
 */
async function saveAll(withSnapshots: boolean): Promise<void> {
  const jobs = (await getQueue()).filter((j) => inFilter(j) && hasLogs(j));
  if (!jobs.length) return void ($('bulkMsg').textContent = 'No logs in this list yet.');
  saving = true;
  $<HTMLButtonElement>('saveLogsBtn').disabled = $<HTMLButtonElement>('saveSnapsBtn').disabled = true;
  let snaps = 0;
  let closed = 0;
  try {
    const out = [];
    for (const [i, j] of jobs.entries()) {
      const entry: ReturnType<typeof jobLog> & { snapshot?: { at: string; frames: FramePart[] } | string } = jobLog(j);
      if (withSnapshots) {
        $('bulkMsg').textContent = `Snapshotting page ${i + 1} of ${jobs.length}…`;
        const alive = j.tabId !== undefined && (await chrome.tabs.get(j.tabId).then(() => true, () => false));
        const frames: FramePart[] | undefined = alive
          ? await chrome.runtime.sendMessage({ type: 'snapshotTab', tabId: j.tabId }).catch(() => undefined)
          : undefined;
        if (frames?.length) {
          entry.snapshot = { at: new Date().toISOString(), frames };
          snaps++;
        } else {
          entry.snapshot = alive ? "Couldn't read the page (it may be loading or reloaded)" : 'Its tab is closed';
          closed++;
        }
      }
      out.push(entry);
    }
    const name = `autopilot-${withSnapshots ? 'logs-snapshots' : 'logs'}-${filter}-${today()}-${new Date().toTimeString().slice(0, 5).replace(':', '')}.json`;
    download(JSON.stringify({ savedAt: new Date().toISOString(), list: filter, jobs: out }, null, 1), 'application/json', name);
    $('bulkMsg').textContent = `Saved ${name}: ${jobs.length} job${jobs.length === 1 ? '' : 's'}${
      withSnapshots ? `, ${snaps} page snapshot${snaps === 1 ? '' : 's'}${closed ? ` (${closed} without: tab closed or unreadable)` : ''}` : ''
    }.`;
  } finally {
    saving = false;
    void render();
  }
}

$('saveLogsBtn').addEventListener('click', () => void saveAll(false));
$('saveSnapsBtn').addEventListener('click', () => void saveAll(true));

async function render(): Promise<void> {
  const [q, st, ap] = await Promise.all([getQueue(), getRunner(), getAutopilot()]);
  const started = st.startedByDay[today()] ?? 0;
  const appliedToday = q.filter((j) => j.appliedAt && today(new Date(j.appliedAt)) === today()).length;
  $('state').dataset.on = st.running ? '1' : '';
  const current = q.find((j) => j.id === st.currentJobId);
  $('stateText').textContent = st.running
    ? `Running${current ? ` — ${current.company ?? current.title ?? host(current.url)}: ${current.log.at(-1)?.slice(6) ?? ''}` : ' — waiting before the next job'}`
    : `Stopped${st.pausedReason ? ` — ${st.pausedReason}` : ''}`;
  $<HTMLButtonElement>('start').disabled = st.running;
  $<HTMLButtonElement>('pause').disabled = !st.running;

  const count = (s: JobStatus) => q.filter((j) => j.status === s).length;
  const tabs: [typeof filter, string][] = [
    ['all', `All ${q.length}`],
    ['needs-you', `Needs you ${count('needs-you')}`],
    ['ready', `Ready ${count('ready')}`],
    ['queued', `Queued ${count('queued') + count('running')}`],
    ['applied', `Applied ${count('applied')}`],
    ['done', `Skipped / failed ${count('skipped') + count('failed')}`],
  ];
  $('counts').innerHTML = '';
  for (const [f, text] of tabs) {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = f === filter ? 'on' : '';
    b.addEventListener('click', () => {
      filter = f;
      render();
    });
    $('counts').appendChild(b);
  }
  const todayLine = document.createElement('span');
  todayLine.className = 'muted';
  todayLine.style.alignSelf = 'center';
  const aiCost = q.reduce((s, j) => s + (j.ai?.cost ?? 0), 0);
  const aiCalls = q.reduce((s, j) => s + (j.ai?.calls ?? 0), 0);
  todayLine.textContent = `Today: ${started}/${ap.dailyCap} started, ${appliedToday} applied${aiCalls ? ` · AI in this list: ${aiCalls} calls, $${aiCost.toFixed(4)}` : ''}`;
  $('counts').appendChild(todayLine);

  const shown = q.filter(inFilter);
  const withLogs = shown.filter(hasLogs).length;
  $<HTMLButtonElement>('saveLogsBtn').disabled = $<HTMLButtonElement>('saveSnapsBtn').disabled = !withLogs || saving;
  $('saveLogsBtn').textContent = `Save all logs (${withLogs})`;
  // Things waiting on you first, then the running job, then the queue in order.
  const order: JobStatus[] = ['needs-you', 'ready', 'running', 'queued', 'failed', 'applied', 'skipped'];
  shown.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || Number(!!b.priority) - Number(!!a.priority));

  const list = $('list');
  if (!shown.length) {
    list.innerHTML = `<div class="empty muted">${q.length ? 'Nothing here.' : 'No jobs yet — paste links below or load the sample CSV.'}</div>`;
  } else {
    list.innerHTML = '<table><thead><tr><th>Status</th><th>Job</th><th>What happened</th><th></th></tr></thead><tbody></tbody></table>';
    const tbody = list.querySelector('tbody')!;
    for (const j of shown) tbody.append(...row(j));
  }
  renderSettings(ap);
}

function row(j: QueueJob): HTMLTableRowElement[] {
  const tr = document.createElement('tr');
  const name = j.title || j.company ? `${esc(j.title ?? '')}${j.title && j.company ? ' · ' : ''}${esc(j.company ?? '')}` : esc(host(j.url));
  tr.innerHTML = `
    <td><span class="pill ${j.status}">${LABEL[j.status]}</span>${j.priority && j.status === 'queued' ? ' <span class="muted">next</span>' : ''}${
      j.status === 'ready' && j.submitAt ? `<div class="muted" style="font-size:11px">auto-submits ${new Date(j.submitAt).toTimeString().slice(0, 5)}</div>` : ''
    }</td>
    <td class="job"><div class="t">${name}</div><a href="${esc(j.url)}" target="_blank" rel="noreferrer">${esc(host(j.url))}</a>${j.profile ? ` <span class="muted">· ${esc(j.profile)}</span>` : ''}${
      j.ai?.calls
        ? `<div class="muted" style="font-size:11px">AI: ${j.ai.calls} call${j.ai.calls > 1 ? 's' : ''} · ${(j.ai.tokensIn + j.ai.tokensOut).toLocaleString()} tokens${j.ai.cost ? ` · $${j.ai.cost.toFixed(4)}` : ''}</div>`
        : ''
    }</td>
    <td class="why"><div>${esc(j.reason ?? j.log.at(-1)?.slice(6) ?? '')}</div><div class="chips">${summaryChips(j)}</div></td>
    <td class="acts"></td>`;
  if (j.log.length || j.fillLog?.length || j.aiLog?.length) {
    const more = document.createElement('button');
    more.className = 'more';
    more.textContent = details.has(j.id) ? 'Hide details' : 'Details';
    more.setAttribute('aria-expanded', String(details.has(j.id)));
    more.addEventListener('click', () => {
      if (details.has(j.id)) details.delete(j.id);
      else details.set(j.id, firstTab(j));
      render();
    });
    tr.querySelector('.chips')!.appendChild(more);
  }
  const acts = tr.querySelector('.acts')!;
  // Everything about this job in one file, for a bug report.
  const dl = document.createElement('button');
  dl.textContent = 'Download log';
  dl.title = 'Step log, fill log and AI log for this job, as one JSON file';
  dl.addEventListener('click', () => download(JSON.stringify(jobLog(j), null, 2), 'application/json', `autopilot-log-${host(j.url)}-${today()}.json`));
  acts.appendChild(dl);
  for (const [action, text, cls] of ACTIONS[j.status]) {
    const b = document.createElement('button');
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', async () => {
      if (action === 'remove' && !confirm('Remove this job from the queue?')) return;
      const r = await send({ action, id: j.id });
      if (!r?.ok) say("Couldn't do that (is it the job running right now?)");
    });
    acts.appendChild(b);
  }
  const tab = details.get(j.id);
  if (!tab) return [tr];
  const pick = (t: Tab) => {
    details.set(j.id, t);
    render();
  };
  return [tr, detailsRow(j, tab, pick, claudeHooks)];
}

/** "Ask your Claude": copy the prompt; fill the pasted answers into the job's tab (through the background). */
const claudeHooks = {
  copy: (text: string) => navigator.clipboard.writeText(text),
  fill: (jobId: string, answers: { label: string; text: string; coverLetter?: boolean }[]) => chrome.runtime.sendMessage({ type: 'pasteAnswers', jobId, answers }),
};

// ---------- Adding jobs ----------

async function addFromText(text: string, source: string): Promise<void> {
  const { jobs, skipped } = jobsFromCsv(text);
  if (!jobs.length) return say(`No links found in the ${source}.`);
  const r = await send({ action: 'add', jobs });
  say(`Added ${r?.added ?? 0} from the ${source}${r?.duplicates ? `, ${r.duplicates} already in the queue` : ''}${skipped ? `, ${skipped} rows without a link` : ''}.`);
}

$('addBtn').addEventListener('click', async () => {
  await addFromText($<HTMLTextAreaElement>('paste').value, 'pasted text');
  $<HTMLTextAreaElement>('paste').value = '';
});
$('sampleBtn').addEventListener('click', async () => {
  const text = await fetch(chrome.runtime.getURL('sample-jobs.csv')).then((r) => r.text());
  await addFromText(text, 'sample CSV');
});
$('csvBtn').addEventListener('click', () => $<HTMLInputElement>('csvFile').click());
$<HTMLInputElement>('csvFile').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await addFromText(await file.text(), file.name);
  (e.target as HTMLInputElement).value = '';
});
$('clearBtn').addEventListener('click', async () => {
  if (confirm('Remove applied and skipped jobs from the list?')) await send({ action: 'clearFinished' });
});
$('exportBtn').addEventListener('click', async () => {
  const q = await getQueue();
  const cell = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [
    ['url', 'company', 'title', 'profile', 'status', 'reason', 'applied_at'].join(','),
    ...q.map((j) => [j.url, j.company, j.title, j.profile, j.status, j.reason, j.appliedAt ? new Date(j.appliedAt).toISOString() : ''].map(cell).join(',')),
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `autopilot-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

$('exportAiBtn').addEventListener('click', async () => {
  const q = await getQueue();
  const cell = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [['time', 'job', 'company', 'question', 'note', 'options', 'answer', 'confidence', 'decision', 'tokens', 'cost_usd'].join(',')];
  for (const j of q) {
    for (const e of j.aiLog ?? []) {
      lines.push(
        [new Date(e.at).toISOString(), j.url, j.company, e.question, e.note, (e.options ?? []).join(' | '), e.answer, e.confidence, e.decision, e.tokens, e.cost].map(cell).join(','),
      );
    }
  }
  if (lines.length === 1) return say('No AI calls logged yet.');
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `autopilot-ai-log-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- Start / pause ----------

$('start').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'runner', cmd: 'start' });
  if (!r?.ok) say(r?.error ?? "Couldn't start");
});
$('pause').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'runner', cmd: 'pause' }));

// ---------- Settings ----------

const NUMS = ['dailyCap', 'delayMinSec', 'delayMaxSec', 'jobTimeoutMin', 'maxHeldTabs', 'autoSubmitAfterMin'] as const;
let settingsShown = false;

function renderSettings(ap: AutopilotSettings): void {
  // Don't overwrite a box you're typing in.
  for (const k of NUMS) if (document.activeElement !== $(k) || !settingsShown) $<HTMLInputElement>(k).value = String(ap[k]);
  $<HTMLInputElement>('autoSubmit').checked = ap.autoSubmit;
  settingsShown = true;
}

for (const k of NUMS) {
  $<HTMLInputElement>(k).addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const v = Math.min(Number(input.max), Math.max(Number(input.min), Math.round(Number(input.value) || 0)));
    input.value = String(v);
    setAutopilot({ [k]: v } as Partial<AutopilotSettings>);
  });
}
$<HTMLInputElement>('autoSubmit').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (on && !confirm('Submit applications automatically when nothing is flagged? It will tick "I certify / I agree" boxes too. You can turn this off any time.')) {
    (e.target as HTMLInputElement).checked = false;
    return;
  }
  setAutopilot({ autoSubmit: on });
});

// Don't redraw under you while you're pasting a reply into a job's Claude box; catch up when you leave it.
let pendingRender = false;
const typing = () => document.activeElement instanceof HTMLTextAreaElement && document.activeElement.classList.contains('claude-reply');
document.addEventListener('focusout', () => {
  if (pendingRender) setTimeout(() => {
    if (!typing() && pendingRender) {
      pendingRender = false;
      render();
    }
  }, 0);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.queue || changes.runner || changes.autopilot)) return;
  if (typing()) pendingRender = true;
  else render();
});
render();
