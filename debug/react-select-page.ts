// Debug page: the real react-select plus the extension's fill engine, to watch
// a fill in a real Chromium (the jsdom tests can't show focus/visibility quirks).
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import Select from 'react-select';
import { scanFields } from '../src/engine/fields';
import { fillField } from '../src/engine/widgets';

const LIVING = [
  'I currently live in the Chicago area',
  'I do not live in Chicago but am willing to relocate',
  'I do not live in Chicago and may consider relocating',
  'I am not open to relocating to Chicago',
];

const log: string[] = [];
createRoot(document.getElementById('root')!).render(
  createElement(Select, {
    inputId: 'living',
    classNamePrefix: 'react-select',
    options: LIVING.map((o) => ({ value: o, label: o })),
    onChange: (v: { label: string } | null) => log.push(`onChange: ${v?.label}`),
  } as never),
);

(window as unknown as { __dbg: unknown }).__dbg = {
  log,
  async fill(text: string) {
    const f = scanFields().find((x) => /living situation/.test(x.label))!;
    const r = await fillField(f, { text }, true);
    return { kind: f.kind, result: r, log: [...log], shown: document.querySelector('.react-select__single-value')?.textContent ?? null };
  },
};

// The whole fill, as Autopilot does it: peek the options for the AI, then select its answer.
import { run } from '../src/engine/run';
import { resolveProfile, validateStore } from '../src/profile/merge';
import example from '../profiles/example.json';
(window as unknown as { __dbgRun: unknown }).__dbgRun = async () => {
  const profile = resolveProfile(validateStore(example), 'swe');
  const asked: string[][] = [];
  const ai = Object.assign(
    async (q: { options: string[] }) => {
      asked.push(q.options);
      return { answer: 'I do not live in Chicago but am willing to relocate', confidence: 0.9 };
    },
    { decided: () => {} },
  );
  const report = await run({ profile, learned: [], learn: false, overwrite: true, autoAdvance: false, onReport: () => {}, ai } as never);
  return { asked, log: [...log], shown: document.querySelector('.react-select__single-value')?.textContent ?? null, row: report.fields.find((f) => /living/.test(f.label)) };
};
