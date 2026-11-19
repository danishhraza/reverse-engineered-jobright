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

describe('iCIMS candidate profile (resume + login + address lookup)', () => {
  const resume = () => new File(['%PDF-1.4'], 'alex-resume.pdf', { type: 'application/pdf' });

  function page(): void {
    document.body.innerHTML = `
      <h2>Candidate Profile</h2>
      <form>
        <h3>Resume</h3>
        <label for="PortalProfileFields.Resume_File">Please upload your resume (Max size: 5 MB)*</label>
        <input type="file" id="PortalProfileFields.Resume_File" style="display:none"><button type="button">My Computer</button>
        <span id="resume-name"></span>
        <h3>Create a login</h3>
        <label for="login">Login</label><input id="login">
        <label for="pw">Password</label><input id="pw" type="password">
        <label for="pw2">Password (Re-enter)</label><input id="pw2" type="password">
        <label for="fn">First Name</label><input id="fn">
        <label for="ln">Last Name</label><input id="ln">
        <label for="em">Email</label><input id="em" type="email">
        <div><label for="-1_PersonProfileFields.PhoneType">Type</label>
          <select id="-1_PersonProfileFields.PhoneType"><option value="">— Make a selection —</option><option>Home</option><option>Mobile</option><option>Work</option></select></div>
        <div><label for="-1_PersonProfileFields.PhoneNumber">Number</label><input id="-1_PersonProfileFields.PhoneNumber"></div>
        <div><label for="-1_PersonProfileFields.AddressType">Type</label>
          <select id="-1_PersonProfileFields.AddressType"><option value="">— Make a selection —</option><option>Home</option><option>Work</option><option>Other</option></select></div>
        <div class="iCIMS_InfoData"><label id="label_addr">Address*</label>
          <a id="addr" class="dropdown-select" role="combobox" aria-expanded="false" aria-labelledby="label_addr" aria-label="Address" aria-required="true">
            <span id="addr-text" class="dropdown-text"><span class="dropdown-placeholder">— Make a selection —</span></span></a>
          <div id="addr-ctnr" class="dropdown-container" hidden>
            <input type="text" class="dropdown-search" placeholder="— Type to Search —" aria-label="— Type to Search —">
            <ul class="dropdown-results" role="listbox"><li role="option">— Enter Manually —</li></ul></div></div>
        <div><label for="city">City</label><input id="city"></div>
        <div><label for="zip">Zip/Postal Code</label><input id="zip"></div>
        <button type="button">Next</button>
      </form>`;
    const file = document.getElementById('PortalProfileFields.Resume_File') as HTMLInputElement;
    file.addEventListener('change', () => (document.getElementById('resume-name')!.textContent = file.files?.[0]?.name ?? ''));
    // iCIMS dropdown: the link opens a box with its own search; results come back a moment after typing.
    const a = document.getElementById('addr')!;
    const box = document.getElementById('addr-ctnr')!;
    const search = box.querySelector('input')!;
    const ul = box.querySelector('ul')!;
    a.addEventListener('click', () => (box.hidden = !box.hidden));
    let timer: ReturnType<typeof setTimeout> | undefined;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const hits = ['100 Main Street, Boston, MA, USA', '100 Main Street, Springfield, IL, USA', '100 Mains Road, Springfield, MO, USA'].filter((x) =>
          x.toLowerCase().startsWith(search.value.toLowerCase().split(',')[0]),
        );
        ul.innerHTML = '<li role="option">— Enter Manually —</li>' + hits.map((h) => `<li role="option">${h}</li>`).join('');
        for (const li of Array.from(ul.querySelectorAll('li'))) {
          li.addEventListener('click', () => {
            document.getElementById('addr-text')!.textContent = li.textContent!;
            box.hidden = true;
          });
        }
      }, 400);
    });
  }

  it('uploads the resume once: after the site re-parses and reloads, it fills again without re-uploading', async () => {
    page();
    await run({ ...base, profile: exampleProfile('swe'), resume: resume(), autoAdvance: false });
    expect(document.getElementById('resume-name')!.textContent).toBe('alex-resume.pdf');
    // iCIMS reloads the page with the resume parsed in (and its own guesses for the fields).
    page();
    (document.getElementById('fn') as HTMLInputElement).value = 'Alexander';
    const report = await run({ ...base, profile: exampleProfile('swe'), resume: resume(), autoAdvance: false });
    expect(document.getElementById('resume-name')!.textContent).toBe('');
    expect(report.fields.find((f) => f.key === 'resume')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/not again/) });
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('Alex');
    sessionStorage.clear();
  }, 60000);

  it('is the application (not a sign-up page), even with "Create a login" on it', () => {
    page();
    expect(probe()).toMatchObject({ kind: 'form' });
  });

  it('uploads the resume, picks the address from the lookup, and fills phone and address types', async () => {
    page();
    const report = await run({ ...base, profile: exampleProfile('swe'), resume: resume(), autoAdvance: false });
    expect(document.getElementById('resume-name')!.textContent).toBe('alex-resume.pdf');
    expect(document.getElementById('addr-text')!.textContent).toBe('100 Main Street, Springfield, IL, USA');
    expect((document.getElementById('-1_PersonProfileFields.PhoneType') as HTMLSelectElement).value).toBe('Mobile');
    expect((document.getElementById('-1_PersonProfileFields.AddressType') as HTMLSelectElement).value).toBe('Home');
    const number = report.fields.find((f) => f.label === 'Number');
    expect(number?.status).toBe('filled');
  }, 60000);
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

