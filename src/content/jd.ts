import { isVisible } from '../engine/dom';

// The job description on a job page, as plain text: kept on the job so you
// can hand it (with the questions Autopilot couldn't answer) to Claude.

/** Boxes sites put the description in, most specific first. */
const DESCRIPTION_SEL = [
  '[data-automation-id="jobPostingDescription"]', // Workday
  '[itemprop="description"]',
  '[class*="job-description" i], [id*="job-description" i], [class*="jobdescription" i], [id*="jobdescription" i]',
  '[class*="jobdesciption" i]', // (sic) Trakstar
  '[class*="description" i], [id*="description" i]',
  '#content .job, .job-post, .posting, .opening',
].join(', ');

const MAX = 12000;

function textOf(el: HTMLElement): string {
  return (el.innerText || el.textContent || '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The job description here, or '' when this page doesn't show one. */
export function jobDescription(): string {
  let best = '';
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(DESCRIPTION_SEL))) {
    // A form's own help text isn't the description; nor is our panel.
    if (el.closest('.rej-ui, form') || el.querySelector('input:not([type="hidden"]), select, textarea') || !isVisible(el)) continue;
    const t = textOf(el);
    if (t.length > best.length) best = t;
  }
  if (best.length < 400) {
    // No marked-up description: the main text of the page, minus any form.
    const root = document.querySelector<HTMLElement>('main, article, [role="main"]') ?? document.body;
    if (root) {
      const copy = root.cloneNode(true) as HTMLElement;
      for (const x of Array.from(copy.querySelectorAll('form, nav, header, footer, script, style, noscript, .rej-ui'))) x.remove();
      const t = textOf(copy);
      if (t.length > best.length && t.length >= 400) best = t;
    }
  }
  return best.length >= 200 ? best.slice(0, MAX) : '';
}
