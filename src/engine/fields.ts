import { cleanText, isVisible, squash } from './dom';
import { isPlaceholderOption } from './match';

// Field discovery: turn the page's inputs, selects, custom dropdowns, radio
// groups and Yes/No button groups into one list of Field descriptors, each
// with the question text a human would read next to it.

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'date'
  | 'select'
  | 'combobox'
  | 'radio'
  | 'checkbox'
  | 'checkboxGroup'
  | 'buttonGroup'
  | 'file';

export interface Choice {
  label: string;
  el: HTMLElement;
}

export interface Field {
  id: string;
  kind: FieldKind;
  el: HTMLElement;
  label: string;
  /** name / id / automation-id / autocomplete tokens, used as a weaker signal than the label. */
  hints: string;
  required: boolean;
  choices?: Choice[];
  inputType?: string;
}

const ID_ATTR = 'data-rej-id';
let counter = 0;

export function stampId(el: HTMLElement): string {
  let id = el.getAttribute(ID_ATTR);
  if (!id) {
    id = `rej-${++counter}`;
    el.setAttribute(ID_ATTR, id);
  }
  return id;
}

export function findById(id: string): HTMLElement | null {
  const sel = `[${ID_ATTR}="${id}"]`;
  const light = document.querySelector<HTMLElement>(sel);
  if (light) return light;
  for (const r of withShadowRoots(document).slice(1)) {
    const el = r.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

const CONTROL_SEL = 'input, select, textarea, button, [role="combobox"], [role="listbox"], [contenteditable="true"]';
// Password inputs are kept (for job-site sign-up / sign-in); they're never learned or shown in reports.
const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'range', 'color']);

export function stripLabel(s: string): string {
  const out = squash(
    s
      .replace(/\(\s*(required|optional)\s*\)/gi, '')
      .replace(/[*✱]/g, '')
      // After a failed Next, labels turn into errors: "City is required", "Address Line 1 is invalid".
      // Only at the very end: "Micron is required to comply with…" is a question, not an error.
      .replace(/\s+(is|are) (required|mandatory|invalid|missing|not valid)[.!]?\s*$/i, '')
      .replace(/\s*required\s*$/i, ''),
  );
  // Long legal preambles end with the actual question: keep the start and the end.
  return out.length > 400 ? `${out.slice(0, 120)} … ${out.slice(-276)}` : out;
}

/** Text of the elements with these ids, looked up in `ctx`'s own document or shadow root. */
function textOfIds(ids: string | null, ctx?: Element): string {
  if (!ids) return '';
  const root = (ctx?.getRootNode() ?? document) as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map((id) => cleanText(root.getElementById?.(id) ?? document.getElementById(id)))
    .filter(Boolean)
    .join(' ');
}

/** `root` plus every open shadow root inside it (web-component forms: ADP, Salesforce…). */
function withShadowRoots(root: ParentNode): ParentNode[] {
  const out: ParentNode[] = [root];
  for (let i = 0; i < out.length; i++) {
    for (const el of Array.from(out[i].querySelectorAll('*'))) if (el.shadowRoot) out.push(el.shadowRoot);
  }
  return out;
}

function deep<T extends Element>(roots: ParentNode[], sel: string): T[] {
  return roots.flatMap((r) => Array.from(r.querySelectorAll<T>(sel)));
}

/** The element hosting `el`'s shadow root, if it lives in one. */
export function shadowHost(el: Element): HTMLElement | null {
  const r = el.getRootNode();
  return r instanceof ShadowRoot ? (r.host as HTMLElement) : null;
}

/** closest() that also climbs out of shadow roots to their hosts. */
function composedClosest(el: Element, test: (e: Element) => boolean): HTMLElement | null {
  for (let n: Element | null = el; n; n = n.parentElement ?? shadowHost(n)) if (test(n)) return n as HTMLElement;
  return null;
}

const GROUP_SEL = 'fieldset, [role="radiogroup"], [role="group"], [data-automation-id^="formField-"]';
/** A radio/checkbox group's container: fieldset, ARIA group, or a <x-radio-group> web component. */
const isGroup = (e: Element) => e.matches(GROUP_SEL) || /radio-?group|checkbox-?group|choice-?group/i.test(e.tagName);

/** Radio or ARIA radio/checkbox: is it selected? */
export function isChecked(el: HTMLElement): boolean {
  return el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
}

