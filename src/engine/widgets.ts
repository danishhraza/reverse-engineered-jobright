import { cleanText, isVisible, pressKey, realClick, setNativeValue, sleep, squash, typeText, waitFor, waitForSettle } from './dom';
import { checkCancel, isCancelled, status } from './control';
import { clickTarget, comboboxDisplay, currentValue, isChecked, isPressed, shadowHost, valueBoxText, type Field } from './fields';
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
  if (!overwrite && (f.kind === 'checkbox' || f.kind === 'checkboxGroup')) {
    const cur = currentValue(f);
    if (cur) return { ok: true, value: cur, match: 1, skipped: true, reason: 'Already filled' };
  }
  if (d.multi && d.multi.length > 1 && (f.kind === 'combobox' || (f.kind === 'text' && isTagInput(f.el)))) return fillTags(f, d.multi);
  if ((f.kind === 'text' || f.kind === 'combobox') && isPlacesInput(f.el)) return fillPlaces(f, d, overwrite);
  switch (f.kind) {
    case 'text':
    case 'textarea':
      return fillText(f, d.text, overwrite);
    case 'date':
      return fillText(f, toIsoDate(d.text), overwrite);
    case 'richtext':
      return fillRichText(f, d.text, overwrite);
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

function fieldName(f: Field): string {
  return f.label ? `"${f.label.length > 50 ? `${f.label.slice(0, 47)}…` : f.label}"` : 'Dropdown';
}

function toIsoDate(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s;
}

const digits = (s: string) => s.replace(/\D/g, '');

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Year and month of a date written as 06/2024, 2024-06, 06/01/2024, Jun 2024… Null if it isn't one. */
function yearMonth(s: string): { y: number; m: number } | null {
  const t = s.trim();
  if (!t || t.length > 30) return null;
  const nums = t.match(/\d+/g) ?? [];
  const yi = nums.findIndex((n) => n.length === 4);
  if (yi < 0) return null;
  const named = MONTH_NAMES.findIndex((n) => new RegExp(`\\b${n}`, 'i').test(t));
  const m = named >= 0 ? named + 1 : Number(nums.filter((_, i) => i !== yi)[0]);
  return m >= 1 && m <= 12 ? { y: Number(nums[yi]), m } : null;
}

/** Date pickers rewrite what you type into their own format: same year and month counts as stuck. */
function sameDate(a: string, b: string): boolean {
  const x = yearMonth(a);
  const y = yearMonth(b);
  return !!x && !!y && x.y === y.y && x.m === y.m;
}

async function fillText(f: Field, value: string, overwrite: boolean): Promise<WidgetResult> {
  const el = f.el as HTMLInputElement | HTMLTextAreaElement;
  const cur = el.value ?? '';
  if (cur === value || sameDate(cur, value)) return { ok: true, value: cur, match: 1 };
  if (currentValue(f).trim() && !overwrite) return { ok: true, value: cur, match: 1, skipped: true, reason: 'Already filled' };
  el.focus({ preventScroll: true });
  setNativeValue(el, value);
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  await sleep(30);
  let now = el.value;
  if (now !== value && !sameDate(now, value) && !(digits(value).length >= 7 && digits(now).endsWith(digits(value).slice(-7)))) {
    // Some forms (ADP, web components) throw away values set from script and keep only real
    // edits: let the browser insert the text itself, which fires the same events as typing.
    el.focus({ preventScroll: true });
    el.select?.();
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, value);
    } catch {
      // execCommand unavailable (tests)
    }
    if (inserted) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await sleep(50);
      now = el.value;
    }
  }
  if (now === value) return { ok: true, value, match: 1 };
  if (sameDate(now, value)) return { ok: true, value: now, match: 1 };
  // Input masks (phone) reformat the value; accept if the digits survived.
  if (digits(value).length >= 7 && digits(now).endsWith(digits(value).slice(-7))) return { ok: true, value: now, match: 0.95 };
  if (el.maxLength > 0 && value.startsWith(now)) return { ok: true, value: now, match: 0.8, reason: `Truncated to ${el.maxLength} chars` };
  return { ok: false, match: 0, reason: `Value did not stick (field shows "${now.slice(0, 40)}")` };
}

