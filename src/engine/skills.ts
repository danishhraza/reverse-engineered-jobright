// Skills boxes: which of your skills to add, the ones this job asks for first.
//
// Tag-style pickers are filled in three passes (widgets.ts fillTags): type each
// candidate and note what the site offers, ask the AI once which of those
// options to add (up to MAX_SKILLS), then add them one by one.

/** Most skills added to one box. */
export const MAX_SKILLS = 10;
/** How many of your skills are tried in the site's search. */
export const MAX_CANDIDATES = 15;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the job description mention this skill? Whole words; "C++"/".NET" style names too. */
export function mentions(jd: string, skill: string): boolean {
  const s = skill.trim();
  if (!s || !jd) return false;
  const alts = [s, s.replace(/\.js$/i, ''), s.replace(/^(\w+)\s*\(.*\)$/, '$1')].filter((x, i, a) => x.length > 1 && a.indexOf(x) === i);
  return alts.some((a) => new RegExp(`(^|[^\\w+#.])${esc(a)}(?![\\w+#])`, 'i').test(jd));
}

/** Your skills, the ones the job description mentions first (each group keeps your order). */
export function rankSkills(skills: string[], jd: string): string[] {
  const unique = Array.from(new Set(skills.map((s) => s.trim()).filter(Boolean)));
  const asked = unique.filter((s) => mentions(jd, s));
  return [...asked, ...unique.filter((s) => !asked.includes(s))];
}

/** What the site offered for each skill typed into its search. */
export interface SkillSearch {
  query: string;
  options: string[];
}

export interface SkillPickRequest {
  /** Your skills, most relevant first. */
  mine: string[];
  seen: SkillSearch[];
  max: number;
  /** The job description, shortened. */
  jd: string;
}

/** One option to add, and what to type to find it again. */
export interface SkillPick {
  query: string;
  option: string;
}

export type SkillPicker = (r: SkillPickRequest) => Promise<SkillPick[] | null>;

let picker: SkillPicker | undefined;
/** Set for each fill (the AI, when it's on). */
export function setSkillPicker(fn: SkillPicker | undefined): void {
  picker = fn;
}
export function skillPicker(): SkillPicker | undefined {
  return picker;
}

/** Keep only picks that are real options seen for that query, no repeats, at most `max`. */
export function validPicks(picks: SkillPick[] | null | undefined, seen: SkillSearch[], max: number): SkillPick[] {
  const out: SkillPick[] = [];
  for (const p of picks ?? []) {
    const s = seen.find((x) => x.query.toLowerCase() === String(p?.query ?? '').toLowerCase());
    const option = s?.options.find((o) => o.toLowerCase() === String(p?.option ?? '').toLowerCase());
    if (!s || !option || out.some((o) => o.option.toLowerCase() === option.toLowerCase())) continue;
    out.push({ query: s.query, option });
    if (out.length >= max) break;
  }
  return out;
}
