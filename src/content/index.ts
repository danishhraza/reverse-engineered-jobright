import { isKnownAts, pickAdapter } from '../adapters';
import { getLearned, getSettings, setSettings } from '../profile/storage';
import { hiddenOn } from '../profile/sites';
import { loadSetup } from './context';
import { probe, step, submitReady, type StepRequest } from './autopilot';
import { snapshot } from './snapshot';
import { jobDescription } from './jd';
import { setJobText } from '../engine/salary';
import { fillPastedAnswers, type PastedAnswer } from './paste-answers';
import { looksLikeForm } from '../engine/fields';
import { cancel } from '../engine/control';
import { sleep, waitForSettle } from '../engine/dom';
import { focusField, isRunning, run, runSingle } from '../engine/run';
import type { Answer, FillMode, FillReport } from '../types';

// Runs in every frame. Fills when the background asks; the top frame also
// shows a small floating "Autofill" button on application pages.

type Msg =
  | { type: 'ping' }
  | { type: 'focusInfo' }
  | { type: 'fill'; profileId?: string; mode?: FillMode; page?: number }
  | { type: 'cancel' }
  | { type: 'fabReport'; report: FillReport }
  | { type: 'focus'; id: string }
  | { type: 'autoProbe' }
  | { type: 'submitReady'; jobId: string; profileId?: string }
  | { type: 'snapshot' }
  | { type: 'pasteAnswers'; answers: PastedAnswer[]; profileId?: string }
  | ({ type: 'autoStep'; step: number } & StepRequest);

// The form control you last clicked or tabbed into, for "fill just this field".
let lastFocus: { el: Element; ts: number } | null = null;
const CONTROL = 'input, select, textarea, button, [role="combobox"], [role="radio"], [role="checkbox"], [role="button"], [role="option"], [contenteditable], label';

function noteFocus(e: Event): void {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || t.closest('.rej-ui')) return;
  const el = t.closest(CONTROL);
  // A dropdown option belongs to the dropdown you opened, which already has focus.
  if (!el || el.matches('[role="option"]')) return;
  lastFocus = { el, ts: Date.now() };
}
document.addEventListener('focusin', noteFocus, true);
document.addEventListener('pointerdown', noteFocus, true);

// The last full report, so a single-field fill updates it instead of replacing it.
let lastReport: FillReport | null = null;
// You pressed Cancel: the side panel has already been told, so drop the engine's
// in-flight progress updates until it finishes unwinding.
let stopping = false;

// Read-only on purpose: nothing here may change the page until you press Fill.
const hasForm = () => looksLikeForm();

async function proposeLearned(a: Answer): Promise<void> {
  const prev = (await getLearned()).find((x) => x.pattern === a.pattern);
  if (prev?.answer === a.answer) return;
  send({ type: 'learnProposal', answer: a, previous: prev?.answer });
}

async function startFill(profileId?: string, mode?: FillMode, page?: number): Promise<{ started: boolean; reason?: string }> {
  if (isRunning()) return { started: false, reason: 'Already filling' };
  if (mode === 'focused') return startSingle(profileId);
  if (!hasForm()) return { started: false, reason: 'No form in this frame' };
  const setup = await loadSetup(profileId);
  if ('error' in setup) return { started: false, reason: setup.error };
  const { settings, profileId: id } = setup;
  // A pay range in the description on this page answers the salary question.
  setJobText(jobDescription());

  stopping = false;
  setFab('busy', 'Filling…');
  run({
    profile: setup.profile,
    resume: setup.resume,
    learned: setup.learned,
    ai: setup.ai,
    overwrite: mode === 'empty' ? false : mode === 'all' ? true : settings.overwrite,
    autoAdvance: settings.autoAdvance,
    learn: settings.learn,
    startPage: page,
    onReport: (report) => {
      if (stopping && !report.done) return;
      lastReport = report;
      send({ type: 'report', report });
    },
    onLearn: (a) => void proposeLearned(a),
    // If this click reloads the page, the background starts the fill again on the new one.
    onNavigate: (nextPage) => send({ type: 'advancing', profileId: id, mode, page: nextPage }),
  }).catch((e) => {
    const report: FillReport = { url: location.href, ats: pickAdapter().name, page: 1, fields: [], done: true, message: `Error: ${e?.message ?? e}` };
    send({ type: 'report', report });
  });
  return { started: true };
}

