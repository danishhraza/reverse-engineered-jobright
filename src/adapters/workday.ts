import type { Adapter, FillContext } from './types';
import type { Education, FieldReport, Work, YearMonth } from '../types';
import { byText, cleanText, isVisible, realClick, waitFor, waitForSettle } from '../engine/dom';
import { scanFields, type Field } from '../engine/fields';
import { norm, type Desired } from '../engine/match';
import { fillField } from '../engine/widgets';

// Workday: multi-page wizard, repeatable "Work Experience N" / "Education N"
// panels behind "Add" buttons, its own dropdowns and month/year date inputs.

const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel)).find((el) => isVisible(el)) ?? null;

const HEADING_SEL = 'h2, h3, h4, h5, legend, [role="heading"], [data-automation-id*="Heading"], [data-automation-id*="title" i]';

function sectionContainer(title: RegExp): HTMLElement | null {
  const heading = byText<HTMLElement>(HEADING_SEL, title);
  if (!heading) return null;
  let node: HTMLElement | null = heading.parentElement;
  for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
    if (addButton(node) || numberedHeadings(node, title).length) return node;
  }
  return null;
}

function addButton(container: ParentNode): HTMLElement | null {
  const buttons = Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(
    (b) => isVisible(b) && (/^add( another)?$/i.test(cleanText(b)) || b.getAttribute('data-automation-id') === 'Add' || b.getAttribute('data-automation-id') === 'add-button'),
  );
  return buttons[buttons.length - 1] ?? null;
}

function numberedHeadings(container: ParentNode, title: RegExp): HTMLElement[] {
  const base = title.source.replace(/^\^|\$$/g, '');
  const re = new RegExp(`^${base}\\s*\\d+$`, 'i');
  return Array.from(container.querySelectorAll<HTMLElement>(HEADING_SEL)).filter((h) => isVisible(h) && re.test(cleanText(h)));
}

function panelFor(heading: HTMLElement, all: HTMLElement[]): HTMLElement {
  let node: HTMLElement = heading;
  while (node.parentElement) {
    const parent = node.parentElement;
    if (all.some((h) => h !== heading && parent.contains(h))) break;
    node = parent;
    if (node.querySelector('input, textarea, button[aria-haspopup="listbox"]') && node.matches('[role="group"], fieldset, section, [data-automation-id]')) break;
  }
  return node;
}

function panels(container: HTMLElement, title: RegExp): HTMLElement[] {
  const hs = numberedHeadings(container, title);
  return hs.map((h) => panelFor(h, hs));
}

const pad = (n: number) => String(n).padStart(2, '0');

function dateValue(f: Field, ym: YearMonth | undefined): string | null {
  if (!ym) return null;
  const h = `${f.hints} ${norm(f.el.getAttribute('aria-label') ?? '')}`;
  if (/month/.test(h)) return ym.month ? pad(ym.month) : null;
  if (/year/.test(h)) return String(ym.year);
  return ym.month ? `${pad(ym.month)}/${ym.year}` : String(ym.year);
}

type EntryResolver<T> = (f: Field, label: string, entry: T) => Desired | null | 'skip';

const workResolver: EntryResolver<Work> = (f, label, w) => {
  if (/currently work|current(ly)? (employed|working)|i currently/.test(label)) return { text: w.current ? 'Yes' : 'No', bool: !!w.current };
  if (/title|position|role$/.test(label)) return { text: w.title };
  if (/company|employer|organi[sz]ation/.test(label)) return { text: w.company };
  if (/location/.test(label)) return w.location ? { text: w.location } : 'skip';
  if (/^from$|start/.test(label)) {
    const v = dateValue(f, w.start);
    return v ? { text: v } : 'skip';
  }
  if (/^to$|end/.test(label)) {
    if (w.current) return 'skip';
    const v = dateValue(f, w.end);
    return v ? { text: v } : 'skip';
  }
  if (/description|responsibilit|summary|duties/.test(label)) {
    const text = w.summary ?? (w.bullets ?? []).map((b) => `• ${b}`).join('\n');
    return text ? { text } : 'skip';
  }
  return null;
};

const eduResolver: EntryResolver<Education> = (f, label, e) => {
  if (/school|university|college|institution/.test(label)) return { text: e.school };
  if (/degree/.test(label)) {
    const alts = [e.degreeShort ?? '', /master/i.test(e.degree) ? "Master's Degree" : /bachelor/i.test(e.degree) ? "Bachelor's Degree" : ''].filter(Boolean);
    return { text: e.degree, alts };
  }
  if (/field of study|major|discipline/.test(label)) return { text: e.major };
  if (/gpa|overall result|grade/.test(label)) return e.gpa ? { text: e.gpa } : 'skip';
  if (/^from$|start/.test(label)) {
    const v = dateValue(f, e.start);
    return v ? { text: v } : 'skip';
  }
  if (/^to$|end|graduat/.test(label)) {
    const v = dateValue(f, e.end);
    return v ? { text: v } : 'skip';
  }
  return null;
};