/** The nearest preceding text block inside `container` that comes before `el`. */
const VALUE_NODES = '[class*="single-value" i], [class*="singleValue"], [class*="placeholder" i], [class*="multi-value" i]';

function precedingText(el: Element, maxLevels = 5): string {
  let node: Element | null = el;
  for (let level = 0; level < maxLevels && node; level++) {
    let sib = node.previousElementSibling;
    while (sib) {
      // A dropdown's current value or placeholder sits right before its input: it isn't the question.
      if (!sib.matches(`script, style, ${VALUE_NODES}`) && isVisible(sib)) {
        const hasControls = sib.querySelector(CONTROL_SEL);
        const t = cleanText(sib);
        if (t && (!hasControls || sib.matches('label, legend'))) return t;
        if (hasControls) return '';
      }
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
    if (node?.matches('form, body')) break;
  }
  return '';
}

/**
 * A <label> that wraps both the question and the control (Lever) also holds
 * hidden helper/error text; if it has a dedicated label-ish child, use that.
 */
function labelText(label: HTMLLabelElement): string {
  const inner = Array.from(label.querySelectorAll('[class*="label" i]')).find((n) => n !== label && cleanText(n));
  return cleanText(inner ?? label);
}

// Labels that name a button, not the question ("Attach" next to "Resume/CV").
const GENERIC_LABEL = /^(attach|upload|browse|choose( a)? files?|select( a)? files?|drop .*|add files?|enter manually|or)$/i;

/**
 * How many separate questions a fieldset / group holds. More than one means it's a section
 * ("Application questions", "Contact Information"), and its legend is a heading, not the question.
 */
function questionCount(group: Element): number {
  const keys = new Set<unknown>();
  for (const c of Array.from(group.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radio"]'))) {
    const i = c as HTMLInputElement;
    const inner = c.parentElement?.closest('fieldset, [role="radiogroup"], [role="group"]');
    const choice = i.type === 'radio' || i.type === 'checkbox' || c.getAttribute('role') === 'radio';
    keys.add(choice ? (i.name || (inner && inner !== group ? inner : group)) : c);
    if (keys.size > 1) return keys.size;
  }
  return keys.size;
}

function labelFor(el: HTMLElement): string {
  const own = ownLabel(el);
  if (own && !GENERIC_LABEL.test(own.trim())) return own;
  // Look outward: a labelled group around the control, or text before that group.
  let group = el.parentElement?.closest('[aria-labelledby], [role="group"], fieldset') ?? null;
  if (group && questionCount(group) > 1) group = null; // a section, not this question's group
  const groupText = group ? textOfIds(group.getAttribute('aria-labelledby'), group) || cleanText(group.querySelector('legend')) : '';
  if (groupText && !GENERIC_LABEL.test(groupText)) return groupText;
  const pre = precedingText(group ?? el.parentElement ?? el);
  if (pre) return pre;
  // Inside a web component with no label of its own: the question sits next to the component.
  const host = shadowHost(el);
  if (host && !own) return labelFor(host);
  return own;
}

function ownLabel(el: HTMLElement): string {
  // Workday wraps each question in data-automation-id="formField-..." with its own label.
  const wd = el.closest('[data-automation-id^="formField-"]');
  if (wd) {
    const l = wd.querySelector('label, legend');
    if (l) return cleanText(l);
  }
  const by = textOfIds(el.getAttribute('aria-labelledby'), el);
  if (by) return by;
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) {
    const t = Array.from(labels).map(labelText).filter(Boolean).join(' ');
    if (t) return t;
  }
  const aria = el.getAttribute('aria-label');
  if (aria && !/^(select|search|choose)\b.{0,12}$/i.test(aria)) return aria;
  const pre = precedingText(el);
  if (pre) return pre;
  return el.getAttribute('placeholder') || aria || '';
}

/** Group question text for radios/checkboxes/button groups: fieldset legend, radiogroup label, or preceding text. */
function groupLabel(container: Element): string {
  // A fieldset around several questions is a section: its legend is the heading, not this question.
  const fs = container.closest('fieldset');
  const legend = fs && questionCount(fs) <= 1 ? fs.querySelector(':scope > legend') : null;
  if (legend) return cleanText(legend);
  const group = container.closest('[role="radiogroup"], [role="group"]');
  if (group && (group === container || questionCount(group) <= 1)) {
    const t = textOfIds(group.getAttribute('aria-labelledby')) || group.getAttribute('aria-label');
    if (t) return t;
  }
  const wd = container.closest('[data-automation-id^="formField-"]');
  if (wd) {
    const l = wd.querySelector('label, legend');
    if (l) return cleanText(l);
  }
  const pre = precedingText(container, 6);
  if (pre) return pre;
  // Inside a web component: the question is outside it, next to the group's host.
  const host = shadowHost(container);
  return host ? groupLabel(composedClosest(host, isGroup) ?? host) : '';
}

function hintsFor(el: Element): string {
  return ['name', 'id', 'data-automation-id', 'autocomplete', 'data-qa', 'data-testid']
    .map((a) => el.getAttribute(a) ?? '')
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-[\]\d.]+/g, ' ')
    .toLowerCase()
    .trim();
}

