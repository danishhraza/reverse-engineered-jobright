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

describe('ADP-style contact page', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <div class="f"><span>Mobile Number*</span>
          <div class="iti"><button type="button" aria-haspopup="listbox" aria-label="Mobile Number" id="flag">🇺🇸</button>
          <input type="tel" id="mob" aria-label="Mobile Number" required></div></div>
        <div class="f"><label><input type="checkbox" id="sms"> (Optional) I would like to receive text messages to this number about my job application.</label></div>
        <div class="f"><label for="home">Home Phone Number</label><input type="tel" id="home"></div>
        <div class="field"><label id="cl">Country *</label>
          <div class="wrap"><div role="combobox" aria-haspopup="listbox" aria-labelledby="cl" tabindex="0" id="cty"></div><span class="shown"></span></div></div>
        <div class="f"><label for="city">City *</label><input id="city" required></div>
        <div class="f"><label for="st">State / Territory *</label>
          <select id="st" required><option value="">Select</option><option>IA - Iowa</option><option>IL - Illinois</option><option>TX - Texas</option></select></div>
        <div class="f"><label for="zip">Zip Code *</label><input id="zip" required></div>
        <div class="f"><label for="county">County</label><input id="county"></div>
      </form>`;
    // A dropdown that shows the chosen value in a sibling, not in itself.
    const cty = document.getElementById('cty')!;
    cty.addEventListener('click', () => {
      if (document.getElementById('cty-list')) return;
      const ul = document.createElement('ul');
      ul.id = 'cty-list';
      ul.setAttribute('role', 'listbox');
      for (const c of ['Canada', 'United States']) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = c;
        li.addEventListener('click', () => {
          document.querySelector('.shown')!.textContent = c;
          ul.remove();
        });
        ul.appendChild(li);
      }
      document.body.appendChild(ul);
    });
  });

  it('fills the mobile number, leaves optional extras alone, and is not blocked by the flag picker', async () => {
    // The site pre-fills the dial code; re-picking the country would reset the number.
    (document.getElementById('mob') as HTMLInputElement).value = '+1 ';
    let flagClicks = 0;
    document.getElementById('flag')!.addEventListener('click', () => flagClicks++);
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false });
    expect(flagClicks).toBe(0);
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    expect(val('mob')).not.toBe('');
    expect(val('home')).toBe('');
    expect((document.getElementById('sms') as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector('.shown')!.textContent).toBe('United States');
    expect((document.getElementById('st') as HTMLSelectElement).selectedOptions[0].textContent).toBe('IL - Illinois');
    const blocking = report.fields.filter((f) => f.status === 'flagged' && f.required);
    expect(blocking.map((f) => `${f.label}: ${f.reason}`)).toEqual([]);
  }, 60000);
});

describe('"XX - State" options', () => {
  it('Texas / TX picks "TX - Texas"', async () => {
    const { matchOption } = await import('../src/engine/match');
    const m = matchOption(['Select', 'TN - Tennessee', 'TX - Texas'], { text: 'Texas', alts: ['TX'] });
    expect(m).toMatchObject({ index: 2 });
    expect(m!.score).toBeGreaterThanOrEqual(0.85);
  });
});

describe('Next anyway (autopilot)', () => {
  const page = (validates: boolean) => {
    document.body.innerHTML = `
      <form>
        <section id="s1"><h2>Step 1</h2>
          <div><label for="fn">First Name</label><input id="fn"></div>
          <div><label for="q">Favourite colour of the hiring manager? *</label><input id="q" required></div>
          <div id="err"></div>
          <button type="button" id="next">Next</button></section>
        <section id="s2" hidden><h2>Step 2</h2><div><label for="em">Email</label><input id="em"></div><button type="button">Submit Application</button></section>
      </form>`;
    document.getElementById('next')!.addEventListener('click', () => {
      if (validates && !(document.getElementById('q') as HTMLInputElement).value) {
        document.getElementById('err')!.innerHTML = '<p role="alert">This field is required</p>';
        return;
      }
      document.getElementById('s1')!.hidden = true;
      document.getElementById('s2')!.hidden = false;
    });
  };

  it('goes on when the site lets it', async () => {
    page(false);
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: true, autopilot: true });
    expect(report.stop).toBe('final');
    expect((document.getElementById('em') as HTMLInputElement).value).toBe('alex@example.com');
  }, 40000);

  it('stops for you when the site says the answer is required', async () => {
    page(true);
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: true, autopilot: true });
    expect(report.stop).toBe('blocked');
    expect(document.getElementById('s2')!.hidden).toBe(true);
  }, 40000);
});

describe('Yes / No found by their text', () => {
  it('answers Yes/No choices built from plain elements, with no inputs or roles to go on', async () => {
    document.body.innerHTML = `
      <form><h3>Please answer the following questions:</h3>
        <div class="q"><p>1. Are you legally authorized to work in the United States? *</p>
          <div class="opts"><span class="opt"><i class="dot"></i><span>Yes</span></span><span class="opt"><i class="dot"></i><span>No</span></span></div></div>
        <div class="q"><p>2. Will you now, or in the future, require sponsorship for employment visa status? *</p>
          <div class="opts"><span class="opt"><i class="dot"></i><span>Yes</span></span><span class="opt"><i class="dot"></i><span>No</span></span></div></div>
        <p>Already answered elsewhere:</p>
        <label><input type="radio" name="x" value="1"> Yes</label><label><input type="radio" name="x" value="0"> No</label>
      </form>`;
    for (const s of Array.from(document.querySelectorAll<HTMLElement>('.opt span'))) {
      s.addEventListener('click', () => {
        for (const o of Array.from(s.closest('.opts')!.querySelectorAll('.opt'))) o.classList.toggle('selected', o.contains(s));
      });
    }
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false });
    const chosen = (i: number) => document.querySelectorAll('.opts')[i].querySelector('.opt.selected')?.textContent;
    expect(chosen(0)).toBe('Yes');
    expect(chosen(1)).toBe('No');
    // The real radio group is still one field, not also picked up by the text fallback.
    expect(report.fields.filter((f) => /already answered/i.test(f.label))).toHaveLength(1);
  }, 30000);
});

describe('ADP address block', () => {
  let countryClicks = 0;
  /** Country is a custom dropdown showing its value beside itself; picking a country resets the address below. */
  function page(addressFilled: boolean) {
    countryClicks = 0;
    document.body.innerHTML = `
      <form>
        <div class="f"><label id="cl">Country *</label>
          <div class="sel"><div role="combobox" aria-haspopup="listbox" aria-labelledby="cl" tabindex="0" id="cty"></div><span class="val">United States</span><span>▾</span></div></div>
        <div class="f"><label for="a1">Address Line 1 is required *</label><input id="a1" placeholder="Enter a location" required></div>
        <div class="f"><label for="a2">Address Line 2</label><input id="a2"></div>
        <div class="f"><label for="city">City is required *</label><input id="city" required></div>
        <div class="f"><label for="zip">Zip Code is required *</label><input id="zip" required></div>
        <div class="f"><label for="county">County</label><input id="county"></div>
      </form>`;
    document.getElementById('cty')!.addEventListener('click', () => {
      countryClicks++;
      for (const id of ['a1', 'city', 'zip', 'county']) (document.getElementById(id) as HTMLInputElement).value = '';
    });
    // Google Places: typing shows suggestions; picking one fills the street, city and zip.
    const a1 = document.getElementById('a1') as HTMLInputElement;
    a1.addEventListener('input', () => {
      document.querySelector('.pac-container')?.remove();
      if (!a1.value) return;
      const box = document.createElement('div');
      box.className = 'pac-container';
      box.innerHTML = '<div class="pac-item">100 Main Street, Springfield, IL, USA</div><div class="pac-item">100 Main Street, Boston, MA, USA</div>';
      for (const item of Array.from(box.querySelectorAll('.pac-item'))) {
        item.addEventListener('mousedown', () => {
          a1.value = item.textContent!.split(',')[0];
          (document.getElementById('city') as HTMLInputElement).value = item.textContent!.split(', ')[1];
          (document.getElementById('zip') as HTMLInputElement).value = '62701';
          box.remove();
        });
      }
      document.body.appendChild(box);
    });
    if (addressFilled) a1.value = '100 Main Street';
  }

  it('reads labels that turned into errors ("City is required")', async () => {
    const { stripLabel } = await import('../src/engine/fields');
    expect(stripLabel('City is required*')).toBe('City');
    expect(stripLabel('Address Line 1 is required *')).toBe('Address Line 1');
  });

  it('sees the Country that is already chosen, and never picks it again', async () => {
    const { comboboxDisplay } = await import('../src/engine/fields');
    page(false);
    expect(comboboxDisplay(document.getElementById('cty')!)).toBe('United States');
    await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false });
    expect(countryClicks).toBe(0);
  }, 40000);

  it('picks the matching address suggestion, which fills city and zip', async () => {
    page(false);
    await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false });
    expect((document.getElementById('a1') as HTMLInputElement).value).toBe('100 Main Street');
    expect((document.getElementById('city') as HTMLInputElement).value).toBe('Springfield');
    expect((document.getElementById('zip') as HTMLInputElement).value).toBe('62701');
  }, 40000);

  it('on Continue: fills only required empty boxes, leaves optional ones and your answers alone', async () => {
    page(true);
    (document.getElementById('zip') as HTMLInputElement).value = '99999'; // you typed this
    await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false, requiredOnly: true });
    expect(countryClicks).toBe(0);
    expect((document.getElementById('a1') as HTMLInputElement).value).toBe('100 Main Street');
    expect((document.getElementById('city') as HTMLInputElement).value).toBe('Springfield');
    expect((document.getElementById('zip') as HTMLInputElement).value).toBe('99999');
    expect((document.getElementById('a2') as HTMLInputElement).value).toBe('');
  }, 40000);
});

describe('ADP-style questions page', () => {
  // <x-radio>Yes</x-radio>: each radio is a web component with its own <input> in a shadow root.
  class XRadio extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const sr = this.attachShadow({ mode: 'open' });
      sr.innerHTML = '<label><input type="radio"><slot></slot></label>';
      const input = sr.querySelector('input')!;
      // Picking one clears the others in the same group, like the real component.
      input.addEventListener('change', () => {
        for (const other of Array.from(this.parentElement!.querySelectorAll('x-radio'))) {
          if (other !== this) (other.shadowRoot!.querySelector('input') as HTMLInputElement).checked = false;
        }
      });
    }
  }
  if (!customElements.get('x-radio')) customElements.define('x-radio', XRadio);

  beforeEach(() => {
    document.body.innerHTML = `
      <form><h3>Please answer the following questions:</h3>
        <div class="q"><p>1. Are you legally authorized to work in the United States? *</p>
          <x-radio-group id="auth"><x-radio>Yes</x-radio><x-radio>No</x-radio></x-radio-group></div>
        <div class="q"><p>2. Will you now, or in the future, require sponsorship for employment visa status (e.g. H-1B visa status) *</p>
          <x-radio-group id="spons"><x-radio>Yes</x-radio><x-radio>No</x-radio></x-radio-group></div>
        <div class="q"><p id="q4">4. Will you require relocation assistance? *</p>
          <div role="radiogroup" aria-labelledby="q4" id="reloc">
            <div role="radio" aria-checked="false" tabindex="0">Yes</div><div role="radio" aria-checked="false" tabindex="0">No</div></div></div>
      </form>`;
    for (const r of Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'))) {
      r.addEventListener('click', () => {
        for (const o of Array.from(r.parentElement!.children)) o.setAttribute('aria-checked', String(o === r));
      });
    }
  });

  const picked = (groupId: string) =>
    Array.from(document.querySelectorAll(`#${groupId} x-radio`))
      .filter((x) => (x.shadowRoot!.querySelector('input') as HTMLInputElement).checked)
      .map((x) => x.textContent);

  it('answers Yes/No radios that live inside web components', async () => {
    const ai: AiAsk = async (q) => (/relocation/i.test(q.question) ? { answer: 'No', confidence: 0.9 } : null);
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false, ai });
    expect(picked('auth')).toEqual(['Yes']);
    expect(picked('spons')).toEqual(['No']);
    // A role="radio" group; relocation *assistance* went to the AI, not "willing to relocate".
    expect(document.querySelector('#reloc [aria-checked="true"]')?.textContent).toBe('No');
    expect(report.fields.find((f) => /relocation/i.test(f.label))?.reason).toMatch(/AI/);
  }, 30000);
});

