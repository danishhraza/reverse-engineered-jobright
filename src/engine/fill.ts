import type { Adapter, FillContext } from '../adapters/types';
import type { Answer, FieldReport, Profile } from '../types';
import { classify, resolve } from './answers';
import { checkCancel, rethrowCancel, status } from './control';
import { cleanText, isVisible, realClick, sleep, squash, waitFor, waitForSettle } from './dom';
import { currentValue, scanFields, stampId, type Field } from './fields';
import { fillField, MIN_MATCH } from './widgets';
import { norm } from './match';

// The page-level fill loop: upload the resume first (sites re-parse it and
// overwrite fields), then fill every field, retrying each a few times, and
// flag anything we're unsure of for a human.

export interface PageFillOptions {
  profile: Profile;
  resume?: File;
  adapter: Adapter;
  learned: Answer[];
  overwrite: boolean;
  onProgress?: (rows: FieldReport[]) => void;
}

/** Below this, fill nothing and ask the human. Between this and AUTO_OK, fill but ask the human to check. */
const ASK_HUMAN = 0.55;
const AUTO_OK = 0.75;
const RETRIES = 3;
/** How long to keep watching for fields that render after the page looks done. */
const LATE_FIELDS_MS = 5000;

export async function fillPage(opts: PageFillOptions): Promise<FieldReport[]> {
  const { profile, adapter } = opts;
  const rows: FieldReport[] = [];
  const ctx: FillContext = { profile, resume: opts.resume, overwrite: opts.overwrite, handled: new Set(), extra: [] };
  const emit = () => opts.onProgress?.([...ctx.extra, ...rows]);

  // Some ATSs (SuccessFactors) are still rendering sections when we start.
  status('Waiting for the page to finish loading…');
  await waitForSettle(400, 3000);
  checkCancel();

  // 1. Resume.
  const initial = scanFields();
  const resumeRow = await uploadResume(initial, opts);
  if (resumeRow) {
    rows.push(resumeRow);
    emit();
  }

  // 2. Adapter-specific sections (Workday work/education entries, etc).
  if (adapter.fillSpecial) {
    checkCancel();
    try {
      await adapter.fillSpecial(ctx);
    } catch (e) {
      rethrowCancel(e);
      ctx.extra.push({ id: '', label: `${adapter.name} sections`, status: 'failed', confidence: 0, reason: String(e) });
    }
    emit();
  }

  // 3. Generic pass. Re-scan after each pass: answering one question can reveal others.
  const done = new Set<string>(ctx.handled);
  if (resumeRow?.id) done.add(resumeRow.id);
  const fresh = () => scanFields().filter((f) => !done.has(f.id) && !ctx.handled.has(f.id));
  for (let pass = 0; pass < 8; pass++) {
    let fields = fresh();
    if (!fields.length) {
      // Nothing new yet. Sections can render seconds later (SuccessFactors), so
      // keep looking for a while before calling the page done.
      status('Checking for sections that load late…');
      const until = Date.now() + LATE_FIELDS_MS;
      while (!fields.length && Date.now() < until) {
        await sleep(500);
        checkCancel();
        fields = fresh();
      }
      if (!fields.length) break;
    }
    for (const f of fields) {
      checkCancel();
      done.add(f.id);
      if (f.kind === 'file') {
        if (f.required && !currentValue(f)) rows.push(row(f, 'flagged', 0, undefined, 'File upload needed'));
        continue;
      }
      const r = await fillOne(f, opts);
      if (r) {
        rows.push(r);
        emit();
      }
    }
    await waitForSettle(300, 1500);
  }
  return [...ctx.extra, ...rows];
}

/**
 * Fill just one field (the one you clicked). Always overwrites: you asked for it.
 * Returns null when the field isn't something we know how to answer.
 */
export async function fillSingle(f: Field, opts: PageFillOptions): Promise<FieldReport | null> {
  const o = { ...opts, overwrite: true };
  if (f.kind === 'file') {
    if (/cover/i.test(`${f.label} ${f.hints}`)) return row(f, 'flagged', 0, 'coverLetter', 'Cover letter — attach it yourself');
    return uploadTo(f, o);
  }
  if (opts.adapter.fillOne) {
    const ctx: FillContext = { profile: opts.profile, resume: opts.resume, overwrite: true, handled: new Set(), extra: [] };
    const r = await opts.adapter.fillOne(ctx, f);
    if (r !== undefined) return r;
  }
  return fillOne(f, o);
}

