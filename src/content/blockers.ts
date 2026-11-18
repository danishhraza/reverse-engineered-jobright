import { cleanText, isVisible, squash } from '../engine/dom';
import { buttonText } from '../engine/nav';

// Things in the way of an application that aren't part of it: privacy-notice
// pop-ups ("Consent & Continue"), cookie banners, "please wait / redirecting"
// pages. Plus the list of clickable things the AI picks from when the rules
// don't know what to press.

const CLICKABLE = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"]';

const MODAL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .modal.show, .modal.in, .modal[style*="display: block"]';
const COOKIE_BOX = '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="onetrust" i], [class*="onetrust" i], [id*="gdpr" i], [class*="gdpr" i], [id*="truste" i], [class*="cc-window" i], [aria-label*="cookie" i]';

// Cookie banners: the least you can agree to first.
const COOKIE_REJECT = /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|(use )?(only )?(strictly )?(necessary|essential|required)( cookies)?( only)?|continue without accepting|refuse( all)?)$/i;
const CLOSE = /^(close|dismiss|×|✕|x|no,? thanks|not now|maybe later|skip)$/i;
const COOKIE_ACCEPT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|i accept|ok|okay|got it|agree)$/i;
// Notices you must accept to go on (privacy policy, data processing, "before you apply").
const MODAL_GO = /^((i )?(consent|agree|accept)( (&|and) (continue|proceed|apply))?|(accept|agree|consent) (&|and) (continue|close)|continue|proceed|ok|okay|got it|i understand|acknowledge|yes,? continue|start|let'?s go)$/i;
const NEVER = /decline|reject|cancel|withdraw|sign out|log ?out|delete|remove|submit( application)?$/i;

// Buttons already pressed on this page; a banner that ignores the click isn't reported again.
const tried = new WeakSet<HTMLElement>();
export const markTried = (b: HTMLElement) => tried.add(b);

function clickables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CLICKABLE)).filter((b) => !b.closest('.rej-ui') && isVisible(b) && !(b as HTMLButtonElement).disabled);
}

function textInputs(root: ParentNode): number {
  return Array.from(root.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="submit"]):not([type="button"]), textarea, select')).filter((e) =>
    isVisible(e),
  ).length;
}

export interface Blocker {
  kind: 'cookie' | 'modal';
  button: HTMLElement;
  label: string;
}

/** A pop-up or banner covering the page, and the button that gets past it. Null if none (or none we can handle). */
export function findBlocker(): Blocker | null {
  // Pop-ups that aren't forms themselves (an application inside a modal is the form, not a blocker).
  for (const m of Array.from(document.querySelectorAll<HTMLElement>(MODAL))) {
    if (m.closest('.rej-ui') || !isVisible(m) || textInputs(m) > 0) continue;
    const bs = clickables(m).filter((b) => !tried.has(b));
    const cookie = m.matches(COOKIE_BOX) || /cookie/i.test(cleanText(m).slice(0, 400));
    const pick = cookie ? pickCookie(bs) : bs.find((b) => MODAL_GO.test(buttonText(b)) && !NEVER.test(buttonText(b)));
    if (pick) return { kind: cookie ? 'cookie' : 'modal', button: pick, label: buttonText(pick) || pick.getAttribute('aria-label') || 'close' };
  }
  // Cookie banners pinned to the page edge.
  for (const box of Array.from(document.querySelectorAll<HTMLElement>(COOKIE_BOX))) {
    if (box.closest('.rej-ui') || !isVisible(box) || textInputs(box) > 0) continue;
    if (!/cookie|privacy|consent|tracking/i.test(cleanText(box).slice(0, 600))) continue;
    const pick = pickCookie(clickables(box).filter((b) => !tried.has(b)));
    if (pick) return { kind: 'cookie', button: pick, label: buttonText(pick) || pick.getAttribute('aria-label') || 'close' };
  }
  return null;
}

function pickCookie(bs: HTMLElement[]): HTMLElement | undefined {
  const label = (b: HTMLElement) => buttonText(b) || b.getAttribute('aria-label') || b.title || '';
  return bs.find((b) => COOKIE_REJECT.test(label(b))) ?? bs.find((b) => CLOSE.test(label(b))) ?? bs.find((b) => COOKIE_ACCEPT.test(label(b)));
}

const LOADING = /redirect(ing)?|loading|please wait|one moment|just a moment|taking you to|you('re| are) (now )?being|hang tight|almost there|preparing (your )?application|opening/i;

/** A "please wait / redirecting" page that will move on by itself. */
export function looksLoading(text: string): boolean {
  if (document.querySelector('[aria-busy="true"]') && text.length < 2000) return true;
  const spinner = Array.from(document.querySelectorAll('[class*="spinner" i], [class*="loader" i], [class*="loading" i], [role="progressbar"]')).some((e) => isVisible(e));
  if (text.length < 600 && (spinner || LOADING.test(text))) return true;
  return text.length < 3000 && LOADING.test(text.slice(0, 400));
}

// ---------- For the AI: what's on screen and what can be clicked ----------

export interface Candidate {
  i: number;
  text: string;
  kind: string;
  inDialog: boolean;
}

export function candidates(): { els: HTMLElement[]; list: Candidate[] } {
  const els: HTMLElement[] = [];
  const list: Candidate[] = [];
  const seen = new Set<string>();
  for (const el of clickables(document)) {
    const text = squash(buttonText(el) || el.getAttribute('aria-label') || el.title || '').slice(0, 80);
    if (!text) continue;
    const kind = el.tagName === 'A' ? 'link' : el.getAttribute('role') ?? 'button';
    const key = `${kind}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ i: els.length, text, kind, inDialog: !!el.closest(MODAL) });
    els.push(el);
    if (els.length >= 60) break;
  }
  return { els, list };
}
