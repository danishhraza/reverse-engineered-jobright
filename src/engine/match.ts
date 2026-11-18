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
  // "masters" / "master", "sciences" / "science": plurals and possessives count as the same word.
  return new Set(
    norm(s)
      .split(' ')
      .filter((t) => t.length > 1 || /\d/.test(t))
      .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)),
  );
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
  if (real[0].score <= 0) return null;
  // Several options equally good: break the tie on how many words they share with the answer
  // ("Masters of Science (MS)" over "Masters of Arts (MA)" for "Master of Science").
  const tied = real.filter((s) => s.score === real[0].score);
  if (tied.length > 1 && real[0].score < 1) {
    const overlap = (i: number) => Math.max(...[desired.text, ...(desired.alts ?? [])].filter(Boolean).map((c) => jaccard(options[i], c)));
    tied.sort((a, b) => overlap(b.index) - overlap(a.index));
    // Still a tie: ambiguous, so lower confidence.
    if (overlap(tied[0].index) === overlap(tied[1].index)) return { index: tied[0].index, score: Math.min(tied[0].score, 0.55) };
    return tied[0];
  }
  return real[0];
}

function scoreOne(label: string, d: Desired): number {
  const n = norm(label);
  if (d.decline) return DECLINE.test(n) ? 0.95 : 0;
  const cands = [d.text, ...(d.alts ?? [])].filter(Boolean);
  let text = 0;
  for (const c of cands) text = Math.max(text, textScore(label, c));
  if (d.bool !== undefined) {
    if (DECLINE.test(n)) return 0;
    const no = NOISH.test(n);
    const yes = YESISH.test(n) && !no;
    if (n === 'yes') return d.bool ? 1 : 0;
    if (n === 'no') return d.bool ? 0 : 1;
    // Exact wording we were given ("I am not a veteran") beats any option that merely sounds like no.
    if (text >= 0.9) return text;
    if (d.bool && yes) return 0.85;
    if (!d.bool && no) return 0.85;
    // Option texts that don't look yes/no-ish: text matching only.
    return text * 0.8;
  }
  return text;
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