function row(f: Field, status: FieldReport['status'], confidence: number, key?: string, reason?: string, value?: string): FieldReport {
  return { id: f.id, label: f.label || '(unlabeled field)', key, status, confidence: Math.round(confidence * 100) / 100, reason, value, required: f.required };
}

async function fillOne(f: Field, opts: PageFillOptions): Promise<FieldReport | null> {
  const c = classify(f, opts.profile.answers, opts.learned);
  if (!c) {
    if (f.required && !currentValue(f)) return row(f, 'flagged', 0, undefined, "Couldn't work out what this asks");
    return f.label ? row(f, 'skipped', 0, undefined, 'Not recognised (optional)') : null;
  }
  const res = resolve(c, opts.profile, f);
  if ('skip' in res) {
    if (c.key === 'resume') return null;
    return f.required && !currentValue(f) ? row(f, 'flagged', c.score, c.key, res.skip) : row(f, 'skipped', c.score, c.key, res.skip);
  }
  if ('flag' in res) {
    if (currentValue(f) && !f.required) return row(f, 'skipped', c.score, c.key, res.flag, currentValue(f));
    return row(f, 'flagged', c.score, c.key, res.flag, currentValue(f) || undefined);
  }
  if (c.score < ASK_HUMAN) return row(f, 'flagged', c.score, c.key, 'Not sure what this field is');

  let last = { ok: false, match: 0, reason: 'Not attempted' } as Awaited<ReturnType<typeof fillField>>;
  // Dropdowns already retry with several queries internally.
  const tries = f.kind === 'combobox' ? 1 : RETRIES;
  const name = f.label ? `"${f.label.length > 60 ? `${f.label.slice(0, 57)}…` : f.label}"` : 'a field';
  for (let i = 0; i < tries; i++) {
    checkCancel();
    status(i ? `Retrying ${name} (try ${i + 1} of ${tries})…` : f.kind === 'combobox' ? `Picking ${name} — waiting for its options…` : `Filling ${name}…`);
    try {
      last = await fillField(f, res.desired, opts.overwrite);
    } catch (e) {
      rethrowCancel(e);
      last = { ok: false, match: 0, reason: String(e) };
    }
    if (last.ok || (last.match > 0 && last.match < MIN_MATCH)) break; // weak match won't improve by retrying
    await sleep(250 * (i + 1));
  }
  const conf = c.score * last.match;
  if (!last.ok) return row(f, 'flagged', conf, c.key, last.reason, last.value);
  if (last.skipped) return row(f, 'skipped', conf, c.key, last.reason, last.value);
  if (conf < AUTO_OK) return row(f, 'flagged', conf, c.key, last.reason ?? 'Filled, but low confidence — check it', last.value);
  return row(f, 'filled', conf, c.key, last.reason, last.value);
}

// ---------- Resume upload ----------

