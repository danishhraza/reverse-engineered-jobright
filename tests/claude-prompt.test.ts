import type { QueueJob } from '../src/queue/types';
import { buildPrompt, parseAnswers, questionsFor } from '../src/ui/claude-prompt';
import { pdfSafe, textToPdf } from '../src/engine/textpdf';
import { jobDescription } from '../src/content/jd';
import { fillPastedAnswers } from '../src/content/paste-answers';
import { detailsRow } from '../src/ui/job-details';

// "Copy prompt for Claude": the questions Autopilot couldn't answer + the job
// description, as a prompt for your own Claude project; its reply pasted back
// and filled in (a cover letter as a PDF).

const WHY = "Tell us why you're interested in Clean Power Research";
const COVER = 'Cover Letter – (required and please do not upload your resume here, only a cover letter)';

const job = {
  id: 'j1',
  url: 'https://cleanpower.hire.trakstar.com/jobs/fk0zncr',
  title: 'Software Engineer, PowerClerk',
  company: 'Clean Power Research',
  status: 'needs-you',
  attempts: 1,
  addedAt: 0,
  updatedAt: 0,
  log: [],
  jd: 'Clean Power Research builds cloud software for utilities. You will work in C#, TypeScript and SQL on AWS.',
  fillLog: [
    {
      at: 1,
      url: 'https://cleanpower.hire.trakstar.com/jobs/fk0zncr?apply=true',
      page: 1,
      fields: [
        { label: 'First Name', key: 'firstName', status: 'filled', value: 'Alex', kind: 'text' },
        { label: 'Resume', key: 'resume', status: 'flagged', kind: 'file', reason: 'check it' },
        { label: COVER, status: 'flagged', kind: 'file', required: true, reason: 'File upload needed' },
        { label: WHY, status: 'flagged', kind: 'textarea', required: true, reason: "Couldn't work out what this asks" },
        { label: 'Are you located in the Greater Seattle Area?', status: 'flagged', kind: 'select', options: ['Yes', 'No'], required: true },
        { label: 'Password', status: 'flagged', kind: 'text' },
      ],
    },
  ],
} as unknown as QueueJob;

describe('the prompt', () => {
  it('asks about what needs you (cover letter, essay, a choice), never the resume or a password', () => {
    expect(questionsFor(job).map((q) => q.label)).toEqual([COVER, WHY, 'Are you located in the Greater Seattle Area?']);
    expect(questionsFor(job)[0].coverLetter).toBe(true);
  });

  it('has the job, its description, numbered questions with their choices, and the reply format', () => {
    const p = buildPrompt(job, questionsFor(job));
    expect(p).toContain('Software Engineer, PowerClerk — Clean Power Research');
    expect(p).toContain('cloud software for utilities');
    expect(p).toContain(`[2] ${WHY} (required)`);
    expect(p).toContain('pick exactly one of: "Yes" | "No"');
    expect(p).toContain('cover letter');
    expect(p).toMatch(/\[1\]\n<answer>\n\[2\]\n<answer>\n\[3\]\n<answer>$/);
  });
});

describe("reading Claude's reply", () => {
  it('splits it at [1], [2]… even with Markdown around them', () => {
    const reply = `Here you go:\n\n**[1]**\nDear Hiring Team,\n\nI am excited…\n\nBest,\nAlex\n\n### [2]\nAnswer: I care about clean energy.\n\n[3] "No"`;
    expect(parseAnswers(reply, 3)).toEqual(['Dear Hiring Team,\n\nI am excited…\n\nBest,\nAlex', 'I care about clean energy.', 'No']);
  });

  it('leaves an answer empty when the reply skipped it', () => {
    expect(parseAnswers('[1]\nYes', 2)).toEqual(['Yes', '']);
  });
});

