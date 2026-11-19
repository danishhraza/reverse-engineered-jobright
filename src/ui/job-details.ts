import type { QueueJob } from '../queue/types';

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

function needsPanel(j: QueueJob): string {
  const items = needsYou(j);
  const head = j.reason ? `<p class="reason">${esc(j.reason)}</p>` : '';
  if (!items.length) return `${head}<p class="muted">Nothing left unanswered on the last page it filled.</p>`;
  return `${head}<table class="ailog"><thead><tr><th>Question</th><th>Why it stopped</th><th>In the box now</th><th>AI suggested</th></tr></thead><tbody>${items
    .map(
      (n) =>
        `<tr><td>${esc(n.label)}</td><td class="muted">${esc(n.reason ?? '')}</td><td>${esc(n.value ?? '')}</td><td>${
          n.ai ? esc(n.ai) : '<span class="muted">—</span>'
        }</td></tr>`,
    )
    .join('')}</tbody></table>`;
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
          [n('filled'), 'filled', 'filled'],
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
            `<tr><td>${esc(f.label)}${f.key ? ` <span class="muted">(${esc(f.key)})</span>` : ''}</td><td><span class="pill ${pillFor(f.status)}">${esc(
              f.status,
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
  return [
    need ? `<span class="pill needs-you">${need} unanswered</span>` : '',
    j.fillLog?.length ? `<span class="muted">${plural(j.fillLog.length, 'page')} filled</span>` : '',
    j.aiLog?.length ? `<span class="muted">${plural(j.aiLog.length, 'AI call')}</span>` : '',
  ]
    .filter(Boolean)
    .join('<span class="muted">·</span>');
}

/** Which tab to open first: what needs you, when something does. */
export function firstTab(j: QueueJob): Tab {
  return needsYou(j).length && (j.status === 'needs-you' || j.status === 'ready') ? 'needs' : 'steps';
}

/** The details row under a job: tabs and the open tab's panel. */
export function detailsRow(j: QueueJob, tab: Tab, pick: (t: Tab) => void): HTMLTableRowElement {
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
  return tr;
}