function isRequired(el: Element, label: string): boolean {
  return (
    (el as HTMLInputElement).required ||
    el.getAttribute('aria-required') === 'true' ||
    /[*✱]/.test(label) ||
    /\(required\)/i.test(label)
  );
}

function rawLabelIncludesStar(el: HTMLElement): string {
  // Keep the star for required detection before stripping it.
  return labelFor(el);
}

function choiceLabel(input: HTMLInputElement): string {
  const own = cleanText(input.labels?.[0]) || input.getAttribute('aria-label') || cleanText(input.nextElementSibling) || cleanText(input.parentElement);
  if (own) return own;
  // A radio web component (<x-radio>Yes</x-radio>): its text is slotted in from outside.
  const host = shadowHost(input);
  return (host && (cleanText(host) || host.getAttribute('label') || host.getAttribute('aria-label'))) || input.value;
}

/** Where to click for a radio/checkbox the page draws itself (the real input is hidden). */
export function clickTarget(input: HTMLElement): HTMLElement {
  if (isVisible(input)) return input;
  const label = (input as HTMLInputElement).labels?.[0];
  if (label && isVisible(label)) return label;
  const host = shadowHost(input);
  if (host && isVisible(host)) return host;
  return input.parentElement && isVisible(input.parentElement) ? input.parentElement : input;
}

function isCombobox(el: Element): boolean {
  const role = el.getAttribute('role');
  if (role === 'combobox') return true;
  if (el.getAttribute('aria-haspopup') === 'listbox') return true;
  if (el.getAttribute('aria-autocomplete') === 'list' || el.getAttribute('aria-autocomplete') === 'both') return true;
  if (el.closest('[data-automation-id="multiselectInputContainer"]')) return true;
  return false;
}

export interface ScanOptions {
  root?: ParentNode;
  /** Elements inside these are ignored (e.g. our own UI). */
  exclude?: string;
}