describe('the cover letter PDF', () => {
  it('is a well-formed PDF with the text in it', () => {
    const bytes = textToPdf('Dear Hiring Team,\n\nI (really) like C:\\ paths — and “quotes”.');
    const s = new TextDecoder().decode(bytes);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toContain('(I \\(really\\) like C:\\\\ paths - and "quotes".) Tj');
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    // Every object offset in the table points at its "n 0 obj".
    const offsets = Array.from(s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)).map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(s.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });

  it('runs onto more pages when long', () => {
    const s = new TextDecoder().decode(textToPdf(Array.from({ length: 120 }, (_, i) => `Line ${i}`).join('\n')));
    expect(/\/Count (\d+)/.exec(s)![1]).toBe('3');
  });

  it('keeps to characters a standard font can show', () => {
    expect(pdfSafe('café – “hi” …')).toBe('cafe - "hi" ...');
  });
});

describe('the job description on the page', () => {
  it('reads the description box, not the form', () => {
    document.body.innerHTML = `<div class="jobdesciption"><h3>Who Are We?</h3><p>${'We build software for utilities. '.repeat(20)}</p></div>
      <form><label>Tell us why</label><textarea></textarea></form>`;
    const jd = jobDescription();
    expect(jd).toContain('Who Are We?');
    expect(jd).not.toContain('Tell us why');
  });

  it('is empty on a page without one', () => {
    document.body.innerHTML = '<form><label for="a">Email</label><input id="a"></form>';
    expect(jobDescription()).toBe('');
  });
});

describe('filling the pasted answers', () => {
  beforeEach(() => {
    document.body.innerHTML = `<form>
      <div class="form-group"><label for="id_cover_letter">${COVER}</label><input type="file" id="id_cover_letter" required></div>
      <div class="form-group"><label for="why">${WHY}</label><textarea id="why" required></textarea></div>
      <div class="form-group"><label for="sea">Are you located in the Greater Seattle Area?</label>
        <select id="sea" required><option value="">---------</option><option>Yes</option><option>No</option></select></div></form>`;
  });

  it('fills each by its question, and uploads the cover letter as a PDF', async () => {
    const r = await fillPastedAnswers([
      { label: COVER.slice(0, 60), text: 'Dear Hiring Team,\n\nI would love to join.', coverLetter: true },
      { label: WHY, text: 'Because clean energy matters to me.' },
      { label: 'Are you located in the Greater Seattle Area?', text: 'No' },
      { label: 'A question on another page', text: 'Yes' },
    ]);
    expect(r.filled).toHaveLength(3);
    expect(r.notHere).toEqual(['A question on another page']);
    expect((document.getElementById('why') as HTMLTextAreaElement).value).toBe('Because clean energy matters to me.');
    expect((document.getElementById('sea') as HTMLSelectElement).value).toBe('No');
    const file = (document.getElementById('id_cover_letter') as HTMLInputElement).files![0];
    expect(file.name).toBe('Cover Letter.pdf');
    expect(file.type).toBe('application/pdf');
  }, 30000);
});

describe('the Autopilot box', () => {
  it('copies the prompt, previews the pasted reply, and fills it', async () => {
    let copied = '';
    let sent: { label: string; text: string }[] = [];
    const tr = detailsRow(job, 'needs', () => {}, {
      copy: async (t) => void (copied = t),
      fill: async (_id, answers) => {
        sent = answers;
        return { ok: true, filled: answers.map((a) => a.label), failed: [], missing: [] };
      },
    });
    document.body.innerHTML = '<table><tbody></tbody></table>';
    document.querySelector('tbody')!.appendChild(tr);
    (tr.querySelector('.copy-claude') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(copied).toContain('[3]');
    const reply = tr.querySelector('.claude-reply') as HTMLTextAreaElement;
    reply.value = '[1]\nDear Hiring Team,\n[2]\nI love it.\n[3]\nNo';
    reply.dispatchEvent(new Event('input'));
    expect(tr.querySelectorAll('.claude-preview li')).toHaveLength(3);
    const fill = tr.querySelector('.fill-claude') as HTMLButtonElement;
    expect(fill.disabled).toBe(false);
    fill.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((a) => a.text)).toEqual(['Dear Hiring Team,', 'I love it.', 'No']);
    expect(tr.querySelector('.claude-msg')!.textContent).toMatch(/Filled 3 of 3/);
  });
});