async function startSingle(profileId?: string): Promise<{ started: boolean; reason?: string }> {
  const target = lastFocus?.el;
  if (!target?.isConnected) return { started: false, reason: 'Click into a field on the page first, then try again.' };
  const setup = await loadSetup(profileId);
  if ('error' in setup) return { started: false, reason: setup.error };
  stopping = false;
  runSingle(
    {
      profile: setup.profile,
      resume: setup.resume,
      learned: setup.learned,
      ai: setup.ai,
      learn: setup.settings.learn,
      onReport: (single) => {
        if (stopping && !single.done) return;
        const ids = new Set(single.fields.map((f) => f.id));
        const merged: FillReport = lastReport
          ? { ...lastReport, done: single.done, current: single.current, cancelled: single.cancelled, message: single.message, fields: [...lastReport.fields.filter((f) => !ids.has(f.id)), ...single.fields] }
          : single;
        if (single.done) lastReport = merged;
        send({ type: 'report', report: merged });
      },
      onLearn: (a) => void proposeLearned(a),
    },
    target,
  ).catch((e) => send({ type: 'report', report: { ...(lastReport ?? { url: location.href, ats: pickAdapter().name, page: 1, fields: [] }), done: true, message: `Error: ${e?.message ?? e}` } }));
  return { started: true };
}

/** Autopilot works in this tab: the page-world script (dialogs.ts) answers alert/confirm here from now on. */
function markAutopilotTab(): void {
  try {
    sessionStorage.setItem('rej-autopilot', '1');
  } catch {
    // storage blocked
  }
}

// Dialogs answered by dialogs.ts: put them in the job's log.
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'rej-dialog') return;
  send({ type: 'dialog', kind: e.data.kind, message: e.data.message, answer: e.data.answer });
});

function send(msg: unknown): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    // Extension reloaded; the old content script is orphaned.
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
  if (msg.type === 'ping') {
    reply({ hasForm: hasForm(), ats: pickAdapter().name, top: window === window.top });
    return;
  }
  if (msg.type === 'autoProbe') {
    try {
      reply(probe());
    } catch (e) {
      reply({ kind: 'none', sig: location.href, detail: String(e) });
    }
    return;
  }
  if (msg.type === 'submitReady') {
    reply({ ok: true });
    markAutopilotTab();
    submitReady(msg.profileId, (report) => send({ type: 'report', report }))
      .then((outcome) => outcome && send({ type: 'readyResult', jobId: msg.jobId, outcome }))
      .catch((e) => send({ type: 'readyResult', jobId: msg.jobId, outcome: { kind: 'needs-you', reason: `Error: ${e?.message ?? e}` } }));
    return;
  }
  if (msg.type === 'snapshot') {
    reply(snapshot());
    return;
  }
  if (msg.type === 'pasteAnswers') {
    fillPastedAnswers(msg.answers, msg.profileId).then(reply, (e) => reply({ filled: [], failed: [], notHere: msg.answers.map((a) => a.label), error: String(e) }));
    return true;
  }
  if (msg.type === 'autoStep') {
    // Answer now; the result comes back as its own message (a step can take minutes).
    reply({ ok: true });
    markAutopilotTab();
    stopping = false;
    step(msg, (report) => {
      lastReport = report;
      send({ type: 'report', report });
    })
      .then((outcome) => send({ type: 'autoResult', step: msg.step, outcome }))
      .catch((e) => send({ type: 'autoResult', step: msg.step, outcome: { kind: 'failed', reason: `Error: ${e?.message ?? e}` } }));
    return;
  }
  if (msg.type === 'focusInfo') {
    reply({ ts: lastFocus?.el.isConnected ? lastFocus.ts : 0 });
    return;
  }
  if (msg.type === 'fill') {
    startFill(msg.profileId, msg.mode, msg.page).then(reply);
    return true;
  }
  if (msg.type === 'cancel') {
    const wasRunning = isRunning();
    if (wasRunning) {
      cancel();
      // Tell the side panel now; the engine stops at its next step (within ~100 ms of any wait).
      stopping = true;
      const base: FillReport = lastReport ?? { url: location.href, ats: pickAdapter().name, page: 1, fields: [], done: true };
      const stopped: FillReport = { ...base, done: true, cancelled: true, current: undefined, message: 'Stopped. Anything already filled stays — press Fill to redo it.' };
      lastReport = stopped;
      send({ type: 'report', report: stopped });
    }
    reply({ wasRunning });
    return;
  }
  if (msg.type === 'fabReport') {
    updateFab(msg.report);
    return;
  }
  if (msg.type === 'focus') {
    focusField(msg.id);
    reply({ ok: true });
  }
});