export function scanFields(opts: ScanOptions = {}): Field[] {
  const root = opts.root ?? document;
  const exclude = opts.exclude ?? '.rej-ui';
  const fields: Field[] = [];
  const seen = new Set<Element>();
  const roots = withShadowRoots(root);

  const push = (f: Omit<Field, 'id' | 'required' | 'label'> & { rawLabel: string }) => {
    const { rawLabel, ...rest } = f;
    fields.push({ ...rest, id: stampId(f.el), label: stripLabel(rawLabel), required: isRequired(f.el, rawLabel) });
  };

  // Custom comboboxes first so their inner inputs aren't double-counted as text fields.
  for (const el of deep<HTMLElement>(roots, '[role="combobox"], [aria-haspopup="listbox"], input[aria-autocomplete]')) {
    if (el.closest(exclude) || seen.has(el) || !isVisible(el)) continue;
    if (!isCombobox(el)) continue;
    if ((el as HTMLInputElement).disabled) continue;
    // A combobox wrapper div that contains the actual input: prefer the input.
    if (el.tagName !== 'INPUT' && el.tagName !== 'BUTTON') {
      const inner = el.querySelector<HTMLElement>('input:not([type="hidden"]), button[aria-haspopup="listbox"]');
      if (inner) {
        seen.add(el);
        continue;
      }
    }
    seen.add(el);
    push({ kind: 'combobox', el, rawLabel: rawLabelIncludesStar(el), hints: hintsFor(el) });
  }

  const radiosByGroup = new Map<string, HTMLInputElement[]>();
  const checkboxesByGroup = new Map<string, HTMLInputElement[]>();
  const checkboxNames = new Map<string, number>();
  for (const c of deep<HTMLInputElement>(roots, 'input[type="checkbox"][name]')) {
    checkboxNames.set(c.name, (checkboxNames.get(c.name) ?? 0) + 1);
  }

  for (const el of deep<HTMLElement>(roots, 'input, select, textarea')) {
    if (el.closest(exclude) || seen.has(el)) continue;
    const input = el as HTMLInputElement;
    const type = (input.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has(type)) continue;
    if (input.disabled || /recaptcha|captcha|honeypot/i.test(`${input.name} ${el.id}`)) continue;
    if (type === 'file') {
      // File inputs are usually visually hidden behind an "Attach" button; don't require visibility.
      seen.add(el);
      const container = el.closest('fieldset, [role="group"], [data-automation-id^="formField-"], .field, .application-question, div') ?? el;
      const raw = labelFor(el) || groupLabel(container) || cleanText(container);
      push({ kind: 'file', el, rawLabel: raw, hints: hintsFor(el), inputType: type });
      continue;
    }
    if (!isVisible(el) && !(type === 'radio' || type === 'checkbox')) continue;
    if (type === 'radio') {
      // Radios inside web components each live in their own shadow root: group by the container around them.
      const key = shadowHost(input) ? groupKey(input) : input.name || groupKey(input);
      radiosByGroup.set(key, [...(radiosByGroup.get(key) ?? []), input]);
      continue;
    }
    if (type === 'checkbox') {
      // Ashby backs its Yes/No buttons with a hidden checkbox; the buttons are the real control.
      const sibs = input.parentElement ? Array.from(input.parentElement.children) : [];
      if (sibs.some((s) => s.matches('button, [role="button"]') && YES_NO.test(cleanText(s)))) continue;
      // Checkboxes sharing a name are one multi-choice question; group a lone one by container.
      const key = input.name && (checkboxNames.get(input.name) ?? 0) > 1 ? `name-${input.name}` : groupKey(input);
      checkboxesByGroup.set(key, [...(checkboxesByGroup.get(key) ?? []), input]);
      continue;
    }
    if (input.readOnly && el.tagName !== 'SELECT') continue;
    seen.add(el);
    const kind: FieldKind = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : type === 'date' ? 'date' : 'text';
    push({ kind, el, rawLabel: labelFor(el), hints: hintsFor(el), inputType: type });
  }

  // Rich-text editors (Quill, Draft.js, ProseMirror, CKEditor) used for descriptions.
  for (const el of deep<HTMLElement>(roots, '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) {
    if (el.closest(exclude) || seen.has(el) || !isVisible(el)) continue;
    if (el.parentElement?.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) continue;
    seen.add(el);
    push({ kind: 'richtext', el, rawLabel: labelFor(el), hints: hintsFor(el) });
  }

  for (const group of radiosByGroup.values()) {
    const visible = group.filter((r) => clickTarget(r) !== r || isVisible(r));
    if (!visible.length) continue;
    const first = visible[0];
    const container = composedClosest(first, (e) => e.matches('fieldset, [role="radiogroup"]') || /radio-?group/i.test(e.tagName));
    push({
      kind: 'radio',
      el: first,
      // A fieldset around several questions is a section: look for the question next to the choices instead.
      rawLabel: groupLabel(container && questionCount(container) <= 1 ? container : ownBox(visible) ?? first.parentElement ?? first),
      hints: hintsFor(first),
      choices: visible.map((r) => ({ label: choiceLabel(r), el: r })),
    });
  }

  // Radio groups drawn without <input>s: role="radiogroup" > role="radio" (aria-checked).
  for (const g of deep<HTMLElement>(roots, '[role="radiogroup"]')) {
    if (g.closest(exclude) || seen.has(g) || !isVisible(g) || g.querySelector('input[type="radio"]')) continue;
    const radios = Array.from(g.querySelectorAll<HTMLElement>('[role="radio"]')).filter((r) => isVisible(r));
    if (radios.length < 2) continue;
    seen.add(g);
    const label = textOfIds(g.getAttribute('aria-labelledby'), g) || g.getAttribute('aria-label') || groupLabel(g);
    push({ kind: 'radio', el: radios[0], rawLabel: label, hints: hintsFor(g), choices: radios.map((r) => ({ label: cleanText(r) || r.getAttribute('aria-label') || '', el: r })) });
  }

  for (const group of checkboxesByGroup.values()) {
    const visible = group.filter((c) => isVisible(c) || (c.labels?.[0] && isVisible(c.labels[0])));
    if (!visible.length) continue;
    const first = visible[0];
    if (visible.length === 1) {
      const own = choiceLabel(first);
      const groupQ = groupLabel(first.parentElement ?? first);
      push({ kind: 'checkbox', el: first, rawLabel: own || groupQ, hints: hintsFor(first), choices: [{ label: own, el: first }] });
    } else {
      push({
        kind: 'checkboxGroup',
        el: first,
        rawLabel: groupLabel(((g) => (g && questionCount(g) <= 1 ? g : null))(first.closest('fieldset, [role="group"]')) ?? ownBox(visible) ?? first),
        hints: hintsFor(first),
        choices: visible.map((c) => ({ label: choiceLabel(c), el: c })),
      });
    }
  }

  // Yes/No style button groups (Ashby and others).
  for (const g of findButtonGroups(root, exclude)) {
    if (seen.has(g.container)) continue;
    seen.add(g.container);
    const el = g.container as HTMLElement;
    push({ kind: 'buttonGroup', el, rawLabel: groupLabel(el), hints: hintsFor(el), choices: g.buttons.map((b) => ({ label: cleanText(b), el: b })) });
  }

  // Last resort: a Yes / No pair recognised by its visible text, whatever it's built from
  // (radio components whose inner inputs can't be seen or told apart).
  const covered = fields.flatMap((f) => [f.el, ...(f.choices ?? []).map((c) => c.el)]);
  for (const g of findYesNoByText(roots, exclude, covered)) {
    const rawLabel = groupLabel(g.container);
    if (!stripLabel(rawLabel)) continue; // a lone Yes/No with no question isn't a question
    push({ kind: 'buttonGroup', el: g.container, rawLabel, hints: hintsFor(g.container), choices: g.items.map((i) => ({ label: squash(i.textContent ?? ''), el: i })) });
  }

  // Document order makes filling feel natural and handles dependent fields (country before state).
  // A field inside a web component sorts where its outermost host is.
  const anchor = (el: Element) => {
    let n = el;
    for (let h = shadowHost(n); h; h = shadowHost(n)) n = h;
    return n;
  };
  fields.sort((a, b) => {
    const [x, y] = [anchor(a.el), anchor(b.el)];
    if (x === y) return 0;
    return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return fields;
}

function groupKey(input: HTMLInputElement): string {
  const c = composedClosest(input, isGroup);
  return c ? `grp-${stampId(c)}` : `solo-${stampId(input)}`;
}

/** The box around just these choices: their shared container, unless that's the form or holds other questions. */
function ownBox(els: Element[]): Element | null {
  const anc = commonAncestor(els);
  return anc && !anc.matches('form, body') && questionCount(anc) <= 1 ? anc : null;
}

function commonAncestor(els: Element[]): Element | null {
  let anc: Element | null = els[0].parentElement;
  while (anc && !els.every((e) => anc!.contains(e))) anc = anc.parentElement;
  return anc;
}

const YES_NO = /^(yes|no)$/i;

function findButtonGroups(root: ParentNode, exclude: string): { container: Element; buttons: HTMLElement[] }[] {
  const out: { container: Element; buttons: HTMLElement[] }[] = [];
  const done = new Set<Element>();
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    if (b.closest(exclude) || !YES_NO.test(cleanText(b)) || !isVisible(b)) continue;
    const parent = b.parentElement;
    if (!parent || done.has(parent)) continue;
    const buttons = Array.from(parent.querySelectorAll<HTMLElement>(':scope > button, :scope > [role="button"]'));
    if (buttons.length < 2 || buttons.length > 5) continue;
    if (!buttons.some((x) => /^yes$/i.test(cleanText(x))) || !buttons.some((x) => /^no$/i.test(cleanText(x)))) continue;
    done.add(parent);
    out.push({ container: parent, buttons });
  }
  return out;
}

/**
 * Cheap, read-only "is there an application form here?" check for passive use
 * (before you press Fill). Unlike scanFields it never touches the page:
 * stamping attributes onto inputs while a React/Next.js site is still hydrating
 * can break the page.
 */
export function looksLikeForm(root: ParentNode = document): boolean {
  if (root.querySelector('input[type="file"]')) return true;
  const sel = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="search"]), select, textarea';
  let n = 0;
  for (const el of Array.from(root.querySelectorAll(sel))) {
    if (!el.closest('.rej-ui') && isVisible(el) && ++n >= 3) return true;
  }
  return false;
}