describe('fields inside web components (shadow DOM)', () => {
  it('finds and fills an input inside a custom element, labelled by the text next to it', async () => {
    document.body.innerHTML = `<form><div class="f"><span>First Name*</span><x-input id="fn"></x-input></div><div class="f"><span>Last Name*</span><x-input id="ln"></x-input></div></form>`;
    for (const id of ['fn', 'ln']) {
      const sr = document.getElementById(id)!.attachShadow({ mode: 'open' });
      sr.innerHTML = '<input type="text">';
    }
    const report = await run({ ...base, profile: exampleProfile('swe'), autoAdvance: false });
    const inner = (id: string) => (document.getElementById(id)!.shadowRoot!.querySelector('input') as HTMLInputElement).value;
    expect(inner('fn')).toBe('Alex');
    expect(inner('ln')).toBe('Example');
    expect(report.fields.find((f) => f.label === 'First Name')?.status).toBe('filled');
  }, 30000);
});

describe('page snapshot', () => {
  it('includes what is inside web components, live values, and what the scanner saw', async () => {
    const { snapshot } = await import('../src/content/snapshot');
    document.body.innerHTML = '<form><p>Q?</p><x-box id="b"></x-box><label for="e">Email</label><input id="e"><input type="password" id="pw"></form>';
    document.getElementById('b')!.attachShadow({ mode: 'open' }).innerHTML = '<label>Yes<input type="radio"></label>';
    (document.getElementById('e') as HTMLInputElement).value = 'a@b.c';
    (document.getElementById('pw') as HTMLInputElement).value = 'secret';
    const s = snapshot();
    expect(s.html).toMatch(/<template shadowrootmode="open"><label>Yes<input type="radio"[^>]* data-live-checked="false"><\/label><\/template>/);
    expect(s.html).toContain('data-live-value="a@b.c"');
    expect(s.html).not.toContain('secret');
    expect(s.fields.find((f) => f.label === 'Email')).toMatchObject({ kind: 'text', key: 'email', value: 'a@b.c' });
  });
});

