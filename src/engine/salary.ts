import type { Preferences } from '../types';
import type { Field } from './fields';
import { norm } from './match';

// Salary questions: the job's posted pay range when it has one, otherwise your
// own range; a single number (your preferred figure, kept inside the posted
// range) for boxes that won't take a range; the matching option in a list.

export interface PayRange {
  min: number;
  max: number;
}

/** The job description known for this application (set by the content script: the page's, or the one Autopilot saved). */
let jobText = '';
export function setJobText(text: string | undefined): void {
  if (text?.trim()) jobText = text;
}
export function knownJobText(): string {
  return jobText;
}

const AMOUNT = String.raw`(?:US\$|USD\s?|\$|£|€)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k\b|thousand\b)?`;
const RANGE = new RegExp(String.raw`${AMOUNT}\s*(?:-|–|—|to|and)\s*${AMOUNT}(\s*(?:USD|per year|/\s*(?:yr|year)|annually|a year))?`, 'gi');
const PAY_WORDS = /salary|compensation|pay\b|pay range|base|annual|per year|\/\s*(yr|year)|ote|wage/i;

function amount(num: string, k?: string): number {
  const n = Number(num.replace(/,/g, ''));
  return k ? n * 1000 : n;
}

/**
 * The yearly pay range a job description posts ("$95,000 - $120,000", "$95K–$120K per year",
 * "between 80,000 and 100,000 USD"), or null. Hourly rates and other numbers are ignored.
 */
export function postedPayRange(text: string): PayRange | null {
  if (!text) return null;
  for (const m of text.matchAll(RANGE)) {
    const [all, n1, k1, n2, k2, tail] = m;
    // "$95-120K": the K covers both.
    const lo = amount(n1, k1 ?? (k2 && !k1 && Number(n1.replace(/,/g, '')) < 1000 ? k2 : undefined));
    const hi = amount(n2, k2);
    if (!(lo >= 20000 && hi <= 1_000_000 && hi >= lo && hi <= lo * 3)) continue;
    const after = text.slice(m.index! + all.length, m.index! + all.length + 20);
    if (/^\s*(\/\s*h(ou)?r|per hour|an hour|hourly)/i.test(after)) continue;
    // A money sign, or pay words nearby, so a phone number or a headcount isn't taken for pay.
    const near = text.slice(Math.max(0, m.index! - 120), m.index!);
    if (!/[$£€]|USD/i.test(all) && !tail && !PAY_WORDS.test(near)) continue;
    return { min: Math.round(lo), max: Math.round(hi) };
  }
  return null;
}

/** What to answer: a range to type, and one number for boxes that take only one. */
export interface SalaryPlan {
  range: PayRange;
  single: number;
  /** The job's posted range was used. */
  posted: boolean;
}

export function salaryPlan(pref: Preferences, posted: PayRange | null = postedPayRange(jobText)): SalaryPlan | null {
  const { salaryMin: lo, salaryMax: hi, salaryPreferred: want } = pref;
  const own = lo || hi ? { min: (lo ?? hi)!, max: (hi ?? lo)! } : want ? { min: want, max: want } : null;
  const range = posted ?? own;
  if (!range) return null;
  const pick = want ?? Math.round((range.min + range.max) / 2 / 1000) * 1000;
  // Your number, but inside what they posted (not below their floor, not above their ceiling).
  const single = posted ? Math.min(Math.max(pick, posted.min), posted.max) : pick;
  return { range, single, posted: !!posted };
}

/** A box that takes one number, not a range: number inputs, numeric-only patterns, "numbers only" hints. */
export function wantsSingle(f: Field): boolean {
  const el = f.el as HTMLInputElement;
  if (f.inputType === 'number' || el.type === 'number') return true;
  if (/numeric|decimal/.test(el.getAttribute('inputmode') ?? '')) return true;
  const pattern = el.getAttribute('pattern');
  if (pattern && !/-|\\s|\[\^/.test(pattern) && /\\d|0-9/.test(pattern)) return true;
  const maxLen = Number(el.getAttribute('maxlength') ?? 0);
  if (maxLen > 0 && maxLen < 12) return true;
  const hint = norm(`${f.label} ${f.hints} ${el.getAttribute('placeholder') ?? ''}`);
  if (/\b(numbers? only|numeric|digits only|whole number|no ranges?|single (number|value|figure|amount)|one number|exact (number|amount|figure))\b/.test(hint)) return true;
  // A placeholder that is just a number ("e.g. 85000").
  return /^\s*(e g\s*)?\d{4,7}\s*$/.test(norm(el.getAttribute('placeholder') ?? ''));
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
export const rangeText = (r: PayRange) => (r.min === r.max ? money(r.min) : `${money(r.min)} - ${money(r.max)}`);

/** The amounts in an option ("$70,000 - $79,999", "$70k–80k", "Under $50k", "150K+"), as a range. */
function optionRange(option: string): PayRange | null {
  const nums = Array.from(option.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k\b|thousand\b)?/gi)).map((m) => amount(m[1], m[2]));
  // "$70-80k": the k covers both.
  if (nums.length === 2 && nums[0] < 1000 && nums[1] >= 1000 && /\dk/i.test(option)) nums[0] *= 1000;
  const yearly = nums.filter((n) => n >= 1000);
  if (!yearly.length) return null;
  if (yearly.length >= 2) return { min: Math.min(...yearly), max: Math.max(...yearly) };
  const n = yearly[0];
  if (/\b(under|less than|below|up to|max(imum)?)\b|</i.test(option)) return { min: 0, max: n };
  if (/\+|\b(over|more than|above|greater than|at least|or more|and up)\b|>/i.test(option)) return { min: n, max: Infinity };
  return { min: n, max: n };
}

/** The option whose range holds `value` (closest if none does), or null when the options aren't pay amounts. */
export function pickSalaryOption(options: string[], value: number): string | null {
  const ranged = options.map((o) => ({ o, r: optionRange(o) })).filter((x): x is { o: string; r: PayRange } => !!x.r);
  if (ranged.length < 2) return null;
  const inside = ranged.find((x) => value >= x.r.min && value <= x.r.max);
  if (inside) return inside.o;
  const dist = (r: PayRange) => (value < r.min ? r.min - value : value - r.max);
  return ranged.reduce((a, b) => (dist(b.r) < dist(a.r) ? b : a)).o;
}
