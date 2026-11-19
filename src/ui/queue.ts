import { jobsFromCsv } from '../queue/csv';
import { getAutopilot, getQueue, getRunner, setAutopilot, today } from '../queue/store';
import type { AutopilotSettings, JobStatus, QueueJob } from '../queue/types';

// The Autopilot page: queue, Start/Pause, per-job actions, and settings.
// It only reads storage; every change goes through the background.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const msgEl = $('msg');
let filter: JobStatus | 'all' | 'done' = 'all';
const open = new Set<string>(); // jobs with their log expanded
const openAi = new Set<string>(); // jobs with their AI log expanded
const openFill = new Set<string>(); // jobs with their fill log expanded

/** Every page fill on a job: each field, what went in, and why. */
function fillTable(j: QueueJob): string {
  return (j.fillLog ?? [])
    .map(
      (e) => `<div class="muted" style="margin-top:8px;font-size:12px">${new Date(e.at).toTimeString().slice(0, 8)} · page ${e.page} · ${esc(e.message ?? '')}${
        e.stop ? ` · stop: ${esc(e.stop)}` : ''
      }<br><span style="font-size:11px">${esc(e.url.slice(0, 140))}</span></div>
      <table class="ailog"><thead><tr><th>Field</th><th>Result</th><th>Value</th><th>Why</th></tr></thead><tbody>${e.fields
        .map(
          (f) => `<tr><td>${esc(f.label)}${f.key ? ` <span class="muted">(${esc(f.key)})</span>` : ''}</td><td><span class="pill ${f.status === 'filled' ? 'applied' : f.status === 'flagged' ? 'needs-you' : f.status}">${esc(f.status)}</span></td><td>${esc(f.value ?? '')}</td><td class="muted">${esc(f.reason ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table>`,
    )
    .join('');
}

/** Every AI call on a job: what was asked (with the options), what it answered, and what was done with it. */
function aiTable(j: QueueJob): string {
  const rows = (j.aiLog ?? [])
    .map(
      (e) => `<tr>
        <td>${new Date(e.at).toTimeString().slice(0, 8)}</td>
        <td>${esc(e.question)}${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}${
          e.options?.length ? `<details><summary class="muted">${e.options.length} options</summary>${esc(e.options.join(' · '))}</details>` : '<div class="muted">free text</div>'
        }</td>
        <td>${esc(e.answer ?? '—')}${e.confidence !== undefined ? ` <span class="muted">(${e.confidence})</span>` : ''}</td>
        <td>${esc(e.decision ?? '—')}</td>
        <td class="muted">${e.tokens ? `${e.tokens.toLocaleString()} tok` : ''}${e.cost !== undefined ? `<br>$${e.cost.toFixed(5)}` : ''}</td>
      </tr>`,
    )
    .join('');
  return `<table class="ailog"><thead><tr><th>Time</th><th>Asked</th><th>AI answered</th><th>What was done</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function say(text: string): void {
  msgEl.textContent = text;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
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

  const shown = q.filter((j) =>
    filter === 'all' ? true : filter === 'done' ? j.status === 'skipped' || j.status === 'failed' : filter === 'queued' ? j.status === 'queued' || j.status === 'running' : j.status === filter,
  );
  // Things waiting on you first, then the running job, then the queue in order.
  const order: JobStatus[] = ['needs-you', 'ready', 'running', 'queued', 'failed', 'applied', 'skipped'];
  shown.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || Number(!!b.priority) - Number(!!a.priority));

  const list = $('list');
  if (!shown.length) {
    list.innerHTML = `<div class="empty muted">${q.length ? 'Nothing here.' : 'No jobs yet — paste links below or load the sample CSV.'}</div>`;
  } else {
    list.innerHTML = '<table><thead><tr><th>Status</th><th>Job</th><th>What happened</th><th></th></tr></thead><tbody></tbody></table>';
    const tbody = list.querySelector('tbody')!;
    for (const j of shown) tbody.appendChild(row(j));
  }
  renderSettings(ap);
}

function row(j: QueueJob): HTMLTableRowElement {
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
    <td class="why">${esc(j.reason ?? j.log.at(-1)?.slice(6) ?? '')}${j.log.length ? ` <a href="#" class="toggle">${open.has(j.id) ? 'hide log' : 'log'}</a>` : ''}${open.has(j.id) ? `<div class="log">${esc(j.log.join('\n'))}</div>` : ''}</td>
    <td class="acts"></td>`;
  tr.querySelector('.toggle')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (open.has(j.id)) open.delete(j.id);
    else open.add(j.id);
    render();
  });
  if (j.aiLog?.length) {
    const why = tr.querySelector('.why')!;
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = openAi.has(j.id) ? ` hide AI log` : ` AI log (${j.aiLog.length})`;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (openAi.has(j.id)) openAi.delete(j.id);
      else openAi.add(j.id);
      render();
    });
    why.appendChild(link);
    if (openAi.has(j.id)) why.insertAdjacentHTML('beforeend', aiTable(j));
  }
  if (j.fillLog?.length) {
    const why = tr.querySelector('.why')!;
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = openFill.has(j.id) ? ' hide fill log' : ` fill log (${j.fillLog.length})`;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (openFill.has(j.id)) openFill.delete(j.id);
      else openFill.add(j.id);
      render();
    });
    why.appendChild(link);
    if (openFill.has(j.id)) why.insertAdjacentHTML('beforeend', fillTable(j));
  }
  const acts = tr.querySelector('.acts')!;
  // Everything about this job in one file, for a bug report.
  const dl = document.createElement('button');
  dl.textContent = 'Download log';
  dl.title = 'Step log, fill log and AI log for this job, as one JSON file';
  dl.addEventListener('click', () => {
    const { url, company, title, profile, status, reason, resumeUrl, attempts, log, fillLog, aiLog, ai } = j;
    const blob = new Blob([JSON.stringify({ url, company, title, profile, status, reason, resumeUrl, attempts, ai, log, fillLog, aiLog }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `autopilot-log-${host(j.url)}-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
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
  return tr;
}

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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.queue || changes.runner || changes.autopilot)) render();
});
render();
