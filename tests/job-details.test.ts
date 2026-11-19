import type { QueueJob } from '../src/queue/types';
import { detailsRow, firstTab, needsYou, summaryChips } from '../src/ui/job-details';

// The Autopilot page's job details: unanswered questions pulled out of the
// last page fill, with what the AI suggested, and tabs for the rest.

const job = {
  id: 'j1',
  url: 'https://example.com/apply',
  status: 'needs-you',
  reason: '2 questions need you',
  attempts: 1,
  addedAt: 0,
  updatedAt: 0,
  log: ['10:01 Opened the job', '10:02 Filled 12 fields (AI answered 1)', '10:03 Stuck: required questions left'],
  fillLog: [
    { at: 1, url: 'https://example.com/apply/1', page: 1, fields: [{ label: 'Email', status: 'filled', value: 'a@b.c' }] },
    {
      at: 2,
      url: 'https://example.com/apply/2',
      page: 2,
      fields: [
        { label: 'Phone', status: 'filled', value: '555' },
        { label: 'Years of Python?', status: 'flagged', reason: 'Not sure' },
        { label: 'Work 1: Employer Country', status: 'flagged', reason: 'Not in your profile for this entry' },
      ],
    },
  ],
  aiLog: [{ at: 3, question: 'Years of Python?', answer: '3', confidence: 0.5, decision: 'Only suggested' }],
} as unknown as QueueJob;

describe('Autopilot job details', () => {
  it('lists what the last page left unanswered, with the AI suggestion', () => {
    expect(needsYou(job)).toEqual([
      { label: 'Years of Python?', reason: 'Not sure', value: undefined, ai: '3' },
      { label: 'Work 1: Employer Country', reason: 'Not in your profile for this entry', value: undefined, ai: undefined },
    ]);
    expect(firstTab(job)).toBe('needs');
    expect(summaryChips(job)).toContain('2 unanswered');
  });

  it('shows each kind of log in its own tab', () => {
    const picked: string[] = [];
    const tr = detailsRow(job, 'steps', (t) => picked.push(t));
    expect(Array.from(tr.querySelectorAll('.dtabs button')).map((b) => b.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Needs you 2',
      'Steps 3',
      'Fill log 2',
      'AI log 1',
    ]);
    expect(tr.querySelectorAll('ol.steps li')).toHaveLength(3);
    expect(tr.querySelector('ol.steps li.bad')!.textContent).toContain('Stuck');
    (tr.querySelector('[data-tab="ai"]') as HTMLButtonElement).click();
    expect(picked).toEqual(['ai']);
    expect(detailsRow(job, 'fill', () => {}).querySelectorAll('details.page')).toHaveLength(2);
    expect(detailsRow(job, 'ai', () => {}).textContent).toContain('Only suggested');
  });
});
