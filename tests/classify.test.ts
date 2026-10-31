import { classify, resolve } from '../src/engine/answers';
import type { Field } from '../src/engine/fields';
import { exampleProfile } from './helpers';

const f = (label: string, hints = '', kind: Field['kind'] = 'text'): Field => ({
  id: 'x',
  kind,
  el: document.createElement('input'),
  label,
  hints,
  required: false,
});

const key = (label: string, hints = '') => classify(f(label, hints), [], [])?.key;

describe('classify', () => {
  it.each([
    ['First Name', 'firstName'],
    ['Preferred First Name', 'preferredFirstName'],
    ['Last Name', 'lastName'],
    ['Full name', 'fullName'],
    ['Name', 'fullName'],
    ['Email Address', 'email'],
    ['Phone', 'phone'],
    ['Phone Device Type', 'phoneType'],
    ['Country Phone Code', 'phoneCountryCode'],
    ['Address Line 1', 'address1'],
    ['Postal Code', 'postalCode'],
    ['County', 'county'],
    ['Country', 'country'],
    ['State', 'state'],
    ['City', 'city'],
    ['Location (City)', 'location'],
    ['LinkedIn Profile', 'linkedin'],
    ['GitHub URL', 'github'],
    ['Website', 'portfolio'],
    ['Are you legally authorized to work in the United States?', 'workAuthorized'],
    ['Will you now or in the future require sponsorship for employment visa status (e.g. H-1B)?', 'sponsorship'],
    ['Are you Hispanic/Latino?', 'hispanic'],
    ['Race', 'ethnicity'],
    ['Gender', 'gender'],
    ['Veteran Status', 'veteran'],
    ['Disability Status', 'disability'],
    ['How did you hear about this job?', 'howDidYouHear'],
    ['What are your salary expectations?', 'salary'],
    ['Current Company', 'currentCompany'],
    ['School', 'school'],
    ['Degree', 'degree'],
    ['Discipline', 'major'],
    ['I have read and agree to the privacy policy', 'consent'],
    ['Are you willing to relocate?', 'relocate'],
    ['Are you at least 18 years of age?', 'over18'],
  ])('%s -> %s', (label, expected) => {
    expect(key(label)).toBe(expected);
  });

  it('handles phrasing seen on live Lever forms', () => {
    expect(key('Name Pronunciation | How do you pronounce your name?')).not.toBe('pronouns');
    expect(key('Please tell us how you heard about this opportunity.')).toBe('howDidYouHear');
    expect(key('Which university are you currently attending or did you last attend?')).toBe('school');
  });

  it('flags citizenship questions about countries not in the profile', () => {
    const field = f('Are you a Singapore citizen?', '', 'radio');
    const c = classify(field, [], [])!;
    expect(c.key).toBe('citizen');
    expect(resolve(c, exampleProfile(), field)).toHaveProperty('flag');
  });

  it('does not treat a location question as the location field', () => {
    expect(key('Are you open to working at our location in Austin?')).not.toBe('location');
  });

  it('falls back to attributes when the label is empty', () => {
    expect(key('', 'first name')).toBe('firstName');
    expect(key('', 'systemfield email')).toBe('email');
  });

  it('prefers the answer bank for questions', () => {
    const c = classify(f('Have you previously worked for Acme?'), [{ pattern: 'previously worked for', answer: 'No' }], []);
    expect(c?.source).toBe('answer-bank');
  });

  it('uses learned answers for the exact question', () => {
    const c = classify(f('What is your favorite color?'), [], [{ pattern: 'What is your favorite color?', answer: 'Blue' }]);
    expect(c).toMatchObject({ source: 'learned', answer: 'Blue' });
  });

  it('answers SuccessFactors education questions from the school, not your address', () => {
    const p = exampleProfile();
    p.education = [
      { school: 'Georgia Tech', degree: 'Master of Science', major: 'CS', city: 'Atlanta', state: 'Georgia', current: true, end: { year: 2099 } },
      { school: 'IBA', degree: 'Bachelor of Science', major: 'CS', city: 'Karachi', state: 'Sindh', end: { year: 2025, month: 5 } },
    ];
    const ans = (label: string, kind: Field['kind'] = 'text') => {
      const field = f(label, '', kind);
      const c = classify(field, [], [])!;
      const r = resolve(c, p, field);
      return 'desired' in r ? r.desired.text : r;
    };
    expect(ans('Institution City')).toBe('Atlanta');
    expect(ans('Institution State')).toBe('Georgia');
    expect(ans('Institution Name')).toBe('Georgia Tech');
    // An in-progress master's hasn't been "obtained" yet.
    expect(ans('Highest Level of Education Obtained', 'select')).toBe('Bachelor of Science');
    expect(ans('Degree', 'select')).toBe('Master of Science');
  });

  it('answers job descriptions with one bullet per line', () => {
    expect(key('Job Description')).toBe('workDescription');
    expect(key('Role Description')).toBe('workDescription');
    const field = f('Job Description', '', 'textarea');
    const r = resolve(classify(field, [], [])!, exampleProfile(), field);
    expect('desired' in r && r.desired.text).toBe('• Built things.\n• Fixed other things.');
  });
});
