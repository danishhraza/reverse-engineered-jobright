import type { AiAnswer, AiQuestion } from '../engine/fill';
import type { SkillPick, SkillPickRequest } from '../engine/skills';
import type { LlmSettings } from '../queue/types';

// Screening questions the rules can't answer go to a model on OpenRouter
// (https://openrouter.ai/api/v1/chat/completions, OpenAI-style chat format).
// Runs in the background service worker, so page CORS rules don't apply.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 30000;

const SYSTEM = `You answer screening questions on job applications for the candidate described below.
Answer truthfully from the candidate facts and standing answers only. Never invent experience, credentials, licenses or personal facts.
If the facts don't settle the question, still give your best answer but set confidence below 0.5.
When options are listed, the answer must be one of them, copied exactly.
For a yes/no question without options, answer "Yes" or "No".
For a free-text question, answer in first person in at most three short sentences, based only on the facts.
Confidence is from 0 to 1: how firmly the facts support the answer.`;

const SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The answer, or one option copied exactly' },
    confidence: { type: 'number', description: '0 to 1' },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
};

export interface AskContext {
  facts: string;
  /** Page title / host, so "Have you worked at <company>?" has a company. */
  job?: string;
}

export function buildPrompt(q: AiQuestion, ctx: AskContext, standing: string): string {
  return [
    `Candidate facts:\n${ctx.facts}`,
    standing.trim() ? `Standing answers (always true):\n${standing.trim()}` : '',
    ctx.job ? `Job being applied to: ${ctx.job}` : '',
    `Question: ${q.question}${q.required ? ' (required)' : ''}`,
    q.options.length ? `Options:\n${q.options.map((o) => `- ${o}`).join('\n')}` : 'Free text answer.',
    q.note ? `Note: ${q.note}` : '',
    'Reply with JSON: {"answer": "...", "confidence": 0.0}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Pull {answer, confidence} out of the reply, even if the model wrapped the JSON in text or a code fence. */
export function parseAnswer(text: string): AiAnswer | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { answer?: unknown; confidence?: unknown };
    if (typeof o.answer !== 'string') return null;
    const c = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence);
    return { answer: o.answer.trim(), confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0 };
  } catch {
    return null;
  }
}

export class LlmError extends Error {}

