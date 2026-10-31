import { cleanText, isVisible, pressKey, realClick, setNativeValue, sleep, typeText, waitFor, waitForSettle } from './dom';
import { comboboxDisplay, currentValue, type Field } from './fields';
import { isPlaceholderOption, jaccard, matchOption, norm, type Desired } from './match';

// One function per widget kind. Each returns how confident we are that the
// field now holds the right answer.

export interface WidgetResult {
  ok: boolean;
  value?: string;
  /** How well the chosen option matched the desired answer (1 for free text). */
  match: number;
  reason?: string;
  skipped?: boolean;
}

export const MIN_MATCH = 0.6;

const OPTION_SEL = [
  '[role="option"]',
  '[data-automation-id="promptOption"]',
  '[data-automation-id="menuItem"]',
  '.select__option',
  '.select2-results__option',
  '[class*="option"][id*="-option-"]',
].join(', ');

export async function fillField(f: Field, d: Desired, overwrite: boolean): Promise<WidgetResult> {
  switch (f.kind) {
    case 'text':
    case 'textarea':
      return fillText(f, d.text, overwrite);
    case 'date':
      return fillText(f, toIsoDate(d.text), overwrite);
    case 'select':
      return fillSelect(f, d, overwrite);
    case 'radio':
    case 'buttonGroup':
      return fillChoice(f, d, overwrite);
    case 'checkbox':
      return fillCheckbox(f, d);
    case 'checkboxGroup':
      return fillCheckboxGroup(f, d);
    case 'combobox':
      return fillCombobox(f, d, overwrite);
    case 'file':
      return { ok: false, match: 0, reason: 'File inputs are handled separately' };
  }
}

function toIsoDate(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s;
}

const digits = (s: string) => s.replace(/\D/g, '');

async function fillText(f: Field, value: string, overwrite: boolean): Promise<WidgetResult> {
  const el = f.el as HTMLInputElement | HTMLTextAreaElement;
  const cur = el.value ?? '';
  if (cur === value) return { ok: true, value, match: 1 };
  if (cur.trim() && !overwrite) return { ok: true, value: cur, match: 1, skipped: true, reason: 'Already filled' };
  el.focus({ preventScroll: true });
  setNativeValue(el, value);
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  await sleep(30);
  const now = el.value;
  if (now === value) return { ok: true, value, match: 1 };
  // Input masks (phone) reformat the value; accept if the digits survived.
  if (digits(value).length >= 7 && digits(now).endsWith(digits(value).slice(-7))) return { ok: true, value: now, match: 0.95 };
  if (el.maxLength > 0 && value.startsWith(now)) return { ok: true, value: now, match: 0.8, reason: `Truncated to ${el.maxLength} chars` };
  return { ok: false, match: 0, reason: `Value did not stick (field shows "${now.slice(0, 40)}")` };
}

async function fillSelect(f: Field, d: Desired, overwrite: boolean): Promise<WidgetResult> {
  const el = f.el as HTMLSelectElement;
  const opts = Array.from(el.options);
  const m = matchOption(
    opts.map((o) => o.textContent ?? ''),
    d,
  );
  if (!m) return { ok: false, match: 0, reason: 'No matching option' };
  const opt = opts[m.index];
  const label = cleanText(opt);
  if (m.score < MIN_MATCH) return { ok: false, match: m.score, value: label, reason: `Best option "${label}" is a weak match` };
  const cur = currentValue(f);
  if (cur && !overwrite && cur !== label) return { ok: true, value: cur, match: 1, skipped: true, reason: 'Already selected' };
  if (el.value !== opt.value) setNativeValue(el, opt.value);
  return el.value === opt.value ? { ok: true, value: label, match: m.score } : { ok: false, match: 0, reason: 'Selection did not stick' };
}