/** The field an element belongs to (the input itself, a radio in a group, a combobox's inner input…). */
export function fieldFor(el: Element, fields: Field[] = scanFields()): Field | null {
  const inside = (n: Element) => n === el || n.contains(el);
  const direct =
    fields.find((f) => f.el === el) ??
    fields.find((f) => f.choices?.some((c) => inside(c.el))) ??
    fields.find((f) => inside(f.el));
  if (direct) return direct;
  // A wrapper you clicked (a radio's <label>, a combobox's outer div) — only if it holds exactly one field.
  const within = fields.filter((f) => el.contains(f.el) || f.choices?.some((c) => el.contains(c.el)));
  if (within.length === 1) return within[0];
  if (within.length > 1) return null;
  // Same field wrapper (Workday formField-*, Greenhouse .field).
  const wrap = el.closest('[data-automation-id^="formField-"], .field, .application-question, fieldset');
  return wrap ? (fields.find((f) => wrap.contains(f.el)) ?? null) : null;
}

/** Current displayed value of a field, for "already filled?" checks and learning. */
export function currentValue(f: Field): string {
  const el = f.el;
  switch (f.kind) {
    case 'text':
    case 'textarea':
    case 'date': {
      const v = (el as HTMLInputElement).value ?? '';
      // A phone box pre-filled with just its dial code ("+1 ") is still empty.
      return /^\s*\+\d{1,4}[\s-]*$/.test(v) ? '' : v;
    }
    case 'richtext':
      return (el.innerText ?? el.textContent ?? '').trim();
    case 'select': {
      const s = el as HTMLSelectElement;
      const opt = s.selectedOptions?.[0];
      // "Please Select" (even with a value behind it) means nothing is chosen yet.
      return opt && opt.value !== '' && !isPlaceholderOption(opt.textContent ?? '') ? squash(opt.textContent ?? '') : '';
    }
    case 'radio':
    case 'checkboxGroup':
      return (f.choices ?? [])
        .filter((c) => isChecked(c.el))
        .map((c) => c.label)
        .join(', ');
    case 'checkbox':
      return (el as HTMLInputElement).checked ? 'Yes' : '';
    case 'buttonGroup':
      return (f.choices ?? []).find((c) => isPressed(c.el))?.label ?? '';
    case 'combobox':
      return comboboxDisplay(el);
    case 'file':
      return (el as HTMLInputElement).files?.length ? (el as HTMLInputElement).files![0].name : '';
  }
}

