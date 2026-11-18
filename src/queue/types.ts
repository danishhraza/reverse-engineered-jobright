// Autopilot: a queue of job links applied to one at a time in a runner tab.

export type JobStatus =
  /** Waiting its turn. */
  | 'queued'
  /** Being applied to right now. */
  | 'running'
  /** Stopped on something only you can do (code, CAPTCHA, a question). Its tab is kept open. */
  | 'needs-you'
  /** Filled up to Submit; waiting for you to review and submit (review mode). */
  | 'ready'
  | 'applied'
  /** Closed posting, LinkedIn Easy Apply, already applied elsewhere… */
  | 'skipped'
  | 'failed';

export interface QueueJob {
  id: string;
  url: string;
  company?: string;
  title?: string;
  /** Profile name or id from the CSV ("Product"); blank = the active profile. */
  profile?: string;
  status: JobStatus;
  /** Why it needs you / was skipped / failed. */
  reason?: string;
  /** Where to carry on from: the page it stopped on. */
  resumeUrl?: string;
  /** The tab kept open for you (needs-you / ready). */
  tabId?: number;
  /** Continue ahead of the rest of the queue (you pressed Continue). */
  priority?: boolean;
  attempts: number;
  addedAt: number;
  updatedAt: number;
  startedAt?: number;
  appliedAt?: number;
  /** Ready jobs: when it will be submitted for you if you haven't (review mode with a time limit). */
  submitAt?: number;
  /** AI calls made while applying: count, tokens, and dollars when OpenRouter reports them. */
  ai?: { calls: number; tokensIn: number; tokensOut: number; cost: number };
  /** Last few things the runner did, newest last. */
  log: string[];
}

export interface AutopilotSettings {
  /** Stop starting new jobs after this many in a day. */
  dailyCap: number;
  /** Pause between jobs, randomised in this range (seconds). */
  delayMinSec: number;
  delayMaxSec: number;
  /** Give up on a job after this long and hand it to you. */
  jobTimeoutMin: number;
  /** Pause the queue when this many tabs are waiting on you. */
  maxHeldTabs: number;
  /** Press Submit yourself (review mode) unless this is on. */
  autoSubmit: boolean;
  /** Review mode: submit a Ready application yourself within this many minutes, or it's submitted for you. 0 = never. */
  autoSubmitAfterMin: number;
}

export const DEFAULT_AUTOPILOT: AutopilotSettings = {
  dailyCap: 100,
  delayMinSec: 30,
  delayMaxSec: 75,
  jobTimeoutMin: 10,
  maxHeldTabs: 12,
  autoSubmit: false,
  autoSubmitAfterMin: 0,
};

export interface LlmSettings {
  enabled: boolean;
  /** OpenRouter key; kept in this browser's local storage only. */
  apiKey?: string;
  model: string;
  /** Answers that always apply ("No relatives at the company…"), given to the model with every question. */
  standing: string;
}

export const DEFAULT_LLM: LlmSettings = {
  enabled: true,
  model: 'anthropic/claude-haiku-5.5[1m]',
  standing: [
    'I do not have any relatives, close friends or household members working at the company or its clients.',
    'I have never worked for the company, its subsidiaries or its clients before, and I am not a current employee there.',
  ].join('\n'),
};

/** The runner's own state, kept in storage so it survives the service worker restarting. */
export interface RunnerState {
  running: boolean;
  /** Paused because too many tabs are waiting on you, the daily cap was hit, etc. */
  pausedReason?: string;
  /** The tab jobs are opened in. */
  tabId?: number;
  /** The window that tab lives in. */
  windowId?: number;
  currentJobId?: string;
  /** Increments each step so late results from an old step are ignored. */
  step: number;
  /** Steps taken on the current job (loop guard). */
  jobSteps: number;
  /** Recent step fingerprints for the current job, to spot being stuck. */
  seen: string[];
  /** A step sent to a page and not answered yet; no new step starts until it is (or its frame reloads). */
  inFlight?: { step: number; frameId: number; since: number };
  /** When probes started finding nothing / a loading page (waiting for a redirect). */
  waitSince?: number;
  /** Page fingerprints the AI was already asked about (once each). */
  guided?: string[];
  /** The page a job was continued on: fill only empty fields there (keep your fixes). */
  keepUrl?: string;
  /** yyyy-mm-dd -> jobs started that day. */
  startedByDay: Record<string, number>;
}

export const INITIAL_RUNNER: RunnerState = { running: false, step: 0, jobSteps: 0, seen: [], startedByDay: {} };

export type ProbeKind = 'captcha' | 'verify' | 'blocker' | 'account' | 'form' | 'applied' | 'apply' | 'closed' | 'loading' | 'none';

/** What a frame sees, without changing anything (content script -> background). */
export interface Probe {
  kind: ProbeKind;
  /** Short text for the queue log ("Apply now"). */
  detail?: string;
  /** Changes when the page meaningfully changes (stuck detection). */
  sig: string;
}

/** Most important first: the background acts on the frame whose probe ranks highest. */
export const PROBE_RANK: ProbeKind[] = ['captcha', 'verify', 'blocker', 'account', 'form', 'applied', 'apply', 'closed', 'loading', 'none'];

/** What one step on a page found or did (content script -> background). */
export type StepOutcome =
  /** Clicked something (Apply, Sign in, Create account); the page will change. */
  | {
      kind: 'acted';
      action: string;
      /** Open this URL in the job's tab (an Apply link). */
      navigate?: string;
      /** We just created (or found) an account on this site. */
      accountCreated?: boolean;
    }
  /** Needs you: verification code, CAPTCHA, questions it couldn't answer… */
  | { kind: 'needs-you'; reason: string }
  /** Filled up to the Submit step (review mode). */
  | { kind: 'ready'; reason: string }
  | { kind: 'applied'; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }
  /** Nothing to do in this frame (no form, no Apply button). */
  | { kind: 'nothing' };