async function fillRepeatable<T>(ctx: FillContext, title: RegExp, name: string, entries: T[], resolver: EntryResolver<T>): Promise<void> {
  const container = sectionContainer(title);
  if (!container || !entries.length) return;
  for (let i = 0; i < entries.length; i++) {
    let ps = panels(container, title);
    if (ps.length <= i) {
      const add = addButton(container);
      if (!add) break;
      realClick(add);
      await waitFor(() => panels(container, title).length > i, { timeout: 5000 });
      await waitForSettle(300, 2000);
      ps = panels(container, title);
      if (ps.length <= i) {
        ctx.extra.push({ id: '', label: `${name} ${i + 1}`, status: 'flagged', confidence: 0, reason: 'Could not add another entry' });
        break;
      }
    }
    const panel = ps[i];
    const fields = scanFields({ root: panel });
    // Fill the "currently work here" checkbox first: it hides the end date.
    fields.sort((a, b) => Number(b.kind === 'checkbox') - Number(a.kind === 'checkbox'));
    for (const f of fields) {
      ctx.handled.add(f.id);
      const label = norm(f.label);
      const d = resolver(f, label, entries[i]);
      const rowLabel = `${name} ${i + 1}: ${f.label || f.hints}`;
      if (d === 'skip') continue;
      if (!d) {
        if (f.required) ctx.extra.push({ id: f.id, label: rowLabel, status: 'flagged', confidence: 0, reason: 'Unknown field in section', required: true });
        continue;
      }
      if (!f.el.isConnected) continue; // e.g. end date removed after ticking "currently work here"
      const r = await fillField(f, d, ctx.overwrite);
      const conf = 0.9 * r.match;
      const status: FieldReport['status'] = !r.ok ? 'flagged' : r.skipped ? 'skipped' : conf < 0.75 ? 'flagged' : 'filled';
      ctx.extra.push({ id: f.id, label: rowLabel, status, confidence: Math.round(conf * 100) / 100, value: r.value, reason: r.reason, required: f.required });
      await waitForSettle(150, 800);
    }
  }
  // Leave the generic pass out of these sections entirely.
  for (const f of scanFields({ root: container })) ctx.handled.add(f.id);
}

async function fillSkills(ctx: FillContext): Promise<void> {
  const container = sectionContainer(/^skills$/i);
  if (!container) return;
  const field = scanFields({ root: container }).find((f) => f.kind === 'combobox' || f.kind === 'text');
  if (!field) return;
  ctx.handled.add(field.id);
  const picked: string[] = [];
  for (const skill of ctx.profile.skills.slice(0, 15)) {
    const r = await fillField({ ...field, kind: 'combobox' }, { text: skill }, true);
    if (r.ok && r.match >= 0.85) picked.push(skill);
  }
  ctx.extra.push({
    id: field.id,
    label: 'Skills',
    status: picked.length ? 'filled' : 'flagged',
    confidence: picked.length ? 0.85 : 0,
    value: picked.join(', '),
    reason: picked.length ? undefined : 'No skills matched Workday’s list',
  });
}

export const workday: Adapter = {
  name: 'Workday',
  detect: (loc, doc) => /myworkday(jobs|site)?\.com$/.test(loc.hostname) || !!doc.querySelector('[data-automation-id="applyFlowPage"], [data-automation-id="pageFooterNextButton"]'),
  resumeInput: () =>
    q<HTMLInputElement>('input[data-automation-id="file-upload-input-ref"]') ??
    document.querySelector<HTMLInputElement>('input[type="file"][data-automation-id*="file" i]'),
  async waitResumeProcessed(_input, file) {
    const base = file.name.replace(/\.[^.]+$/, '');
    const ok = await waitFor(
      () =>
        !!document.querySelector('[data-automation-id="file-upload-successful"], [data-automation-id="fileUploadSuccessful"]') ||
        (document.body.textContent?.includes(base) && !/uploading/i.test(document.body.textContent ?? '')) ||
        /successfully uploaded/i.test(document.body.textContent ?? ''),
      { timeout: 30000, interval: 300 },
    );
    return !!ok;
  },
  async fillSpecial(ctx) {
    await fillRepeatable(ctx, /^work experience$/i, 'Work', ctx.profile.work, workResolver);
    await fillRepeatable(ctx, /^education$/i, 'Education', ctx.profile.education, eduResolver);
    await fillSkills(ctx);
  },
  nextButton: () =>
    q('[data-automation-id="pageFooterNextButton"], [data-automation-id="bottom-navigation-next-button"]') ??
    byText<HTMLElement>('button', /^(save and continue|next|continue)$/i) ??
    null,
  isFinalPage: () => {
    const next = workday.nextButton!();
    if (next && /submit/i.test(cleanText(next))) return true;
    return !!byText(HEADING_SEL, /^review$/i) || !!byText('button', /^submit$/i);
  },
  pageSignature: () =>
    cleanText(q('[data-automation-id="progressBarActiveStep"], [aria-current="step"]')) ||
    cleanText(q('h2, [data-automation-id="pageHeader"]')) ||
    location.href,
  hasErrors: () =>
    !!q('[data-automation-id="errorBanner"], [data-automation-id="errorMessage"]') ||
    !!Array.from(document.querySelectorAll('[role="alert"]')).find((a) => isVisible(a) && /error/i.test(a.textContent ?? '')),
};
