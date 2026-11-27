import type { Adapter, FillContext } from './types';
import type { FieldReport } from '../types';
import { byText, cleanText, isVisible, realClick, waitFor, waitForSettle } from '../engine/dom';
import { eduResolver, fillEntryField, workResolver, type EntryResolver } from '../engine/entries';
import { checkCancel, status } from '../engine/control';
import { currentValue, scanFields, type Field } from '../engine/fields';
import { norm } from '../engine/match';
import { fillField } from '../engine/widgets';
import { knownJobText } from '../engine/salary';
import { MAX_CANDIDATES, rankSkills } from '../engine/skills';

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

/** A field inside "Work Experience N" / "Education N": fill it from entry N. */
async function fillOneInSection(ctx: FillContext, f: Field): Promise<FieldReport | null | undefined> {
  const sections = [
    [/^work experience$/i, 'Work', ctx.profile.work, workResolver],
    [/^education$/i, 'Education', ctx.profile.education, eduResolver],
  ] as const;
  for (const [title, name, entries, resolver] of sections) {
    const container = sectionContainer(title);
    if (!container?.contains(f.el)) continue;
    const i = panels(container, title).findIndex((p) => p.contains(f.el));
    if (i < 0) return undefined;
    const entry = entries[i];
    if (!entry) return { id: f.id, label: `${name} ${i + 1}: ${f.label}`, status: 'flagged', confidence: 0, reason: `Your profile has only ${entries.length} ${name.toLowerCase()} entries` };
    return fillEntryField(f, `${name} ${i + 1}`, entry as never, resolver as EntryResolver<unknown>, ctx.overwrite, undefined, ctx.aiPick);
  }
  if (sectionContainer(/^skills$/i)?.contains(f.el)) {
    await fillSkills(ctx);
    return ctx.extra.pop() ?? null;
  }
  return undefined;
}

async function fillRepeatable<T>(ctx: FillContext, title: RegExp, name: string, entries: T[], resolver: EntryResolver<T>): Promise<void> {
  const container = sectionContainer(title);
  if (!container || !entries.length) return;
  for (let i = 0; i < entries.length; i++) {
    checkCancel();
    let ps = panels(container, title);
    if (ps.length <= i) {
      status(`Workday: adding ${name} ${i + 1}…`);
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
      checkCancel();
      ctx.handled.add(f.id);
      status(`Workday: ${name} ${i + 1} — ${f.label || 'field'}…`);
      const r = await fillEntryField(f, `${name} ${i + 1}`, entries[i], resolver, ctx.overwrite, undefined, ctx.aiPick);
      if (r) ctx.extra.push(r);
    }
  }
  // Workday reads your resume in the background and can rewrite these boxes after we filled them
  // (a job title of "Azure…" from a bullet point): check the typed ones and put yours back.
  await waitForSettle(800, 4000);
  const filled = panels(container, title);
  for (let i = 0; i < Math.min(filled.length, entries.length); i++) {
    for (const f of scanFields({ root: filled[i] })) {
      if (f.kind !== 'text') continue;
      const d = resolver(f, norm(f.label), entries[i]);
      if (!d || typeof d !== 'object' || !d.text || norm(currentValue(f)) === norm(d.text)) continue;
      checkCancel();
      status(`Workday: ${name} ${i + 1} — putting back ${f.label || 'a field'}…`);
      const r = await fillEntryField(f, `${name} ${i + 1}`, entries[i], resolver, true);
      if (r) ctx.extra.push({ ...r, reason: 'Put back what Workday changed after filling' });
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
  // Your skills, the job's first: looked up in Workday's list, the best (up to 10) picked by the AI, then added.
  const ranked = rankSkills(ctx.profile.skills, knownJobText());
  if (!ranked.length) return;
  checkCancel();
  status('Workday: adding skills…');
  const r = await fillField({ ...field, kind: 'combobox' }, { text: ranked[0], multi: ranked.slice(0, MAX_CANDIDATES) }, true);
  ctx.extra.push({
    id: field.id,
    label: 'Skills',
    status: r.ok ? 'filled' : 'flagged',
    confidence: r.ok ? 0.9 : 0,
    value: r.value,
    reason: r.ok ? r.reason : (r.reason ?? 'No skills matched Workday’s list'),
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
    // Workday then reads the resume and fills sections from it: let that finish before we fill.
    if (ok) await waitForSettle(1000, 8000);
    return !!ok;
  },
  async fillSpecial(ctx) {
    await fillRepeatable(ctx, /^work experience$/i, 'Work', ctx.profile.work, workResolver);
    await fillRepeatable(ctx, /^education$/i, 'Education', ctx.profile.education, eduResolver);
    await fillSkills(ctx);
  },
  fillOne: fillOneInSection,
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