function findResumeInput(fields: Field[], adapter: Adapter): Field | null {
  const custom = adapter.resumeInput?.(fields);
  if (custom) return fields.find((f) => f.el === custom) ?? { id: stampId(custom), kind: 'file', el: custom, label: 'Resume', hints: '', required: true };
  const files = fields.filter((f) => f.kind === 'file');
  const score = (f: Field) => {
    const t = norm(`${f.label} ${f.hints}`);
    if (/cover/.test(t)) return -1;
    if (/autofill|parse/.test(t)) return 0;
    if (/resume|\bcv\b|curriculum/.test(t)) return 2;
    return 1;
  };
  const ranked = files.map((f) => ({ f, s: score(f) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
  return ranked[0]?.f ?? null;
}

async function uploadResume(fields: Field[], opts: PageFillOptions): Promise<FieldReport | null> {
  const target = findResumeInput(fields, opts.adapter) ?? (opts.resume ? await revealResumeInput(opts.adapter) : null);
  return target ? uploadTo(target, opts) : null;
}

async function uploadTo(target: Field, opts: PageFillOptions): Promise<FieldReport> {
  if (!/resume|\bcv\b/i.test(target.label)) target = { ...target, label: 'Resume' };
  const input = target.el as HTMLInputElement;
  if (!opts.resume) return row(target, 'flagged', 0, 'resume', 'No resume file saved for this profile — add it in Options');
  if (input.files?.length && input.files[0].name === opts.resume.name) return row(target, 'filled', 1, 'resume', 'Already attached', opts.resume.name);
  if (alreadyUploadedText(input, opts.resume.name) && !opts.overwrite) return row(target, 'skipped', 1, 'resume', 'Resume already uploaded', opts.resume.name);

  status(`Uploading ${opts.resume.name} — waiting for the site to process it…`);
  const dt = new DataTransfer();
  dt.items.add(opts.resume);
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await confirmUploadDialog(input);

  const ok = opts.adapter.waitResumeProcessed
    ? await opts.adapter.waitResumeProcessed(input, opts.resume)
    : await defaultWaitUploaded(input, opts.resume);
  // Sites that parse the resume rewrite form fields right after; let that finish.
  await waitForSettle(800, 8000);
  return ok
    ? row(target, 'filled', 1, 'resume', undefined, opts.resume.name)
    : row(target, 'flagged', 0.5, 'resume', "Attached, but couldn't confirm the upload finished — check it", opts.resume.name);
}

function alreadyUploadedText(input: HTMLInputElement, name: string): boolean {
  const scope = input.closest('fieldset, [data-automation-id^="formField-"], .field, section, form') ?? document.body;
  return (scope.textContent ?? '').includes(name);
}

async function defaultWaitUploaded(input: HTMLInputElement, file: File): Promise<boolean> {
  const scope = input.closest('form') ?? document.body;
  const base = file.name.replace(/\.[^.]+$/, '');
  const seen = await waitFor(() => (scope.textContent ?? '').includes(base) || /upload(ed)? successful|successfully uploaded/i.test(scope.textContent ?? ''), { timeout: 20000, interval: 250 });
  return !!seen;
}

// Some ATSs (SuccessFactors, iCIMS) only create the file input after you click
// "Upload"/"Attach". Click it with the native file picker suppressed, then use
// whatever file input appears.
const REVEAL_TEXT = /^(upload|attach|add|browse)( a| an| your| my)?( resume| cv| file| document)?s?$|^(upload|attach|add) (resume|cv)\b/i;

function revealButton(): HTMLElement | undefined {
  const cands = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"], input[type="button"]')).filter(
    (b) => !b.closest('.rej-ui') && isVisible(b),
  );
  const text = (b: HTMLElement) => cleanText(b) || (b as HTMLInputElement).value || b.getAttribute('aria-label') || '';
  const nearResume = (b: HTMLElement) => {
    let n: HTMLElement | null = b;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const t = norm(cleanText(n));
      if (/\bcover\b/.test(t) && !/\b(resume|cv)\b/.test(t)) return false;
      if (/\b(resume|cv|curriculum vitae)\b/.test(t)) return true;
    }
    return false;
  };
  return cands.find((b) => /\b(resume|cv)\b/i.test(text(b)) && REVEAL_TEXT.test(squash(text(b)))) ?? cands.find((b) => REVEAL_TEXT.test(squash(text(b))) && nearResume(b));
}

async function revealResumeInput(adapter: Adapter): Promise<Field | null> {
  const btn = revealButton();
  if (!btn) return null;
  status('Opening the resume upload…');
  const before = new Set(document.querySelectorAll('input[type="file"]'));
  const block = (e: Event) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'file') e.preventDefault();
  };
  window.addEventListener('click', block, true);
  try {
    realClick(btn);
    const input = await waitFor(
      () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((i) => !before.has(i)),
      { timeout: 5000, interval: 200 },
    );
    await sleep(300);
    const all = scanFields();
    const found = findResumeInput(all, adapter);
    if (found) return found;
    if (!input) return null;
    return { id: stampId(input), kind: 'file', el: input, label: 'Resume', hints: '', required: true };
  } finally {
    // Leave the blocker in place briefly: some pages call input.click() on a timer.
    setTimeout(() => window.removeEventListener('click', block, true), 2000);
  }
}

/** If the input sits in an upload dialog, press its Upload/OK button. */
async function confirmUploadDialog(input: HTMLInputElement): Promise<void> {
  const dialog = input.closest('[role="dialog"], [aria-modal="true"], .modal, .dialog, [class*="Dialog"], [class*="popup" i]');
  if (!dialog) return;
  await sleep(500);
  const ok = Array.from(dialog.querySelectorAll<HTMLElement>('button, a, [role="button"], input[type="button"], input[type="submit"]')).find(
    (b) => isVisible(b) && /^(upload|ok|attach|save|done|continue)$/i.test(squash(cleanText(b) || (b as HTMLInputElement).value || '')),
  );
  if (ok) realClick(ok);
}
