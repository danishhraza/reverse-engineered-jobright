import type { Education, FieldReport, Work, YearMonth } from '../types';
import { describeJob, degreeAlts } from './answers';
import { waitForSettle } from './dom';
import { currentValue, type Field } from './fields';
import { norm, type Desired } from './match';
import { fillField } from './widgets';

// Filling one field of a Work or Education entry (a Workday "Work Experience 2"
// panel, an Avature "Work History" block…) from the matching profile entry.

/**
 * What to put in a field of one entry. null = not an entry field (let the
 * generic engine answer it), 'skip' = leave it, 'ask' = it needs something the
 * profile doesn't have for this entry.
 */
export type EntryResolver<T> = (f: Field, label: string, entry: T) => Desired | null | 'skip' | 'ask';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A date in whatever shape the input wants: separate month/year boxes, <input type=date>, or a typed mm/yyyy. */
export function dateDesired(f: Field, ym: YearMonth | undefined): Desired | null {
  if (!ym) return null;
  const ph = (f.el.getAttribute('placeholder') ?? '').toLowerCase();
  const h = `${f.hints} ${norm(f.el.getAttribute('aria-label') ?? '')} ${norm(ph)}`;
  const m = ym.month;
  const month = /\bmonth\b|\bmm\b/.test(h);
  const year = /\byear\b|\byyyy\b/.test(h);
  if (month && !year) return m ? { text: pad(m), alts: [MONTHS[m - 1], MONTHS[m - 1].slice(0, 3), String(m)] } : null;
  if (year && !month) return { text: String(ym.year) };
  if (f.inputType === 'date') return { text: `${ym.year}-${pad(m ?? 1)}-01` };
  if (f.inputType === 'month') return { text: `${ym.year}-${pad(m ?? 1)}` };
  if (/dd/.test(ph)) return { text: /^dd/.test(ph) ? `01/${pad(m ?? 1)}/${ym.year}` : `${pad(m ?? 1)}/01/${ym.year}` };
  if (/^yyyy/.test(ph)) return { text: `${ym.year}-${pad(m ?? 1)}` };
  return { text: m ? `${pad(m)}/${ym.year}` : String(ym.year) };
}

/** "Current position?" / "I currently work here" / "Still attending?" style yes-no fields. */
function asksCurrent(f: Field, label: string): boolean {
  if (/currently (work|attend|enrolled)|current(ly)? (employed|working)|i currently|i work here|still (attending|enrolled|work)/.test(label)) return true;
  if (!/\bcurrent(ly)?\b|\bpresent\b|\bin progress\b/.test(label)) return false;
  if (f.kind === 'checkbox' || f.kind === 'radio' || f.kind === 'buttonGroup' || /\?$/.test(f.label.trim())) return true;
  return f.kind === 'select' && Array.from((f.el as HTMLSelectElement).options).some((o) => /^\s*yes\s*$/i.test(o.textContent ?? ''));
}

const yesNo = (b: boolean): Desired => ({ text: b ? 'Yes' : 'No', bool: b });

function stillGoing(e: { current?: boolean; end?: YearMonth }): boolean {
  if (e.current !== undefined) return e.current;
  if (!e.end) return false;
  const now = new Date();
  return e.end.year * 12 + (e.end.month ?? 12) > now.getFullYear() * 12 + now.getMonth() + 1;
}

