import type { AiAnswer, AiQuestion } from '../engine/fill';
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

/** Ask the model. Retries rate limits / provider errors twice; falls back to plain JSON if the model can't do structured output. */
export async function askModel(s: LlmSettings, q: AiQuestion, ctx: AskContext): Promise<AiAnswer | null> {
  if (!s.apiKey) throw new LlmError('No OpenRouter key — add it in Options');
  const base = {
    model: s.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildPrompt(q, ctx, s.standing) },
    ],
    max_tokens: 1500,
  };
  let structured = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = structured ? { ...base, response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: SCHEMA } } } : base;
    const { status, json } = await post(s, body);
    if (status === 200) {
      const text: string = json?.choices?.[0]?.message?.content ?? '';
      return parseAnswer(text);
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
