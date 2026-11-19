import { run } from '../src/engine/run';
import { probe } from '../src/content/autopilot';
import { exampleProfile } from './helpers';

// Oracle Cloud HCM (Candidate Experience) first step: "You don't need to have an
// account" — Email, a drawn "I agree with the terms and conditions" checkbox
// whose real input is hidden, and a Next button disabled until both are done.

const base = { learned: [], learn: false, overwrite: true, onReport: () => {} };
let accepted = false;

beforeEach(() => {
  accepted = false;
  document.body.innerHTML = `
    <h1>You don't need to have an account</h1>
    <form>
      <div class="input-row"><label for="primary-email-0">Email Address *</label>
        <input type="email" id="primary-email-0" class="input-row__control" required></div>
      <div class="input-row">
        <input type="checkbox" id="legal-disclaimer-checkbox" class="input-row__hidden-control" style="display:none" aria-labelledby="legal-disclaimer-checkbox-label" required>
        <span class="apply-flow-input-checkbox" id="legal-disclaimer-checkbox-label">
          <span class="apply-flow-input-checkbox__button" id="box"></span>
          <span class="apply-flow-input-checkbox__label apply-flow-input-checkbox__label--required">I agree with the <a href="#" id="terms">terms and conditions</a></span></span></div>
      <button type="button" class="button">Cancel</button>
      <button type="submit" id="next" class="button apply-flow-pagination__button" disabled>Next</button>
    </form>`;
  const email = document.getElementById('primary-email-0') as HTMLInputElement;
  const next = document.getElementById('next') as HTMLButtonElement;
  const update = () => (next.disabled = !(email.value.includes('@') && accepted));
  email.addEventListener('input', update);
  // Knockout-style: only the drawn box reacts, and only its class shows the state.
  document.getElementById('box')!.addEventListener('click', () => {
    accepted = !accepted;
    document.getElementById('box')!.classList.toggle('apply-flow-input-checkbox__button--checked', accepted);
    update();
  });
});

describe('Oracle Cloud email step', () => {
  it('counts as a form: one email box and a (greyed-out) Next', () => {
    expect(probe()).toMatchObject({ kind: 'form' });
  });

  it('fills the email and ticks the drawn terms box, which enables Next', async () => {
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false, autopilot: true, agreeToTerms: true });
    expect((document.getElementById('primary-email-0') as HTMLInputElement).value).toBe('alex@example.com');
    expect(accepted).toBe(true);
    expect((document.getElementById('next') as HTMLButtonElement).disabled).toBe(false);
    expect(report.fields.find((f) => /agree/i.test(f.label))).toMatchObject({ status: 'filled' });
  }, 30000);
});