export function isPressed(b: HTMLElement): boolean {
  if (
    b.getAttribute('aria-pressed') === 'true' ||
    b.getAttribute('aria-checked') === 'true' ||
    b.getAttribute('data-state') === 'on' ||
    /\b(selected|active|is-selected|_active)\w*/i.test(typeof b.className === 'string' ? b.className : '')
  ) {
    return true;
  }
  // A choice drawn around a real radio: the radio inside it, in its shadow root, or the one its label points at.
  const inner = b.shadowRoot?.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]') ?? b.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]');
  if (inner?.checked) return true;
  const ctl = (b.closest('label') as HTMLLabelElement | null)?.control as HTMLInputElement | null;
  if (ctl?.checked) return true;
  const host = shadowHost(b);
  return !!host && (host.getAttribute('aria-checked') === 'true' || (host.hasAttribute('checked') && host.getAttribute('checked') !== 'false'));
}

/** `a` contains `b`, looking through shadow roots. */
function composedContains(a: Element, b: Element): boolean {
  for (let n: Element | null = b; n; n = n.parentElement ?? shadowHost(n)) if (n === a) return true;
  return false;
}

/** Yes / No pairs found by their text: the innermost element holding each word, grouped by their nearest shared container. */
function findYesNoByText(roots: ParentNode[], exclude: string, covered: Element[]): { container: HTMLElement; items: HTMLElement[] }[] {
  const items: HTMLElement[] = [];
  for (const r of roots) {
    const walker = document.createTreeWalker(r as Node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const word = (t.nodeValue ?? '').trim();
      if (!/^(yes|no)$/i.test(word)) continue;
      const el = t.parentElement;
      if (!el || (el.textContent ?? '').trim() !== word || el.matches('option, script, style, button, [role="button"], [role="option"]') || el.closest(exclude)) continue;
      if (!isVisible(el)) continue;
      // The word is a radio's own label — wrapped around it, pointing at it with for=, or right
      // beside it in the same box: already a field.
      const label = el.closest('label') as HTMLLabelElement | null;
      const near = [label, label?.control, el.parentElement].filter(Boolean) as Element[];
      if (covered.some((c) => composedContains(c, el) || composedContains(el, c) || near.some((n) => n === c || composedContains(n, c)))) continue;
      items.push(el);
    }
  }
  const used = new Set<HTMLElement>();
  const out: { container: HTMLElement; items: HTMLElement[] }[] = [];
  for (const yes of items) {
    if (used.has(yes) || !/^yes$/i.test(yes.textContent!.trim())) continue;
    let n: Element | null = yes;
    for (let i = 0; i < 5 && n; i++) {
      n = n.parentElement ?? shadowHost(n);
      if (!n || n.matches('form, body')) break;
      const inside = items.filter((x) => !used.has(x) && composedContains(n!, x));
      if (!inside.some((x) => /^no$/i.test(x.textContent!.trim()))) continue;
      if (inside.length === 2) {
        inside.forEach((x) => used.add(x));
        out.push({ container: n as HTMLElement, items: inside });
      }
      break; // the first container holding a "No" decides; more than a pair means it spans questions
    }
  }
  return out;
}

