import { run, runSingle } from '../src/engine/run';
import type { FillReport } from '../src/types';
import { exampleProfile } from './helpers';

const base = { profile: exampleProfile('swe'), learned: [], learn: false, onReport: () => {} };
const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

beforeEach(() => {
  document.body.innerHTML = `
    <form>
      <div class="field"><label for="fn">First Name</label><input id="fn"></div>
      <div class="field"><label for="ln">Last Name</label><input id="ln"></div>
      <div class="field"><label for="em">Email</label><input id="em" type="email"></div>
      <fieldset><legend>Will you now or in the future require sponsorship?</legend>
        <label><input type="radio" name="sp" value="y"> Yes</label>
        <label><input type="radio" name="sp" value="n"> No</label></fieldset>
      <div class="field"><label id="jd-l">Job Description</label><div id="jd" contenteditable="true" aria-labelledby="jd-l"></div></div>
    </form>`;
});

describe('only empty fields', () => {
  it("leaves values the site (or you) already filled", async () => {
    (document.getElementById('fn') as HTMLInputElement).value = 'Danny';
    const report = await run({ ...base, overwrite: false, autoAdvance: false });
    expect(val('fn')).toBe('Danny');
    expect(val('ln')).toBe('Example');
    expect(report.fields.find((f) => f.label === 'First Name')?.status).toBe('skipped');
  });
});

describe('just the field I clicked', () => {
  it('fills only that field, even if it already has a value', async () => {
    const em = document.getElementById('em') as HTMLInputElement;
    em.value = 'old@example.com';
    const report = await runSingle(base, em);
    expect(em.value).toBe('alex@example.com');
    expect(val('fn')).toBe('');
    expect(val('ln')).toBe('');
    expect(report.fields).toHaveLength(1);
  });

  it('works when you clicked one option of a radio group', async () => {
    const yesRadio = document.querySelector('input[value=y]') as HTMLInputElement;
    await runSingle(base, yesRadio.parentElement!);
    expect((document.querySelector('input[value=n]') as HTMLInputElement).checked).toBe(true);
    expect(val('fn')).toBe('');
  });

  it('says so when the click was not on a field', async () => {
    let last: FillReport | undefined;
    await runSingle({ ...base, onReport: (r) => (last = r) }, document.querySelector('form')!);
    expect(last?.fields).toEqual([]);
    expect(last?.message).toMatch(/Couldn't find a form field/);
    expect(val('fn')).toBe('');
  });
});

describe('job description', () => {
  it('keeps one bullet per line in a rich-text editor', async () => {
    await runSingle(base, document.getElementById('jd')!);
    const jd = document.getElementById('jd')!;
    expect(Array.from(jd.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['• Built things.', '• Fixed other things.']);
  });
});

describe('before you press Fill', () => {
  it('detects a form without changing the page', async () => {
    const { looksLikeForm } = await import('../src/engine/fields');
    const before = document.body.innerHTML;
    expect(looksLikeForm()).toBe(true);
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector('[data-rej-id]')).toBeNull();
    document.body.innerHTML = '<input type="search"><a href="/jobs">Jobs</a>';
    expect(looksLikeForm()).toBe(false);
  });
});