async function fillChoice(f: Field, d: Desired, overwrite: boolean): Promise<WidgetResult> {
  const choices = f.choices ?? [];
  const m = matchOption(
    choices.map((c) => c.label),
    d,
  );
  if (!m) return { ok: false, match: 0, reason: 'No matching option' };
  const choice = choices[m.index];
  if (m.score < MIN_MATCH) return { ok: false, match: m.score, value: choice.label, reason: `Best option "${choice.label}" is a weak match` };
  const cur = currentValue(f);
  if (cur === choice.label) return { ok: true, value: cur, match: m.score };
  if (cur && !overwrite) return { ok: true, value: cur, match: 1, skipped: true, reason: 'Already answered' };
  const input = choice.el as HTMLInputElement;
  const target = f.kind === 'radio' && !isVisible(input) && input.labels?.[0] ? input.labels[0] : input;
  realClick(target);
  await sleep(50);
  if (f.kind === 'radio' && !input.checked) {
    // Some frameworks only listen to label clicks.
    if (input.labels?.[0] && target !== input.labels[0]) realClick(input.labels[0]);
    await sleep(50);
    if (!input.checked) return { ok: false, match: 0, reason: 'Radio did not select' };
  }
  return { ok: true, value: choice.label, match: m.score };
}

async function fillCheckbox(f: Field, d: Desired): Promise<WidgetResult> {
  const el = f.el as HTMLInputElement;
  const want = d.bool ?? /^(yes|true|1)$/i.test(d.text);
  if (el.checked !== want) {
    realClick(!isVisible(el) && el.labels?.[0] ? el.labels[0] : el);
    await sleep(50);
  }
  return el.checked === want ? { ok: true, value: want ? 'Checked' : 'Unchecked', match: 1 } : { ok: false, match: 0, reason: 'Checkbox did not toggle' };
}

async function fillCheckboxGroup(f: Field, d: Desired): Promise<WidgetResult> {
  const choices = f.choices ?? [];
  const wanted = d.multi?.length ? d.multi.map((text) => ({ text })) : [d];
  const picked: string[] = [];
  let worst = 1;
  for (const w of wanted) {
    const m = matchOption(
      choices.map((c) => c.label),
      w as Desired,
    );
    if (!m || m.score < MIN_MATCH) return { ok: false, match: m?.score ?? 0, reason: `No good option for "${w.text}"` };
    const input = choices[m.index].el as HTMLInputElement;
    if (!input.checked) realClick(!isVisible(input) && input.labels?.[0] ? input.labels[0] : input);
    await sleep(50);
    if (!input.checked) return { ok: false, match: 0, reason: 'Checkbox did not toggle' };
    picked.push(choices[m.index].label);
    worst = Math.min(worst, m.score);
  }
  return { ok: true, value: picked.join(', '), match: worst };
}

// ---------- Custom dropdowns (react-select, Workday prompts, Ashby, ...) ----------