describe('iCIMS voluntary information (EEO) page', () => {
  // Plain <select>s that iCIMS marks role="combobox" and points at a listbox that never exists.
  const select = (name: string, options: string[]) => `<div class="iCIMS_TableRow">
    <label id="label_CandProfileFields.${name}" for="CandProfileFields.${name}">${name}</label><span class="Field_Required"><span class="Field_RequiredStar">* </span></span>
    <select id="CandProfileFields.${name}" name="CandProfileFields.${name}" class="iCIMS_Forms_EeoDropDown form-control" icimsdropdown-enabled="0" aria-labelledby="label_CandProfileFields.${name}" aria-required="true"
      role="combobox" aria-expanded="false" aria-controls="CandProfileFields.${name}_listbox">
      <option legacy="true" value="">— Make a Selection —</option>${options.map((o) => `<option value="${o}">${o}</option>`).join('')}</select></div>`;

  beforeEach(() => {
    document.body.innerHTML = `<form><h2 class="iCIMS_SubHeader">Voluntary Information</h2>
      ${select('Gender', ['Male', 'Female', 'Opt Out'])}
      ${select('Race', ['Hispanic or Latino', 'American Indian or Alaska Native (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)', 'White (Not Hispanic or Latino)', 'Opt Out'])}
      ${select('Nationality', ['American', 'Arab', 'Austrian', 'Belgian', 'Canadian'])}
      <input type="submit" value="Submit" class="iCIMS_PrimaryButton"></form>`;
  });

  it('treats them as ordinary dropdowns and answers gender, race and nationality', async () => {
    const p = exampleProfile('swe');
    p.eeo.gender = 'Male';
    p.eeo.ethnicity = 'Asian';
    await run({ ...base, profile: p, autoAdvance: false, autopilot: true, agreeToTerms: true });
    const val = (n: string) => (document.getElementById(`CandProfileFields.${n}`) as HTMLSelectElement).value;
    expect([val('Gender'), val('Race'), val('Nationality')]).toEqual(['Male', 'Asian (Not Hispanic or Latino)', 'American']);
    expect(scanFields().map((f) => f.kind)).toEqual(['select', 'select', 'select']);
  }, 30000);
});

describe('iCIMS "Submit Profile"', () => {
  it('is the way to the next page, not the final submit', async () => {
    const { genericNext, submitButton } = await import('../src/engine/nav');
    document.body.innerHTML = `<form><label for="fn">First Name</label><input id="fn">
      <input type="submit" id="cp_form_submit_i" class="iCIMS_PrimaryButton" name="profileButton" value="Submit Profile"></form>`;
    expect(genericNext()?.id).toBe('cp_form_submit_i');
    expect(submitButton()).toBeNull();
  });
});
