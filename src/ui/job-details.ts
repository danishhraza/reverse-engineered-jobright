import type { QueueJob } from '../queue/types';
import type { PastedAnswer } from '../content/paste-answers';
import { buildPrompt, parseAnswers, questionsFor, type AskQuestion } from './claude-prompt';

// A job's details on the Autopilot page, in tabs: what still needs you, the
// steps taken, every page fill, and every AI call.

export type Tab = 'needs' | 'steps' | 'fill' | 'ai';

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);
const pillFor = (status: string) => (status === 'filled' ? 'applied' : status === 'flagged' ? 'needs-you' : status);
const squashed = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface Unanswered {
  label: string;
  reason?: string;
  value?: string;
  /** What the AI answered for it, if it was asked. */
  ai?: string;
}

/** Questions the last page fill couldn't answer, with what the AI suggested for each. */
export function needsYou(j: QueueJob): Unanswered[] {
  const last = j.fillLog?.at(-1);
  if (!last) return [];
  return last.fields
    .filter((f) => f.status === 'flagged' || f.status === 'failed')
    .map((f) => {
      // "Work 1: Employer" was asked as "Employer".
      const q = squashed(f.label.replace(/^[^:]*\d+: /, ''));
      const ai = [...(j.aiLog ?? [])]
        .reverse()
        .find((e) => e.answer && q && (squashed(e.question).includes(q) || q.includes(squashed(e.question))));
      return { label: f.label, reason: f.reason, value: f.value, ai: ai?.answer };
    });
}

/** Fields the last page fill filled with an AI answer it wasn't sure of (pink on the page). */
export function toReview(j: QueueJob): { label: string; value?: string; reason?: string }[] {
  return (j.fillLog?.at(-1)?.fields ?? []).filter((f) => f.status === 'filled' && f.review);
}

function reviewTable(j: QueueJob): string {
  const items = toReview(j);
  if (!items.length) return '';
  return `<h4 class="review-head">To review: the AI filled these but wasn't sure <span class="muted">(pink on the page)</span></h4>
    <table class="ailog review"><thead><tr><th>Question</th><th>What it put in</th></tr></thead><tbody>${items
      .map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(f.value ?? '')}</td></tr>`)
      .join('')}</tbody></table>`;
}

/** The "ask your own Claude" box: copy a prompt, paste the reply back, fill. */
function claudeBox(j: QueueJob): string {
  const qs = questionsFor(j);
  if (!qs.length) return '';
  const jd = j.jd ? `job description (${Math.round(j.jd.length / 100) / 10}k chars)` : 'no job description captured — Claude gets the link';
  return `<div class="claude">
    <div class="claude-head"><b>Ask your Claude</b> <span class="muted">${qs.length} question${qs.length === 1 ? '' : 's'} + ${jd}</span></div>
    <div class="claude-row"><button type="button" class="copy-claude primary">Copy prompt for Claude</button>
      <span class="muted">Paste it in your Claude project, then paste its reply below.</span></div>
    <textarea class="claude-reply" rows="5" placeholder="Paste Claude's reply here — it starts with [1]"></textarea>
    <div class="claude-preview"></div>
    <div class="claude-row"><button type="button" class="fill-claude" disabled>Fill these answers</button> <span class="claude-msg muted"></span></div>
  </div>`;
}

function needsPanel(j: QueueJob): string {
  const items = needsYou(j);
  const head = (j.reason ? `<p class="reason">${esc(j.reason)}</p>` : '') + claudeBox(j);
  if (!items.length) return `${head}<p class="muted">Nothing left unanswered on the last page it filled.</p>${reviewTable(j)}`;
  return `${head}<table class="ailog"><thead><tr><th>Question</th><th>Why it stopped</th><th>In the box now</th><th>AI suggested</th></tr></thead><tbody>${items
    .map(
      (n) =>
        `<tr><td>${esc(n.label)}</td><td class="muted">${esc(n.reason ?? '')}</td><td>${esc(n.value ?? '')}</td><td>${
          n.ai ? esc(n.ai) : '<span class="muted">—</span>'
        }</td></tr>`,
    )
    .join('')}</tbody></table>${reviewTable(j)}`;
}

const BAD = /\b(fail(ed)?|error|stuck|couldn.?t|could not|timed? ?out|gave up)\b/i;
const WARN = /needs you|waiting for you|captcha|\bcode\b|verif/i;

/** The runner's step log, one line per action, problems marked. */
function stepsPanel(j: QueueJob): string {
  if (!j.log.length) return '<p class="muted">No steps yet.</p>';
  return `<ol class="steps">${j.log
    .map((line) => {
      const m = /^(\d\d:\d\d) ([\s\S]*)$/.exec(line);
      const time = m ? m[1] : '';
      const text = m ? m[2] : line;
      const kind = BAD.test(text) ? 'bad' : WARN.test(text) ? 'warn' : /\bAI\b/.test(text) ? 'ai' : '';
      return `<li class="${kind}"><time>${time}</time><span>${esc(text)}</span></li>`;
    })
    .join('')}</ol>`;
}

/** Every page fill: each field, what went in, and why. The latest page starts open. */
function fillPanel(j: QueueJob): string {
  const pages = j.fillLog ?? [];
  if (!pages.length) return '<p class="muted">No pages filled yet.</p>';
  return pages
    .map((e, i) => {
      const n = (...s: string[]) => e.fields.filter((f) => s.includes(f.status)).length;
      const counts = (
        [
          [n('filled') - e.fields.filter((f) => f.status === 'filled' && f.review).length, 'filled', 'filled'],
          [e.fields.filter((f) => f.status === 'filled' && f.review).length, 'to review', 'review'],
          [n('flagged', 'failed'), 'need you', 'flagged'],
          [n('skipped'), 'skipped', 'skipped'],
        ] as [number, string, string][]
      )
        .filter(([c]) => c)
        .map(([c, t, cls]) => `<span class="pill ${cls}">${c} ${t}</span>`)
        .join(' ');
      return `<details class="page"${i === pages.length - 1 ? ' open' : ''}><summary><b>Page ${e.page}</b> <span class="muted">${clock(e.at)}</span> ${counts}${
        e.message ? ` <span class="muted">· ${esc(e.message)}</span>` : ''
      }${e.stop ? ` <span class="muted">· stopped: ${esc(e.stop)}</span>` : ''}</summary>
      <div class="muted url">${esc(e.url.slice(0, 160))}</div>
      <table class="ailog"><thead><tr><th>Field</th><th>Result</th><th>Value</th><th>Why</th></tr></thead><tbody>${e.fields
        .map(
          (f) =>
            `<tr><td>${esc(f.label)}${f.key ? ` <span class="muted">(${esc(f.key)})</span>` : ''}</td><td><span class="pill ${f.review && f.status === 'filled' ? 'review' : pillFor(f.status)}">${esc(
              f.review && f.status === 'filled' ? 'review' : f.status,
            )}</span></td><td>${esc(f.value ?? '')}</td><td class="muted">${esc(f.reason ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table></details>`;
    })
    .join('');
}