async function post(s: LlmSettings, body: object): Promise<{ status: number; json: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.apiKey}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'Autofill Jobs',
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (e) {
    throw new LlmError((e as Error).name === 'AbortError' ? 'OpenRouter timed out' : `Network error: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

/** Tokens and (when OpenRouter reports it) dollars for one call. */
export interface Usage {
  tokensIn: number;
  tokensOut: number;
  cost?: number;
}

/** Ask the model. Retries rate limits / provider errors twice; falls back to plain JSON if the model can't do structured output. */
export async function askModel(s: LlmSettings, q: AiQuestion, ctx: AskContext): Promise<{ answer: AiAnswer | null; usage: Usage }> {
  const { text, usage } = await complete(s, SYSTEM, buildPrompt(q, ctx, s.standing), 'answer', SCHEMA);
  return { answer: parseAnswer(text), usage };
}

// ---------- Which button gets the application moving ----------

const GUIDE_SYSTEM = `You help a browser autofill tool get through online job applications.
You see one page: its URL, title, some visible text, and a numbered list of things that can be clicked.
Pick the ONE item to click that moves toward applying for this job (opening the application, getting past a pop-up or notice, choosing to apply manually, continuing).
Rules:
- Never pick anything that submits or sends the application, withdraws it, signs out, or deletes anything.
- Never sign in through LinkedIn, Google, Facebook, Apple or another third-party account.
- For cookie banners, prefer reject / necessary-only / close. Accept privacy or data notices only when they must be accepted to apply.
- Prefer applying manually over uploading or parsing a resume through a third party.
- If a person has to do something (CAPTCHA, a code, a password problem) or nothing here helps, answer -1.
Confidence is from 0 to 1.`;

const GUIDE_SCHEMA = {
  type: 'object',
  properties: {
    choice: { type: 'integer', description: 'Index of the item to click, or -1' },
    confidence: { type: 'number' },
    reason: { type: 'string', description: 'A few words' },
  },
  required: ['choice', 'confidence', 'reason'],
  additionalProperties: false,
};

export interface GuidePage {
  url: string;
  title: string;
  text: string;
  buttons: { i: number; text: string; kind: string; inDialog: boolean }[];
}

export interface GuideAnswer {
  choice: number;
  confidence: number;
  reason: string;
}

export function buildGuidePrompt(p: GuidePage): string {
  return [
    `URL: ${p.url}`,
    `Title: ${p.title}`,
    `Visible text (start):\n${p.text}`,
    `Clickable items:\n${p.buttons.map((b) => `[${b.i}] ${b.kind}${b.inDialog ? ' (in pop-up)' : ''}: "${b.text}"`).join('\n')}`,
    'Reply with JSON: {"choice": 0, "confidence": 0.0, "reason": "..."}',
  ].join('\n\n');
}

export function parseGuide(text: string, count: number): GuideAnswer | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<GuideAnswer>;
    const choice = Number(o.choice);
    if (!Number.isInteger(choice) || choice >= count || choice < -1) return null;
    return { choice, confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)), reason: String(o.reason ?? '').slice(0, 160) };
  } catch {
    return null;
  }
}

export async function askGuide(s: LlmSettings, page: GuidePage): Promise<{ answer: GuideAnswer | null; usage: Usage }> {
  const { text, usage } = await complete(s, GUIDE_SYSTEM, buildGuidePrompt(page), 'click', GUIDE_SCHEMA);
  return { answer: parseGuide(text, page.buttons.length), usage };
}

// ---------- Which skills to add to a skills box ----------

const SKILLS_SYSTEM = `You help a job applicant fill the "Skills" box of an online application.
You get the applicant's own skills, what the site's skills list offered when each one was typed in, and the job description.
Pick up to the given number of options to add. Rules:
- Only pick options that appear exactly in the lists shown; copy them character for character, with the skill that was typed to find it.
- Only pick options that are the same skill as one of the applicant's (a different name or spelling is fine: "React" -> "React.js"). Never pick a skill the applicant doesn't have.
- Prefer skills the job description asks for, then the applicant's strongest general ones.
- No two picks for the same skill.`;

const SKILLS_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The skill that was typed' }, option: { type: 'string', description: 'The exact option to add' } },
        required: ['query', 'option'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
};

export function buildSkillsPrompt(r: SkillPickRequest): string {
  return [
    `Pick up to ${r.max}.`,
    `Applicant's skills (most relevant first): ${r.mine.join(', ')}`,
    `What the site offered:\n${r.seen.map((s) => `- typed "${s.query}": ${s.options.map((o) => `"${o}"`).join(', ')}`).join('\n')}`,
    r.jd ? `Job description (start):\n${r.jd}` : '',
    'Reply with JSON: {"picks": [{"query": "...", "option": "..."}]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parseSkills(text: string): SkillPick[] | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { picks?: SkillPick[] };
    return Array.isArray(o.picks) ? o.picks.filter((p) => p && typeof p.query === 'string' && typeof p.option === 'string') : null;
  } catch {
    return null;
  }
}

export async function askSkills(s: LlmSettings, r: SkillPickRequest): Promise<{ picks: SkillPick[] | null; usage: Usage }> {
  const { text, usage } = await complete(s, SKILLS_SYSTEM, buildSkillsPrompt(r), 'skills', SKILLS_SCHEMA);
  return { picks: parseSkills(text), usage };
}

/** One chat completion; returns the reply text and what it cost. */
async function complete(s: LlmSettings, system: string, user: string, schemaName: string, schema: object): Promise<{ text: string; usage: Usage }> {
  if (!s.apiKey) throw new LlmError('No OpenRouter key — add it in Options');
  const base = {
    model: s.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 1500,
  };
  let structured = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = structured ? { ...base, response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } } } : base;
    const { status, json } = await post(s, body);
    if (status === 200) {
      const u = json?.usage ?? {};
      return {
        text: json?.choices?.[0]?.message?.content ?? '',
        usage: { tokensIn: Number(u.prompt_tokens) || 0, tokensOut: Number(u.completion_tokens) || 0, cost: typeof u.cost === 'number' ? u.cost : undefined },
      };
    }
    const msg: string = json?.error?.message ?? `HTTP ${status}`;
    if ((status === 400 || status === 422) && structured && /response_format|structured|json_schema|schema/i.test(msg)) {
      structured = false;
      attempt--; // not a real retry
      continue;
    }
    if (status === 429 || status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (status === 401) throw new LlmError('OpenRouter rejected the key (401)');
    if (status === 402) throw new LlmError('OpenRouter account is out of credits (402)');
    throw new LlmError(`OpenRouter: ${msg}`);
  }
  throw new LlmError('OpenRouter kept failing (rate limit or provider error)');
}
