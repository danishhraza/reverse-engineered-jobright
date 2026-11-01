import type { FieldReport, Profile } from '../types';
import { checkCancel, status } from './control';
import { cleanText, isVisible, realClick, squash, waitFor, waitForSettle } from './dom';
import { eduResolver, fillEntryField, workResolver, type EntryResolver } from './entries';
import { scanFields, type Field } from './fields';
import { norm } from './match';

// Repeating "Work History" / "Education" blocks on any site (Avature,
// SuccessFactors, iCIMS…): block 1 gets the first job in your profile, block 2
// the second, and "Add another" is clicked until there's a block per entry.
//
// A section runs from its title to its "Add" control, in document order, so it
// doesn't depend on how the site nests its markup. Blocks are told apart by a
// label repeating ("Employer" again = the next job).

interface Kind {
  name: string;
  title: RegExp;
  entries: (p: Profile) => unknown[];
  resolver: EntryResolver<unknown>;
}

const KINDS: Kind[] = [
  {
    name: 'Work',
    title: /^(work|employment|professional|job|career)( experience| history)s?$|^(work )?experiences?$|^employment$|^employers?$/,
    entries: (p) => p.work,
    resolver: workResolver as EntryResolver<unknown>,
  },
  {
    name: 'Education',
    title: /^education(al)?( history| background| details)?$|^schools?$|^academic (history|background)$/,
    entries: (p) => p.education,
    resolver: eduResolver as EntryResolver<unknown>,
  },
];

/** Most blocks we'll add per section; past this it's faster to do by hand. */
const MAX_ENTRIES = 6;

const ADD_TEXT =
  /^\+?\s*add( another| more| new| an?)?( (position|job|employer|employment|experience|work( experience| history)?|education|school|degree|entry|record|row|item))?\s*\+?$/i;
const TITLE_SEL = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"], label, span, div, p, strong, b, th, dt';
const CONTROL_SEL = 'input, select, textarea, button, [role="combobox"], [contenteditable="true"]';

interface Section {
  kind: Kind;
  title: HTMLElement;
  add: HTMLElement;
}

const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function addControls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a, button, [role="button"], input[type="button"]')).filter((b) => {
    if (b.closest('.rej-ui') || !isVisible(b)) return false;
    const t = squash(cleanText(b) || (b as HTMLInputElement).value || b.getAttribute('aria-label') || '');
    return ADD_TEXT.test(t);
  });
}

/** Elements whose own text is a section title we know ("Work History"). Innermost only. */
function titles(): { el: HTMLElement; kind: Kind }[] {
  const out: { el: HTMLElement; kind: Kind }[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(TITLE_SEL))) {
    // Cheap length check first: cleanText clones, and big containers have long text.
    if ((el.textContent ?? '').length > 80 || el.closest('.rej-ui') || el.querySelector(CONTROL_SEL)) continue;
    if (el instanceof HTMLLabelElement && el.control) continue; // a field's own label
    const text = cleanText(el);
    if (!text || text.length > 40) continue;
    const kind = KINDS.find((k) => k.title.test(norm(text)));
    if (!kind || !isVisible(el)) continue;
    if (Array.from(el.children).some((c) => cleanText(c) === text)) continue;
    out.push({ el, kind });
  }
  return out;
}

/**
 * Pair each "Add" control with the title right before it. An add control whose
 * nearest marker is another add control belongs to a section we don't handle
 * (Languages, Certifications).
 */
function findSections(): Section[] {
  const markers = [
    ...titles().map((t) => ({ el: t.el, kind: t.kind as Kind | null })),
    ...addControls().map((el) => ({ el, kind: null as Kind | null })),
  ].sort((a, b) => (before(a.el, b.el) ? -1 : 1));
  const out: Section[] = [];
  for (let i = 1; i < markers.length; i++) {
    const prev = markers[i - 1];
    if (markers[i].kind === null && prev.kind) out.push({ kind: prev.kind, title: prev.el, add: markers[i].el });
  }
  return out;
}