// ---------- Floating button ----------

let fab: { root: HTMLElement; label: HTMLElement } | null = null;

function setFab(state: 'idle' | 'busy' | 'done' | 'warn', text: string): void {
  if (!fab) return;
  fab.root.dataset.state = state;
  fab.label.textContent = text;
  fab.label.title = text;
}

/** Progress from whichever frame is filling (relayed by the background). */
function updateFab(r: FillReport): void {
  if (!r.done) return setFab('busy', r.current ?? r.message ?? 'Filling…');
  if (r.cancelled) return setFab('warn', 'Stopped');
  if (/^Error/.test(r.message ?? '')) return setFab('warn', 'Error');
  const flagged = r.fields.filter((f) => f.status === 'flagged').length;
  setFab(flagged ? 'warn' : 'done', flagged ? `${flagged} need you` : 'Done');
}

/**
 * Drag the floating button anywhere; it stays there on every site (kept as a distance from the
 * bottom-right corner, so it follows window resizes). A press that barely moves is still a click.
 */
function makeDraggable(host: HTMLElement, btn: HTMLElement): void {
  const MARGIN = 6;
  const place = (right: number, bottom: number) => {
    const r = host.getBoundingClientRect();
    const maxRight = Math.max(MARGIN, window.innerWidth - r.width - MARGIN);
    const maxBottom = Math.max(MARGIN, window.innerHeight - r.height - MARGIN);
    const x = Math.min(maxRight, Math.max(MARGIN, right));
    const y = Math.min(maxBottom, Math.max(MARGIN, bottom));
    host.style.right = `${x}px`;
    host.style.bottom = `${y}px`;
    return { right: x, bottom: y };
  };
  chrome.storage.local
    .get('fabPos')
    .then(({ fabPos }) => {
      const p = fabPos as { right: number; bottom: number } | undefined;
      if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) place(p.right, p.bottom);
    })
    .catch(() => {});

  btn.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, right: parseFloat(host.style.right) || 18, bottom: parseFloat(host.style.bottom) || 18 };
    let moved = false;
    let last = { right: start.right, bottom: start.bottom };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) {
        moved = true;
        btn.style.cursor = 'grabbing';
      }
      ev.preventDefault();
      last = place(start.right - dx, start.bottom - dy);
    };
    // On the window: a quick drag leaves the button before the first move arrives.
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      btn.style.cursor = '';
      if (!moved) return;
      btn.dataset.dragged = '1'; // the click that follows is the drop
      setTimeout(() => delete btn.dataset.dragged, 300);
      void chrome.storage.local.set({ fabPos: last }).catch(() => {});
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  });
  // Keep it on screen when the window shrinks.
  window.addEventListener('resize', () => place(parseFloat(host.style.right) || 18, parseFloat(host.style.bottom) || 18));
}

