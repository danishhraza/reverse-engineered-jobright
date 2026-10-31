// Text normalization and option matching with a confidence score.

export interface Desired {
  /** Main answer text. */
  text: string;
  /** Acceptable alternative spellings ("United States of America", "USA"). */
  alts?: string[];
  /** Yes/No question: pick the yes-ish or no-ish option. */
  bool?: boolean;
  /** Pick the "decline to answer" option. */
  decline?: boolean;
  /** Several options may be checked (checkbox groups). */
  multi?: string[];
  /** What to type into a search-as-you-type dropdown, if different from `text`. */
  query?: string;
}

export function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(' ').filter((t) => t.length > 1 || /\d/.test(t)));
}

export function jaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const DECLINE = /\b(decline|prefer not|dont wish|do not wish|not wish|choose not|rather not|not to (answer|say|disclose|self identify)|i dont want to answer|do not want to answer|wish not)\b/;
const NOISH = /^no\b|\bnot\b|\bdont\b|\bdo not\b|\bwont\b|\bwill not\b|\bnever\b|\bam not\b|\bnone\b/;
const YESISH = /^yes\b|^i am\b|^i do\b|^i will\b|^i have\b|^i identify\b|\bauthorized\b/;
const PLACEHOLDER = /^(select( one| an option)?|choose( one)?|please select|search|none selected|)$/;
const EMPTY_OPTION = /^(loading|no options|no results|no matches|searching)\b/;

export function isPlaceholderOption(label: string): boolean {
  const n = norm(label);
  return PLACEHOLDER.test(n) || EMPTY_OPTION.test(n);
}

export interface MatchResult {
  index: number;
  score: number;
}

function wordContains(hay: string, needle: string): boolean {
  return (` ${hay} `).includes(` ${needle} `);
}

function textScore(option: string, cand: string): number {
  const o = norm(option);
  const c = norm(cand);
  if (!o || !c) return 0;
  if (o === c) return 1;
  if (o.startsWith(c + ' ') || c.startsWith(o + ' ')) return 0.9;
  if (wordContains(o, c)) return 0.85;
  if (o.length >= 3 && wordContains(c, o)) return 0.8;
  return jaccard(o, c) * 0.8;
}

/** Pick the best option for `desired`. Returns null if nothing scores above zero. */
export function matchOption(options: string[], desired: Desired): MatchResult | null {
  const scored = options.map((label, index) => ({ index, score: scoreOne(label, desired) }));
  const real = scored.filter((s) => !isPlaceholderOption(options[s.index]));
  if (!real.length) return null;
  real.sort((a, b) => b.score - a.score);
  const best = real[0];
  if (best.score <= 0) return null;
  // Two options equally good and not exact: ambiguous, so lower confidence.
  if (real[1] && real[1].score === best.score && best.score < 1) return { index: best.index, score: Math.min(best.score, 0.55) };
  return best;
}

function scoreOne(label: string, d: Desired): number {
  const n = norm(label);
  if (d.decline) return DECLINE.test(n) ? 0.95 : 0;
  if (d.bool !== undefined) {
    if (DECLINE.test(n)) return 0;
    const no = NOISH.test(n);
    const yes = YESISH.test(n) && !no;
    if (n === 'yes') return d.bool ? 1 : 0;
    if (n === 'no') return d.bool ? 0 : 1;
    if (d.bool && yes) return 0.85;
    if (!d.bool && no) return 0.85;
    // Fall through to text matching (e.g. option texts that don't look yes/no-ish).
  }
  const cands = [d.text, ...(d.alts ?? [])].filter(Boolean);
  let best = 0;
  for (const c of cands) best = Math.max(best, textScore(label, c));
  return d.bool !== undefined ? best * 0.8 : best;
}

/** Does a question match an answer-bank pattern? Plain words must all appear; /re/flags is a regex. */
export function patternMatches(pattern: string, question: string): boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern.trim());
  if (re) {
    try {
      return new RegExp(re[1], re[2] || 'i').test(question);
    } catch {
      return false;
    }
  }
  const q = ` ${norm(question)} `;
  return norm(pattern)
    .split(' ')
    .filter(Boolean)
    .every((w) => q.includes(` ${w}`));
}
