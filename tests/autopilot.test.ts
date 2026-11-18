import { run } from '../src/engine/run';
import type { AiAsk } from '../src/engine/fill';
import { applyButton } from '../src/engine/nav';
import { jobsFromCsv, parseCsv, sameJob } from '../src/queue/csv';
import { buildPrompt, parseAnswer } from '../src/llm/openrouter';
import { profileFacts } from '../src/llm/facts';
import { probe } from '../src/content/autopilot';
import { exampleProfile } from './helpers';

const base = { learned: [], learn: false, overwrite: true, onReport: () => {} };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('CSV', () => {
  it('handles quotes, commas and newlines inside cells', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ]);
  });

  it('maps header names and skips rows without a link', () => {
    const { jobs, skipped } = jobsFromCsv('Job Title,Apply Link,Company,Profile\nPM,https://x.com/1,Acme,Product\nBA,not a link,Foo,\n');
    expect(jobs).toEqual([{ title: 'PM', url: 'https://x.com/1', company: 'Acme', profile: 'Product' }]);
    expect(skipped).toBe(1);
  });

  it('takes bare pasted links without a header', () => {
    expect(jobsFromCsv('https://a.com/j/1\n\nhttps://b.com/j/2\n').jobs.map((j) => j.url)).toEqual(['https://a.com/j/1', 'https://b.com/j/2']);
  });

  it('treats tracking parameters as the same posting', () => {
    expect(sameJob('https://boards.greenhouse.io/acme/jobs/1?gh_src=abc&utm_source=li', 'https://boards.greenhouse.io/acme/jobs/1/')).toBe(true);
    expect(sameJob('https://x.com/jobs?id=1', 'https://x.com/jobs?id=2')).toBe(false);
  });
});

describe('AI prompt and reply', () => {
  it('reads JSON even inside a code fence, and clamps confidence', () => {
    expect(parseAnswer('```json\n{"answer": "No", "confidence": 1.4}\n```')).toEqual({ answer: 'No', confidence: 1 });
    expect(parseAnswer('I think no')).toBeNull();
  });

  it('gives the model the options, standing answers and profile facts, without contact details', () => {
    const p = exampleProfile('swe');
    const facts = profileFacts(p);
    expect(facts).not.toContain(p.personal.email);
    expect(facts).not.toContain(p.personal.phone);
    const prompt = buildPrompt({ question: 'Relatives at Acme?', kind: 'select', options: ['Yes', 'No'], required: true }, { facts, job: 'Acme' }, 'No relatives anywhere.');
    expect(prompt).toContain('- Yes\n- No');
    expect(prompt).toContain('No relatives anywhere.');
    expect(prompt).toContain('Work history:');
  });
});

