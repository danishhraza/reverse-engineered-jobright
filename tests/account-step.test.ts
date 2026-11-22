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

  it("leaves Workday's bot trap empty (filling it makes Create Account do nothing)", async () => {
    // As on medtronic.wd1.myworkdayjobs.com: a hidden "website" box for robots.
    document.body.innerHTML = `
      <form><h2>Create Account</h2>
        <label for="em">Email Address *</label><input id="em" type="email" required>
        <label for="pw">Password *</label><input id="pw" type="password" required>
        <label for="pw2">Verify New Password *</label><input id="pw2" type="password" required>
        <div class="css-1l3dlbk"><label for="bee" class="css-i19yjz">Enter website. This input is for robots only, do not enter if you're human.</label><input data-automation-id="beecatcher" id="bee" name="website" type="text"></div>
        <label for="hp">Leave this field blank</label><input id="hp" name="contact_me" value="https://spam.example">
        <label><input type="checkbox" id="tos" required> I acknowledge *</label>
        <button type="button" id="go">Create Account</button>
      </form>`;
    let clicked = false;
    document.getElementById('go')!.addEventListener('click', () => (clicked = true));
    const out = await step(req, () => {});
    expect(val('em')).toBe('jobs@example.com');
    expect(val('bee')).toBe('');
    expect(val('hp')).toBe(''); // something already in a trap is emptied
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

describe('Ready application not reviewed in time', () => {
  it('ticks the required certification, presses Submit and sees the confirmation', async () => {
    const { submitReady } = await import('../src/content/autopilot');
    document.body.innerHTML = `<form id="f"><h2>Review &amp; Submit</h2>
      <label><input type="checkbox" id="cert" required> I certify that the information I provided is true and complete *</label>
      <button type="button" id="sub">Submit Application</button></form>`;
    document.getElementById('sub')!.addEventListener('click', () => {
      if ((document.getElementById('cert') as HTMLInputElement).checked) document.body.innerHTML = '<h1>Thank you for applying!</h1>';
    });
    const out = await submitReady('swe', () => {});
    expect(out).toMatchObject({ kind: 'applied' });
  }, 40000);

  it('does nothing in a frame without a Submit button', async () => {
    const { submitReady } = await import('../src/content/autopilot');
    document.body.innerHTML = '<p>ads</p>';
    expect(await submitReady('swe', () => {})).toBeNull();
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

  it('finds iCIMS\'s "Apply for this job online" (long and short labels side by side)', async () => {
    // As on jobs-bylight.icims.com, inside the in_iframe=1 frame.
    document.body.innerHTML = `<div class="iCIMS_JobOptions"><h1>Software Engineer I</h1>
      <a href="https://jobs-bylight.icims.com/jobs/12239/software-engineer-i/job?mode=apply&apply=yes&in_iframe=1" class="iCIMS_Anchor iCIMS_Action_Button iCIMS_ApplyOnlineButton" title="Apply for this job online"><div class="iCIMS_Action_ButtonText"><span class="iCIMS_LongLabel">Apply for this job online</span><span class="iCIMS_ShortLabel" style="display:none">Apply</span></div></a>
      <a href="#" class="iCIMS_Action_Button">Share</a></div>`;
    const out = await step(req, () => {});
    expect(out).toMatchObject({ kind: 'acted', navigate: 'https://jobs-bylight.icims.com/jobs/12239/software-engineer-i/job?mode=apply&apply=yes&in_iframe=1' });
  });

  it('opens SuccessFactors\' "Apply now ▾" menu and clicks its plain Apply Now', async () => {
    // As on careers.leonardodrs.com: the plain link is hidden; the button is a Bootstrap
    // dropdown whose "Apply Now" (href="#") is handled by a script.
    document.body.innerHTML = `<h1>Embedded Software Engineer Intern</h1>
      <a class="btn apply dialogApplyBtn" style="display:none" href="/talentcommunity/apply/1416974200/">Apply now »</a>
      <div class="btn-group btn-social btn-social-apply">
        <button class="btn btn-primary dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-label="Apply now" aria-expanded="false" id="tgl">Apply now <span class="caret"></span></button>
        <ul class="dropdown-menu" hidden>
          <li role="none"><a role="menuitem" href="#" id="manual" aria-label="Apply Now"> Apply Now </a><a href="javascript:alert('help')" aria-label="Apply now Help" title="Apply now Help"><img aria-label="Apply now Help" src="x.png"></a></li>
          <li role="none"><a role="menuitem" href="#" id="li" aria-label="Apply with LinkedIn">Apply with LinkedIn</a></li>
        </ul>
      </div>`;
    const tgl = document.getElementById('tgl')!;
    const menu = document.querySelector('ul')!;
    let toggles = 0;
    tgl.addEventListener('click', () => {
      toggles++;
      menu.hidden = !menu.hidden;
      tgl.setAttribute('aria-expanded', String(!menu.hidden));
    });
    let applied = '';
    document.getElementById('manual')!.addEventListener('click', (e) => {
      e.preventDefault();
      applied = 'manual';
    });
    document.getElementById('li')!.addEventListener('click', () => (applied = 'linkedin'));
    const out = await step(req, () => {});
    expect(toggles).toBe(1); // opened once, not toggled shut again
    expect(applied).toBe('manual');
    expect(out).toMatchObject({ kind: 'acted' });
    expect(out).not.toHaveProperty('navigate');
  });
});
