import { phoneDigits } from '../src/engine/answers';
import { run } from '../src/engine/run';
import { exampleProfile } from './helpers';

// Phone numbers go in as plain digits; a box that insists on another format
// gets the number as written in the profile.

const base = { learned: [], learn: false, overwrite: true, autoAdvance: false, onReport: () => {} };
const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

describe('phone numbers', () => {
  it('reads the national number as digits', () => {
    expect(phoneDigits('(555) 010-0100', '+1')).toBe('5550100100');
    expect(phoneDigits('+1 555-010-0100', '+1')).toBe('5550100100');
    expect(phoneDigits('555.010.0100')).toBe('5550100100');
    expect(phoneDigits('')).toBeUndefined();
  });

  it('fills plain digits by default', async () => {
    document.body.innerHTML = `<form><label for="fn">First Name</label><input id="fn"><label for="ph">Phone Number *</label><input id="ph" type="tel" required></form>`;
    const p = exampleProfile('swe');
    p.personal.phone = '(555) 010-0100';
    await run({ ...base, profile: p });
    expect(val('ph')).toBe('5550100100');
  }, 30000);

  it('uses the written form when the box marks plain digits invalid', async () => {
    document.body.innerHTML = `<form><label for="fn">First Name</label><input id="fn"><label for="ph">Phone *</label><input id="ph" type="tel" required></form>`;
    const ph = document.getElementById('ph') as HTMLInputElement;
    const check = () => ph.setAttribute('aria-invalid', String(!/^\(\d{3}\) \d{3}-\d{4}$/.test(ph.value)));
    ph.addEventListener('input', check);
    ph.addEventListener('blur', check);
    const p = exampleProfile('swe');
    p.personal.phone = '(555) 010-0100';
    const report = await run({ ...base, profile: p });
    expect(val('ph')).toBe('(555) 010-0100');
    expect(report.fields.find((f) => f.key === 'phone')).toMatchObject({ status: 'filled' });
  }, 30000);
});