describe('AI button picker', () => {
  it('numbers the buttons and reads a valid choice back', async () => {
    const { buildGuidePrompt, parseGuide } = await import('../src/llm/openrouter');
    const prompt = buildGuidePrompt({ url: 'https://x.com', title: 'Job', text: 'Start your application', buttons: [{ i: 0, text: 'Apply Manually', kind: 'button', inDialog: false }] });
    expect(prompt).toContain('[0] button: "Apply Manually"');
    expect(parseGuide('{"choice": 0, "confidence": 0.9, "reason": "manual"}', 1)).toEqual({ choice: 0, confidence: 0.9, reason: 'manual' });
    expect(parseGuide('{"choice": 5, "confidence": 0.9, "reason": ""}', 1)).toBeNull();
  });
});

describe('what a page is (probe)', () => {
  const kind = (html: string) => {
    document.body.innerHTML = html;
    return probe().kind;
  };

  it('job posting with an Apply button', () => {
    expect(kind('<h1>Analyst</h1><p>Great job.</p><a href="https://x.com/apply">Apply now</a>')).toBe('apply');
  });
  it('ranks Apply buttons: manual > company site > plain > resume parser > apply-with-another-site', () => {
    document.body.innerHTML = '<button>Apply with Indeed</button><a href="/x">Apply on company site</a>';
    expect(applyButton()?.textContent).toBe('Apply on company site');
    document.body.innerHTML = '<button>Apply with Indeed</button>';
    expect(applyButton()?.textContent).toBe('Apply with Indeed');
    // Unum-style "Start Your Application" chooser.
    document.body.innerHTML = '<h2>Start Your Application</h2><button>Autofill with Resume</button><button>Apply Manually</button><button>Use My Last Application</button>';
    expect(applyButton()?.textContent).toBe('Apply Manually');
  });
  it('a privacy pop-up in front of the page (ADP "Consent & Continue")', () => {
    expect(
      kind(`<h1>SAP MM Business Process Analyst</h1><button>Apply</button>
        <div role="dialog" aria-modal="true"><h2>Privacy Policy</h2><p>Certain jurisdictions require notice…</p>
        <button>Consent &amp; Continue</button><button>Decline &amp; Close</button></div>`),
    ).toBe('blocker');
    expect(probe().detail).toMatch(/Consent & Continue/);
  });
  it('cookie banners: rejects optional cookies rather than accepting', () => {
    document.body.innerHTML = `<button>Apply</button><div id="onetrust-banner-sdk"><p>We use cookies to improve your experience.</p><button>Accept All Cookies</button><button>Reject All</button></div>`;
    expect(probe()).toMatchObject({ kind: 'blocker', detail: 'Cookie banner: "Reject All"' });
  });
  it('a form inside a pop-up is the form, not something to dismiss', () => {
    expect(
      kind(`<div role="dialog"><label for="a">First Name</label><input id="a"><label for="b">Last Name</label><input id="b"><label for="c">Email</label><input id="c"><button>Continue</button></div>`),
    ).toBe('form');
  });
  it('a redirect / loading page', () => {
    expect(kind('<div class="spinner"></div><p>Redirecting you to the company website…</p>')).toBe('loading');
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
