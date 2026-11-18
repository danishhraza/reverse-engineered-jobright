import { looksLikeForm, scanFields } from '../engine/fields';
import { classify } from '../engine/answers';
import { cleanText, isVisible, realClick, sleep, squash, waitFor, waitForSettle } from '../engine/dom';
import { applyButton, buttonText, submitButton } from '../engine/nav';
import { isRunning, run } from '../engine/run';
import type { FillReport } from '../types';
import type { Probe, StepOutcome } from '../queue/types';
import { loadSetup } from './context';
import { candidates, findBlocker, looksLoading, markTried } from './blockers';

// Autopilot, page side. The background asks every frame what it sees
// (probe), picks the frame that matters, and asks it to take one step: click
// Apply, sign in / create the account, or fill the form up to Submit.

const APPLIED = /thank you for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received|complete)|you('ve| have) (already |successfully )?applied|successfully (applied|submitted)|we('ve| have) received your application/i;
const CLOSED = /no longer (accepting applications|available|active|open)|(position|job|posting|requisition|vacancy) (has been |is )?(filled|closed|expired|removed|no longer)|this job (has )?expired|job (is )?not found|page (you('re| are) looking for )?(was )?not found|page (doesn.?t|does not) exist/i;
const VERIFY = /(verify|confirm|activate) your (email|e-mail|account|identity)|verification (code|link|email)|enter the (\d+[- ]digit )?(code|passcode)|one[- ]time (pass)?code|we('ve| have)? (just )?(sent|emailed) (you )?(an? )?(email|code|link|verification)|check your (email|inbox)/i;
const HUMAN = /verify (that )?you are (a )?human|are you a robot|press (&|and) hold|complete the security check|verifying you are human/i;

function pageText(): string {
  return (document.body?.innerText || document.body?.textContent || '').slice(0, 40000);
}

function passwordBox(): HTMLInputElement | undefined {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).find((i) => isVisible(i) && !i.disabled);
}

function captchaVisible(text: string): boolean {
  const frames = Array.from(
    document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"], iframe[title*="captcha" i]',
    ),
  );
  const shown = frames.some((f) => {
    if (/size=invisible/.test(f.src) || !isVisible(f)) return false;
    const r = f.getBoundingClientRect();
    // (No layout at all means a test DOM; a real visible frame always has a size.)
    return (r.width === 0 && r.height === 0) || (r.width >= 30 && r.height >= 30);
  });
  return shown || HUMAN.test(text);
}

/** How many fields here ask for things an application asks (name, email, phone, resume…). */
function applicationScore(): number {
  const keys = new Set(['firstName', 'lastName', 'fullName', 'email', 'phone', 'resume', 'linkedin', 'address1', 'city', 'school', 'currentCompany']);
  let n = 0;
  for (const f of scanFields()) {
    if (f.kind === 'file') n++;
    else if (keys.has(classify(f, [], [])?.key ?? '')) n++;
  }
  return n;
}

/** Read-only look at the page (besides stamping field ids, which is harmless once the page has loaded). */
export function probe(): Probe {
  const text = pageText();
  const sig = `${location.href}|${squash(cleanText(document.querySelector('h1, h2'))).slice(0, 80)}|${document.querySelectorAll('input, select, textarea').length}`;
  if (captchaVisible(text)) return { kind: 'captcha', sig };
  const blocker = findBlocker();
  if (blocker) return { kind: 'blocker', sig: `${sig}|${blocker.label}`, detail: `${blocker.kind === 'cookie' ? 'Cookie banner' : 'Pop-up'}: "${blocker.label}"` };
  const pw = passwordBox();
  const formy = !pw && looksLikeForm() && applicationScore() >= 2;
  if (!pw && !formy && VERIFY.test(text)) return { kind: 'verify', sig, detail: squash(VERIFY.exec(text)?.[0] ?? '') };
  if (pw) return { kind: 'account', sig };
  if (formy) return { kind: 'form', sig };
  if (APPLIED.test(text)) return { kind: 'applied', sig, detail: squash(APPLIED.exec(text)?.[0] ?? '') };
  const apply = applyButton();
  if (apply) return { kind: 'apply', sig, detail: buttonText(apply) };
  if (CLOSED.test(text)) return { kind: 'closed', sig, detail: squash(CLOSED.exec(text)?.[0] ?? '') };
  // A form without the usual fields (a short custom form): still worth filling.
  if (looksLikeForm()) return { kind: 'form', sig };
  if (looksLoading(text)) return { kind: 'loading', sig };
  return { kind: 'none', sig };
}

export interface StepRequest {
  profileId?: string;
  autoSubmit: boolean;
  /** We already created an account on this site. */
  accountKnown: boolean;
  /** 'guide': the rules are stuck here; ask the AI which button moves the application on. */
  mode?: 'guide';
  /** You fixed things on this page and pressed Continue: fill only empty fields. */
  onlyEmpty?: boolean;
}

export async function step(req: StepRequest, onReport: (r: FillReport) => void): Promise<StepOutcome> {
  if (isRunning()) return { kind: 'acted', action: 'A fill is already running here — waiting' };
  await waitForSettle(400, 4000);
  if (req.mode === 'guide') return guideStep();
  const p = probe();
  if (p.kind === 'blocker') return blockerStep();
  if (p.kind === 'account') return accountStep(req, onReport);
  if (p.kind === 'form') return formStep(req, onReport);
  if (p.kind === 'apply') return applyStep();
  return { kind: 'nothing' };
}

/** Click `el`; an ordinary link is opened by the background instead (script clicks can't open new tabs). */
function press(el: HTMLElement, what: string): StepOutcome {
  const a = el.closest('a');
  if (a?.href && /^https?:/.test(a.href) && (a.target === '_blank' || !a.getAttribute('onclick'))) return { kind: 'acted', action: `Opened "${what}"`, navigate: a.href };
  realClick(el);
  return { kind: 'acted', action: `Clicked "${what}"` };
}

// ---------- Pop-ups and banners ----------

function blockerStep(): StepOutcome {
  const b = findBlocker();
  if (!b) return { kind: 'nothing' };
  markTried(b.button);
  realClick(b.button);
  return { kind: 'acted', action: `${b.kind === 'cookie' ? 'Cookie banner' : 'Pop-up'}: pressed "${b.label}"` };
}

// ---------- Apply button ----------

function applyStep(): StepOutcome {
  const btn = applyButton();
  if (!btn) return { kind: 'nothing' };
  const text = buttonText(btn);
  if (/linkedin\.com$/.test(location.hostname) && /easy apply/i.test(text)) return { kind: 'skipped', reason: "LinkedIn Easy Apply isn't automated (against LinkedIn's terms)" };
  return press(btn, text);
}

// ---------- The AI picks the button ----------

async function guideStep(): Promise<StepOutcome> {
  const { els, list } = candidates();
  if (!list.length) return { kind: 'needs-you', reason: 'Nothing on this page to click — check it, then press Continue' };
  const text = squash(pageText()).slice(0, 2500);
  const r: { choice?: number; confidence?: number; reason?: string; error?: string } | undefined = await chrome.runtime
    .sendMessage({ type: 'aiGuide', page: { url: location.href, title: document.title, text, buttons: list } })
    .catch((e: Error) => ({ error: e.message }));
  if (r?.error) return { kind: 'needs-you', reason: `Stuck here, and the AI couldn't help: ${r.error}` };
  const el = r?.choice !== undefined && r.choice >= 0 ? els[r.choice] : undefined;
  if (!el || (r?.confidence ?? 0) < 0.6) return { kind: 'needs-you', reason: `Stuck here. AI: ${r?.reason ?? 'no good option'}` };
  const out = press(el, list[r!.choice!].text);
  return out.kind === 'acted' ? { ...out, action: `AI: ${out.action} — ${r?.reason ?? ''}` } : out;
}

// ---------- Sign in / create account ----------

const SIGNUP_LINK = /^(create (an |your |new )?account|sign ?up|register( now| here)?|new user\??|create (a )?profile|join now|don'?t have an account\??.*)$/i;
const SIGNIN_LINK = /^(sign ?in|log ?in|already (have an account|registered)\??.*|existing user\??)$/i;
const ACCOUNT_SUBMIT = /^(create (an |my )?account|sign ?up|register|sign ?in|log ?in|continue|next|submit|verify|create profile|get started)$/i;
const EXISTS = /(already (exists|registered|in use|taken|associated)|account (with this|already) .*exist|email (address )?is (already )?(registered|in use|taken))/i;
const BAD_LOGIN = /(invalid|incorrect|wrong|unrecognized) (e-?mail|user ?name|password|credentials|login)|(e-?mail|user ?name) or password (is|are|was)? ?(invalid|incorrect)|could not sign you in|sign[- ]in failed/i;

function clickables(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"]')).filter(
    (b) => !b.closest('.rej-ui') && isVisible(b),
  );
}

function isSignupForm(): boolean {
  const pws = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter((i) => isVisible(i));
  if (pws.length >= 2) return true;
  const heading = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, legend, [role="heading"]'))
    .filter((h) => isVisible(h))
    .map((h) => cleanText(h))
    .join(' ');
  return /create (an |your )?account|sign ?up|register|new (user|candidate) account/i.test(heading);
}

async function accountStep(req: StepRequest, onReport: (r: FillReport) => void): Promise<StepOutcome> {
  const setup = await loadSetup(req.profileId);
  if ('error' in setup) return { kind: 'failed', reason: setup.error };
  const acct = setup.profile.account;
  if (!acct?.email || !acct.password) return { kind: 'needs-you', reason: 'Sign-in needed — save your job-site login in Options → Job site login' };
  const text = pageText();
  const signup = isSignupForm();

  if (signup && EXISTS.test(text)) {
    const link = clickables().find((b) => SIGNIN_LINK.test(buttonText(b)));
    if (link) {
      realClick(link);
      return { kind: 'acted', action: 'Account already exists — going to Sign in', accountCreated: true };
    }
    return { kind: 'needs-you', reason: 'An account already exists here — sign in yourself, then press Continue' };
  }
  if (!signup && BAD_LOGIN.test(text)) {
    return { kind: 'needs-you', reason: "Sign-in failed with the saved password — sign in or reset it, then press Continue" };
  }
  // A sign-in page on a site where we haven't made an account yet: go to Create account.
  if (!signup && !req.accountKnown) {
    const link = clickables().find((b) => SIGNUP_LINK.test(buttonText(b)));
    if (link) {
      realClick(link);
      return { kind: 'acted', action: `Clicked "${buttonText(link)}"` };
    }
  }

  const report = await run({
    profile: setup.profile,
    learned: setup.learned,
    overwrite: true,
    autoAdvance: false,
    learn: false,
    agreeToTerms: true, // a sign-up form can't be sent without accepting the site's terms
    autopilot: true,
    ai: setup.ai,
    onReport,
  });
  const blocking = report.fields.filter((f) => f.status === 'flagged' && f.required);
  if (blocking.length) return { kind: 'needs-you', reason: `Account form: ${blocking.map((f) => `"${f.label}"`).join(', ')} need you` };

  const form = passwordBox()?.closest('form') ?? document;
  const submit =
    Array.from(form.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"], a')).find((b) => isVisible(b) && ACCOUNT_SUBMIT.test(buttonText(b))) ??
    clickables().find((b) => ACCOUNT_SUBMIT.test(buttonText(b)));
  if (!submit) return { kind: 'needs-you', reason: "Filled the sign-in form but couldn't find its button" };
  realClick(submit);
  return { kind: 'acted', action: `${signup ? 'Created account' : 'Signed in'} ("${buttonText(submit)}")`, accountCreated: signup || undefined };
}

// ---------- Application form ----------

async function formStep(req: StepRequest, onReport: (r: FillReport) => void): Promise<StepOutcome> {
  const setup = await loadSetup(req.profileId);
  if ('error' in setup) return { kind: 'failed', reason: setup.error };
  const report = await run({
    profile: setup.profile,
    resume: setup.resume,
    learned: setup.learned,
    overwrite: true,
    requiredOnly: req.onlyEmpty,
    autoAdvance: true,
    learn: false,
    autopilot: true,
    agreeToTerms: req.autoSubmit,
    ai: setup.ai,
    onReport,
  });
  const flagged = report.fields.filter((f) => f.status === 'flagged');
  const blocking = flagged.filter((f) => f.required);
  // With the reason, so the queue says *why* ("First Name" (value didn't stick)).
  const names = (rows: typeof flagged) =>
    rows
      .slice(0, 3)
      .map((f) => `"${f.label.slice(0, 50)}"${f.reason ? ` (${f.reason.slice(0, 60)})` : ''}`)
      .join(', ') + (rows.length > 3 ? ` +${rows.length - 3} more` : '');
  switch (report.stop) {
    case 'cancelled':
      return { kind: 'failed', reason: 'Stopped' };
    case 'blocked':
      return blocking.length
        ? { kind: 'needs-you', reason: `${blocking.length} required question(s) need you: ${names(blocking)}` }
        : { kind: 'needs-you', reason: report.message ?? 'Something required on this page is still missing' };
    case 'errors':
      return { kind: 'needs-you', reason: 'The page shows errors after Next — fix them, then press Continue' };
    case 'not-moved':
      return { kind: 'needs-you', reason: "Pressed Next but the page didn't change — check it, then press Continue" };
    case 'max-pages':
      return { kind: 'needs-you', reason: 'Went through 10 pages without reaching Submit' };
  }
  const final = report.stop === 'final' || !!submitButton();
  if (!final) {
    return blocking.length
      ? { kind: 'needs-you', reason: `${blocking.length} required question(s) need you: ${names(blocking)}` }
      : { kind: 'needs-you', reason: "Filled this page but couldn't find Next or Submit" };
  }
  if (!req.autoSubmit) {
    return { kind: 'ready', reason: flagged.length ? `Ready to submit — check ${names(flagged)}` : 'Ready to submit — review and press Submit' };
  }
  if (flagged.length) return { kind: 'needs-you', reason: `Not auto-submitted: check ${names(flagged)}` };
  return submit();
}

/**
 * A Ready application you didn't submit in time: tick the required "I certify" boxes, fill any
 * required box still empty, and press Submit. Null when this frame has no Submit button.
 */
export async function submitReady(profileId: string | undefined, onReport: (r: FillReport) => void): Promise<StepOutcome | null> {
  if (!submitButton()) return null;
  if (isRunning()) return { kind: 'needs-you', reason: 'A fill was running on the page' };
  const setup = await loadSetup(profileId);
  if ('error' in setup) return { kind: 'needs-you', reason: setup.error };
  const report = await run({
    profile: setup.profile,
    learned: setup.learned,
    overwrite: false,
    requiredOnly: true,
    agreeToTerms: true,
    autoAdvance: false,
    learn: false,
    autopilot: true,
    ai: setup.ai,
    onReport,
  });
  const blocking = report.fields.filter((f) => f.status === 'flagged' && f.required);
  if (blocking.length) return { kind: 'needs-you', reason: `Required: ${blocking.map((f) => `"${f.label.slice(0, 50)}"`).join(', ')}` };
  return submit();
}

async function submit(): Promise<StepOutcome> {
  const btn = submitButton();
  if (!btn) return { kind: 'needs-you', reason: "Couldn't find the Submit button" };
  const before = location.href;
  realClick(btn);
  // "Before submitting, please review this notice… I Agree": press it and keep waiting.
  let pressed = 0;
  const seen = await waitFor(
    () => {
      if (APPLIED.test(pageText())) return 'applied';
      if (location.href !== before) return 'moved';
      const b = pressed < 2 ? findBlocker() : null;
      if (b) {
        pressed++;
        markTried(b.button);
        realClick(b.button);
      }
      return null;
    },
    { timeout: 20000, interval: 400 },
  );
  if (seen === 'applied') return { kind: 'applied', reason: 'Submitted' };
  if (seen === 'moved') {
    await sleep(1500);
    return APPLIED.test(pageText()) ? { kind: 'applied', reason: 'Submitted' } : { kind: 'acted', action: 'Pressed Submit' };
  }
  return { kind: 'needs-you', reason: "Pressed Submit but couldn't see a confirmation — check the page" };
}
