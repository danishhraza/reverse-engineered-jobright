import { validateStore } from './merge';
import { getAccount, getSettings, setAccount, setResume, setSettings, setStore } from './storage';
import { setLlm } from '../queue/store';

// Imports the profile, resumes, job-site login and OpenRouter key bundled at
// build time (dist/seed/, from gitignored files; see scripts/build.mjs), so
// you don't attach or type them by hand.
// Runs on install and every reload; does nothing when the bundle hasn't
// changed since the last import. The profile JSON on disk wins over edits
// made in Options.

interface Seed {
  version: string;
  profiles: string;
  /** profile id -> original file name */
  resumes: Record<string, string>;
  account?: { email?: string; username?: string; password?: string; openrouterKey?: string; model?: string };
}

const url = (p: string) => chrome.runtime.getURL(`seed/${p}`);

function toDataUrl(buf: ArrayBuffer, type: string): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

export async function importSeed(): Promise<void> {
  let seed: Seed;
  try {
    const r = await fetch(url('seed.json'));
    if (!r.ok) return;
    seed = await r.json();
  } catch {
    return; // built without a seed
  }
  const { seedVersion } = await chrome.storage.local.get('seedVersion');
  if (seedVersion === seed.version) return;

  const store = validateStore(await (await fetch(url(seed.profiles))).json());
  await setStore(store);
  const settings = await getSettings();
  if (!settings.activeProfileId || !store.profiles.some((p) => p.id === settings.activeProfileId)) await setSettings({ activeProfileId: store.profiles[0].id });

  for (const [id, name] of Object.entries(seed.resumes)) {
    const buf = await (await fetch(url(`${id}.pdf`))).arrayBuffer();
    await setResume(id, { name, type: 'application/pdf', dataUrl: toDataUrl(buf, 'application/pdf') });
  }
  // profiles/account.json is the source of truth for whatever it sets (like the profile JSON):
  // login email / user name / password, and the OpenRouter key and model.
  const acc = seed.account;
  if (acc) {
    const a = await getAccount();
    await setAccount({
      ...a,
      email: acc.email || a.email,
      username: acc.username || a.username,
      password: acc.password || a.password,
    });
    if (acc.openrouterKey || acc.model) {
      await setLlm({
        ...(acc.openrouterKey ? { apiKey: acc.openrouterKey, enabled: true } : {}),
        ...(acc.model ? { model: acc.model } : {}),
      });
    }
  }
  await chrome.storage.local.set({ seedVersion: seed.version });
}