/** Every AI call: what was asked (with the options), what it answered, and what was done with it. */
function aiPanel(j: QueueJob): string {
  const log = j.aiLog ?? [];
  if (!log.length) return '<p class="muted">No AI calls on this job.</p>';
  const tokens = log.reduce((s, e) => s + (e.tokens ?? 0), 0);
  const cost = log.reduce((s, e) => s + (e.cost ?? 0), 0);
  const rows = log
    .map(
      (e) => `<tr>
        <td class="muted">${clock(e.at)}</td>
        <td>${esc(e.question)}${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}${
          e.options?.length
            ? `<details><summary class="muted">${e.options.length} options</summary>${esc(e.options.join(' · '))}</details>`
            : '<div class="muted">free text</div>'
        }</td>
        <td>${esc(e.answer ?? '—')}${e.confidence !== undefined ? ` <span class="muted">(${e.confidence})</span>` : ''}</td>
        <td>${esc(e.decision ?? '—')}</td>
        <td class="muted">${e.tokens ? `${e.tokens.toLocaleString()} tok` : ''}${e.cost !== undefined ? `<br>$${e.cost.toFixed(5)}` : ''}</td>
      </tr>`,
    )
    .join('');
  return `<p class="muted">${plural(log.length, 'call')} · ${tokens.toLocaleString()} tokens · $${cost.toFixed(4)}</p>
    <table class="ailog"><thead><tr><th>Time</th><th>Asked</th><th>AI answered</th><th>What was done</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** One line under the job's status: how many unanswered, pages, AI calls. */
export function summaryChips(j: QueueJob): string {
  const need = needsYou(j).length;
  const review = toReview(j).length;
  return [
    need ? `<span class="pill needs-you">${need} unanswered</span>` : '',
    review ? `<span class="pill review">${review} to review</span>` : '',
    j.fillLog?.length ? `<span class="muted">${plural(j.fillLog.length, 'page')} filled</span>` : '',
    j.aiLog?.length ? `<span class="muted">${plural(j.aiLog.length, 'AI call')}</span>` : '',
  ]
    .filter(Boolean)
    .join('<span class="muted">·</span>');
}

/** Which tab to open first: what needs you, when something does. */
export function firstTab(j: QueueJob): Tab {
  return (needsYou(j).length || toReview(j).length) && (j.status === 'needs-you' || j.status === 'ready') ? 'needs' : 'steps';
}

export interface ClaudeHooks {
  copy: (text: string) => Promise<void>;
  fill: (jobId: string, answers: PastedAnswer[]) => Promise<{ ok: boolean; error?: string; filled: string[]; failed: { label: string; reason: string }[]; missing: string[] }>;
}

/** What you've pasted per job, and the questions the copied prompt asked (kept across re-renders). */
const drafts = new Map<string, string>();
const notes = new Map<string, string>();
const asked = new Map<string, AskQuestion[]>();

function wireClaude(tr: HTMLElement, j: QueueJob, hooks: ClaudeHooks): void {
  const box = tr.querySelector<HTMLElement>('.claude');
  if (!box) return;
  const copyBtn = box.querySelector<HTMLButtonElement>('.copy-claude')!;
  const reply = box.querySelector<HTMLTextAreaElement>('.claude-reply')!;
  const preview = box.querySelector<HTMLElement>('.claude-preview')!;
  const fillBtn = box.querySelector<HTMLButtonElement>('.fill-claude')!;
  const msg = box.querySelector<HTMLElement>('.claude-msg')!;
  const questions = () => asked.get(j.id) ?? questionsFor(j);
  const parsed = () => {
    const qs = questions();
    return parseAnswers(reply.value, qs.length).map((text, i) => ({ q: qs[i], text }));
  };
  const show = () => {
    drafts.set(j.id, reply.value);
    const rows = parsed();
    const got = rows.filter((r) => r.text).length;
    fillBtn.disabled = !got;
    preview.innerHTML = reply.value.trim()
      ? `<ol>${rows
          .map((r) => `<li><span class="muted">${esc(r.q.label.slice(0, 90))}</span><br>${r.text ? esc(r.text.length > 220 ? `${r.text.slice(0, 220)}…` : r.text) : '<i class="muted">no answer found in the reply</i>'}</li>`)
          .join('')}</ol>`
      : '';
  };
  reply.value = drafts.get(j.id) ?? '';
  const say = (text: string) => {
    msg.textContent = text;
    notes.set(j.id, text);
  };
  msg.textContent = notes.get(j.id) ?? '';
  show();
  reply.addEventListener('input', show);
  copyBtn.addEventListener('click', async () => {
    const qs = questionsFor(j);
    asked.set(j.id, qs);
    try {
      await hooks.copy(buildPrompt(j, qs));
      say('Copied — paste it into Claude.');
    } catch {
      say("Couldn't copy (clipboard blocked).");
    }
    show();
  });
  fillBtn.addEventListener('click', async () => {
    const answers = parsed()
      .filter((r) => r.text)
      .map((r) => ({ label: r.q.label, text: r.text, coverLetter: r.q.coverLetter }));
    fillBtn.disabled = true;
    say(`Filling ${answers.length}…`);
    const r = await hooks.fill(j.id, answers).catch((e) => ({ ok: false, error: String(e), filled: [], failed: [], missing: [] }));
    fillBtn.disabled = false;
    if (!r.ok) {
      say(r.error ?? "Couldn't fill them.");
      return;
    }
    const not = [...r.failed.map((f) => `${f.label.slice(0, 40)} (${f.reason})`), ...r.missing.map((m) => `${m.slice(0, 40)} (not on the page now)`)];
    say(`Filled ${r.filled.length} of ${answers.length}.${not.length ? ` Not filled: ${not.join('; ')}` : ' Check them on the page, then press Done — continue.'}`);
    if (!not.length) drafts.delete(j.id);
  });
}

/** The details row under a job: tabs and the open tab's panel. */
export function detailsRow(j: QueueJob, tab: Tab, pick: (t: Tab) => void, hooks?: ClaudeHooks): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'details';
  const tabs: [Tab, string, number][] = [
    ['needs', 'Needs you', needsYou(j).length],
    ['steps', 'Steps', j.log.length],
    ['fill', 'Fill log', j.fillLog?.length ?? 0],
    ['ai', 'AI log', j.aiLog?.length ?? 0],
  ];
  const body = tab === 'needs' ? needsPanel(j) : tab === 'steps' ? stepsPanel(j) : tab === 'fill' ? fillPanel(j) : aiPanel(j);
  tr.innerHTML = `<td colspan="4"><div class="dtabs">${tabs
    .map(([t, text, n]) => `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${text} <span class="n${t === 'needs' && n ? ' warn' : ''}">${n}</span></button>`)
    .join('')}</div><div class="dbody">${body}</div></td>`;
  for (const b of Array.from(tr.querySelectorAll<HTMLButtonElement>('.dtabs button'))) {
    b.addEventListener('click', () => pick(b.dataset.tab as Tab));
  }
  if (hooks) wireClaude(tr, j, hooks);
  return tr;
}
