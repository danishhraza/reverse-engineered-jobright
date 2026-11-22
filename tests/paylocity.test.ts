import { run } from '../src/engine/run';
import type { Profile } from '../src/types';
import { exampleProfile } from './helpers';

// Paylocity (recruiting.paylocity.com): each job in Work History asks for the
// employer's own address and phone, whether they may contact it for a
// reference, and the supervisor. Those come from that job's entry only; your
// home address and phone must never land there.

function profile(): Profile {
  const p = exampleProfile('swe');
  p.personal = { ...p.personal, phone: '(555) 010-0100', address1: '100 Example Road', city: 'Austin', state: 'Texas', postalCode: '73301', country: 'United States' };
  p.work = [
    {
      company: 'Example Labs', title: 'Associate Software Consultant', current: true, start: { year: 2025, month: 12 },
      country: 'Pakistan', city: 'Karachi', state: 'Sindh', address1: '2nd Floor, 1 Example Avenue', phone: '+92 21 0000000',
      reference: { name: 'Jane Roe', title: 'Project Manager' },
    },
    { company: 'Sample School Co', title: 'Full Stack Developer', country: 'Pakistan', start: { year: 2024, month: 6 }, end: { year: 2025, month: 5 } },
  ];
  return p;
}

let n = 0;
const opt = (xs: string[]) => xs.map((x) => `<option>${x}</option>`).join('');
function job(): string {
  const i = ++n;
  const field = (id: string, label: string, input = `<input id="${id}${i}">`) => `<div><label for="${id}${i}">${label}</label>${input}</div>`;
  return `<div class="job">
    ${field('co', 'Company Name *')}
    ${field('pos', 'Position *')}
    ${field('cph', 'Company Phone Number')}
    ${field('ctry', 'Country', `<select id="ctry${i}">${opt(['United States', 'Pakistan', 'Canada'])}</select>`)}
    ${field('a1', 'Address Line 1')}
    ${field('a2', 'Address Line 2')}
    ${field('city', 'City')}
    ${field('cnty', 'County')}
    ${field('zip', 'Zip Code')}
    ${field('mc', 'May We Contact for Reference?', `<select id="mc${i}"><option value="">Select</option>${opt(['Yes', 'No'])}</select>`)}
    ${field('sn', 'Supervisor Name')}
    ${field('sp', 'Supervisor Phone Number')}
  </div>`;
}

const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
const base = { learned: [], learn: false, overwrite: true, autoAdvance: false, onReport: () => {} };

beforeEach(() => {
  n = 0;
  document.body.innerHTML = `<form>
    <h2>Contact Information</h2>
    <div><label for="mob">Mobile Number</label><input id="mob" type="tel"></div>
    <div><label for="home1">Address Line 1</label><input id="home1"></div>
    <div><label for="homecity">City</label><input id="homecity"></div>
    <div><label for="homezip">Zip Code</label><input id="homezip"></div>
    <h2>Work History</h2>
    <div id="jobs">${job()}${job()}</div>
    <a href="#" id="addJob">Add another</a>
  </form>`;
});

describe('Paylocity work history', () => {
  it("fills each job from its own entry, never from your home address", async () => {
    await run({ ...base, profile: profile() });

    // Your own details, outside the jobs.
    expect(val('mob')).toBe('5550100100');
    expect(val('home1')).toBe('100 Example Road');
    expect(val('homecity')).toBe('Austin');

    // Job 1: the office and its reference.
    expect(val('co1')).toBe('Example Labs');
    expect(val('cph1')).toBe('+92 21 0000000');
    expect(val('ctry1')).toBe('Pakistan');
    expect(val('a11')).toBe('2nd Floor, 1 Example Avenue');
    expect(val('city1')).toBe('Karachi');
    expect(val('zip1')).toBe(''); // not known: left blank, not your zip
    expect(val('cnty1')).toBe('');
    expect(val('mc1')).toBe('Yes');
    expect(val('sn1')).toBe('Jane Roe');
    expect(val('sp1')).toBe(''); // you add her number yourself

    // Job 2: no reference, no address of its own.
    expect(val('co2')).toBe('Sample School Co');
    expect(val('ctry2')).toBe('Pakistan');
    expect(val('mc2')).toBe('No');
    expect(val('sn2')).toBe('');
    for (const id of ['cph2', 'a12', 'city2', 'zip2', 'sp2']) expect(val(id)).toBe('');
  }, 60000);
});
