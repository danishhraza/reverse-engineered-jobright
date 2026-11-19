import { DEFAULT_AUTOPILOT, DEFAULT_LLM, INITIAL_RUNNER, type AutopilotSettings, type LlmSettings, type QueueJob, type RunnerState } from './types';

// Storage for autopilot (chrome.storage.local):
//   queue          QueueJob[]
//   runner         RunnerState
//   autopilot      AutopilotSettings
//   llm            LlmSettings (OpenRouter key: plain text in this browser only)
//   siteAccounts   { [host]: number }  when we created an account on that site
//   aiAnswers      { [question key]: { answer, confidence } }  answers reused across applications
//
// Only the background writes the queue and runner state; pages ask it to by
// message. Writes go through one promise chain so two updates can't overwrite
// each other.

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` after every earlier locked update has finished. */
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function get<T>(key: string, fallback: T): Promise<T> {
  const v = (await chrome.storage.local.get(key))[key];
  return (v as T | undefined) ?? fallback;
}

export const getQueue = () => get<QueueJob[]>('queue', []);
export const saveQueue = (queue: QueueJob[]) => chrome.storage.local.set({ queue });

export async function getRunner(): Promise<RunnerState> {
  return { ...INITIAL_RUNNER, ...(await get<Partial<RunnerState>>('runner', {})) };
}
export const saveRunner = (runner: RunnerState) => chrome.storage.local.set({ runner });

export async function getAutopilot(): Promise<AutopilotSettings> {
  return { ...DEFAULT_AUTOPILOT, ...(await get<Partial<AutopilotSettings>>('autopilot', {})) };
}
export async function setAutopilot(patch: Partial<AutopilotSettings>): Promise<AutopilotSettings> {
  const next = { ...(await getAutopilot()), ...patch };
  await chrome.storage.local.set({ autopilot: next });
  return next;
}

export async function getLlm(): Promise<LlmSettings> {
  const s = { ...DEFAULT_LLM, ...(await get<Partial<LlmSettings>>('llm', {})) };
  // An earlier default carried a "[1m]" suffix that isn't part of the OpenRouter model id.
  return { ...s, model: s.model.replace(/\[1m\]$/, '') };
}
export async function setLlm(patch: Partial<LlmSettings>): Promise<LlmSettings> {
  const next = { ...(await getLlm()), ...patch };
  await chrome.storage.local.set({ llm: next });
  return next;
}

export async function accountCreatedOn(host: string): Promise<boolean> {
  return !!(await get<Record<string, number>>('siteAccounts', {}))[host];
}
export async function markAccountCreated(host: string): Promise<void> {
  const all = await get<Record<string, number>>('siteAccounts', {});
  all[host] = Date.now();
  await chrome.storage.local.set({ siteAccounts: all });
}

export interface CachedAnswer {
  answer: string;
  confidence: number;
}
export const getAiAnswers = () => get<Record<string, CachedAnswer>>('aiAnswers', {});
export async function saveAiAnswer(key: string, a: CachedAnswer): Promise<void> {
  const all = await getAiAnswers();
  all[key] = a;
  await chrome.storage.local.set({ aiAnswers: all });
}

/** Local date as yyyy-mm-dd (the daily cap resets at local midnight). */
export function today(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
