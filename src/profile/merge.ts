import type { DeepPartial, Profile, ProfileStore } from '../types';

const EMPTY: Profile = {
  personal: { firstName: '', lastName: '', email: '', phone: '' },
  education: [],
  work: [],
  skills: [],
  eeo: { workAuth: {} },
  preferences: {},
  answers: [],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Objects merge recursively; arrays and scalars in `over` replace `base`. */
export function deepMerge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v as never) : v;
  }
  return out as T;
}

/** The effective profile for one resume: EMPTY <- base <- overrides. Answer banks concatenate. */
export function resolveProfile(store: ProfileStore, id: string): Profile {
  const entry = store.profiles.find((p) => p.id === id);
  if (!entry) throw new Error(`No profile with id "${id}"`);
  const withBase = deepMerge(EMPTY, store.base);
  const merged = deepMerge(withBase, entry.overrides);
  merged.answers = [...(entry.overrides.answers ?? []), ...(store.base.answers ?? [])] as Profile['answers'];
  return merged;
}

export function validateStore(data: unknown): ProfileStore {
  if (!isPlainObject(data)) throw new Error('Profile file must be a JSON object');
  if (data.version !== 1) throw new Error('Expected "version": 1');
  if (!isPlainObject(data.base)) throw new Error('Missing "base" object');
  if (!Array.isArray(data.profiles) || data.profiles.length === 0) throw new Error('"profiles" must be a non-empty array');
  const ids = new Set<string>();
  for (const p of data.profiles) {
    if (!isPlainObject(p) || typeof p.id !== 'string' || typeof p.name !== 'string')
      throw new Error('Each profile needs a string "id" and "name"');
    if (ids.has(p.id)) throw new Error(`Duplicate profile id "${p.id}"`);
    ids.add(p.id);
    if (p.overrides !== undefined && !isPlainObject(p.overrides)) throw new Error(`Profile "${p.id}": "overrides" must be an object`);
    p.overrides ??= {};
  }
  return data as unknown as ProfileStore;
}
