import { run } from '../src/engine/run';
import type { FieldReport, FillReport } from '../src/types';
import { exampleProfile, mountAsyncCombobox, mountButtonDropdown } from './helpers';

const byLabel = (rows: FieldReport[], re: RegExp) => rows.find((r) => re.test(r.label));

async function fill(opts: { autoAdvance?: boolean; resume?: File } = {}): Promise<FillReport> {
  return run({
    profile: exampleProfile('swe'),
    resume: opts.resume,
    learned: [],
    overwrite: true,
    autoAdvance: opts.autoAdvance ?? false,
    learn: false,
    onReport: () => {},
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('single-page form (Greenhouse-like)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field"><label for="first_name">First Name *</label><input id="first_name" required></div>
        <div class="field"><label for="last_name">Last Name *</label><input id="last_name" required></div>
        <div class="field"><label for="email">Email *</label><input id="email" type="email" required></div>
        <div class="field"><label for="phone">Phone</label><input id="phone" type="tel"></div>
        <div class="field" id="resume-field"><label for="resume">Resume/CV *</label><input id="resume" type="file"><span id="resume-name"></span></div>
        <div class="field"><label for="li">LinkedIn Profile</label><input id="li"></div>
        <div class="field" id="loc"><label>Location (City)</label></div>
        <div class="field"><label for="auth">Are you legally authorized to work in the United States? *</label>
          <select id="auth" required><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select></div>
        <fieldset><legend>Will you now or in the future require sponsorship? *</legend>
          <label><input type="radio" name="spons" value="y"> Yes</label>
          <label><input type="radio" name="spons" value="n"> No</label></fieldset>
        <div class="field"><label for="gender">Gender</label>
          <select id="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Decline To Self Identify</option></select></div>
        <div class="field"><label for="vet">Veteran Status</label>
          <select id="vet"><option value="">Select...</option><option>I am not a protected veteran</option><option>I identify as one or more of the classifications of protected veteran</option><option>I don't wish to answer</option></select></div>
        <div class="field"><label for="why">Why do you want to work here? *</label><textarea id="why" required></textarea></div>
        <div><p>Have you ever worked for Acme before?</p><div><button type="button">Yes</button><button type="button">No</button></div></div>
        <div class="field"><label><input type="checkbox" id="consent" required> I agree to the privacy policy</label></div>
      </form>`;
    // Async "location" autocomplete.
    mountAsyncCombobox(document.getElementById('loc')!, ['Springfield, Illinois, United States', 'Springfield, Missouri, United States'], 250);
    // Simulated upload: the filename shows up after a delay.
    document.getElementById('resume')!.addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      setTimeout(() => (document.getElementById('resume-name')!.textContent = f?.name ?? ''), 400);
    });
    // Ashby-style button group marks the pressed button.
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('button'))) {
      b.addEventListener('click', () => b.setAttribute('aria-pressed', 'true'));
    }
  });

  it('fills what it knows, waits for upload and dropdowns, flags the rest', async () => {
    const resume = new File(['%PDF-1.4'], 'Alex Example - SWE.pdf', { type: 'application/pdf' });
    const report = await fill({ resume });
    const rows = report.fields;

    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Alex');
    expect((document.getElementById('last_name') as HTMLInputElement).value).toBe('Example');
    expect((document.getElementById('email') as HTMLInputElement).value).toBe('alex@example.com');
    expect((document.getElementById('li') as HTMLInputElement).value).toContain('linkedin.com');
    expect(byLabel(rows, /Resume/)?.status).toBe('filled');
    expect((document.getElementById('resume') as HTMLInputElement).files?.[0].name).toBe('Alex Example - SWE.pdf');

    expect((document.getElementById('auth') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Yes');
    expect((document.querySelector('input[name=spons][value=n]') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('gender') as HTMLSelectElement).selectedOptions[0].textContent).toMatch(/Decline/);
    expect((document.getElementById('vet') as HTMLSelectElement).selectedOptions[0].textContent).toMatch(/don't wish/);

    expect(document.querySelector('.select__single-value')!.textContent).toBe('Springfield, Illinois, United States');
    expect(byLabel(rows, /Location/)?.status).toBe('filled');

    // Previously-employed button group answered No.
    expect(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'No')!.getAttribute('aria-pressed')).toBe('true');

    // Things a human must do.
    expect(byLabel(rows, /Why do you want/)?.status).toBe('flagged');
    expect(byLabel(rows, /privacy policy/)?.status).toBe('flagged');
    expect((document.getElementById('consent') as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector('[data-rej-state="flagged"]')).not.toBeNull();
  });

  it('flags a missing resume instead of failing', async () => {
    const report = await fill();
    expect(byLabel(report.fields, /Resume/)).toMatchObject({ status: 'flagged' });
  });
});

describe('dropdown retry', () => {
  it('flags a dropdown whose options never contain the answer', async () => {
    document.body.innerHTML = '<form><div id="c"><label>Country</label></div><input><input></form>';
    mountAsyncCombobox(document.getElementById('c')!, ['Narnia', 'Mordor'], 50);
    const report = await fill();
    expect(byLabel(report.fields, /Country/)?.status).toBe('flagged');
  });
});

describe('multi-page form (Workday-like)', () => {
  it('fills page 1, clicks Next, fills page 2 and stops before Submit', async () => {
    document.body.innerHTML = '<div data-automation-id="applyFlowPage"><h2 id="h">My Information</h2><div id="page"></div><button data-automation-id="pageFooterNextButton">Save and Continue</button></div>';
    const page = document.getElementById('page')!;
    const next = document.querySelector<HTMLButtonElement>('[data-automation-id="pageFooterNextButton"]')!;
    page.innerHTML = `
      <div data-automation-id="formField-legalNameSection_firstName"><label>First Name*</label><input data-automation-id="legalNameSection_firstName"></div>
      <div data-automation-id="formField-legalNameSection_lastName"><label>Last Name*</label><input data-automation-id="legalNameSection_lastName"></div>
      <div data-automation-id="formField-email"><label>Email Address*</label><input data-automation-id="email"></div>`;
    mountButtonDropdown(page, 'Country', ['Canada', 'United States of America']);

    let step = 1;
    next.addEventListener('click', () => {
      step++;
      setTimeout(() => {
        document.getElementById('h')!.textContent = step === 2 ? 'My Experience' : 'Review';
        if (step === 2) {
          page.innerHTML = `
            <div><h3>Work Experience</h3>
              <div id="wx"></div>
              <button type="button" data-automation-id="Add">Add</button>
            </div>`;
          const add = page.querySelector<HTMLButtonElement>('[data-automation-id="Add"]')!;
          add.addEventListener('click', () => {
            const n = page.querySelectorAll('[data-test-panel]').length + 1;
            const panel = document.createElement('div');
            panel.setAttribute('role', 'group');
            panel.setAttribute('data-test-panel', '');
            panel.innerHTML = `
              <h4>Work Experience ${n}</h4>
              <div data-automation-id="formField-jobTitle"><label>Job Title*</label><input></div>
              <div data-automation-id="formField-companyName"><label>Company*</label><input></div>
              <div data-automation-id="formField-currentlyWorkHere"><label><input type="checkbox"> I currently work here</label></div>
              <div data-automation-id="formField-startDate"><label>From*</label>
                <input data-automation-id="dateSectionMonth-input" aria-label="Month">
                <input data-automation-id="dateSectionYear-input" aria-label="Year"></div>`;
            document.getElementById('wx')!.appendChild(panel);
          });
        } else {
          page.innerHTML = '<p>Review your application</p>';
          next.textContent = 'Submit';
        }
      }, 300);
    });

    const reports: FillReport[] = [];
    const report = await run({
      profile: exampleProfile('swe'),
      learned: [],
      overwrite: true,
      autoAdvance: true,
      learn: false,
      onReport: (r) => reports.push(r),
    });

    // Page 1 rows were reported before moving on.
    const p1 = reports.filter((r) => r.page === 1 && r.fields.length).pop()!;
    expect(byLabel(p1.fields, /^First Name/)?.status).toBe('filled');
    expect(byLabel(p1.fields, /^Country/)).toMatchObject({ status: 'filled', value: 'United States of America' });

    const p2 = reports.filter((r) => r.page === 2 && r.fields.length).pop()!;
    expect(byLabel(p2.fields, /Work 1: Job Title/)).toMatchObject({ status: 'filled', value: 'Software Engineer' });
    expect(byLabel(p2.fields, /Work 1: Company/)).toMatchObject({ status: 'filled', value: 'Acme Corp' });
    expect(byLabel(p2.fields, /Work 1: I currently work here/)?.status).toBe('filled');
    const month = document.querySelector('[data-automation-id="dateSectionMonth-input"]') as HTMLInputElement | null;
    // We are now on the review page, so the panel is gone; check the report instead.
    expect(month).toBeNull();
    expect(p2.fields.filter((f) => /Work 1: From/.test(f.label)).map((f) => f.value)).toEqual(['06', '2023']);

    expect(report.page).toBe(3);
    expect(report.message).toMatch(/review\/submit/i);
  });
});