describe('AI answers in a fill', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <div><label for="fn">First Name</label><input id="fn"></div>
        <div><label for="rel">Do you have any relatives currently employed by Acme Corp? *</label>
          <select id="rel" required><option value="">Select</option><option>Yes</option><option>No</option></select></div>
        <div><label for="col">What is your favorite color? *</label><input id="col" required></div>
        <div><label for="hear">How did you hear about this position? *</label>
          <select id="hear" required><option value="">Select</option><option>Company website</option><option>Career fair</option><option>Other</option></select></div>
      </form>`;
  });

  it('fills what the model is sure of, and only suggests what it is not', async () => {
    const asked: string[] = [];
    const ai: AiAsk = async (q) => {
      asked.push(q.question);
      if (/relatives/.test(q.question)) return { answer: 'No', confidence: 0.95 };
      if (/hear/.test(q.question)) return { answer: 'Other', confidence: 0.8 };
      return { answer: 'Blue', confidence: 0.3 };
    };
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false, ai });
    expect((document.getElementById('rel') as HTMLSelectElement).value).toBe('No');
    expect(report.fields.find((f) => /relatives/.test(f.label))?.reason).toMatch(/Answered by AI/);
    // Not in the profile, so the model picked one of the site's options.
    expect((document.getElementById('hear') as HTMLSelectElement).value).toBe('Other');
    expect((document.getElementById('col') as HTMLInputElement).value).toBe('');
    expect(report.fields.find((f) => /color/.test(f.label))).toMatchObject({ status: 'flagged', reason: expect.stringMatching(/suggests "Blue"/) });
    expect(asked).not.toContain('First Name');
  });

  it("rejects an answer that isn't one of the options", async () => {
    const ai: AiAsk = async () => ({ answer: 'Nope', confidence: 0.9 });
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false, ai });
    expect((document.getElementById('rel') as HTMLSelectElement).value).toBe('');
    expect(report.fields.find((f) => /relatives/.test(f.label))?.reason).toMatch(/isn't one of the options/);
  });
});

describe('multi-step forms without an adapter (autopilot)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <section id="s1"><h2>Step 1: About you</h2>
          <div><label for="fn">First Name</label><input id="fn"></div>
          <div><label for="ln">Last Name</label><input id="ln"></div>
          <button type="button" id="next">Next</button></section>
        <section id="s2" hidden><h2>Step 2: Contact</h2>
          <div><label for="em">Email</label><input id="em" type="email"></div>
          <div class="row"><label><input type="checkbox" id="cert"> I certify that the information provided is true</label></div>
          <button type="button" id="sub">Submit Application</button></section>
      </form>`;
    document.getElementById('next')!.addEventListener('click', () => {
      document.getElementById('s1')!.hidden = true;
      document.getElementById('s2')!.hidden = false;
    });
  });

  it('clicks Next and stops at Submit', async () => {
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: true, autopilot: true });
    expect(report.stop).toBe('final');
    expect((document.getElementById('em') as HTMLInputElement).value).toBe('alex@example.com');
    // Without "agree to terms" the certification stays for you.
    expect((document.getElementById('cert') as HTMLInputElement).checked).toBe(false);
  }, 40000);

  it('ticks the certification when told to agree (auto-submit)', async () => {
    await run({ ...base, profile: exampleProfile('swe'), autoAdvance: true, autopilot: true, agreeToTerms: true });
    expect((document.getElementById('cert') as HTMLInputElement).checked).toBe(true);
  }, 40000);

  it('stays on page 1 for a normal fill', async () => {
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: true });
    expect(report.stop).toBe('no-next');
    expect(document.getElementById('s2')!.hidden).toBe(true);
  }, 40000);
});

describe('what a page is (probe)', () => {
  const kind = (html: string) => {
    document.body.innerHTML = html;
    return probe().kind;
  };

  it('job posting with an Apply button', () => {
    expect(kind('<h1>Analyst</h1><p>Great job.</p><a href="https://x.com/apply">Apply now</a>')).toBe('apply');
  });
  it('prefers "Apply on company site" and skips "Apply with LinkedIn"', () => {
    document.body.innerHTML = '<button>Apply with LinkedIn</button><a href="/x">Apply on company site</a>';
    expect(applyButton()?.textContent).toBe('Apply on company site');
    document.body.innerHTML = '<button>Apply with LinkedIn</button>';
    expect(applyButton()).toBeNull();
  });
  it('sign-in / sign-up page', () => {
    expect(kind('<form><label for="e">Email</label><input id="e"><label for="p">Password</label><input id="p" type="password"><button>Sign In</button></form>')).toBe('account');
  });
  it('email verification', () => {
    expect(kind('<h1>Verify your email</h1><p>We have sent you an email with a link.</p>')).toBe('verify');
  });
  it('confirmation page', () => {
    expect(kind('<h1>Thank you for applying!</h1><p>We will be in touch.</p>')).toBe('applied');
  });
  it('closed posting', () => {
    expect(kind('<h1>Sorry</h1><p>This job is no longer accepting applications.</p>')).toBe('closed');
  });
  it('visible CAPTCHA, but not the invisible badge', () => {
    expect(kind('<iframe src="https://www.google.com/recaptcha/api2/anchor?size=normal" style="width:300px;height:80px"></iframe><input><input><input>')).toBe('captcha');
    expect(kind('<iframe src="https://www.google.com/recaptcha/api2/anchor?size=invisible"></iframe><p>hi</p>')).toBe('none');
  });
  it('application form', () => {
    expect(
      kind('<form><label for="a">First Name</label><input id="a"><label for="b">Last Name</label><input id="b"><label for="c">Email</label><input id="c"><button>Apply</button></form>'),
    ).toBe('form');
  });
});
