import { isKnownAts, pickAdapter } from '../adapters';
import { resolveProfile } from '../profile/merge';
import { dataUrlToFile, getLearned, getResume, getSettings, getStore } from '../profile/storage';
import { scanFields } from '../engine/fields';
import { focusField, isRunning, run, runSingle } from '../engine/run';
import type { Answer, FillMode, FillReport } from '../types';

// Runs in every frame. Fills when the background asks; the top frame also
// shows a small floating "Autofill" button on application pages.

type Msg =
  | { type: 'ping' }
  | { type: 'focusInfo' }
  | { type: 'fill'; profileId?: string; mode?: FillMode }
  | { type: 'focus'; id: string };

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

function hasForm(): boolean {
  return scanFields().filter((f) => f.kind !== 'file').length >= 3 || !!document.querySelector('input[type="file"]');
}

async function proposeLearned(a: Answer): Promise<void> {
  const prev = (await getLearned()).find((x) => x.pattern === a.pattern);
  if (prev?.answer === a.answer) return;
  send({ type: 'learnProposal', answer: a, previous: prev?.answer });
}

async function startFill(profileId?: string, mode?: FillMode): Promise<{ started: boolean; reason?: string }> {
  if (isRunning()) return { started: false, reason: 'Already filling' };
  if (mode === 'focused') return startSingle(profileId);
  if (!hasForm()) return { started: false, reason: 'No form in this frame' };
  const [store, settings, learned] = await Promise.all([getStore(), getSettings(), getLearned()]);
  if (!store) return { started: false, reason: 'No profiles yet — import them in Options' };
  const id = profileId ?? settings.activeProfileId ?? store.profiles[0].id;
  const profile = resolveProfile(store, id);
  const stored = await getResume(id);
  const resume = stored ? dataUrlToFile(stored) : undefined;

  setFab('busy', 'Filling…');
  run({
    profile,
    resume,
    learned,
    overwrite: mode === 'empty' ? false : mode === 'all' ? true : settings.overwrite,
    autoAdvance: settings.autoAdvance,
    learn: settings.learn,
    onReport: (report) => {
      lastReport = report;
      send({ type: 'report', report });
      if (report.done) {
        const flagged = report.fields.filter((f) => f.status === 'flagged').length;
        setFab(flagged ? 'warn' : 'done', flagged ? `${flagged} need you` : 'Done');
      }
    },
    onLearn: (a) => void proposeLearned(a),
  }).catch((e) => {
    const report: FillReport = { url: location.href, ats: pickAdapter().name, page: 1, fields: [], done: true, message: `Error: ${e?.message ?? e}` };
    send({ type: 'report', report });
    setFab('warn', 'Error');
  });
  return { started: true };
}

async function startSingle(profileId?: string): Promise<{ started: boolean; reason?: string }> {
  const target = lastFocus?.el;
  if (!target?.isConnected) return { started: false, reason: 'Click into a field on the page first, then try again.' };
  const [store, settings, learned] = await Promise.all([getStore(), getSettings(), getLearned()]);
  if (!store) return { started: false, reason: 'No profiles yet — import them in Options' };
  const id = profileId ?? settings.activeProfileId ?? store.profiles[0].id;
  const stored = await getResume(id);
  runSingle(
    {
      profile: resolveProfile(store, id),
      resume: stored ? dataUrlToFile(stored) : undefined,
      learned,
      learn: settings.learn,
      onReport: (single) => {
        const ids = new Set(single.fields.map((f) => f.id));
        const merged: FillReport = lastReport
          ? { ...lastReport, done: true, message: single.message, fields: [...lastReport.fields.filter((f) => !ids.has(f.id)), ...single.fields] }
          : single;
        lastReport = merged;
        send({ type: 'report', report: merged });
      },
      onLearn: (a) => void proposeLearned(a),
    },
    target,
  ).catch((e) => send({ type: 'report', report: { ...(lastReport ?? { url: location.href, ats: pickAdapter().name, page: 1, fields: [] }), done: true, message: `Error: ${e?.message ?? e}` } }));
  return { started: true };
}

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
  if (msg.type === 'focusInfo') {
    reply({ ts: lastFocus?.el.isConnected ? lastFocus.ts : 0 });
    return;
  }
  if (msg.type === 'fill') {
    startFill(msg.profileId, msg.mode).then(reply);
    return true;
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
}

async function mountFab(): Promise<void> {
  if (window !== window.top || fab) return;
  const settings = await getSettings();
  if (!settings.showFab) return;
  // Embedded ATS iframes (Greenhouse on company sites) count too.
  const embedded = !!document.querySelector('iframe[src*="greenhouse.io"], iframe[src*="lever.co"], iframe[src*="ashbyhq.com"], iframe[src*="myworkday"]');
  if (!isKnownAts() && !embedded && !hasForm()) return;

  const host = document.createElement('div');
  host.className = 'rej-ui';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 10px 14px;
        border-radius: 999px; font: 600 13px/1 system-ui, sans-serif; color: #fff; background: #111827;
        box-shadow: 0 6px 20px rgba(0,0,0,.25); transition: transform .15s; }
      button:hover { transform: translateY(-1px); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; }
      :host([data-state="busy"]) .dot, button[data-state="busy"] .dot { background: #6366f1; animation: p 1s infinite; }
      button[data-state="warn"] .dot { background: #f59e0b; }
      .x { opacity: .5; margin-left: 4px; font-weight: 400; }
      @keyframes p { 50% { opacity: .3; } }
    </style>
    <button part="b" data-state="idle"><span class="dot"></span><span class="t">Autofill</span><span class="x" title="Hide">✕</span></button>`;
  const btn = shadow.querySelector('button')!;
  const label = shadow.querySelector('.t') as HTMLElement;
  fab = { root: btn, label };
  btn.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('x')) {
      host.remove();
      return;
    }
    if (btn.dataset.state === 'busy') return;
    setFab('busy', 'Filling…');
    send({ type: 'fillTab' });
  });
  document.documentElement.appendChild(host);
}

// Job pages are often SPAs that render the form late.
setTimeout(mountFab, 1200);
setTimeout(mountFab, 4000);