/**
 * Rich-text editors keep their own document model, so setting innerHTML is
 * undone on the next keystroke. Paste the text (every major editor handles
 * paste and keeps the line breaks), then fall back to typing it line by line.
 */
async function fillRichText(f: Field, value: string, overwrite: boolean): Promise<WidgetResult> {
  const el = f.el;
  const read = () => squash(el.innerText ?? el.textContent ?? '');
  const want = squash(value);
  const cur = read();
  if (cur === want) return { ok: true, value, match: 1 };
  if (cur && !overwrite) return { ok: true, value: cur, match: 1, skipped: true, reason: 'Already filled' };
  const lines = value.split('\n');
  const stuck = () => read().includes(squash(lines[0]).slice(0, 40)) && read().length >= want.length * 0.9;

  el.focus({ preventScroll: true });
  const selectAll = () => {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  selectAll();
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  } catch {
    // No ClipboardEvent constructor (tests).
  }
  await sleep(100);

  if (!stuck()) {
    selectAll();
    try {
      lines.forEach((line, i) => {
        if (i > 0) document.execCommand('insertParagraph');
        if (line) document.execCommand('insertText', false, line);
      });
    } catch {
      // execCommand unavailable.
    }
    await sleep(50);
  }

  if (!stuck()) {
    // Last resort for plain contenteditable divs.
    el.innerHTML = lines.map((l) => `<p>${l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!) || '<br>'}</p>`).join('');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  }
  el.dispatchEvent(new FocusEvent('blur'));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  return stuck() ? { ok: true, value, match: 1 } : { ok: false, match: 0, reason: "The text editor didn't accept the text" };
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
  // Custom-drawn radios hide the real input: click what you'd click (its label or the component).
  const target = f.kind === 'radio' ? clickTarget(input) : input;
  realClick(target);
  await sleep(80);
  if (f.kind === 'radio' && !isChecked(input)) {
    // Some frameworks only listen to one of the input / its label / the component.
    for (const alt of [input, input.labels?.[0], shadowHost(input)]) {
      if (!alt || alt === target || isChecked(input)) continue;
      realClick(alt);
      await sleep(80);
    }
    if (!isChecked(input)) return { ok: false, match: 0, reason: 'Radio did not select' };
  }
  if (f.kind === 'buttonGroup' && !isPressed(target)) {
    // A Yes/No found by its text: the thing that actually takes the click may be the radio
    // inside it, in its shadow root, or the component around it.
    const inner = target.shadowRoot?.querySelector<HTMLElement>('input, [role="radio"], label') ?? target.querySelector<HTMLElement>('input, [role="radio"]');
    for (const alt of [inner, target.closest('label'), shadowHost(target)]) {
      if (!alt || isPressed(target)) continue;
      realClick(alt);
      await sleep(80);
    }
    // Some components show the choice in ways we can't read; a click on the right word is still likely right.
    if (!isPressed(target)) return { ok: true, value: choice.label, match: Math.min(m.score, 0.85), reason: "Clicked — couldn't confirm it took" };
  }
  return { ok: true, value: choice.label, match: m.score };
}

