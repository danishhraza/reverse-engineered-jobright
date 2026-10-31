import { DEFAULT_SETTINGS, type Answer, type ProfileStore, type Settings } from '../types';

// Everything lives in chrome.storage.local (with unlimitedStorage), so content
// scripts, the side panel and the options page all read the same data.
//   store        ProfileStore
//   settings     Settings
//   learned      Answer[]  answers captured from fields you filled by hand
//   resume:<id>  { name, type, dataUrl }

export interface StoredResume {
  name: string;
  type: string;
  dataUrl: string;
}

export async function getStore(): Promise<ProfileStore | undefined> {
  const { store } = await chrome.storage.local.get('store');
  return store as ProfileStore | undefined;
}

export async function setStore(store: ProfileStore): Promise<void> {
  await chrome.storage.local.set({ store });
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getLearned(): Promise<Answer[]> {
  const { learned } = await chrome.storage.local.get('learned');
  return (learned as Answer[] | undefined) ?? [];
}

export async function setLearned(learned: Answer[]): Promise<void> {
  await chrome.storage.local.set({ learned });
}

export async function addLearned(a: Answer): Promise<void> {
  const list = await getLearned();
  const i = list.findIndex((x) => x.pattern === a.pattern);
  if (i >= 0) list[i] = a;
  else list.push(a);
  await setLearned(list);
}

export async function getResume(profileId: string): Promise<StoredResume | undefined> {
  const key = `resume:${profileId}`;
  const res = await chrome.storage.local.get(key);
  return res[key] as StoredResume | undefined;
}

export async function setResume(profileId: string, resume: StoredResume | null): Promise<void> {
  const key = `resume:${profileId}`;
  if (resume) await chrome.storage.local.set({ [key]: resume });
  else await chrome.storage.local.remove(key);
}

export function dataUrlToFile(r: StoredResume): File {
  const [head, b64] = r.dataUrl.split(',');
  const type = /data:([^;]+)/.exec(head)?.[1] ?? r.type ?? 'application/pdf';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], r.name, { type });
}
