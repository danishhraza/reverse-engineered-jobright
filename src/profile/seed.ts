import { validateStore } from './merge';
import { getAccount, getSettings, setAccount, setResume, setSettings, setStore } from './storage';

// Imports the profile, resumes and login email bundled at build time
// (dist/seed/, see scripts/build.mjs), so you don't attach them by hand.
// Runs on install and every reload; does nothing when the bundle hasn't
// changed since the last import. The profile JSON on disk wins over edits
// made in Options.

interface Seed {
  version: string;
  profiles: string;
  /** profile id -> original file name */
  resumes: Record<string, string>;
  account?: { email?: string; username?: string };
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
  if (seed.account?.email) {
    const a = await getAccount();
    // Only fill in what's missing; a password is never bundled.
    if (!a.email) await setAccount({ ...a, email: seed.account.email, username: a.username ?? seed.account.username });
  }
  await chrome.storage.local.set({ seedVersion: seed.version });
}