/** "Austin, TX" -> city "Austin", state "TX". */
function locationPart(loc: string | undefined, part: 'city' | 'state'): string | undefined {
  const bits = (loc ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (bits.length < 2) return undefined;
  return part === 'city' ? bits[0] : bits[1];
}

export const workResolver: EntryResolver<Work> = (f, label, w) => {
  if (asksCurrent(f, label)) return yesNo(!!w.current);
  if (/title|position|role$/.test(label)) return { text: w.title };
  if (/company|employer|organi[sz]ation/.test(label)) return { text: w.company };
  if (/country/.test(label)) return w.country ? { text: w.country } : 'ask';
  if (/\bcity\b/.test(label)) return locationPart(w.location, 'city') ? { text: locationPart(w.location, 'city')! } : 'ask';
  if (/\bstate\b|province/.test(label)) return locationPart(w.location, 'state') ? { text: locationPart(w.location, 'state')! } : 'ask';
  if (/location/.test(label)) return w.location ? { text: w.location } : 'skip';
  if (/^from$|start/.test(label)) return dateDesired(f, w.start) ?? 'skip';
  if (/^to$|end/.test(label)) return w.current ? 'skip' : (dateDesired(f, w.end) ?? 'skip');
  if (/description|responsibilit|summary|duties|accomplishment/.test(label)) {
    const text = describeJob(w);
    return text ? { text } : 'skip';
  }
  return null;
};

export const eduResolver: EntryResolver<Education> = (f, label, e) => {
  // "Highest degree obtained" is about all your schools, not this one.
  if (/highest|obtain/.test(label)) return null;
  if (asksCurrent(f, label)) return yesNo(stillGoing(e));
  if (/school|university|college|institution/.test(label) && !/city|state|country|location/.test(label)) return { text: e.school };
  if (/degree|diploma/.test(label)) return { text: e.degree, alts: degreeAlts(e.degree, e.degreeShort) };
  if (/field of study|major|discipline|concentration|area of study/.test(label)) return { text: e.major };
  if (/gpa|overall result|grade/.test(label)) return e.gpa ? { text: e.gpa } : 'skip';
  if (/country/.test(label)) return e.country ? { text: e.country } : 'ask';
  if (/\bcity\b/.test(label)) return e.city ? { text: e.city } : 'ask';
  if (/\bstate\b|province/.test(label)) return e.state ? { text: e.state } : 'ask';
  if (/^from$|start/.test(label)) return dateDesired(f, e.start) ?? 'skip';
  if (/^to$|end|graduat|complet/.test(label)) return dateDesired(f, e.end) ?? 'skip';
  return null;
};

/**
 * Fill field `f` of entry `name` ("Work 2"). Fields the resolver doesn't know
 * go to `fallback` (the generic engine) when given, else get flagged if required.
 */
export async function fillEntryField<T>(
  f: Field,
  name: string,
  entry: T,
  resolver: EntryResolver<T>,
  overwrite: boolean,
  fallback?: (f: Field) => Promise<FieldReport | null>,
): Promise<FieldReport | null> {
  const d = resolver(f, norm(f.label), entry);
  const rowLabel = `${name}: ${f.label || f.hints}`;
  if (d === 'skip') return null;
  if (d === 'ask') {
    const cur = currentValue(f);
    if (cur) return { id: f.id, label: rowLabel, status: 'skipped', confidence: 0, value: cur, reason: 'Kept what the site put in (not in your profile for this entry)', required: f.required };
    return { id: f.id, label: rowLabel, status: 'flagged', confidence: 0, reason: 'Not in your profile for this entry', required: f.required };
  }
  if (!d) {
    if (fallback) {
      const r = await fallback(f);
      return r && { ...r, label: rowLabel };
    }
    return f.required ? { id: f.id, label: rowLabel, status: 'flagged', confidence: 0, reason: 'Unknown field in section', required: true } : null;
  }
  if (!f.el.isConnected) return null; // e.g. end date removed after ticking "currently work here"
  const r = await fillField(f, d, overwrite);
  const conf = 0.9 * r.match;
  const status: FieldReport['status'] = !r.ok ? 'flagged' : r.skipped ? 'skipped' : conf < 0.75 ? 'flagged' : 'filled';
  await waitForSettle(150, 800);
  return { id: f.id, label: rowLabel, status, confidence: Math.round(conf * 100) / 100, value: r.value, reason: r.reason, required: f.required };
}
