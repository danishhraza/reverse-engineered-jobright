import { pickAdapter } from '../adapters';
import type { Answer, FieldReport, FillReport, Profile } from '../types';
import { begin, Cancelled, checkCancel, end, status } from './control';
import { cleanText, isVisible, realClick, sleep, waitFor, waitForSettle } from './dom';
import { currentValue, fieldFor, findById, scanFields } from './fields';
import { fillPage, fillSingle, type AiAsk } from './fill';
import { setSkillPicker } from './skills';
import { disabledNext, genericFinal, genericNext, genericSignature } from './nav';
import { findBlocker, markTried } from '../content/blockers';

/** A visible error banner or invalid-field message after pressing Next (sites without an adapter). */
function pageErrors(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="alert"], .error, .errors, [class*="error-message" i], [aria-invalid="true"]')).some(
    (e) => isVisible(e) && (e.getAttribute('aria-invalid') === 'true' || /required|invalid|error|please (enter|select|complete)/i.test(cleanText(e))),
  );
}

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
  /** Answers questions the rules can't. */
  ai?: AiAsk;
  /** Tick "I agree / I certify" boxes (autopilot). */
  agreeToTerms?: boolean;
  /** Autopilot: also find Next/Submit on sites without an adapter. */
  autopilot?: boolean;
  /** Picking up after you (Continue): on the first page, fill only required fields that are still empty. */
  requiredOnly?: boolean;
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
  setSkillPicker(opts.ai?.pickSkills);
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
        ai: opts.ai,
        agreeToTerms: opts.agreeToTerms,
        // Only the page you were on; pages after it get a normal fill.
        requiredOnly: opts.requiredOnly && page === (opts.startPage ?? 1),
        overwrite: opts.requiredOnly && page === (opts.startPage ?? 1) ? false : opts.overwrite,
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
      const generic = opts.autopilot && !adapter.nextButton;
      const next = adapter.nextButton?.() ?? (generic ? genericNext() : null);
      const final = adapter.isFinalPage?.() ?? (generic ? genericFinal() : false);
      if (!opts.autoAdvance || !next || final) {
        // A greyed-out Next means the site still wants something on this page.
        const greyed = !final && !next && generic && !!disabledNext();
        report.stop = final ? 'final' : blocking.length || greyed ? 'blocked' : 'no-next';
        report.message = final
          ? 'Reached the review/submit step — check everything and submit yourself.'
          : greyed
            ? `Next is greyed out — something required on page ${page} is still missing.${blocking.length ? '' : ' ' + summary(fields)}`
            : summary(fields);
        break;
      }
      const blockedMsg = `Stopped on page ${page}: ${blocking.length} required field(s) need you. Fix them, then press Fill again to continue.`;
      // Autopilot lets the site decide what's really required: press Next anyway, and only stop
      // if the site refuses. (A flag can be ours alone: a phone's country picker, a value we couldn't read back.)
      const tryAnyway = blocking.length > 0 && !!opts.autopilot;
      if (blocking.length && !tryAnyway) {
        report.stop = 'blocked';
        report.message = blockedMsg;
        break;
      }
      checkCancel();
      status(`Page ${page} done — clicking Next and waiting for page ${page + 1}…`);
      const signature = () => adapter.pageSignature?.() ?? (generic ? genericSignature() : location.href);
      const sig = signature();
      const hadErrors = generic && pageErrors();
      opts.onNavigate?.(page + 1);
      realClick(next);
      // A pop-up that appears on Next ("Notice… I Agree") is pressed through, then we keep waiting.
      let pressed = 0;
      const moved = await waitFor(
        () => {
          if (signature() !== sig) return 'moved';
          const b = opts.autopilot && pressed < 2 ? findBlocker() : null;
          if (b) {
            pressed++;
            markTried(b.button);
            realClick(b.button);
            status(`Pop-up after Next: pressed "${b.label}"…`);
            return null;
          }
          return adapter.hasErrors?.() || (generic && !hadErrors && pageErrors()) ? 'error' : null;
        },
        { timeout: 15000, interval: 250 },
      );
      if (moved !== 'moved' && tryAnyway) {
        report.stop = 'blocked';
        report.message = blockedMsg;
        break;
      }
      if (moved !== 'moved') {
        report.stop = moved === 'error' ? 'errors' : 'not-moved';
        report.message = moved === 'error' ? `Page ${page} has validation errors — fix them, then press Fill again.` : `Clicked Next on page ${page}, but the page didn't change.`;
        break;
      }
      if (page === MAX_PAGES) report.stop = 'max-pages';
      await waitForSettle(800, 10000);
      opts.onReport({ ...report, done: false, message: `Moving to page ${page + 1}…` });
      await sleep(300);
      checkCancel();
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    report = { ...report, fields: rows, cancelled: true, stop: 'cancelled', message: `Stopped. ${summary(rows)} Anything already filled stays — press Fill to redo it.` };
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
  setSkillPicker(opts.ai?.pickSkills);
  begin((current) => opts.onReport({ ...report, done: false, current }));
  try {
    const field = fieldFor(target);
    if (!field) {
      report.message = "Couldn't find a form field where you clicked. Click into the field, then try again.";
    } else {
      const row = await fillSingle(field, { profile: opts.profile, resume: opts.resume, adapter, learned: opts.learned, overwrite: true, ai: opts.ai });
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
  const review = fields.filter((f) => f.status === 'filled' && f.review).length;
  return `Filled ${n('filled')}${review ? ` (${review} to review)` : ''}, ${flagged} need you, ${n('skipped')} skipped.${flagged ? ' Flagged fields are outlined in orange.' : ''}${
    review ? " AI answers it wasn't sure of are outlined in pink." : ''
  }`;
}

// ---------- Highlighting ----------

const STYLE_ID = 'rej-styles';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    [data-rej-state="flagged"] { outline: 2px solid #f59e0b !important; outline-offset: 2px !important; border-radius: 4px; }
    [data-rej-state="review"] { outline: 2px solid #ec4899 !important; outline-offset: 2px !important; border-radius: 4px; background-color: rgba(236,72,153,.07) !important; }
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
      const state = f.status === 'filled' && f.review ? 'review' : f.status;
      t.setAttribute('data-rej-state', state);
      t.title = state !== 'filled' ? `Autofill: ${f.reason ?? 'check this'}` : t.title;
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
