import { run } from '../src/engine/run';
import { matchOption } from '../src/engine/match';
import { classify, resolve } from '../src/engine/answers';
import { eduResolver, fillEntryField } from '../src/engine/entries';
import { scanFields } from '../src/engine/fields';
import { fillField } from '../src/engine/widgets';
import type { FieldReport } from '../src/types';
import { exampleProfile } from './helpers';

// From a Phenom career site (Trane): date pickers that reformat, long Degree /
// Field of Study lists, EEO wording, a Next button greyed out until the page is valid.

const base = { learned: [], learn: false, overwrite: true, onReport: () => {} };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('date pickers that rewrite what you type', () => {
  it('counts "Jun 2024" as the same as 06/2024', async () => {
    document.body.innerHTML = '<label for="from">From *</label><input id="from" placeholder="MM/YYYY">';
    const el = document.getElementById('from') as HTMLInputElement;
    el.addEventListener('blur', () => {
      const m = /^(\d{2})\/(\d{4})$/.exec(el.value);
      if (m) el.value = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'][Number(m[1]) - 1]} ${m[2]}`;
    });
    const f = scanFields()[0];
    const r = await fillField(f, { text: '06/2024' }, true);
    expect(r).toMatchObject({ ok: true, match: 1 });
    expect(el.value).toBe('Jun 2024');
  });
});

describe('Phenom option lists', () => {
  const DEGREES = [
    'Please Select', 'Associate of Applied Science', 'Associate of Arts (AA)', 'Associate of Science (AS)', 'Bachelor of Arts (BA)',
    'Bachelor of Science (BS)', "Bachelor's Degree (Other)", 'CÉGEP/Certificate', 'Doctor of Philosophy (PhD)', 'General Equivalency Diploma (GED)',
    'High School', 'Juris Doctor (JD)', "Master's Degree (Other)", 'Masters of Arts (MA)', 'Masters of Business Administration (MBA)', 'Masters of Science (MS)', 'None',
  ];
  const degree = (d: string, short: string) => {
    document.body.innerHTML = `<label for="d">Degree *</label><select id="d">${DEGREES.map((o) => `<option>${o}</option>`).join('')}</select>`;
    const want = eduResolver(scanFields()[0], 'degree', { school: 'X', degree: d, degreeShort: short, major: 'Computer Science' });
    const m = matchOption(DEGREES, want as never)!;
    return { label: DEGREES[m.index], score: m.score };
  };

  it('picks "Masters of Science (MS)" for a Master of Science, not another "Masters …"', () => {
    expect(degree('Master of Science', 'M.S.')).toMatchObject({ label: 'Masters of Science (MS)' });
    expect(degree('Master of Science', 'M.S.').score).toBeGreaterThanOrEqual(0.75);
  });

  it('picks "Bachelor of Science (BS)" for a Bachelor of Science', () => {
    expect(degree('Bachelor of Science', 'B.S.')).toMatchObject({ label: 'Bachelor of Science (BS)' });
  });

  it('veteran: "I am not a veteran", not "…just not a protected veteran"', () => {
    const options = [
      'Please Select',
      'I identify as one or more of the classifications of protected veterans listed above',
      'I identify as a veteran, just not a protected veteran',
      'I am not a veteran',
      'I do not wish to self-identify',
    ];
    document.body.innerHTML = `<label for="v">Please select the veteran status which most accurately describes your status. *</label><select id="v">${options.map((o) => `<option>${o}</option>`).join('')}</select>`;
    const f = scanFields()[0];
    const p = exampleProfile('swe');
    p.eeo.veteran = false;
    const c = classify(f, [], [])!;
    expect(c.key).toBe('veteran');
    const res = resolve(c, p, f) as { desired: never };
    const m = matchOption(options, res.desired)!;
    expect(options[m.index]).toBe('I am not a veteran');
    expect(m.score).toBe(1);
  });

  it("Field of Study: when there's no \"Computer Science\", the AI picks the closest option", async () => {
    document.body.innerHTML = `<label for="fos">Field of Study *</label><select id="fos" required>
      <option>Please Select</option><option>Computer Engineering</option><option>Computer and Information Science</option><option>Software Engineering</option></select>`;
    const f = scanFields()[0];
    const notes: string[] = [];
    const aiPick = async (field: typeof f, note: string): Promise<FieldReport> => {
      notes.push(note);
      (field.el as HTMLSelectElement).value = 'Computer and Information Science';
      return { id: field.id, label: field.label, status: 'filled', confidence: 0.9, value: 'Computer and Information Science', reason: 'Answered by AI — check it' };
    };
    const r = await fillEntryField(f, 'Education 1', { school: 'Georgia Tech', degree: 'Master of Science', major: 'Computer Science' }, eduResolver, true, undefined, aiPick);
    expect(notes[0]).toMatch(/Education 1.*"Computer Science"/);
    expect(r).toMatchObject({ status: 'filled', label: 'Education 1: Field of Study', value: 'Computer and Information Science' });
  });
});

describe('a greyed-out Next', () => {
  it('means something is still missing, not "no Next button"', async () => {
    document.body.innerHTML = `<form>
      <div><label for="fn">First Name</label><input id="fn"></div>
      <div><label for="q">Badge number *</label><input id="q"></div>
      <button type="button" disabled>Next</button></form>`;
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: true, autopilot: true });
    expect(report.stop).toBe('blocked');
    expect(report.message).toMatch(/greyed out/);
  }, 30000);
});

describe('browser alerts in Autopilot tabs', () => {
  it('answers alert/confirm there (Cancel for risky ones), and leaves other tabs alone', async () => {
    const realAlert = vi.fn();
    const realConfirm = vi.fn(() => false);
    window.alert = realAlert;
    window.confirm = realConfirm;
    await import('../src/content/dialogs');
    const told: { kind: string; message: string; answer: string }[] = [];
    window.addEventListener('message', (e) => e.data?.source === 'rej-dialog' && told.push(e.data));

    sessionStorage.removeItem('rej-autopilot');
    window.alert('hi');
    expect(realAlert).toHaveBeenCalledTimes(1);

    sessionStorage.setItem('rej-autopilot', '1');
    window.alert('You have uploaded your resume');
    expect(realAlert).toHaveBeenCalledTimes(1);
    expect(window.confirm('Continue with this resume?')).toBe(true);
    expect(window.confirm('Are you sure you want to withdraw your application?')).toBe(false);
    expect(realConfirm).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(told.map((t) => t.answer)).toEqual(['OK', 'OK', 'Cancel']);
    sessionStorage.removeItem('rej-autopilot');
  });
});
