import type { QueueJob } from '../queue/types';

// "Copy prompt for Claude": the job, its description and the questions
// Autopilot couldn't answer, as one prompt to paste into your own Claude
// project (which knows you). Its reply, pasted back, is split into answers
// and filled into the job's tab.

export interface AskQuestion {
  /** The field's label, exactly as the fill log has it (used to find the field again). */
  label: string;
  kind?: string;
  options?: string[];
  required?: boolean;
  /** A cover letter upload: Claude writes the letter, we turn it into a file. */
  coverLetter?: boolean;
  /** What the AI put in already (kept so Claude can do better). */
  current?: string;
}

const COVER = /cover\s*letter|motivation(al)? letter|letter of (interest|motivation)/i;

/**
 * The questions to ask about, from the last page fill: the ones still needing
 * you, plus written answers the AI drafted (Claude, knowing you, may do them
 * better). Your resume and passwords are never part of it.
 */
export function questionsFor(j: QueueJob): AskQuestion[] {
  const last = j.fillLog?.at(-1);
  if (!last) return [];
  const out: AskQuestion[] = [];
  for (const f of last.fields) {
    if (f.key === 'resume' || /password/i.test(f.label)) continue;
    const isFile = f.kind === 'file';
    const cover = isFile && COVER.test(f.label);
    if (isFile && !cover) continue;
    const open = f.status === 'flagged' || f.status === 'failed';
    const aiEssay = f.status === 'filled' && f.key === 'ai' && f.kind === 'textarea';
    if (!open && !aiEssay) continue;
    out.push({ label: f.label, kind: f.kind, options: f.options, required: f.required, coverLetter: cover || undefined, current: aiEssay ? f.value : undefined });
  }
  return out;
}

function describe(q: AskQuestion): string {
  if (q.coverLetter) return 'a cover letter for this job (plain text, 200-300 words, no address block or date; open with "Hi <company> team," and sign off with just my first name)';
  if (q.options?.length) return `pick exactly one of: ${q.options.map((o) => `"${o}"`).join(' | ')}`;
  if (q.kind === 'textarea') return 'a written answer (about 60-120 words; shorter is fine if it says it)';
  return 'a short answer';
}

export function buildPrompt(j: QueueJob, qs: AskQuestion[]): string {
  const title = [j.title, j.company].filter(Boolean).join(' — ') || 'this job';
  const lines = [
    `I'm applying for ${title}. Please answer the application questions below as me, in the first person, using what you know about me (my resume, experience and preferences).`,
    '',
    `Job link: ${j.url}`,
    '',
    'Job description:',
    '"""',
    j.jd?.trim() || '(not captured — use the job link and what you can infer from the questions)',
    '"""',
    '',
    'Questions:',
    ...qs.map((q, i) => `[${i + 1}] ${q.label.trim()}${q.required ? ' (required)' : ''}\n    → ${describe(q)}${q.current ? `\n    (a draft I don't love: "${q.current.slice(0, 200)}")` : ''}`),
    '',
    'How to write it:',
    "- Sound like me, a real person typing this myself: conversational, a bit casual, still someone they'd want to hire. Not stiff, not salesy, not corporate.",
    "- Use contractions (I'm, I've, it's), plain everyday words and short sentences mixed with longer ones.",
    '- Lead with something concrete: a real project, a number, or the specific thing about this company or role that got my attention. Skip openers that restate the question.',
    `- No AI tells: no em dashes, no "I'm excited/thrilled to", "passionate", "leverage", "spearheaded", "delve", "fast-paced", "dynamic", "synergy", "aligns with", "resonates", "testament", "unique blend", "I'm confident that". No lists of three adjectives, no bullet points, headings or bold.`,
    `- Don't wrap up with a summary or "I look forward to…" line; just stop when the point is made.`,
    '- For a question with choices, reply with one choice copied word for word, nothing else.',
    '- Be specific to this company and role; no placeholders like [Company] and nothing you would need me to fill in.',
    "- Don't invent experience I don't have.",
    '',
    'Reply ONLY in this format, one block per question, with no other text before or after:',
    ...qs.flatMap((_, i) => [`[${i + 1}]`, '<answer>']),
  ];
  return lines.join('\n');
}

/**
 * Claude's reply split by its "[1]", "[2]"… markers into answers, one per
 * question (missing ones are ''). Tolerates Markdown around the markers
 * ("**[1]**", "### [2]") and a leading "Answer:".
 */
export function parseAnswers(reply: string, count: number): string[] {
  const out = Array.from({ length: count }, () => '');
  const marker = /^[ \t>#*_]*\[(\d{1,2})\][ \t*_:.)-]*(.*)$/gm;
  const hits = Array.from(reply.matchAll(marker));
  hits.forEach((m, i) => {
    const n = Number(m[1]) - 1;
    if (n < 0 || n >= count) return;
    const start = m.index! + m[0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index! : reply.length;
    const text = `${m[2]}\n${reply.slice(start, end)}`
      .replace(/^\s*(answer|a)\s*:\s*/i, '')
      .replace(/^```\w*\n?|```\s*$/g, '')
      .trim();
    out[n] = text.replace(/^"(.*)"$/s, '$1').trim();
  });
  return out;
}
