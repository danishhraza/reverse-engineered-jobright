import { resolveProfile } from '../profile/merge';
import { dataUrlToFile, getAccount, getLearned, getResume, getSettings, getStore } from '../profile/storage';
import { getLlm } from '../queue/store';
import { profileFacts } from '../llm/facts';
import type { AiAsk } from '../engine/fill';
import type { Answer, Profile, Settings } from '../types';

// Everything a fill needs, loaded from storage: the profile (with the saved
// job-site login), its resume file, learned answers, settings, and the AI hook.

export interface FillSetup {
  profileId: string;
  profile: Profile;
  resume?: File;
  learned: Answer[];
  settings: Settings;
  ai?: AiAsk;
}

/** `profileId` may be an id or a profile name ("Product"); unknown or blank = the active profile. */
export async function loadSetup(profileId?: string): Promise<FillSetup | { error: string }> {
  const [store, settings, learned, account, llm] = await Promise.all([getStore(), getSettings(), getLearned(), getAccount(), getLlm()]);
  if (!store?.profiles.length) return { error: 'No profiles yet — import them in Options' };
  const wanted = profileId?.trim().toLowerCase();
  const entry =
    store.profiles.find((p) => p.id === profileId) ??
    (wanted ? store.profiles.find((p) => p.name.toLowerCase() === wanted || p.id.toLowerCase() === wanted) : undefined) ??
    store.profiles.find((p) => p.id === settings.activeProfileId) ??
    store.profiles[0];
  const profile: Profile = { ...resolveProfile(store, entry.id), account };
  const stored = await getResume(entry.id);
  return {
    profileId: entry.id,
    profile,
    resume: stored ? dataUrlToFile(stored) : undefined,
    learned,
    settings,
    ai: llm.enabled && llm.apiKey ? aiFor(profile) : undefined,
  };
}

function aiFor(profile: Profile): AiAsk {
  const facts = profileFacts(profile);
  const ask: AiAsk = async (q) => {
    const job = [document.title, location.hostname].filter(Boolean).join(' — ');
    const r: { answer?: string; confidence?: number; error?: string } | undefined = await chrome.runtime.sendMessage({ type: 'aiAsk', q, facts, job });
    if (r?.error) throw new Error(r.error);
    return r?.answer ? { answer: r.answer, confidence: r.confidence ?? 0 } : null;
  };
  // What the fill did with the answer, for the job's AI log.
  ask.decided = (question, decision) => void chrome.runtime.sendMessage({ type: 'aiDecided', question, decision }).catch(() => {});
  // Which options a skills box offered to add: one call for the whole box.
  ask.pickSkills = async (req) => {
    const r: { picks?: { query: string; option: string }[]; error?: string } | undefined = await chrome.runtime.sendMessage({ type: 'aiSkills', req });
    return r?.picks ?? null;
  };
  return ask;
}