function regionFields(s: Section): Field[] {
  return scanFields().filter((f) => f.kind !== 'file' && before(s.title, f.el) && before(f.el, s.add));
}

function entryKey(f: Field): string {
  const part = /\bmonth\b/.test(f.hints) ? 'm' : /\byear\b/.test(f.hints) ? 'y' : /\bday\b/.test(f.hints) ? 'd' : '';
  return `${norm(f.label) || `#${f.id}`}|${part}`;
}

/** Split a section's fields into blocks: a label we've already seen in this block starts the next one. */
export function splitBlocks(fields: Field[]): Field[][] {
  const out: Field[][] = [];
  let cur: Field[] = [];
  let seen = new Set<string>();
  for (const f of fields) {
    const k = entryKey(f);
    if (seen.has(k) && cur.length) {
      out.push(cur);
      cur = [];
      seen = new Set();
    }
    seen.add(k);
    cur.push(f);
  }
  if (cur.length) out.push(cur);
  return out;
}

const blocksOf = (s: Section) => splitBlocks(regionFields(s));
const sectionOf = (kind: Kind) => findSections().find((s) => s.kind === kind) ?? null;

export interface SectionFillOptions {
  profile: Profile;
  overwrite: boolean;
  /** Fields filled here; the generic pass skips them. */
  handled: Set<string>;
  onRow: (r: FieldReport) => void;
  /** The generic engine, for fields in a block that aren't about the entry ("Highest degree obtained"). */
  fallback: (f: Field) => Promise<FieldReport | null>;
}

export async function fillSections(opts: SectionFillOptions): Promise<void> {
  for (const kind of KINDS) {
    const entries = kind.entries(opts.profile).slice(0, MAX_ENTRIES);
    let sec = sectionOf(kind);
    if (!sec || !entries.length) continue;
    const done = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      checkCancel();
      let blocks = blocksOf(sec);
      if (blocks.length <= i) {
        status(`Adding ${kind.name} ${i + 1} of ${entries.length} ("add another")…`);
        const had = blocks.length;
        realClick(sec.add);
        await waitFor(() => {
          const s = sectionOf(kind);
          return !!s && blocksOf(s).length > had;
        }, { timeout: 5000 });
        await waitForSettle(300, 2000);
        sec = sectionOf(kind) ?? sec;
        blocks = blocksOf(sec);
        if (blocks.length <= i) {
          opts.onRow({ id: '', label: `${kind.name} ${i + 1}`, status: 'flagged', confidence: 0, reason: 'Could not add another entry — add it yourself' });
          break;
        }
      }
      // Two rounds: an answer can reveal more fields (End Date after "Current position? No").
      for (let round = 0; round < 2; round++) {
        const todo = (blocksOf(sec)[i] ?? []).filter((f) => !done.has(f.id));
        if (!todo.length) break;
        for (const f of todo) {
          checkCancel();
          done.add(f.id);
          opts.handled.add(f.id);
          status(`${kind.name} ${i + 1} of ${entries.length}: ${f.label || 'field'}…`);
          const r = await fillEntryField(f, `${kind.name} ${i + 1}`, entries[i], kind.resolver, opts.overwrite, opts.fallback);
          if (r) opts.onRow(r);
        }
        await waitForSettle(200, 1000);
        sec = sectionOf(kind) ?? sec;
      }
    }
    // Extra blocks the site showed beyond your entries: leave them alone.
    const last = sectionOf(kind);
    if (last) for (const f of regionFields(last)) opts.handled.add(f.id);
  }
}

/** For "fill just this field": which section block `f` sits in, and the profile entry for it. */
export function entryFor(f: Field, profile: Profile): { name: string; entry: unknown; resolver: EntryResolver<unknown> } | null {
  for (const s of findSections()) {
    const i = blocksOf(s).findIndex((b) => b.some((x) => x.el === f.el));
    if (i < 0) continue;
    const entry = s.kind.entries(profile)[i];
    return entry ? { name: `${s.kind.name} ${i + 1}`, entry, resolver: s.kind.resolver } : null;
  }
  return null;
}
