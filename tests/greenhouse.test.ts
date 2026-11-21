import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import Select from 'react-select';
import { pickDuration, startInDays } from '../src/engine/answers';
import { run } from '../src/engine/run';
import { exampleProfile } from './helpers';

// Greenhouse's new job boards (job-boards.greenhouse.io): start-date questions
// whose options are ranges, in a react-select; and a resume box that swaps
// itself for a progress bar while it uploads, and puts "Attach" back if the
// upload fails.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const base = { learned: [], learn: false, overwrite: true, autoAdvance: false, onReport: () => {} };
const RANGES = [
  'Within two weeks of accepting.',
  'More than two weeks, but within 30 days of accepting.',
  'More than 30 days, but within 60 days of accepting.',
  'More than 60 days after accepting.',
];

describe('start date as ranges', () => {
  it('reads how soon you can start', () => {
    expect(startInDays('Within 2 months after offer acceptance')).toBe(60);
    expect(startInDays('Two weeks after offer acceptance')).toBe(14);
    expect(startInDays('Immediately')).toBe(0);
    expect(startInDays('Flexible')).toBeNull();
  });

  it('picks the range your answer falls in', () => {
    expect(pickDuration('Within 2 months after offer acceptance', RANGES)).toBe(RANGES[2]);
    expect(pickDuration('Two weeks after offer acceptance', RANGES)).toBe(RANGES[0]);
    expect(pickDuration('Immediately', RANGES)).toBe(RANGES[0]);
    expect(pickDuration('3 weeks', RANGES)).toBe(RANGES[1]);
    expect(pickDuration('Three months', RANGES)).toBe(RANGES[3]);
    expect(pickDuration('Within 2 months', ['Yes', 'No'])).toBeNull();
  });

  it('opens the react-select, sees the ranges and picks the right one', async () => {
    document.body.innerHTML = `<form><div class="field-wrapper"><label for="q1">If you receive and accept an offer, when would you be available to start?*</label><div id="root"></div></div></form>`;
    let picked: string | undefined;
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(
        createElement(Select, {
          inputId: 'q1',
          classNamePrefix: 'select',
          options: RANGES.map((o) => ({ value: o, label: o })),
          onChange: (v: { label: string } | null) => (picked = v?.label),
        } as never),
      );
    });
    const p = exampleProfile('swe');
    p.preferences.startAvailability = 'Within 2 months after offer acceptance';
    const report = await run({ ...base, profile: p });
    expect(picked).toBe(RANGES[2]);
    expect(report.fields.find((f) => /available to start/.test(f.label))).toMatchObject({ status: 'filled' });
  }, 30000);
});

describe('Greenhouse resume upload', () => {
  const resume = () => new File(['%PDF-1.4'], 'alex-resume.pdf', { type: 'application/pdf' });
  let failures = 0;
  let attempts = 0;

  /** The upload box: Attach + hidden input; on a file it becomes a progress bar, then the file name (or Attach again). */
  function box(): void {
    const group = document.getElementById('resume-group')!;
    group.innerHTML = `<div id="upload-label-resume" class="label upload-label">Resume/CV<span class="required">*</span></div>
      <div class="file-upload__wrapper"><button type="button" class="btn btn--pill">Attach</button>
      <label class="visually-hidden" for="resume">Attach</label><input id="resume" class="visually-hidden" type="file" accept=".pdf"></div>`;
    const input = group.querySelector<HTMLInputElement>('#resume')!;
    input.addEventListener('change', () => {
      const name = input.files?.[0]?.name;
      if (!name) return;
      attempts++;
      group.querySelector('.file-upload__wrapper')!.innerHTML = '<div role="progressbar" aria-valuenow="0"><span style="width:0%"></span></div>';
      setTimeout(() => {
        if (failures > 0) {
          failures--;
          box(); // upload failed: back to Attach, with a new input
        } else {
          group.querySelector('.file-upload__wrapper')!.innerHTML = `<div class="file-upload__filename">${name}</div><button type="button" aria-label="Remove file">×</button>`;
        }
      }, 300);
    });
    // "Attach" opens the picker and starts over.
    group.querySelector('button')!.addEventListener('click', () => box());
  }

  beforeEach(() => {
    attempts = 0;
    document.body.innerHTML = `<form><label for="fn">First Name*</label><input id="fn">
      <div role="group" aria-labelledby="upload-label-resume" aria-required="true" class="file-upload" id="resume-group"></div></form>`;
    box();
  });

  it('attaches it, waiting through the progress bar without pressing Attach again', async () => {
    failures = 0;
    const report = await run({ ...base, profile: exampleProfile('swe'), resume: resume() });
    expect(attempts).toBe(1);
    expect(document.querySelector('.file-upload__filename')?.textContent).toBe('alex-resume.pdf');
    expect(report.fields.find((f) => f.key === 'resume')).toMatchObject({ status: 'filled' });
  }, 60000);

  it('tries once more when the upload fails and Attach comes back', async () => {
    failures = 1;
    const report = await run({ ...base, profile: exampleProfile('swe'), resume: resume() });
    expect(attempts).toBe(2);
    expect(document.querySelector('.file-upload__filename')?.textContent).toBe('alex-resume.pdf');
    expect(report.fields.find((f) => f.key === 'resume')).toMatchObject({ status: 'filled' });
  }, 60000);

  it('when it never takes, flags it and does not skip it next time as "uploaded earlier"', async () => {
    failures = 5;
    const first = await run({ ...base, profile: exampleProfile('swe'), resume: resume() });
    expect(first.fields.find((f) => f.key === 'resume')).toMatchObject({ status: 'flagged' });
    failures = 0;
    attempts = 0;
    const second = await run({ ...base, profile: exampleProfile('swe'), resume: resume() });
    expect(attempts).toBe(1);
    expect(second.fields.find((f) => f.key === 'resume')).toMatchObject({ status: 'filled' });
  }, 120000);
});

