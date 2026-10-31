import { cleanText, isVisible, squash } from './dom';

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
  return document.querySelector<HTMLElement>(`[${ID_ATTR}="${id}"]`);
}

const CONTROL_SEL = 'input, select, textarea, button, [role="combobox"], [role="listbox"], [contenteditable="true"]';
const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'password', 'range', 'color']);

export function stripLabel(s: string): string {
  return squash(
    s
      .replace(/\(\s*(required|optional)\s*\)/gi, '')
      .replace(/[*✱]/g, '')
      .replace(/\s*required\s*$/i, ''),
  ).slice(0, 400);
}

function textOfIds(ids: string | null): string {
  if (!ids) return '';
  return ids
    .split(/\s+/)
    .map((id) => cleanText(document.getElementById(id)))
    .filter(Boolean)
    .join(' ');
}

/** The nearest preceding text block inside `container` that comes before `el`. */
function precedingText(el: Element, maxLevels = 5): string {
  let node: Element | null = el;
  for (let level = 0; level < maxLevels && node; level++) {
    let sib = node.previousElementSibling;
    while (sib) {
      if (!sib.matches('script, style') && isVisible(sib)) {
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

function labelFor(el: HTMLElement): string {
  const own = ownLabel(el);
  if (own && !GENERIC_LABEL.test(own.trim())) return own;
  // Look outward: a labelled group around the control, or text before that group.
  const group = el.parentElement?.closest('[aria-labelledby], [role="group"], fieldset');
  const groupText = group ? textOfIds(group.getAttribute('aria-labelledby')) || cleanText(group.querySelector('legend')) : '';
  if (groupText && !GENERIC_LABEL.test(groupText)) return groupText;
  return precedingText(group ?? el.parentElement ?? el) || own;
}

function ownLabel(el: HTMLElement): string {
  // Workday wraps each question in data-automation-id="formField-..." with its own label.
  const wd = el.closest('[data-automation-id^="formField-"]');
  if (wd) {
    const l = wd.querySelector('label, legend');
    if (l) return cleanText(l);
  }
  const by = textOfIds(el.getAttribute('aria-labelledby'));
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
  const fs = container.closest('fieldset');
  const legend = fs?.querySelector(':scope > legend');
  if (legend) return cleanText(legend);
  const group = container.closest('[role="radiogroup"], [role="group"]');
  if (group) {
    const t = textOfIds(group.getAttribute('aria-labelledby')) || group.getAttribute('aria-label');
    if (t) return t;
  }
  const wd = container.closest('[data-automation-id^="formField-"]');
  if (wd) {
    const l = wd.querySelector('label, legend');
    if (l) return cleanText(l);
  }
  return precedingText(container, 6);
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
  const l = input.labels?.[0];
  if (l) return cleanText(l);
  const aria = input.getAttribute('aria-label');
  if (aria) return aria;
  const next = input.nextElementSibling;
  if (next) return cleanText(next);
  return cleanText(input.parentElement) || input.value;
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

  const push = (f: Omit<Field, 'id' | 'required' | 'label'> & { rawLabel: string }) => {
    const { rawLabel, ...rest } = f;
    fields.push({ ...rest, id: stampId(f.el), label: stripLabel(rawLabel), required: isRequired(f.el, rawLabel) });
  };

  // Custom comboboxes first so their inner inputs aren't double-counted as text fields.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[role="combobox"], [aria-haspopup="listbox"], input[aria-autocomplete]'))) {
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
  for (const c of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]'))) {
    checkboxNames.set(c.name, (checkboxNames.get(c.name) ?? 0) + 1);
  }

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('input, select, textarea'))) {
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
      const key = input.name || groupKey(input);
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
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'))) {
    if (el.closest(exclude) || seen.has(el) || !isVisible(el)) continue;
    if (el.parentElement?.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) continue;
    seen.add(el);
    push({ kind: 'richtext', el, rawLabel: labelFor(el), hints: hintsFor(el) });
  }

  for (const group of radiosByGroup.values()) {
    const visible = group.filter((r) => isVisible(r) || (r.labels?.[0] && isVisible(r.labels[0])));
    if (!visible.length) continue;
    const first = visible[0];
    push({
      kind: 'radio',
      el: first,
      rawLabel: groupLabel(first.closest('fieldset, [role="radiogroup"]') ?? first.parentElement ?? first),
      hints: hintsFor(first),
      choices: visible.map((r) => ({ label: choiceLabel(r), el: r })),
    });
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
        rawLabel: groupLabel(first.closest('fieldset, [role="group"]') ?? commonAncestor(visible) ?? first),
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

  // Document order makes filling feel natural and handles dependent fields (country before state).
  fields.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return fields;
}

function groupKey(input: HTMLInputElement): string {
  const c = input.closest('fieldset, [role="radiogroup"], [role="group"], [data-automation-id^="formField-"]');
  return c ? `grp-${stampId(c as HTMLElement)}` : `solo-${stampId(input)}`;
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
    case 'date':
      return (el as HTMLInputElement).value ?? '';
    case 'richtext':
      return (el.innerText ?? el.textContent ?? '').trim();
    case 'select': {
      const s = el as HTMLSelectElement;
      const opt = s.selectedOptions?.[0];
      return opt && opt.value !== '' ? squash(opt.textContent ?? '') : '';
    }
    case 'radio':
    case 'checkboxGroup':
      return (f.choices ?? [])
        .filter((c) => (c.el as HTMLInputElement).checked)
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
  return (
    b.getAttribute('aria-pressed') === 'true' ||
    b.getAttribute('aria-checked') === 'true' ||
    b.getAttribute('data-state') === 'on' ||
    /\b(selected|active|is-selected|_active)\w*/i.test(b.className)
  );
}

const PLACEHOLDER = /^(select( one)?|choose|please select|select\.{3}|--+|search|start typing|type to search)\W*$/i;

export function comboboxDisplay(el: HTMLElement): string {
  if (el.tagName === 'INPUT') {
    const v = (el as HTMLInputElement).value;
    if (v) return v;
  }
  // react-select / Greenhouse: the chosen value renders in a sibling "single-value" node.
  const container = el.closest('[class*="container"], [class*="select"], [data-automation-id^="formField-"], .field') ?? el.parentElement;
  const single = container?.querySelector('[class*="single-value"], [class*="singleValue"], [data-automation-id="selectedItem"], [class*="multi-value__label"]');
  if (single) return cleanText(single);
  if (el.tagName === 'BUTTON') {
    const t = cleanText(el);
    return PLACEHOLDER.test(t) ? '' : t;
  }
  return '';
}