function visibleOptions(trigger: HTMLElement): HTMLElement[] {
  const ids = (trigger.getAttribute('aria-controls') || trigger.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
  const scoped = ids.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
  const roots: ParentNode[] = scoped.length ? scoped : [document];
  const out: HTMLElement[] = [];
  for (const r of roots) {
    for (const o of Array.from(r.querySelectorAll<HTMLElement>(OPTION_SEL))) {
      if (o.closest('.rej-ui') || !isVisible(o) || o.querySelector(OPTION_SEL)) continue;
      if (o.getAttribute('aria-disabled') === 'true') continue;
      out.push(o);
    }
  }
  return out.filter((o) => !isPlaceholderOption(cleanText(o)));
}

function isOpen(trigger: HTMLElement): boolean {
  return trigger.getAttribute('aria-expanded') === 'true' || visibleOptions(trigger).length > 0;
}

function queriesFor(d: Desired): string[] {
  const first = d.query ?? d.text;
  const qs = [first];
  const words = first.split(/[\s,]+/).filter(Boolean);
  if (words.length > 2) qs.push(words.slice(0, 2).join(' '));
  for (const a of d.alts ?? []) if (a.length >= 2 && !qs.includes(a)) qs.push(a);
  return qs.slice(0, 3);
}

function displayMatches(display: string, d: Desired, chosen: string): boolean {
  if (!display) return false;
  const n = norm(display);
  return n === norm(chosen) || n.includes(norm(chosen)) || norm(chosen).includes(n) || jaccard(display, chosen) >= 0.5 || n.includes(norm(d.text));
}

async function fillCombobox(f: Field, d: Desired, overwrite: boolean): Promise<WidgetResult> {
  const trigger = f.el;
  const before = comboboxDisplay(trigger);
  if (before && !overwrite) return { ok: true, value: before, match: 1, skipped: true, reason: 'Already selected' };
  if (before && displayMatches(before, d, d.text)) return { ok: true, value: before, match: 0.95 };

  const typable = trigger.tagName === 'INPUT' && !(trigger as HTMLInputElement).readOnly ? (trigger as HTMLInputElement) : null;
  // Search boxes: try the answer, a shorter form, an alternate, then an empty query (full list).
  // Plain dropdowns: open twice (the first open sometimes only focuses).
  const queries = typable ? [...queriesFor(d), ''] : ['', ''];
  let best: { label: string; score: number } | null = null;
  const optionsNow = () => {
    const o = visibleOptions(trigger);
    return o.length ? o : null;
  };

  for (let attempt = 0; attempt < queries.length; attempt++) {
    const query = queries[attempt];
    realClick(trigger);
    if (typable) typeText(typable, query);

    let options = await waitFor(optionsNow, { timeout: 2500 });
    if (!options && typable && attempt === 0) {
      // Workday-style prompts only search on Enter.
      pressKey(typable, 'Enter');
      options = await waitFor(optionsNow, { timeout: 2500 });
    }
    if (!options) {
      closeDropdown(trigger);
      await sleep(200 * (attempt + 1));
      continue;
    }
    // Async lists keep changing for a moment ("Loading..." -> results).
    await waitForSettle(250, 1500);
    options = visibleOptions(trigger);

    // Up to two levels: Workday nests options ("Job Board" -> "LinkedIn").
    for (let level = 0; level < 2 && options.length; level++) {
      const labels = options.map((o) => cleanText(o));
      const m = matchOption(labels, d);
      if (!m || m.score < MIN_MATCH) {
        if (m && (!best || m.score > best.score)) best = { label: labels[m.index], score: m.score };
        break;
      }
      const chosen = labels[m.index];
      realClick(options[m.index]);
      await sleep(250);
      const display = comboboxDisplay(trigger);
      if (displayMatches(display, d, chosen)) {
        closeDropdown(trigger);
        return { ok: true, value: display, match: m.score };
      }
      // Nested menu opened instead of selecting?
      const next = visibleOptions(trigger);
      const nextLabels = next.map((o) => cleanText(o)).join('|');
      if (next.length && nextLabels !== labels.join('|')) {
        options = next;
        continue;
      }
      closeDropdown(trigger);
      // Selected but the widget shows the value somewhere we can't see.
      if (!isOpen(trigger)) return { ok: true, value: chosen, match: Math.min(m.score, 0.7), reason: "Selected, but couldn't read it back — check it" };
      break;
    }
    closeDropdown(trigger);
    await sleep(150);
  }
  if (typable && typable.value && !comboboxDisplay(trigger)) setNativeValue(typable, '');
  return best
    ? { ok: false, match: best.score, value: best.label, reason: `Closest option "${best.label}" is a weak match` }
    : { ok: false, match: 0, reason: 'Dropdown options never appeared' };
}

function closeDropdown(trigger: HTMLElement): void {
  if (trigger.getAttribute('aria-expanded') === 'true' || visibleOptions(trigger).length) {
    pressKey(trigger, 'Escape');
  }
  trigger.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
}