describe('Greenhouse education: an "Education" header in every block', () => {
  // As on job-boards.greenhouse.io: each school is an .education--form with its own
  // "Education" header and react-selects; "Add another" appends the next one.
  // Adding block 2 used to make its header the section start, hiding block 1, so
  // it looked like the add hadn't worked.
  const SCHOOLS = ['Big Tech University', 'Example State University', 'Other College'];
  const DEGREES = ["Bachelor's Degree", "Master's Degree", 'Doctorate'];
  const MAJORS = ['Computer Science', 'Mathematics'];
  let picked: Record<string, string>;

  function select(host: HTMLElement, id: string, options: string[]): Promise<void> {
    const root = createRoot(host);
    return act(async () => {
      root.render(
        createElement(Select, {
          inputId: id,
          classNamePrefix: 'select',
          options: options.map((o) => ({ value: o, label: o })),
          onChange: (v: { label: string } | null) => (picked[id] = v?.label ?? ''),
        } as never),
      );
    });
  }

  async function addBlock(): Promise<void> {
    const list = document.getElementById('edu-list')!;
    const i = list.children.length;
    const form = document.createElement('div');
    form.className = 'education--form';
    form.innerHTML = `<hr><div class="education--header"><p class="body body--medium">Education</p><button type="button" class="icon-button" aria-label="Remove education"></button></div>
      ${['school', 'degree', 'discipline']
        .map((k) => `<div class="select"><label id="${k}--${i}-label" for="${k}--${i}" class="label select__label">${k[0].toUpperCase() + k.slice(1)}</label><div class="rs" data-k="${k}"></div></div>`)
        .join('')}`;
    list.appendChild(form);
    const opts: Record<string, string[]> = { school: SCHOOLS, degree: DEGREES, discipline: MAJORS };
    for (const host of Array.from(form.querySelectorAll<HTMLElement>('.rs'))) await select(host, `${host.dataset.k}--${i}`, opts[host.dataset.k!]);
  }

  beforeEach(async () => {
    picked = {};
    document.body.innerHTML = `<form><label for="fn">First Name*</label><input id="fn">
      <div class="education--container"><div id="edu-list"></div><button class="add-another-button" type="button" id="add">Add another</button></div>
      <label for="li">LinkedIn Profile</label><input id="li"></form>`;
    await addBlock();
    document.getElementById('add')!.addEventListener('click', () => setTimeout(() => void addBlock(), 100));
  });

  it('adds the second school and fills both', async () => {
    const p = exampleProfile('swe');
    p.education = [
      { school: 'Big Tech University', degree: 'Master of Science', major: 'Computer Science', end: { year: 2026, month: 5 } },
      { school: 'Example State University', degree: 'Bachelor of Science', major: 'Computer Science', end: { year: 2023, month: 5 } },
    ];
    const report = await run({ ...base, profile: p });
    expect(document.querySelectorAll('.education--form')).toHaveLength(2);
    expect(picked).toMatchObject({
      'school--0': 'Big Tech University',
      'degree--0': "Master's Degree",
      'discipline--0': 'Computer Science',
      'school--1': 'Example State University',
      'degree--1': "Bachelor's Degree",
      'discipline--1': 'Computer Science',
    });
    expect(report.fields.find((f) => /Could not add/.test(f.reason ?? ''))).toBeUndefined();
  }, 60000);
});
