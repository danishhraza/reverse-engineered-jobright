import { addLearned, getPending, getSettings, getStore, setPending, setSettings } from '../profile/storage';
import type { FieldReport, FillMode, FillReport, Settings } from '../types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const profileSel = $<HTMLSelectElement>('profile');
const fillBtn = $<HTMLButtonElement>('fill');
const modeBtns = [$<HTMLButtonElement>('fillEmpty'), $<HTMLButtonElement>('fillFocused')];
const learnBox = $('learnBox');
const statusEl = $('status');
const reportEl = $('report');

let tabId: number | undefined;
const reports = new Map<number, FillReport>(); // by frameId

async function currentTab(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function init(): Promise<void> {
  const [store, settings] = await Promise.all([getStore(), getSettings()]);
  profileSel.innerHTML = '';
  if (!store) {
    profileSel.innerHTML = '<option>No profiles — import them first</option>';
    fillBtn.disabled = true;
    statusEl.innerHTML = 'Open <b>Profiles &amp; settings</b> to import your profile JSON and resumes.';
  } else {
    for (const p of store.profiles) profileSel.add(new Option(p.name, p.id, false, p.id === settings.activeProfileId));
    fillBtn.disabled = false;
  }
  for (const k of ['autoAdvance', 'learn'] as const) $<HTMLInputElement>(k).checked = settings[k];
  await Promise.all([loadReports(), renderPending()]);
}

async function loadReports(): Promise<void> {
  tabId = await currentTab();
  reports.clear();
  if (tabId === undefined) return render();
  const list: { frameId: number; report: FillReport }[] = await chrome.runtime.sendMessage({ type: 'getReports', tabId });
  for (const { frameId, report } of list ?? []) reports.set(frameId, report);
  render();
}

function render(): void {
  const all = [...reports.entries()];
  const rows: (FieldReport & { frameId: number })[] = all.flatMap(([frameId, r]) => r.fields.map((f) => ({ ...f, frameId })));
  const busy = all.some(([, r]) => !r.done);
  fillBtn.disabled = busy || profileSel.options.length === 0;
  for (const b of modeBtns) b.disabled = fillBtn.disabled;
  fillBtn.textContent = busy ? 'Filling…' : rows.length ? 'Fill again' : 'Fill this page';
  const messages = all.map(([, r]) => (r.ats !== 'Generic' ? `${r.ats}: ` : '') + (r.message ?? '')).filter((m) => m.trim());
  if (messages.length) statusEl.textContent = messages.join(' · ');

  reportEl.innerHTML = '';
  if (!rows.length) {
    if (!messages.length) reportEl.innerHTML = '<div class="empty muted">Open a job application and press Fill.</div>';
    return;
  }
  const groups: [string, FieldReport['status'][], boolean][] = [
    ['Needs you', ['flagged', 'failed'], true],
    ['Filled', ['filled'], false],
    ['Skipped', ['skipped'], false],
  ];
  for (const [title, statuses, open] of groups) {
    const items = rows.filter((r) => statuses.includes(r.status));
    if (!items.length) continue;
    const det = document.createElement('details');
    det.open = open || title === 'Filled' && items.length < 15;
    det.innerHTML = `<summary>${title} (${items.length})</summary>`;
    for (const r of items) det.appendChild(rowEl(r));
    reportEl.appendChild(det);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function rowEl(r: FieldReport & { frameId: number }): HTMLElement {
  const div = document.createElement('div');
  div.className = 'field';
  div.innerHTML = `
    <div class="grow">
      <div class="lbl">${esc(r.label)}${r.required ? ' <span class="muted">*</span>' : ''}</div>
      ${r.value ? `<div class="val">${esc(r.value.slice(0, 140))}</div>` : ''}
      ${r.reason ? `<div class="why">${esc(r.reason)}</div>` : ''}
    </div>
    <span class="pill ${r.status}">${r.status === 'flagged' ? 'check' : r.status}${r.confidence && r.status !== 'skipped' ? ` ${Math.round(r.confidence * 100)}%` : ''}</span>`;
  div.addEventListener('click', () => {
    if (tabId !== undefined && r.id) chrome.tabs.sendMessage(tabId, { type: 'focus', id: r.id }, { frameId: r.frameId }).catch(() => {});
  });
  return div;
}

async function startFill(mode: FillMode): Promise<void> {
  tabId = await currentTab();
  if (tabId === undefined) return;
  // A single-field fill updates the existing report rather than starting over.
  if (mode !== 'focused') {
    reports.clear();
    render();
  }
  statusEl.textContent = mode === 'focused' ? 'Filling the field you clicked…' : 'Starting…';
  const res: { frames: number; started: number; reasons: string[] } = await chrome.runtime.sendMessage({ type: 'fillTab', tabId, profileId: profileSel.value, mode });
  if (!res?.started) {
    const reason = res?.reasons.find((r) => !/No form|No content script/.test(r));
    statusEl.textContent = reason ?? 'No application form found on this page. (If you just installed the extension, reload the page.)';
  }
}

fillBtn.addEventListener('click', () => startFill('all'));
$('fillEmpty').addEventListener('click', () => startFill('empty'));
$('fillFocused').addEventListener('click', () => startFill('focused'));

// ---------- Learned answers awaiting approval ----------

async function renderPending(): Promise<void> {
  const list = await getPending();
  learnBox.hidden = !list.length;
  learnBox.innerHTML = list.length ? `<h3>Learned from you — save for next time?</h3>` : '';
  for (const p of list) {
    const div = document.createElement('div');
    div.className = 'learn';
    div.innerHTML = `
      <div class="grow">
        <div class="q">${esc(p.answer.pattern)}</div>
        <div class="a">${esc(p.answer.answer)}</div>
        ${p.previous !== undefined ? `<div class="prev" title="Saved answer this replaces">${esc(p.previous)}</div>` : ''}
      </div>
      <button class="yes" title="${p.previous !== undefined ? 'Replace the saved answer' : 'Save this answer'}">✓</button>
      <button class="no" title="Don't save">✕</button>`;
    const drop = async () => setPending((await getPending()).filter((x) => x.answer.pattern !== p.answer.pattern));
    div.querySelector('.yes')!.addEventListener('click', async () => {
      await addLearned(p.answer);
      await drop();
    });
    div.querySelector('.no')!.addEventListener('click', drop);
    learnBox.appendChild(div);
  }
}

profileSel.addEventListener('change', () => setSettings({ activeProfileId: profileSel.value }));
for (const k of ['autoAdvance', 'learn'] as const) {
  $<HTMLInputElement>(k).addEventListener('change', (e) => setSettings({ [k]: (e.target as HTMLInputElement).checked } as Partial<Settings>));
}
$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'report' && sender.tab?.id === tabId) {
    reports.set(sender.frameId ?? 0, msg.report);
    render();
  }
});
chrome.tabs.onActivated.addListener(() => loadReports());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.store || changes.settings)) init();
  if (area === 'session' && changes.pendingLearn) renderPending();
});

init();
