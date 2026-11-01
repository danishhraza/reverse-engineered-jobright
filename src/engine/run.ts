import { pickAdapter } from '../adapters';
import type { Answer, FieldReport, FillReport, Profile } from '../types';
import { begin, Cancelled, checkCancel, end, status } from './control';
import { realClick, sleep, waitFor, waitForSettle } from './dom';
import { currentValue, fieldFor, findById, scanFields } from './fields';
import { fillPage, fillSingle } from './fill';

// Multi-page driver + on-page highlighting + learning from manual answers.

export interface RunOptions {
  profile: Profile;
  resume?: File;
  learned: Answer[];
  overwrite: boolean;
  autoAdvance: boolean;
  learn: boolean;
  onReport: (r: FillReport) => void;
  onLearn?: (a: Answer) => void;
  /** About to do something that may reload the page (Next, a resume choice), so the background can carry on after it. */
  onNavigate?: (page: number) => void;
  /** Page number to start counting from when carrying on after a reload. */
  startPage?: number;
}

const MAX_PAGES = 10;
let running = false;

export function isRunning(): boolean {
  return running;
}

export async function run(opts: RunOptions): Promise<FillReport> {
  if (running) throw new Error('Already filling this page');
  running = true;
  ensureStyles();
  const adapter = pickAdapter();
  let report: FillReport = { url: location.href, ats: adapter.name, page: 1, fields: [], done: false };
  let rows: FieldReport[] = [];
  begin((current) => opts.onReport({ ...report, fields: rows, current }));
  try {
    for (let page = opts.startPage ?? 1; page <= MAX_PAGES; page++) {
      report = { url: location.href, ats: adapter.name, page, fields: [], done: false, message: `Filling page ${page}…` };
      rows = [];
      opts.onReport(report);
      const fields = await fillPage({
        profile: opts.profile,
        resume: opts.resume,
        adapter,
        learned: opts.learned,
        overwrite: opts.overwrite,
        onNavigate: () => opts.onNavigate?.(page),
        onProgress: (r) => {
          rows = r;
          opts.onReport({ ...report, fields: r });
        },
      });
      rows = fields;
      report = { ...report, fields };
      highlight(fields);
      if (opts.learn) watchForLearning(fields, opts.onLearn);

      const blocking = fields.filter((f) => f.status === 'flagged' && f.required);
      const next = adapter.nextButton?.();
      if (!opts.autoAdvance || !next || adapter.isFinalPage?.()) {
        report.message = adapter.isFinalPage?.()
          ? 'Reached the review/submit step — check everything and submit yourself.'
          : summary(fields);
        break;
      }
      if (blocking.length) {
        report.message = `Stopped on page ${page}: ${blocking.length} required field(s) need you. Fix them, then press Fill again to continue.`;
        break;
      }
      checkCancel();
      status(`Page ${page} done — clicking Next and waiting for page ${page + 1}…`);
      const sig = adapter.pageSignature?.() ?? location.href;
      opts.onNavigate?.(page + 1);
      realClick(next);
      const moved = await waitFor(() => (adapter.hasErrors?.() ? 'error' : (adapter.pageSignature?.() ?? location.href) !== sig ? 'moved' : null), {
        timeout: 15000,
        interval: 250,
      });
      if (moved !== 'moved') {
        report.message = moved === 'error' ? `Page ${page} has validation errors — fix them, then press Fill again.` : `Clicked Next on page ${page}, but the page didn't change.`;
        break;
      }
      await waitForSettle(800, 10000);
      opts.onReport({ ...report, done: false, message: `Moving to page ${page + 1}…` });
      await sleep(300);
      checkCancel();
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    report = { ...report, fields: rows, cancelled: true, message: `Stopped. ${summary(rows)} Anything already filled stays — press Fill to redo it.` };
    highlight(rows);
  } finally {
    running = false;
    end();
  }
  report.done = true;
  opts.onReport(report);
  return report;
}

/** Fill only the field `target` belongs to (the one you last clicked). */
export async function runSingle(opts: Omit<RunOptions, 'autoAdvance' | 'overwrite'>, target: Element): Promise<FillReport> {
  if (running) throw new Error('Already filling this page');
  running = true;
  ensureStyles();
  const adapter = pickAdapter();
  const report: FillReport = { url: location.href, ats: adapter.name, page: 1, fields: [], done: true };
  begin((current) => opts.onReport({ ...report, done: false, current }));
  try {
    const field = fieldFor(target);
    if (!field) {
      report.message = "Couldn't find a form field where you clicked. Click into the field, then try again.";
    } else {
      const row = await fillSingle(field, { profile: opts.profile, resume: opts.resume, adapter, learned: opts.learned, overwrite: true });
      report.fields = row ? [row] : [];
      report.message = !row
        ? `Nothing to fill for "${field.label || 'this field'}".`
        : row.status === 'filled'
          ? `Filled "${row.label}".`
          : `"${row.label}": ${row.reason ?? row.status}`;
      highlight(report.fields);
      if (opts.learn) watchForLearning(report.fields, opts.onLearn);
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    report.cancelled = true;
    report.message = 'Stopped.';
  } finally {
    running = false;
    end();
  }
  opts.onReport(report);
  return report;
}

function summary(fields: FieldReport[]): string {
  const n = (s: FieldReport['status']) => fields.filter((f) => f.status === s).length;
  const flagged = n('flagged');
  return `Filled ${n('filled')}, ${flagged} need you, ${n('skipped')} skipped.${flagged ? ' Flagged fields are outlined in orange.' : ''}`;
}

// ---------- Highlighting ----------

const STYLE_ID = 'rej-styles';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    [data-rej-state="flagged"] { outline: 2px solid #f59e0b !important; outline-offset: 2px !important; border-radius: 4px; }
    [data-rej-state="filled"] { outline: 1px solid rgba(16,185,129,.55) !important; outline-offset: 1px !important; }
    [data-rej-state="focus"] { outline: 3px solid #6366f1 !important; outline-offset: 3px !important; }
  `;
  document.head.appendChild(s);
}

function visualTarget(el: HTMLElement): HTMLElement {
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox' || el.type === 'file')) {
    return (el.closest('fieldset, [role="radiogroup"], [role="group"], [data-automation-id^="formField-"], .field') as HTMLElement) ?? el.parentElement ?? el;
  }
  return el;
}

function highlight(fields: FieldReport[]): void {
  for (const f of fields) {
    if (!f.id) continue;
    const el = findById(f.id);
    if (!el) continue;
    const t = visualTarget(el);
    if (f.status === 'flagged' || f.status === 'filled') {
      t.setAttribute('data-rej-state', f.status);
      t.title = f.status === 'flagged' ? `Autofill: ${f.reason ?? 'check this'}` : t.title;
    }
  }
}

export function focusField(id: string): void {
  const el = findById(id);
  if (!el) return;
  const t = visualTarget(el);
  t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const prev = t.getAttribute('data-rej-state');
  t.setAttribute('data-rej-state', 'focus');
  setTimeout(() => (prev ? t.setAttribute('data-rej-state', prev) : t.removeAttribute('data-rej-state')), 1600);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.focus({ preventScroll: true });
}

// ---------- Learning ----------

const watched = new WeakSet<HTMLElement>();

function watchForLearning(rows: FieldReport[], onLearn?: (a: Answer) => void): void {
  if (!onLearn) return;
  const flaggedIds = new Set(rows.filter((r) => r.status === 'flagged' && r.id).map((r) => r.id));
  if (!flaggedIds.size) return;
  for (const f of scanFields()) {
    if (!flaggedIds.has(f.id) || f.kind === 'file' || f.inputType === 'password' || watched.has(f.el)) continue;
    // Only learn questions, not personal fields; sensitive EEO answers belong in the profile.
    if (f.label.split(' ').length < 3 || /password|ssn|social security|date of birth|birth ?date/i.test(f.label)) continue;
    watched.add(f.el);
    const container = visualTarget(f.el);
    const save = () => {
      const v = currentValue(f);
      if (v && v.length < 500) onLearn({ pattern: f.label, answer: v, source: 'learned' });
      if (v) container.removeAttribute('data-rej-state');
    };
    container.addEventListener('change', save, true);
    container.addEventListener('click', () => setTimeout(save, 300), true);
    f.el.addEventListener('blur', save, true);
  }
}