async function fillCheckbox(f: Field, d: Desired): Promise<WidgetResult> {
  const el = f.el as HTMLInputElement;
  const want = d.bool ?? /^(yes|true|1)$/i.test(d.text);
  // A drawn checkbox (the real one hidden) may only show its state on the drawing: "…--checked".
  const target = clickTarget(el);
  const drawnChecked = () => [target, target.parentElement].some((n) => !!n && /(^|[-_\s])checked\b/i.test(typeof n.className === 'string' ? n.className : ''));
  const done = () => el.checked === want || (want && drawnChecked());
  if (!done()) {
    realClick(target);
    await sleep(80);
  }
  return done() ? { ok: true, value: want ? 'Checked' : 'Unchecked', match: 1 } : { ok: false, match: 0, reason: 'Checkbox did not toggle' };
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

/**
 * Does the box around this dropdown (up to the nearest ancestor holding another field) now show
 * `chosen`? Option lists are left out, so an open list doesn't count.
 */
function boxShows(trigger: HTMLElement, chosen: string): boolean {
  const want = ` ${norm(chosen)} `;
  return want.trim().length >= 2 && ` ${norm(valueBoxText(trigger))} `.includes(want);
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

  let typable = trigger.tagName === 'INPUT' && !(trigger as HTMLInputElement).readOnly ? (trigger as HTMLInputElement) : null;
  // First just open it and read the whole list: most dropdowns are short lists in their own
  // wording, so pick from what's there. Only search-as-you-type boxes whose list starts empty
  // (or is too long to show everything) get typed queries: the answer, a shorter form, an alternate.
  // Plain dropdowns: open twice (the first open sometimes only focuses).
  let queries = typable ? ['', ...queriesFor(d)] : ['', ''];
  // A search box inside the opened list (iCIMS "— Type to Search —", address lookups).
  let popupSearch: HTMLInputElement | null = null;
  let triedEnter = false;
  let best: { label: string; score: number } | null = null;
  const optionsNow = () => {
    const o = visibleOptions(trigger);
    return o.length ? o : null;
  };

  for (let attempt = 0; attempt < queries.length; attempt++) {
    if (isCancelled()) {
      closeDropdown(trigger);
      checkCancel();
    }
    const query = queries[attempt];
    if (attempt) status(`${fieldName(f)}: no match in the list yet, searching ${query ? `"${query}"` : 'again'} (${attempt + 1} of ${queries.length})…`);
    realClick(trigger);
    // Some lists open and close on the same click: make sure the search box is showing.
    if (popupSearch && !isVisible(popupSearch)) {
      await sleep(150);
      if (!isVisible(popupSearch)) realClick(trigger);
    }
    if (typable) typeText(typable, query);

    let options = await waitFor(optionsNow, { timeout: query ? 2500 : 1200 });
    if (query && popupSearch) {
      // Lookups (addresses) fetch results as you type: let them arrive.
      await waitForSettle(500, 4000);
      options = optionsNow();
    }
    if (!options && !query) {
      // Unfocused window: react-select-style lists open on focus, which never arrives; the down arrow opens them.
      pressKey(trigger, 'ArrowDown');
      options = await waitFor(optionsNow, { timeout: 1500 });
    }
    if (!typable && attempt === 0) {
      // Opened, and the list has its own search box: search there if the answer isn't listed.
      popupSearch = findPopupSearch(trigger);
      if (popupSearch) {
        typable = popupSearch;
        queries = ['', ...queriesFor(d)];
      }
    }
    if (!options && typable && query && !triedEnter) {
      // Workday-style prompts only search on Enter.
      triedEnter = true;
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
      await sleep(150);
      // Many dropdowns show the choice in a sibling node: look in the field's own box.
      if (boxShows(trigger, chosen)) return { ok: true, value: chosen, match: m.score };
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

/** The search box inside an opened dropdown: in the list it controls, or right next to it. */
function findPopupSearch(trigger: HTMLElement): HTMLInputElement | null {
  const ids = [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')].join(' ').split(/\s+/).filter(Boolean);
  const scopes = [
    ...ids.map((id) => document.getElementById(id)),
    trigger.nextElementSibling,
    trigger.parentElement,
  ].filter((x): x is HTMLElement => !!x);
  for (const s of scopes) {
    const box = Array.from(s.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="search"], input:not([type])')).find(
      (i) => i !== trigger && isVisible(i) && !i.readOnly,
    );
    if (box) return box;
  }
  return null;
}

function closeDropdown(trigger: HTMLElement): void {
  if (trigger.getAttribute('aria-expanded') === 'true' || visibleOptions(trigger).length) {
    pressKey(trigger, 'Escape');
  }
  trigger.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
}

// ---------- Tag pickers (skills): type one, pick it, repeat ----------

/** Most tags we'll add; each one waits on the site's search. */
const MAX_TAGS = 20;

function isTagInput(el: HTMLElement): boolean {
  if (el.getAttribute('aria-autocomplete') || el.getAttribute('role') === 'combobox') return true;
  for (let n = el.parentElement, i = 0; n && i < 3; n = n.parentElement, i++) {
    if (/\b\w*(tag|chip|token|multi|select2|choices)\w*\b/i.test(n.className)) return true;
  }
  return false;
}

/** The box holding the input and its chips: grow outward until we'd take in a label or another field. */
function tagBox(input: HTMLElement): HTMLElement {
  let box = input.parentElement ?? input;
  for (let i = 0; i < 4 && box.parentElement; i++) {
    const up = box.parentElement;
    if (up.matches('form, body') || up.querySelector('label, legend, h1, h2, h3, h4, h5, h6')) break;
    const others = Array.from(up.querySelectorAll('input:not([type="hidden"]), select, textarea')).filter((x) => x !== input);
    if (others.length) break;
    box = up;
  }
  return box;
}

/** Chip text in the box, without the input or any open option list. */
function chipText(box: HTMLElement): string {
  const clone = box.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(`${OPTION_SEL}, [role="listbox"], input, textarea`).forEach((n) => n.remove());
  return ` ${norm(clone.textContent ?? '')} `;
}

/** The site said it has nothing for what we typed. */
function noResults(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(`${OPTION_SEL}, [class*="no-result" i], [class*="noresult" i], [class*="no-option" i], [class*="empty" i]`)).some(
    (el) => !el.closest('.rej-ui') && isVisible(el) && /^(no (results?|matches|options|items)|nothing found)\b/i.test(cleanText(el)),
  );
}

const hasTag = (box: HTMLElement, label: string) => chipText(box).includes(` ${norm(label)} `);

/** Best option for one skill: a close match only, shortest label on a tie ("React.js" over "React Native"). */
function bestTag(labels: string[], item: string): number {
  let best = -1;
  let score = 0;
  labels.forEach((l, i) => {
    const s = matchOption([l], { text: item })?.score ?? 0;
    if (s > score || (s === score && best >= 0 && l.length < labels[best].length)) {
      best = i;
      score = s;
    }
  });
  return score >= 0.85 ? best : -1;
}

async function fillTags(f: Field, items: string[]): Promise<WidgetResult> {
  const input = (f.el.tagName === 'INPUT' ? f.el : f.el.querySelector('input:not([type="hidden"])')) as HTMLInputElement | null;
  if (!input) return { ok: false, match: 0, reason: 'No box to type into' };
  const box = tagBox(input);
  const list = items.slice(0, MAX_TAGS);
  const added: string[] = [];
  const missed: string[] = [];
  const clear = () => {
    if (input.value) setNativeValue(input, '');
    closeDropdown(input);
  };

  for (const item of list) {
    if (isCancelled()) {
      clear();
      checkCancel();
    }
    if (hasTag(box, item)) {
      added.push(item);
      continue;
    }
    status(`${fieldName(f)}: adding "${item}" (${added.length + missed.length + 1} of ${list.length})…`);
    realClick(input);
    typeText(input, item);
    // Skill lists are often searched on the server, so give them a while (but not after "No results").
    let options = await waitFor(() => {
      const o = visibleOptions(input);
      return o.length ? o : noResults() ? [] : null;
    }, { timeout: 6000 });
    if (options && !options.length) options = null;
    if (options) {
      await waitForSettle(250, 2000);
      options = visibleOptions(input);
    }
    const labels = (options ?? []).map((o) => cleanText(o));
    const i = options ? bestTag(labels, item) : -1;
    if (i < 0) {
      missed.push(item);
      clear();
      await sleep(150);
      continue;
    }
    realClick(options![i]);
    const stuck = await waitFor(() => hasTag(box, labels[i]), { timeout: 2000 });
    (stuck ? added : missed).push(stuck ? labels[i] : item);
    if (!stuck) clear();
    else if (input.value) setNativeValue(input, '');
    await sleep(150);
  }
  closeDropdown(input);
  if (!added.length) return { ok: false, match: 0, reason: "None of your skills are in the site's list" };
  const rest = items.length > list.length ? ` (stopped at ${MAX_TAGS})` : '';
  return {
    ok: true,
    value: added.join(', '),
    match: missed.length ? 0.9 : 1,
    reason: missed.length ? `Not in the site's list: ${missed.join(', ')}${rest}` : rest.trim() || undefined,
  };
}

// ---------- Address boxes with suggestions (Google Places) ----------

/** Google's address autocomplete marks its input and uses the placeholder "Enter a location". */
function isPlacesInput(el: HTMLElement): boolean {
  return el.tagName === 'INPUT' && (el.classList.contains('pac-target-input') || /^enter a location$/i.test(el.getAttribute('placeholder') ?? ''));
}

function placesSuggestions(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.pac-container .pac-item')).filter((i) => isVisible(i));
}

/**
 * Type the address and pick a suggestion: the site fills City / State / Zip from it, and some
 * (ADP) don't accept the address at all without one.
 */
async function fillPlaces(f: Field, d: Desired, overwrite: boolean): Promise<WidgetResult> {
  const el = f.el as HTMLInputElement;
  const cur = el.value.trim();
  if (cur && !overwrite) return { ok: true, value: cur, match: 1, skipped: true, reason: 'Already filled' };
  if (cur && norm(cur).startsWith(norm(d.text))) return { ok: true, value: cur, match: 1 };
  const query = d.query ?? d.text;
  status(`${fieldName(f)}: looking up "${query}"…`);
  el.focus({ preventScroll: true });
  typeText(el, query);
  const items = await waitFor(() => {
    const s = placesSuggestions();
    return s.length ? s : null;
  }, { timeout: 5000 });
  if (!items) {
    setNativeValue(el, d.text);
    el.dispatchEvent(new FocusEvent('blur'));
    return { ok: true, value: d.text, match: 0.8, reason: 'No address suggestions appeared — typed it in; check it' };
  }
  const best = items.map((i) => ({ i, s: jaccard(cleanText(i), query) })).sort((a, b) => b.s - a.s)[0].i;
  realClick(best);
  let picked = await waitFor(() => !placesSuggestions().length && el.value.trim() !== query && el.value.trim(), { timeout: 2500 });
  if (!picked) {
    // Keyboard fallback: highlight the first suggestion and press Enter.
    pressKey(el, 'ArrowDown');
    pressKey(el, 'Enter');
    picked = await waitFor(() => !placesSuggestions().length && el.value.trim(), { timeout: 2500 });
  }
  // The site fills the rest of the address from the choice.
  await waitForSettle(400, 3000);
  return picked
    ? { ok: true, value: el.value, match: 0.95 }
    : { ok: true, value: el.value, match: 0.7, reason: "Picked an address suggestion but couldn't confirm it — check it" };
}

/** Open a custom dropdown just to read its options (for the AI), then close it again. */
export async function peekOptions(f: Field): Promise<string[]> {
  const trigger = f.el;
  realClick(trigger);
  let shown = await waitFor(() => (visibleOptions(trigger).length ? true : null), { timeout: 1200 });
  if (!shown) {
    // A window without focus never tells the dropdown it was focused, and some (react-select)
    // only open on focus; the down arrow opens them anyway.
    pressKey(trigger, 'ArrowDown');
    shown = await waitFor(() => (visibleOptions(trigger).length ? true : null), { timeout: 1500 });
  }
  if (shown) await waitForSettle(200, 1000);
  const labels = visibleOptions(trigger)
    .map((o) => cleanText(o))
    .filter(Boolean);
  closeDropdown(trigger);
  await sleep(150);
  return Array.from(new Set(labels)).slice(0, 80);
}
