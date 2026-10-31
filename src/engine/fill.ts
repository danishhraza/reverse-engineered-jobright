import type { Adapter, FillContext } from '../adapters/types';
import type { Answer, FieldReport, Profile } from '../types';
import { classify, resolve } from './answers';
import { sleep, waitFor, waitForSettle } from './dom';
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

export async function fillPage(opts: PageFillOptions): Promise<FieldReport[]> {
  const { profile, adapter } = opts;
  const rows: FieldReport[] = [];
  const ctx: FillContext = { profile, resume: opts.resume, overwrite: opts.overwrite, handled: new Set(), extra: [] };
  const emit = () => opts.onProgress?.([...ctx.extra, ...rows]);

  // 1. Resume.
  const initial = scanFields();
  const resumeRow = await uploadResume(initial, opts);
  if (resumeRow) {
    rows.push(resumeRow);
    emit();
  }

  // 2. Adapter-specific sections (Workday work/education entries, etc).
  if (adapter.fillSpecial) {
    try {
      await adapter.fillSpecial(ctx);
    } catch (e) {
      ctx.extra.push({ id: '', label: `${adapter.name} sections`, status: 'failed', confidence: 0, reason: String(e) });
    }
    emit();
  }

  // 3. Generic pass. Re-scan after each pass: answering one question can reveal others.
  const done = new Set<string>(ctx.handled);
  if (resumeRow?.id) done.add(resumeRow.id);
  for (let pass = 0; pass < 3; pass++) {
    const fields = scanFields().filter((f) => !done.has(f.id) && !ctx.handled.has(f.id));
    if (!fields.length) break;
    for (const f of fields) {
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
  for (let i = 0; i < tries; i++) {
    try {
      last = await fillField(f, res.desired, opts.overwrite);
    } catch (e) {
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
  const target = findResumeInput(fields, opts.adapter);
  if (!target) return null;
  const input = target.el as HTMLInputElement;
  if (!opts.resume) return row(target, 'flagged', 0, 'resume', 'No resume file saved for this profile — add it in Options');
  if (input.files?.length && input.files[0].name === opts.resume.name) return row(target, 'filled', 1, 'resume', 'Already attached', opts.resume.name);
  if (alreadyUploadedText(input, opts.resume.name) && !opts.overwrite) return row(target, 'skipped', 1, 'resume', 'Resume already uploaded', opts.resume.name);

  const dt = new DataTransfer();
  dt.items.add(opts.resume);
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

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
