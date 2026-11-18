import { run } from '../src/engine/run';
import type { AiAsk } from '../src/engine/fill';
import { scanFields, stripLabel } from '../src/engine/fields';
import { exampleProfile } from './helpers';

// From an Eightfold application (Micron): every question sits in one big
// "Application questions" fieldset, legal preambles before the question, a
// consent pop-up on Next, custom dropdowns that only show options when open.

const base = { learned: [], learn: false, overwrite: true, onReport: () => {} };
const US_WORKER =
  'Micron is required to comply with federal reporting regulations regarding those who seek employment with the company. We need to know whether you are a U.S. worker. A U.S. worker is defined by the U.S. Department of Labor as a 1) U.S. citizen, 2) U.S. national, 3) U.S. legal permanent resident, 4) refugee, or 5) person granted asylum. Are you in one of the above five groups?';

beforeEach(() => {
  document.body.innerHTML = `
    <form><fieldset><legend>Application questions</legend>
      <div class="q"><div>${US_WORKER} *</div>
        <select id="usw" required><option value="">Select</option><option>Yes</option><option>No</option></select></div>
      <div class="q"><div>Please refer to the Voluntary Self-Identification of Disability statement above before answering this question. *</div>
        <div class="opts">
          <label><input type="radio" name="dis" value="y"> Yes, I have a disability, or have had one in the past</label>
          <label><input type="radio" name="dis" value="n"> No, I do not have a disability and have not had one in the past</label>
          <label><input type="radio" name="dis" value="x"> I do not want to answer</label></div></div>
      <div class="q"><div>Please select your gender:</div>
        <div class="opts"><label><input type="radio" name="g" value="m"> Male</label><label><input type="radio" name="g" value="f"> Female</label></div></div>
    </fieldset></form>`;
});

const checked = (name: string) => (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value;

describe('questions inside one big section', () => {
  it('reads each question, not the section heading', () => {
    const labels = scanFields().map((f) => f.label);
    expect(labels).not.toContain('Application questions');
    expect(labels).toContain('Please select your gender:');
    expect(labels.some((l) => /^Please refer to the Voluntary Self-Identification of Disability/.test(l))).toBe(true);
  });

  it('keeps the real question at the end of a long legal preamble (not "Micron")', () => {
    const label = stripLabel(US_WORKER);
    expect(label).toMatch(/Are you in one of the above five groups\?$/);
    expect(label.startsWith('Micron is required to comply')).toBe(true);
  });

  it('answers gender, disability and U.S. worker from the profile, with no AI', async () => {
    const asked: string[] = [];
    const ai: AiAsk = async (q) => {
      asked.push(q.question);
      return null;
    };
    const p = exampleProfile('swe');
    p.eeo.gender = 'Male';
    p.eeo.disability = false;
    await run({ ...base, profile: p, autoAdvance: false, ai });
    expect((document.getElementById('usw') as HTMLSelectElement).value).toBe('Yes');
    expect(checked('dis')).toBe('n');
    expect(checked('g')).toBe('m');
    expect(asked).toEqual([]);
  }, 30000);
});

describe('custom dropdowns and the AI', () => {
  it("shows the AI the dropdown's real options", async () => {
    document.body.innerHTML = `<form>
      <div><label id="ql">Have you previously worked in any capacity with Micron? *</label>
        <div role="combobox" aria-haspopup="listbox" aria-labelledby="ql" tabindex="0" id="cb"></div><span class="val"></span></div></form>`;
    const cb = document.getElementById('cb')!;
    cb.addEventListener('click', () => {
      if (document.getElementById('lb')) return;
      const ul = document.createElement('ul');
      ul.id = 'lb';
      ul.setAttribute('role', 'listbox');
      for (const o of ['Yes', 'No']) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = o;
        li.addEventListener('click', () => {
          document.querySelector('.val')!.textContent = o;
          ul.remove();
        });
        ul.appendChild(li);
      }
      document.body.appendChild(ul);
    });
    cb.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Escape' && document.getElementById('lb')?.remove());
    const seen: string[][] = [];
    const decisions: string[] = [];
    const ai: AiAsk = async (q) => {
      seen.push(q.options);
      return { answer: 'No', confidence: 0.95 };
    };
    ai.decided = (_q, d) => decisions.push(d);
    await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false, ai });
    expect(seen[0]).toEqual(['Yes', 'No']);
    expect(document.querySelector('.val')!.textContent).toBe('No');
    expect(decisions).toEqual(['Filled in']);
  }, 30000);
});

describe('a consent pop-up after Next', () => {
  it('presses "I Agree" and carries on', async () => {
    document.body.innerHTML = `<form>
      <section id="s1"><h2>Step 1</h2><div><label for="fn">First Name</label><input id="fn"></div><button type="button" id="next">Next</button></section>
      <section id="s2" hidden><h2>Step 2</h2><div><label for="em">Email</label><input id="em"></div><button type="button">Submit application</button></section>
      <div role="dialog" aria-modal="true" id="dlg" hidden><h2>Notice Related to Micron's Use of the Eightfold AI Recruiting Software</h2>
        <p>Micron uses an artificial intelligence ("AI") recruiting software…</p><button type="button" id="cancel">Cancel</button><button type="button" id="agree">I Agree</button></div>
    </form>`;
    document.getElementById('next')!.addEventListener('click', () => (document.getElementById('dlg')!.hidden = false));
    document.getElementById('agree')!.addEventListener('click', () => {
      document.getElementById('dlg')!.hidden = true;
      document.getElementById('s1')!.hidden = true;
      document.getElementById('s2')!.hidden = false;
    });
    let cancelled = false;
    document.getElementById('cancel')!.addEventListener('click', () => (cancelled = true));
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: true, autopilot: true });
    expect(cancelled).toBe(false);
    expect(report.stop).toBe('final');
    expect((document.getElementById('em') as HTMLInputElement).value).toBe('alex@example.com');
  }, 40000);
});
