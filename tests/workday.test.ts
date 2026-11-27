import { readFileSync } from 'node:fs';
import { validateStore } from '../src/profile/merge';
import { run } from '../src/engine/run';
import type { Profile } from '../src/types';
import { exampleProfile } from './helpers';

// Workday's apply flow (*.myworkdayjobs.com): a "Voluntary Disclosures" page that has
// only dropdown buttons and a checkbox; Work Experience / Education panels that
// Workday also fills from your resume in the background.

(globalThis as any).chrome = {
  storage: { local: { get: async () => ({ store: validateStore(JSON.parse(readFileSync('profiles/example.json', 'utf8'))) }), set: async () => {} } },
  runtime: { sendMessage: async () => ({}) },
};
const { probe } = await import('../src/content/autopilot');

const base = { learned: [], learn: false, overwrite: true, autoAdvance: false, onReport: () => {} };
const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

describe('Voluntary Disclosures page', () => {
  it('is recognised as part of the application (only dropdowns and a checkbox on it)', () => {
    document.body.innerHTML = `<div data-automation-id="applyFlowPage"><h2>Software Engineer I</h2><h3>Voluntary Disclosures</h3>
      ${['gender', 'hispanicOrLatino', 'ethnicity', 'veteranStatus']
        .map((k, i) => {
          const label = ['Please self identify Gender.', 'Are you of Hispanic or Latino heritage?', 'Please self identify Race/Ethnicity.', 'Please self identify Veteran Status.'][i];
          return `<div data-automation-id="formField-${k}"><label for="pi--${k}">${label}</label><button aria-haspopup="listbox" type="button" id="pi--${k}" name="${k}">Select One</button></div>`;
        })
        .join('')}
      <div data-automation-id="formField-acceptTermsAndAgreements"><label for="tc">Yes, I have read and consent to the terms and conditions*</label><input id="tc" type="checkbox" aria-required="true"></div>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button></div>`;
    expect(probe().kind).toBe('form');
  });
});

describe('My Experience panels', () => {
  function profile(): Profile {
    const p = exampleProfile('swe');
    p.work = [{ company: 'Example Labs', title: 'Associate Software Consultant', current: true, start: { year: 2025, month: 12 } }];
    p.education = [{ school: 'Example University', degree: 'Master of Science', major: 'Computer Science', end: { year: 2027, month: 5 } }];
    return p;
  }

  beforeEach(() => {
    const opts = (xs: string[]) => `<option value="">Select One</option>${xs.map((x) => `<option>${x}</option>`).join('')}`;
    document.body.innerHTML = `<div data-automation-id="applyFlowPage">
      <section><h3>Work Experience</h3>
        <div role="group" data-automation-id="workExperience-1"><h4>Work Experience 1</h4>
          <label for="jt">Job Title*</label><input id="jt">
          <label for="co">Company*</label><input id="co">
        </div>
        <button data-automation-id="add-button">Add Another</button></section>
      <section><h3>Education</h3>
        <div role="group" data-automation-id="education-1"><h4>Education 1</h4>
          <label for="sc">School or University</label><input id="sc">
          <label for="fos">Field of Study</label><select id="fos">${opts(['Biology', 'Computer and Information Science', 'Computer Engineering Technology', 'Economics'])}</select>
        </div>
        <button data-automation-id="add-button">Add Another</button></section>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button></div>`;
    // Workday's resume reading rewrites the job title a moment after we type ours.
    const jt = document.getElementById('jt') as HTMLInputElement;
    let rewritten = false;
    jt.addEventListener('input', () => {
      if (rewritten) return;
      rewritten = true;
      setTimeout(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(jt, 'Azure Cloud Services');
        jt.dispatchEvent(new Event('input', { bubbles: true }));
      }, 300);
    });
  });

  it('picks the closest Field of Study and puts the job title back after Workday changes it', async () => {
    await run({ ...base, profile: profile() });
    expect(val('fos')).toBe('Computer and Information Science');
    expect(val('jt')).toBe('Associate Software Consultant');
    expect(val('co')).toBe('Example Labs');
  }, 60000);
});
