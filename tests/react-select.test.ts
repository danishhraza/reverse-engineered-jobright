import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Select from 'react-select';
import { scanFields } from '../src/engine/fields';
import { fillField } from '../src/engine/widgets';

// The real react-select component (as on Wolve and many other sites), not a mock.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const LIVING = [
  'I currently live in the Chicago area',
  'I do not live in Chicago but am willing to relocate',
  'I do not live in Chicago and may consider relocating',
  'I am not open to relocating to Chicago',
];

let picked: string | undefined;

async function mount(options: string[]): Promise<void> {
  document.body.innerHTML = `<form><div class="pad-v-3"><label for="living"><span>Which of the following best describes your current living situation? *</span></label><div id="root"></div></div></form>`;
  picked = undefined;
  const root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(
      createElement(Select, {
        inputId: 'living',
        classNamePrefix: 'react-select',
        options: options.map((o) => ({ value: o, label: o })),
        onChange: (v: { label: string } | null) => (picked = v?.label),
      } as never),
    );
  });
}

describe('react-select through the whole fill (peek options -> AI -> select)', () => {
  it('ends with the AI-chosen option selected', async () => {
    const { run } = await import('../src/engine/run');
    const { exampleProfile } = await import('./helpers');
    await mount(LIVING);
    const seen: string[][] = [];
    const ai = Object.assign(
      async (q: { options: string[] }) => {
        seen.push(q.options);
        return { answer: 'I do not live in Chicago but am willing to relocate', confidence: 0.9 };
      },
      { decided: () => {} },
    );
    const report = await run({ profile: exampleProfile('swe'), learned: [], learn: false, overwrite: true, autoAdvance: false, onReport: () => {}, ai } as never);
    expect(seen[0]).toEqual(LIVING);
    expect(picked).toBe('I do not live in Chicago but am willing to relocate');
    expect(report.fields.find((f) => /living/.test(f.label))).toMatchObject({ status: 'filled' });
  }, 30000);
});

describe('clicking like a real mouse', () => {
  it("doesn't move focus when the page cancels the mousedown (react-select menus do; Wolve's closed on it)", async () => {
    const { realClick } = await import('../src/engine/dom');
    document.body.innerHTML = '<input id="in"><div id="menu"><div id="opt" tabindex="-1">Option</div></div>';
    const input = document.getElementById('in') as HTMLInputElement;
    input.focus();
    document.getElementById('menu')!.addEventListener('mousedown', (e) => e.preventDefault());
    let clicked = false;
    document.getElementById('opt')!.addEventListener('click', () => (clicked = true));
    realClick(document.getElementById('opt')!);
    expect(document.activeElement).toBe(input);
    expect(clicked).toBe(true);
    // Without the cancel, focus moves as with a real click.
    document.body.insertAdjacentHTML('beforeend', '<button id="b">B</button>');
    realClick(document.getElementById('b')!);
    expect(document.activeElement?.id).toBe('b');
  });
});

describe('react-select', () => {
  it('selects an option and reads it back', async () => {
    await mount(LIVING);
    const f = scanFields().find((x) => /living situation/.test(x.label))!;
    expect(f.kind).toBe('combobox');
    const r = await fillField(f, { text: 'I do not live in Chicago but am willing to relocate' }, true);
    expect(picked).toBe('I do not live in Chicago but am willing to relocate');
    expect(r).toMatchObject({ ok: true });
    expect(r.reason ?? '').not.toMatch(/couldn't read it back/);
  }, 20000);
});
