import { run } from '../src/engine/run';
import type { AiAsk } from '../src/engine/fill';
import { pickSalaryOption, postedPayRange, salaryPlan, setJobText } from '../src/engine/salary';
import { profileFacts } from '../src/llm/facts';
import { resolveProfile, validateStore } from '../src/profile/merge';
import { exampleProfile } from './helpers';

// Salary: the job's posted range when it has one, else yours; one number
// (your preferred, kept inside the posted range) where a range won't go.
// AI answers between 0.4 and 0.7 confidence are filled but marked to review.

const base = { learned: [], learn: false, overwrite: true, onReport: () => {} };
const pref = { salaryMin: 70000, salaryMax: 80000, salaryPreferred: 89000 };

describe('the pay range a job posts', () => {
  it.each([
    ['The base salary range for this role is $95,000 - $120,000 per year.', [95000, 120000]],
    ['Pay: $95K–$120K', [95000, 120000]],
    ['Compensation: $95-120k depending on experience', [95000, 120000]],
    ['annual salary between 80,000 and 100,000 USD', [80000, 100000]],
    ['US base range: $132,000—$165,000 + equity', [132000, 165000]],
  ])('reads "%s"', (text, [min, max]) => {
    expect(postedPayRange(text)).toEqual({ min, max });
  });

  it.each(['Hourly rate: $25 - $35 per hour', '$45 - $60/hr', 'We were founded 2015 - 2018 and have 200 - 500 employees.', 'Call 555-1234 or 555-9876', 'Team of 25,000 - 30,000 people'])(
    'ignores "%s"',
    (text) => {
      expect(postedPayRange(text)).toBeNull();
    },
  );
});

describe('what to answer', () => {
  it('without a posted range: your range, and your preferred number for single boxes', () => {
    expect(salaryPlan(pref, null)).toEqual({ range: { min: 70000, max: 80000 }, single: 89000, posted: false });
  });

  it('with a posted range: that range, and your number kept inside it', () => {
    expect(salaryPlan(pref, { min: 100000, max: 130000 })).toMatchObject({ range: { min: 100000, max: 130000 }, single: 100000, posted: true });
    expect(salaryPlan(pref, { min: 60000, max: 75000 })).toMatchObject({ single: 75000 });
    expect(salaryPlan(pref, { min: 80000, max: 95000 })).toMatchObject({ single: 89000 });
  });

  it('picks the option holding the number', () => {
    const opts = ['Less than $60,000', '$60,000 - $79,999', '$80,000 - $99,999', '$100,000+'];
    expect(pickSalaryOption(opts, 89000)).toBe('$80,000 - $99,999');
    expect(pickSalaryOption(opts, 150000)).toBe('$100,000+');
    expect(pickSalaryOption(['$70-80k', '$80-90k', '$90-100k'], 89000)).toBe('$80-90k');
    expect(pickSalaryOption(['Yes', 'No'], 89000)).toBeNull();
  });
});

describe('filling salary questions', () => {
  beforeEach(() => setJobText(' '));

  function form(): void {
    document.body.innerHTML = `<form>
      <label for="exp">What are your salary expectations?</label><input id="exp" type="text">
      <label for="num">Desired salary (numbers only)</label><input id="num" type="text">
      <label for="n2">Expected annual salary</label><input id="n2" type="number">
      <label for="band">Desired salary range</label><select id="band"><option value="">Select</option><option>$60,000 - $79,999</option><option>$80,000 - $99,999</option><option>$100,000+</option></select>
    </form>`;
  }
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

  it('uses your range, and 89000 where only one number goes', async () => {
    form();
    const p = exampleProfile();
    p.preferences = { ...p.preferences, ...pref };
    await run({ ...base, profile: p, autoAdvance: false });
    expect(val('exp')).toBe('$70,000 - $80,000');
    expect(val('num')).toBe('89000');
    expect(val('n2')).toBe('89000');
    expect(val('band')).toBe('$80,000 - $99,999');
  });

  it("uses the job's posted range when the description has one", async () => {
    form();
    setJobText('About the role… The salary range for this position is $100,000 - $125,000 annually.');
    const p = exampleProfile();
    p.preferences = { ...p.preferences, ...pref };
    await run({ ...base, profile: p, autoAdvance: false });
    expect(val('exp')).toBe('$100,000 - $125,000');
    expect(val('num')).toBe('100000');
    expect(val('band')).toBe('$100,000+');
  });
});

describe('AI answers it is not sure of', () => {
  it('fills them from 0.4 up, marked pink to review; below 0.4 only suggests', async () => {
    document.body.innerHTML = `<form>
      <label for="q1">Do you hold an active TS/SCI clearance?</label><select id="q1" required><option value="">Select</option><option>Yes</option><option>No</option></select>
      <label for="q2">Have you used Kubernetes in production?</label><select id="q2" required><option value="">Select</option><option>Yes</option><option>No</option></select>
      <label for="q3">Which office would you prefer to work from?</label><select id="q3" required><option value="">Select</option><option>Austin</option><option>Denver</option></select>
    </form>`;
    const ai: AiAsk = async (q) => {
      if (/clearance/.test(q.question)) return { answer: 'No', confidence: 0.9 };
      if (/Kubernetes/.test(q.question)) return { answer: 'Yes', confidence: 0.5 };
      return { answer: 'Austin', confidence: 0.3 };
    };
    const report = await run({ ...base, profile: exampleProfile(), autoAdvance: false, ai });
    const row = (words: string) => report.fields.find((f) => f.label.includes(words))!;
    const sure = row('clearance');
    const unsure = row('Kubernetes');
    const guess = row('office');
    expect(sure).toMatchObject({ status: 'filled' });
    expect(sure.review).toBeFalsy();
    expect(unsure).toMatchObject({ status: 'filled', review: true });
    expect((document.getElementById('q2') as HTMLSelectElement).value).toBe('Yes');
    expect(guess.status).toBe('flagged');
    expect((document.getElementById('q3') as HTMLSelectElement).value).toBe('');
    // Pink on the page.
    expect(document.getElementById('q2')!.getAttribute('data-rej-state')).toBe('review');
    expect(document.getElementById('q1')!.getAttribute('data-rej-state')).toBe('filled');
    expect(report.message).toMatch(/1 to review/);
  });
});

describe('facts about you, for the AI', () => {
  it('adds up base and profile facts and sends them with every question', () => {
    const store = validateStore({
      version: 1,
      base: { personal: { firstName: 'A', lastName: 'B' }, facts: ['I have 1-2 years of professional experience.'], preferences: pref },
      profiles: [{ id: 'swe', name: 'SWE', overrides: { facts: ["I don't have a security clearance."] } }],
    });
    const p = resolveProfile(store, 'swe');
    expect(p.facts).toEqual(['I have 1-2 years of professional experience.', "I don't have a security clearance."]);
    const facts = profileFacts(p);
    expect(facts).toContain('- I have 1-2 years of professional experience.');
    expect(facts).toContain("- I don't have a security clearance.");
    expect(facts).toContain('70000 – 80000 USD (as one number: 89000); if the job posts a pay range, answer within that range instead');
  });
});