async function mountFab(): Promise<void> {
  if (window !== window.top || fab) return;
  const settings = await getSettings();
  if (!settings.showFab || hiddenOn(location.hostname, settings.fabHiddenSites)) return;
  // Embedded ATS iframes (Greenhouse on company sites) count too.
  const embedded = !!document.querySelector('iframe[src*="greenhouse.io"], iframe[src*="lever.co"], iframe[src*="ashbyhq.com"], iframe[src*="myworkday"]');
  if (!isKnownAts() && !embedded && !hasForm()) return;

  const host = document.createElement('div');
  host.className = 'rej-ui';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      button { all: unset; cursor: pointer; touch-action: none; user-select: none; display: flex; align-items: center; gap: 8px; padding: 10px 14px;
        border-radius: 999px; font: 600 13px/1 system-ui, sans-serif; color: #fff; background: #111827;
        box-shadow: 0 6px 20px rgba(0,0,0,.25); transition: transform .15s; }
      button:hover { transform: translateY(-1px); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; }
      :host([data-state="busy"]) .dot, button[data-state="busy"] .dot { background: #6366f1; animation: p 1s infinite; }
      button[data-state="warn"] .dot { background: #f59e0b; }
      .t { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.2; }
      .x { opacity: .5; margin-left: 4px; font-weight: 400; }
      .stop { display: none; margin-left: 4px; padding: 4px 8px; border-radius: 999px; background: #ef4444; font-weight: 600; font-size: 12px; }
      button[data-state="busy"] .stop { display: inline-block; }
      button[data-state="busy"] .x { display: none; }
      button[data-state="busy"] { cursor: default; }
      .ask { display: none; gap: 6px; align-items: center; }
      .ask span { padding: 5px 10px; border-radius: 999px; background: rgba(255,255,255,.14); font-size: 12px; white-space: nowrap; }
      .ask span:hover { background: rgba(255,255,255,.26); }
      button[data-ask] .ask { display: inline-flex; }
      button[data-ask] .dot, button[data-ask] .t, button[data-ask] .x, button[data-ask] .stop { display: none !important; }
      @keyframes p { 50% { opacity: .3; } }
    </style>
    <button part="b" data-state="idle" title="Click to fill this page, or drag to move"><span class="dot"></span><span class="t">Autofill</span><span class="stop" title="Stop autofill">■ Stop</span><span class="x" title="Hide">✕</span><span class="ask"><span class="now">Hide for now</span><span class="never"></span></span></button>`;
  const btn = shadow.querySelector('button')!;
  const label = shadow.querySelector('.t') as HTMLElement;
  fab = { root: btn, label };
  // "✕" asks: hide it just for now, or never show it on this site again.
  const site = location.hostname.replace(/^www\./, '');
  shadow.querySelector('.never')!.textContent = `Never on ${site}`;
  makeDraggable(host, btn);
  btn.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (btn.dataset.dragged) {
      // That was the end of a drag, not a click.
      delete btn.dataset.dragged;
      return;
    }
    if (t.classList.contains('stop')) {
      setFab('busy', 'Stopping…');
      send({ type: 'cancelTab' });
      return;
    }
    if (t.classList.contains('x')) {
      btn.dataset.ask = '1';
      return;
    }
    if (btn.dataset.ask) {
      if (t.classList.contains('now')) host.remove();
      else if (t.classList.contains('never')) {
        const { fabHiddenSites } = await getSettings();
        await setSettings({ fabHiddenSites: [...new Set([...fabHiddenSites, site])] });
        host.remove();
      } else delete btn.dataset.ask; // clicked beside the choices: back to the button
      return;
    }
    if (btn.dataset.state === 'busy') return;
    setFab('busy', 'Starting…');
    chrome.runtime
      .sendMessage({ type: 'fillTab' })
      .then((r: { started: number; reasons: string[] } | undefined) => {
        if (!r?.started) setFab('warn', r?.reasons.find((x) => !/No form|No content script/.test(x)) ?? 'No form found');
      })
      .catch(() => setFab('warn', 'Reload the page'));
  });
  document.documentElement.appendChild(host);
}

// Only add the button once the page has fully loaded and stopped changing, so a
// React/Next.js site has finished hydrating; adding nodes before that can break it.
// Job pages are often SPAs that render the form late, so look once more after that.
async function mountWhenIdle(): Promise<void> {
  if (window !== window.top) return;
  if (document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r, { once: true }));
  for (const delay of [0, 5000]) {
    await sleep(delay);
    await waitForSettle(1000, 10000);
    await new Promise((r) => (window.requestIdleCallback ?? setTimeout)(r, { timeout: 2000 }));
    await mountFab();
    if (fab) return;
  }
}
void mountWhenIdle();
