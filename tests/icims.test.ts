import { run } from '../src/engine/run';
import { probe } from '../src/content/autopilot';
import { comboboxDisplay, scanFields } from '../src/engine/fields';
import { exampleProfile } from './helpers';

// iCIMS's first login step (Planview), as it appears inside the iCIMS frame:
// Email, a link-styled "Phone Country Code" dropdown, Number, Next.

const base = { learned: [], learn: false, overwrite: true, onReport: () => {} };

beforeEach(() => {
  document.body.innerHTML = `
    <h2>Enter Your Information</h2>
    <form><label for="email">Email</label><input type="email" id="email" class="form-control">
      <div class="country-phone-group">
        <div class="country-code"><label for="countryCode">Phone Country Code</label>
          <div class="country-code iCIMS_InfoData">
            <input type="text" id="selectedCountryCode" class="form-control" tabindex="-1" aria-hidden="true">
            <a id="dropdown" class="dropdown-select" aria-expanded="false" tabindex="0" aria-label="Country Code — Make a Selection —" aria-required="true" role="combobox" aria-controls="dropdownOptions">
              <span id="dropdown-select-span" class="dropdown-text"><span class="dropdown-placeholder">— Make a Selection —</span></span></a>
            <div class="dropdown-container" id="dropdownOptions" hidden>
              <input type="text" class="dropdown-search" id="countryCode" placeholder="— Type to Search —">
              <ul class="dropdown-results" id="dropdownResults" role="listbox">
                <li role="option" class="dropdown-result">— Make a Selection —</li>
                <li role="option" class="dropdown-result" value="US">(+1) United States</li>
                <li role="option" class="dropdown-result">(+1) United States Minor Outlying Islands</li>
                <li role="option" class="dropdown-result">(+93) Afghanistan</li>
                <li role="option" class="dropdown-result">(+92) Pakistan</li>
              </ul></div></div></div>
        <div class="phone"><label for="phoneNumber">Number</label><input type="tel" id="phoneNumber" class="form-control"></div>
      </div>
      <button type="submit" class="btn">Next</button></form>
    <div class="h-captcha"><iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox-invisible"></iframe></div>`;
  const a = document.getElementById('dropdown')!;
  const box = document.getElementById('dropdownOptions')!;
  a.addEventListener('click', () => {
    box.hidden = !box.hidden;
    a.setAttribute('aria-expanded', String(!box.hidden));
  });
  for (const li of Array.from(box.querySelectorAll('li'))) {
    li.addEventListener('click', () => {
      document.getElementById('dropdown-select-span')!.textContent = li.textContent!;
      (document.getElementById('selectedCountryCode') as HTMLInputElement).value = li.getAttribute('value') ?? '';
      box.hidden = true;
      a.setAttribute('aria-expanded', 'false');
    });
  }
});

describe('iCIMS email step', () => {
  it('is a form, even with only two input boxes, and the hCaptcha badge is not a CAPTCHA', () => {
    expect(probe()).toMatchObject({ kind: 'form' });
    expect(probe().inputs).toBeGreaterThanOrEqual(3);
  });

  it('"— Make a Selection —" counts as nothing chosen', () => {
    const cc = scanFields().find((f) => f.el.id === 'dropdown')!;
    expect(comboboxDisplay(cc.el)).toBe('');
  });

  it('fills email, picks "(+1) United States", fills the number', async () => {
    await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false });
    expect((document.getElementById('email') as HTMLInputElement).value).toBe('alex@example.com');
    expect(document.getElementById('dropdown-select-span')!.textContent).toBe('(+1) United States');
    expect((document.getElementById('phoneNumber') as HTMLInputElement).value).not.toBe('');
  }, 30000);
});
