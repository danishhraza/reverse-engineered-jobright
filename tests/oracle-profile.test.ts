import { run } from '../src/engine/run';
import { startDate } from '../src/engine/answers';
import { exampleProfile } from './helpers';

// Oracle Cloud HCM (Candidate Experience) application pages, modelled on a saved
// page: cx-select dropdowns whose option grid only exists while open (and only
// the arrow button opens it), race as drawn checkboxes, a Title salutation,
// "Date available to start" as Day / Month / Year, and Work / Education added
// one at a time through "Add Experience" / "Add Education" and their own Save.

const base = { learned: [], learn: false, overwrite: true, onReport: () => {} };
const chosen: Record<string, string> = {};

function profile() {
  const p = exampleProfile('swe');
  p.eeo.gender = 'Male';
  p.eeo.ethnicity = 'Asian';
  p.preferences.startAvailability = 'Two weeks after offer acceptance';
  return p;
}

/** A cx-select: typing does nothing; the arrow button renders a grid of options; a cell picks. */
function cxSelect(id: string, label: string, options: string[]): string {
  return `<div class="input-row"><label for="${id}"><span id="lt-${id}">${label}</span></label>
    <div class="cx-select-container"><div class="input-field-container">
      <input id="${id}" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="${id}-listbox" aria-expanded="false" class="cx-select-input" data-options="${options.join('|')}">
      <button type="button" id="${id}-reset-button" aria-label="Remove value for the ${label} field." class="icon-clear"></button>
      <button type="button" id="${id}-toggle-button" tabindex="-1" aria-label="Open the drop-down list for ${label}." aria-expanded="false" aria-controls="${id}-listbox" class="icon-dropdown-arrow"></button>
    </div></div></div>`;
}

function wireCxSelects(): void {
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('.cx-select-input'))) {
    const id = input.id;
    const toggle = document.getElementById(`${id}-toggle-button`)!;
    const close = () => {
      document.getElementById(`${id}-listbox`)?.remove();
      input.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', () => {
      if (document.getElementById(`${id}-listbox`)) return close();
      const grid = document.createElement('div');
      grid.id = `${id}-listbox`;
      grid.setAttribute('role', 'grid');
      grid.innerHTML = input.dataset.options!.split('|').map((o) => `<div role="row"><div role="gridcell" class="cx-select__list-item">${o}</div></div>`).join('');
      grid.addEventListener('click', (e) => {
        const cell = (e.target as HTMLElement).closest('[role="gridcell"]');
        if (!cell) return;
        input.value = cell.textContent!;
        chosen[id] = cell.textContent!;
        close();
      });
      input.parentElement!.after(grid);
      input.setAttribute('aria-expanded', 'true');
    });
  }
}

/** Oracle's race checkboxes: the real input is hidden; its <label for> is the drawn box. */
function raceGroup(options: string[]): string {
  return `<div class="input-row"><label id="race-label"><span>Select the races you identify with.</span></label>
    <div class="input-row__control-container">${options
      .map(
        (o, i) => `<div class="input-row__control-item"><input type="checkbox" class="input-row__hidden-control" style="display:none" value="${i}" id="dq-option-${i}" aria-labelledby="label-dq-option-${i}">
        <label class="apply-flow-input-checkbox" for="dq-option-${i}"><span class="apply-flow-input-checkbox__button"></span><span class="apply-flow-input-checkbox__label">${o}</span></label></div>`,
      )
      .join('')}</div></div>`;
}

describe('Oracle Cloud: questions page', () => {
  beforeEach(() => {
    for (const k of Object.keys(chosen)) delete chosen[k];
    document.body.innerHTML = `<form>
      ${cxSelect('title-1', 'Title', ['Dr.', 'Miss', 'Mr.', 'Mrs.', 'Ms.'])}
      ${cxSelect('gender-11', 'Gender', ['Cisgender Man', 'Cisgender Woman', 'Non-binary', 'Transgender Man', 'Transgender Woman', 'I prefer not to answer'])}
      ${raceGroup(['American Indian or Alaska Native', 'Asian', 'Black or African American', 'White', 'I do not wish to answer'])}
      <fieldset><legend>Date available to start</legend>
        ${cxSelect('start-day', 'Date available to start Day', Array.from({ length: 31 }, (_, i) => String(i + 1)))}
        ${cxSelect('start-month', 'Date available to start Month', ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'])}
        ${cxSelect('start-year', 'Date available to start Year', ['2025', '2026', '2027', '2028'])}
      </fieldset>
    </form>`;
    wireCxSelects();
    for (const box of Array.from(document.querySelectorAll<HTMLInputElement>('.input-row__hidden-control'))) {
      box.addEventListener('change', () => box.nextElementSibling!.querySelector('span')!.classList.toggle('apply-flow-input-checkbox__button--checked', box.checked));
    }
  });

  it('picks gender from the grid (opened with the arrow button), ticks Asian, and says Mr.', async () => {
    await run({ ...base, profile: profile(), autoAdvance: false, autopilot: true, agreeToTerms: true });
    expect(chosen['gender-11']).toBe('Cisgender Man');
    expect(chosen['title-1']).toBe('Mr.');
    const ticked = Array.from(document.querySelectorAll<HTMLInputElement>('.input-row__hidden-control')).filter((b) => b.checked);
    expect(ticked.map((b) => b.nextElementSibling!.textContent!.trim())).toEqual(['Asian']);
  }, 60000);

  it('fills the start date as Day / Month / Year, two weeks from today', async () => {
    await run({ ...base, profile: profile(), autoAdvance: false, autopilot: true, agreeToTerms: true });
    const d = startDate('Two weeks after offer acceptance');
    expect(chosen['start-day']).toBe(String(d.getDate()));
    expect(chosen['start-month']).toBe(d.toLocaleString('en-US', { month: 'long' }));
    expect(chosen['start-year']).toBe(String(d.getFullYear()));
  }, 60000);
});

