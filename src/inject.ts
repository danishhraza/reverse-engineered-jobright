import { resolveProfile, validateStore } from './profile/merge';
import { scanFields } from './engine/fields';
import { classify } from './engine/answers';
import { run } from './engine/run';
import type { FillReport } from './types';

// Standalone build of the engine for testing on a live page without the
// extension: paste dist/inject.js into DevTools, then
//   await __rej.fill(storeJson, 'swe')        // fills, never submits
//   __rej.scan()                              // shows what it would classify

declare global {
  interface Window {
    __rej: unknown;
  }
}

window.__rej = {
  scan() {
    return scanFields().map((f) => ({ kind: f.kind, label: f.label, required: f.required, key: classify(f, [], [])?.key }));
  },
  async fill(storeJson: unknown, profileId: string, opts: { autoAdvance?: boolean } = {}) {
    const store = validateStore(typeof storeJson === 'string' ? JSON.parse(storeJson) : storeJson);
    let last: FillReport | undefined;
    await run({
      profile: resolveProfile(store, profileId),
      learned: [],
      overwrite: true,
      autoAdvance: opts.autoAdvance ?? false,
      learn: false,
      onReport: (r) => (last = r),
    });
    return last;
  },
};
