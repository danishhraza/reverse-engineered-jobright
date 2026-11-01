import { run } from '../src/engine/run';
import type { Profile } from '../src/types';
import { exampleProfile } from './helpers';

// Taleo-style pages: a "do you want to upload a resume?" choice before the
// file input exists, an Upload button to press after picking the file, and
// account sign-up pages.

const resume = () => new File(['%PDF-1.4'], 'alex-resume.pdf', { type: 'application/pdf' });
const base = { learned: [], learn: false, overwrite: true, autoAdvance: false, onReport: () => {} };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('resume choice', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <fieldset><legend>Resume Selection</legend>
          <label><input type="radio" name="rs" value="up" id="up"> I want to upload my resume</label>
          <label><input type="radio" name="rs" value="no"> I want to continue without a resume</label>
        </fieldset>
        <div id="slot"></div>
        <div><label for="fn">First Name</label><input id="fn"></div>
        <div><label for="ln">Last Name</label><input id="ln"></div>
      </form>`;
    // Choosing "upload" reveals the file input and an Upload button; the file only counts once Upload is pressed.
    document.getElementById('up')!.addEventListener('change', () => {
      const slot = document.getElementById('slot')!;
      slot.innerHTML = '<label for="rf">Resume file</label><input type="file" id="rf"><button type="button" id="ub">Upload</button><span id="done"></span>';
      document.getElementById('ub')!.addEventListener('click', () => {
        const f = (document.getElementById('rf') as HTMLInputElement).files?.[0];
        if (f) document.getElementById('done')!.textContent = `${f.name} uploaded`;
      });
    });
  });

  it('picks "upload my resume", attaches the file and presses Upload', async () => {
    const navigations: number[] = [];
    const report = await run({ ...base, profile: exampleProfile('swe'), resume: resume(), onNavigate: (p) => navigations.push(p) });
    expect((document.getElementById('up') as HTMLInputElement).checked).toBe(true);
    expect(document.getElementById('done')!.textContent).toBe('alex-resume.pdf uploaded');
    expect(report.fields.find((f) => f.key === 'resume')?.status).toBe('filled');
    // Told the background twice that the page might reload (the choice, then Upload).
    expect(navigations.length).toBe(2);
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('Alex');
  }, 30000);

  it('leaves the choice alone when there is no resume file', async () => {
    await run({ ...base, profile: exampleProfile('swe') });
    expect((document.getElementById('up') as HTMLInputElement).checked).toBe(false);
  }, 30000);
});

describe('job-site login pages', () => {
  const withAccount = (account: Profile['account']): Profile => ({ ...exampleProfile('swe'), account });

  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <div><label for="un">User Name</label><input id="un"></div>
        <div><label for="em">Email Address</label><input id="em" type="email"></div>
        <div><label for="pw">Password</label><input id="pw" type="password"></div>
        <div><label for="pw2">Re-enter Password</label><input id="pw2" type="password"></div>
      </form>`;
  });

  const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

  it('fills the saved login and never shows the password in the report', async () => {
    const report = await run({ ...base, profile: withAccount({ email: 'jobs@example.com', password: 's3cret!' }) });
    expect(val('un')).toBe('jobs@example.com');
    expect(val('em')).toBe('jobs@example.com'); // the login email, not the profile email
    expect(val('pw')).toBe('s3cret!');
    expect(val('pw2')).toBe('s3cret!');
    expect(JSON.stringify(report)).not.toContain('s3cret!');
    expect(report.fields.filter((f) => f.key === 'password').every((f) => f.status === 'filled' && f.value === '••••••••')).toBe(true);
  }, 30000);

  it('flags the password when none is saved', async () => {
    const report = await run({ ...base, profile: withAccount({}) });
    expect(val('pw')).toBe('');
    expect(report.fields.find((f) => f.key === 'password')?.reason).toMatch(/Options/);
    expect(val('em')).toBe('alex@example.com');
  }, 30000);
});
