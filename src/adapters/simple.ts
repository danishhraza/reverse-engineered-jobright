import type { Adapter } from './types';
import type { Field } from '../engine/fields';

// Single-page ATSs. The generic engine does nearly all the work; these just
// pin down the resume input and detection.

const first = (sels: string[]) => {
  for (const s of sels) {
    const el = document.querySelector<HTMLInputElement>(s);
    if (el) return el;
  }
  return null;
};

export const greenhouse: Adapter = {
  name: 'Greenhouse',
  detect: (loc, doc) =>
    /(^|\.)greenhouse\.io$/.test(loc.hostname) ||
    !!doc.querySelector('#application_form, #application-form, form[action*="greenhouse"], #grnhse_app'),
  resumeInput: () =>
    first(['input#resume[type="file"]', '#resume_fieldset input[type="file"]', 'input[type="file"][name*="resume" i]', 'input[type="file"][id*="resume" i]']),
};

export const lever: Adapter = {
  name: 'Lever',
  detect: (loc) => /(^|\.)lever\.co$/.test(loc.hostname),
  resumeInput: () => first(['input#resume-upload-input', 'input[type="file"][name="resume"]']),
};

export const ashby: Adapter = {
  name: 'Ashby',
  detect: (loc, doc) => /(^|\.)ashbyhq\.com$/.test(loc.hostname) || !!doc.querySelector('[id^="_systemfield_"]'),
  resumeInput: () => first(['input#_systemfield_resume', 'input[type="file"][id*="resume" i]']),
};

export const generic: Adapter = {
  name: 'Generic',
  detect: () => true,
  resumeInput: (_fields: Field[]) => null,
};