const PLACEHOLDER = /^(select( one)?|choose|please select|select\.{3}|--+|search|start typing|type to search)\W*$/i;

export function comboboxDisplay(el: HTMLElement): string {
  if (el.tagName === 'INPUT') {
    const v = (el as HTMLInputElement).value;
    if (v) return v;
  }
  // react-select / Greenhouse: the chosen value renders in a "single-value" node a few levels up
  // (react-select wraps its input in an "…input-container", which isn't the whole control).
  let n: HTMLElement | null = el.parentElement;
  for (let i = 0; i < 4 && n && !n.matches('form, body'); i++, n = n.parentElement) {
    const single = n.querySelector('[class*="single-value"], [class*="singleValue"], [data-automation-id="selectedItem"], [class*="multi-value__label"]');
    if (single) return cleanText(single);
    if (n.matches('[data-automation-id^="formField-"], .field')) break;
  }
  if (el.tagName !== 'INPUT') {
    const t = cleanText(el);
    if (t && !PLACEHOLDER.test(t) && t.length < 80) return t;
  }
  // Shown next to the control (ADP and other custom selects).
  return valueBoxText(el);
}

/**
 * The text a custom dropdown shows next to itself: the box around the control (never reaching
 * its label or another field), minus option lists, error/help text and placeholders.
 */
export function valueBoxText(el: HTMLElement): string {
  const labelIds = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  let box: HTMLElement = el;
  let found = '';
  for (let i = 0; i < 3 && box.parentElement; i++) {
    const up = box.parentElement;
    if (up.matches('form, body, fieldset')) break;
    // The box holding the label too: read it without the label, but go no further out.
    const hasLabel = !!up.querySelector('label, legend, h1, h2, h3, h4, h5, h6') || labelIds.some((id) => up.contains(document.getElementById(id)));
    const others = Array.from(up.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"], button[aria-haspopup]')).filter(
      (x) => x !== el && !el.contains(x) && !x.contains(el),
    );
    if (others.length) break;
    box = up;
    const clone = box.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll(
        'label, legend, h1, h2, h3, h4, h5, h6, [role="option"], [role="listbox"], [role="alert"], [aria-live], [class*="error" i], [class*="help" i], [class*="hint" i], [class*="placeholder" i], [hidden], .rej-ui',
      )
      .forEach((n) => n.remove());
    for (const id of labelIds) clone.querySelector(`[id="${id}"]`)?.remove();
    const t = squash(clone.textContent ?? '').replace(/[▾▼⌄⌃▲*]/g, '').trim();
    if (t && !PLACEHOLDER.test(t) && t.length < 80) found = t;
    if (hasLabel) break;
  }
  return found;
}