describe('Oracle Cloud: Add Experience / Add Education', () => {
  let saved: Record<string, string>[] = [];

  /** Pressing Add opens a small form; Save checks it, closes it and shows a card. */
  function entryForm(kind: 'exp' | 'edu'): void {
    const timeline = document.getElementById('timeline')!;
    const form = document.createElement('div');
    form.className = 'profile-item-form';
    form.innerHTML =
      kind === 'exp'
        ? `<div class="input-row"><label for="f-title">Job Title</label><input id="f-title" type="text" required></div>
           <div class="input-row"><label for="f-employer">Employer Name</label><input id="f-employer" type="text" required></div>
           <div class="input-row"><label for="f-sm">Start Date Month</label><select id="f-sm"><option value=""></option>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${new Date(2000, i).toLocaleString('en-US', { month: 'long' })}</option>`).join('')}</select></div>
           <div class="input-row"><label for="f-sy">Start Date Year</label><select id="f-sy"><option value=""></option>${[2020, 2021, 2022, 2023, 2024, 2025].map((y) => `<option>${y}</option>`).join('')}</select></div>
           <div class="input-row"><input type="checkbox" id="f-current"><label for="f-current">I currently work here</label></div>`
        : `<div class="input-row"><label for="f-school">School</label><input id="f-school" type="text" required></div>
           <div class="input-row"><label for="f-degree">Degree</label><select id="f-degree"><option value=""></option><option>Associate's Degree</option><option>Bachelor's Degree</option><option>Master's Degree</option></select></div>
           <div class="input-row"><label for="f-major">Major</label><input id="f-major" type="text"></div>`;
    form.insertAdjacentHTML('beforeend', '<div class="buttons"><button type="button" class="cancel">Cancel</button><button type="button" class="save">Save</button></div>');
    form.querySelector('.cancel')!.addEventListener('click', () => form.remove());
    form.querySelector('.save')!.addEventListener('click', () => {
      const values: Record<string, string> = {};
      for (const el of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'))) {
        values[el.id] = el instanceof HTMLInputElement && el.type === 'checkbox' ? String(el.checked) : el.value;
      }
      if (Array.from(form.querySelectorAll<HTMLInputElement>('[required]')).some((x) => !x.value)) return; // stays open
      saved.push({ kind, ...values });
      form.remove();
      timeline.insertAdjacentHTML('beforeend', `<div class="card">${values['f-title'] ?? values['f-degree']} — ${values['f-employer'] ?? values['f-school']}</div>`);
    });
    timeline.appendChild(form);
  }

  beforeEach(() => {
    saved = [];
    document.body.innerHTML = `<form>
      <h2>Experience</h2>
      <div class="buttons">
        <button type="button" id="timeline-add-experience-button" class="apply-flow-profile-item-button"><span class="apply-flow-profile-item-button__label">Add Experience</span></button>
        <button type="button" id="timeline-add-education-button" class="apply-flow-profile-item-button"><span class="apply-flow-profile-item-button__label">Add Education</span></button>
      </div>
      <div id="timeline"></div>
    </form>`;
    document.getElementById('timeline-add-experience-button')!.addEventListener('click', () => entryForm('exp'));
    document.getElementById('timeline-add-education-button')!.addEventListener('click', () => entryForm('edu'));
  });

  it('adds each job and school from the profile through its form, and saves it', async () => {
    const report = await run({ ...base, profile: profile(), autoAdvance: false, autopilot: true, agreeToTerms: true });
    expect(saved).toEqual([
      { kind: 'exp', 'f-title': 'Software Engineer', 'f-employer': 'Acme Corp', 'f-sm': '6', 'f-sy': '2023', 'f-current': 'true' },
      { kind: 'edu', 'f-school': 'Example State University', 'f-degree': "Bachelor's Degree", 'f-major': 'Computer Science' },
    ]);
    expect(document.querySelectorAll('.profile-item-form')).toHaveLength(0);
    expect(report.fields.filter((f) => /^(Work|Education) 1$/.test(f.label))).toMatchObject([
      { status: 'filled', reason: 'Added' },
      { status: 'filled', reason: 'Added' },
    ]);
  }, 60000);

  it('does not add a job that is already on the page', async () => {
    document.getElementById('timeline')!.innerHTML = '<div class="card">Software Engineer — Acme Corp</div>';
    await run({ ...base, profile: profile(), autoAdvance: false, autopilot: true, agreeToTerms: true });
    expect(saved.map((s) => s.kind)).toEqual(['edu']);
  }, 60000);
});
