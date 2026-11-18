import { cleanText, isVisible, squash } from './dom';

// Finding the buttons that move an application along on sites without an
// adapter (Taleo, iCIMS, Avature, SuccessFactors…): Next/Continue, Submit,
// Apply. Used by autopilot; manual fills still stop after one page there.

const CLICKABLE = 'button, a, [role="button"], input[type="button"], input[type="submit"]';

export function buttonText(b: HTMLElement): string {
  return squash(cleanText(b) || (b as HTMLInputElement).value || b.getAttribute('aria-label') || '');
}

function visibleButtons(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CLICKABLE)).filter(
    (b) => !b.closest('.rej-ui') && isVisible(b) && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true',
  );
}

const NEXT = /^(next|continue|save (and|&) continue|save (and|&) next|next step|proceed|continue to next step|save and proceed)\b/i;
const NOT_NEXT = /\b(with|linkedin|google|indeed|apple|facebook|microsoft|shopping|reading|later)\b|submit/i;
const SUBMIT = /^(submit( (my |your |the )?application)?|send( my)? application|complete( my)? application|finish( application)?|submit and finish)$/i;
const APPLY =
  /^(apply( now| today| for this (job|position|role|opportunity)| to (this )?(job|position|role)| online| here| manually)?|easy apply|(start|begin|continue)( your| my| an?| the)? application|apply on (the )?company( site|'s site| website)|i'?m interested|submit (an |your )?application|autofill with (resume|cv)|apply (with|using) (my )?(resume|cv)|apply (with|via|using) [\w .]+)$/i;

/**
 * Which Apply-ish button to prefer, best first: fill the form ourselves ("Apply manually"),
 * leave an aggregator for the company site, plain Apply, start the application, the site's
 * own resume parser, apply-through-another-site (Indeed, LinkedIn…), LinkedIn Easy Apply last.
 */
function applyRank(t: string): number {
  if (/manually/i.test(t)) return 0;
  if (/company/i.test(t)) return 1;
  if (/^apply( now| today| for| to| online| here)?\b/i.test(t) && !/ (with|via|using) /i.test(t)) return 2;
  if (/application|interested/i.test(t)) return 3;
  if (/resume|cv/i.test(t)) return 4;
  if (/easy apply/i.test(t)) return 6;
  return 5;
}

/** The Next/Continue button of a multi-page form (the last one on the page, which is usually the footer). */
export function genericNext(): HTMLElement | null {
  const bs = visibleButtons().filter((b) => {
    const t = buttonText(b);
    return t.length <= 40 && NEXT.test(t) && !NOT_NEXT.test(t);
  });
  return bs[bs.length - 1] ?? null;
}

export function submitButton(): HTMLElement | null {
  const bs = visibleButtons().filter((b) => SUBMIT.test(buttonText(b)));
  return bs[bs.length - 1] ?? null;
}

/** On the last step: a Submit button and nothing to go Next to. */
export function genericFinal(): boolean {
  return !!submitButton() && !genericNext();
}

/** The job posting's best Apply button (see applyRank). */
export function applyButton(): HTMLElement | null {
  const bs = visibleButtons().filter((b) => {
    const t = buttonText(b);
    return t.length <= 50 && APPLY.test(t);
  });
  return bs.sort((a, b) => applyRank(buttonText(a)) - applyRank(buttonText(b)))[0] ?? null;
}

/** What identifies the current step of a single-URL multi-step form. */
export function genericSignature(): string {
  const heading = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, legend, [aria-current="step"]')).find((h) => isVisible(h) && cleanText(h));
  const labels = Array.from(document.querySelectorAll<HTMLElement>('label'))
    .filter((l) => isVisible(l))
    .slice(0, 6)
    .map((l) => cleanText(l))
    .join('|');
  return `${location.href}#${cleanText(heading)}#${labels}`;
}
