import { readFileSync } from 'node:fs';
import { validateStore } from '../src/profile/merge';

// The page side of autopilot on sign-up / sign-in pages, with storage faked.

const local: Record<string, unknown> = {};
(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.map((x) => [x, structuredClone(local[x])]));
      },
      set: async (o: Record<string, unknown>) => void Object.assign(local, structuredClone(o)),
    },
  },
  runtime: { sendMessage: async () => ({}) },
};

const { step } = await import('../src/content/autopilot');

const req = { profileId: 'swe', autoSubmit: false, accountKnown: false };
const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

beforeEach(() => {
  for (const k of Object.keys(local)) delete local[k];
  local.store = validateStore(JSON.parse(readFileSync('profiles/example.json', 'utf8')));
  local.account = { email: 'jobs@example.com', password: 'pa55-word!' };
  document.body.innerHTML = '';
});

describe('create account', () => {
  it('fills the sign-up form, agrees to the terms and presses Create Account', async () => {
    document.body.innerHTML = `
      <form><h2>Create Account</h2>
        <label for="em">Email Address *</label><input id="em" type="email" required>
        <label for="pw">Password *</label><input id="pw" type="password" required>
        <label for="pw2">Verify New Password *</label><input id="pw2" type="password" required>
        <label><input type="checkbox" id="tos" required> I agree to the Terms and Conditions and Privacy Policy *</label>
        <button type="button" id="go">Create Account</button>
      </form>`;
    let clicked = false;
    document.getElementById('go')!.addEventListener('click', () => (clicked = true));
    const out = await step(req, () => {});
    expect(val('em')).toBe('jobs@example.com');
    expect(val('pw')).toBe('pa55-word!');
    expect(val('pw2')).toBe('pa55-word!');
    expect((document.getElementById('tos') as HTMLInputElement).checked).toBe(true);
    expect(clicked).toBe(true);
    expect(out).toMatchObject({ kind: 'acted', accountCreated: true });
  }, 30000);

  it('goes to Create Account from a sign-in page on a new site', async () => {
    document.body.innerHTML = `
      <form><h2>Sign In</h2><label for="em">Email</label><input id="em"><label for="pw">Password</label><input id="pw" type="password"><button type="button">Sign In</button></form>
      <a href="#" id="create">Create Account</a>`;
    let went = false;
    document.getElementById('create')!.addEventListener('click', () => (went = true));
    const out = await step(req, () => {});
    expect(went).toBe(true);
    expect(out).toMatchObject({ kind: 'acted' });
    expect(val('pw')).toBe('');
  }, 30000);

  it('signs in on a site it already made an account on', async () => {
    document.body.innerHTML = `
      <form><h2>Sign In</h2><label for="em">Email</label><input id="em"><label for="pw">Password</label><input id="pw" type="password"><button type="button" id="si">Sign In</button></form>
      <a href="#">Create Account</a>`;
    let signedIn = false;
    document.getElementById('si')!.addEventListener('click', () => (signedIn = true));
    const out = await step({ ...req, accountKnown: true }, () => {});
    expect(val('em')).toBe('jobs@example.com');
    expect(val('pw')).toBe('pa55-word!');
    expect(signedIn).toBe(true);
    expect(out).toMatchObject({ kind: 'acted' });
  }, 30000);

  it('hands a failed sign-in to you instead of retrying', async () => {
    document.body.innerHTML = `<form><h2>Sign In</h2><p role="alert">Invalid email or password.</p><label for="em">Email</label><input id="em"><label for="pw">Password</label><input id="pw" type="password"><button>Sign In</button></form>`;
    expect(await step({ ...req, accountKnown: true }, () => {})).toMatchObject({ kind: 'needs-you', reason: expect.stringMatching(/Sign-in failed/) });
  });

  it('asks you to save a login when none is saved', async () => {
    local.account = {};
    document.body.innerHTML = `<form><label for="em">Email</label><input id="em"><label for="pw">Password</label><input id="pw" type="password"></form>`;
    expect(await step(req, () => {})).toMatchObject({ kind: 'needs-you', reason: expect.stringMatching(/Job site login/) });
  });
});

describe('pop-ups', () => {
  it('presses "Consent & Continue" on a privacy notice, not "Decline & Close"', async () => {
    document.body.innerHTML = `<h1>Analyst</h1><button>Apply</button>
      <div role="dialog" aria-modal="true"><h2>Privacy Policy</h2><button id="ok">Consent &amp; Continue</button><button id="no">Decline &amp; Close</button></div>`;
    const pressed: string[] = [];
    for (const id of ['ok', 'no']) document.getElementById(id)!.addEventListener('click', () => pressed.push(id));
    const out = await step(req, () => {});
    expect(pressed).toEqual(['ok']);
    expect(out).toMatchObject({ kind: 'acted', action: expect.stringMatching(/Consent & Continue/) });
  });
});

describe('Apply buttons', () => {
  it('opens a plain Apply link in the job tab instead of clicking it', async () => {
    document.body.innerHTML = '<h1>Analyst</h1><a href="https://acme.com/careers/1">Apply now</a>';
    const out = await step(req, () => {});
    expect(out).toMatchObject({ kind: 'acted', navigate: 'https://acme.com/careers/1' });
  });
});
