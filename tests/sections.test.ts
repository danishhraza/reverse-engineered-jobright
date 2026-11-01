import { run, runSingle } from '../src/engine/run';
import type { FieldReport, Profile } from '../src/types';
import { exampleProfile } from './helpers';

// An Avature-like "My Experience" page: repeating Work History / Education
// blocks behind "add another" links, and a tag-style skills picker.

function profile(): Profile {
  const p = exampleProfile('swe');
  p.work = [
    { company: 'Acme', title: 'Software Engineer', country: 'United States', current: true, start: { year: 2024, month: 3 }, bullets: ['Built things.'] },
    { company: 'Globex', title: 'Intern', start: { year: 2023, month: 6 }, end: { year: 2023, month: 8 } },
  ];
  p.education = [
    { school: 'Big Tech University', degree: 'Master of Science', major: 'Computer Science', country: 'United States', current: true, end: { year: 2028, month: 5 } },
    { school: 'Example State University', degree: 'Bachelor of Science', major: 'Computer Science', country: 'Pakistan', end: { year: 2023, month: 5 } },
  ];
  p.skills = ['React', 'Python', 'Cobol'];
  return p;
}

let n = 0;
const opt = (xs: string[]) => xs.map((x) => `<option>${x}</option>`).join('');
const selectOne = '<option value="">Select an option</option>';

function workBlock(): string {
  const i = ++n;
  return `<div class="block">
    <div><label for="emp${i}">Employer *</label><input id="emp${i}"></div>
    <div><label for="pt${i}">Position Title *</label><input id="pt${i}"></div>
    <div><label for="wc${i}">Country *</label><select id="wc${i}">${opt(['Pakistan', 'United States'])}</select></div>
    <div><label for="cur${i}">Current position? *</label><select id="cur${i}" class="cur">${selectOne}${opt(['Yes', 'No'])}</select></div>
    <div><label for="sd${i}">Start Date *</label><input id="sd${i}" placeholder="MM/YYYY"></div>
    <div class="endslot"></div>
    <div><label for="rr${i}">Roles &amp; Responsibilities</label><textarea id="rr${i}"></textarea></div>
    <a href="#">remove</a>
  </div>`;
}

function eduBlock(first: boolean): string {
  const i = ++n;
  const degrees = opt(["High School Graduate or Equivalent", "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Doctorate']);
  return `<div class="block">
    ${first ? `<div><label for="hd${i}">Highest Degree/Diploma Obtained *</label><select id="hd${i}">${selectOne}${degrees}</select></div>` : ''}
    <div><label for="sc${i}">School *</label><input id="sc${i}"></div>
    <div><label for="dg${i}">Degree *</label><select id="dg${i}">${selectOne}${degrees}</select></div>
    <div><label for="mj${i}">Major</label><input id="mj${i}"></div>
    <div><label for="ec${i}">Country *</label><select id="ec${i}">${opt(['United States', 'Pakistan'])}</select></div>
    <div><label for="sa${i}">Still Attending?</label><select id="sa${i}">${selectOne}${opt(['Yes', 'No'])}</select></div>
    <a href="#">remove</a>
  </div>`;
}

/** A tag picker: type, options load after a delay, clicking one adds a chip. */
function mountTags(input: HTMLInputElement, all: string[]): void {
  const box = input.parentElement!;
  const close = () => document.getElementById('sk-list')?.remove();
  input.addEventListener('input', () => {
    close();
    const q = input.value.toLowerCase();
    if (!q) return;
    setTimeout(() => {
      if (input.value.toLowerCase() !== q) return;
      const ul = document.createElement('ul');
      ul.id = 'sk-list';
      ul.setAttribute('role', 'listbox');
      const hits = all.filter((x) => x.toLowerCase().includes(q.slice(0, 3)));
      if (!hits.length) ul.innerHTML = '<li class="no-results">No results found</li>';
      for (const o of hits) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = o;
        li.addEventListener('click', () => {
          const chip = document.createElement('span');
          chip.className = 'tag';
          chip.innerHTML = `${o} <span class="x">×</span>`;
          box.insertBefore(chip, input);
          input.value = '';
          close();
        });
        ul.appendChild(li);
      }
      document.body.appendChild(ul);
    }, 200);
  });
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  });
}

const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
const sel = (id: string) => {
  const s = document.getElementById(id) as HTMLSelectElement;
  return s.selectedOptions[0]?.textContent ?? '';
};

beforeEach(() => {
  n = 0;
  document.body.innerHTML = `
    <form>
      <h2>Work Experience</h2>
      <div><label for="ct">Current Position Title *</label><input id="ct"></div>
      <div><label for="ce">Current Employer *</label><input id="ce"></div>
      <h3>Work History</h3>
      <div id="work">${workBlock()}</div>
      <a href="#" id="addWork">add another</a>
      <h3>Education History</h3>
      <div id="edu">${eduBlock(true)}</div>
      <a href="#" id="addEdu">add another</a>
      <h3>Languages</h3>
      <div><label for="lang">Language</label><select id="lang">${selectOne}${opt(['English', 'Urdu'])}</select></div>
      <a href="#" id="addLang">add another</a>
      <h3>Skills</h3>
      <div><label for="sk">Skills</label><div class="tags"><input id="sk" aria-autocomplete="list"></div></div>
    </form>`;
  const add = (link: string, list: string, html: () => string) =>
    document.getElementById(link)!.addEventListener('click', (e) => {
      e.preventDefault();
      setTimeout(() => document.getElementById(list)!.insertAdjacentHTML('beforeend', html()), 100);
    });
  add('addWork', 'work', workBlock);
  add('addEdu', 'edu', () => eduBlock(false));
  add('addLang', 'lang', () => '');
  // "Current position? No" reveals an End Date.
  document.addEventListener('change', (e) => {
    const s = e.target as HTMLSelectElement;
    if (!s.classList?.contains('cur')) return;
    const slot = s.closest('.block')!.querySelector('.endslot')!;
    slot.innerHTML = s.value === 'No' ? `<label for="ed-${s.id}">End Date</label><input id="ed-${s.id}" placeholder="MM/YYYY">` : '';
  });
  mountTags(document.getElementById('sk') as HTMLInputElement, ['.NET Framework', 'Reactor', 'React Native', 'React.js', 'Python', 'Real-Time PCR']);
});

const base = { learned: [], learn: false, onReport: () => {} };

describe('repeating Work / Education blocks', () => {
  it('fills one block per profile entry, in order, adding blocks as needed', async () => {
    const report = await run({ ...base, profile: profile(), overwrite: true, autoAdvance: false });
    const rows = report.fields;

    // Outside the blocks: the current job.
    expect(val('ct')).toBe('Software Engineer');
    expect(val('ce')).toBe('Acme');

    // Work 1 (already on the page) and Work 2 (added).
    expect(document.querySelectorAll('#work .block')).toHaveLength(2);
    expect(val('emp1')).toBe('Acme');
    expect(val('pt1')).toBe('Software Engineer');
    expect(sel('wc1')).toBe('United States');
    expect(sel('cur1')).toBe('Yes');
    expect(val('sd1')).toBe('03/2024');
    expect(val('rr1')).toBe('• Built things.');
    const w2 = document.querySelectorAll('#work .block')[1];
    const w2v = (lbl: string) => (w2.querySelector(`[id^="${lbl}"]`) as HTMLInputElement).value;
    expect(w2v('emp')).toBe('Globex');
    expect(w2v('pt')).toBe('Intern');
    expect((w2.querySelector('select.cur') as HTMLSelectElement).value).toBe('No');
    expect(w2v('sd')).toBe('06/2023');
    expect(w2v('ed-')).toBe('08/2023'); // revealed by "Current position? No"
    // No country for Globex: keeps the site's default instead of guessing.
    expect(byLabel(rows, /^Work 2: Country/)?.status).toBe('skipped');

    // Education: highest *completed* degree, then one block per school.
    expect(document.querySelectorAll('#edu .block')).toHaveLength(2);
    const e = (i: number, p: string) => document.querySelectorAll('#edu .block')[i].querySelector(`[id^="${p}"]`) as HTMLSelectElement;
    expect(e(0, 'hd').selectedOptions[0].textContent).toBe("Bachelor's Degree");
    expect(e(0, 'sc').value).toBe('Big Tech University');
    expect(e(0, 'dg').selectedOptions[0].textContent).toBe("Master's Degree");
    expect(e(0, 'sa').value).toBe('Yes');
    expect(e(1, 'sc').value).toBe('Example State University');
    expect(e(1, 'dg').selectedOptions[0].textContent).toBe("Bachelor's Degree");
    expect(e(1, 'ec').value).toBe('Pakistan');
    expect(e(1, 'sa').value).toBe('No');

    // Languages has its own "add another"; it isn't mistaken for Education.
    expect(document.getElementById('lang')).not.toBeNull();
  }, 40000);

  it('fills just the clicked field from the right entry', async () => {
    document.getElementById('addWork')!.click();
    await new Promise((r) => setTimeout(r, 200));
    const pt2 = document.querySelectorAll('#work .block')[1].querySelector('[id^="pt"]') as HTMLInputElement;
    await runSingle({ ...base, profile: profile() }, pt2);
    expect(pt2.value).toBe('Intern');
    expect(val('pt1')).toBe('');
  });
});

describe('tag-style skills', () => {
  it('adds skills one at a time and picks the closest option', async () => {
    const sk = document.getElementById('sk')!;
    const report = await runSingle({ ...base, profile: profile() }, sk);
    const chips = Array.from(document.querySelectorAll('.tag')).map((c) => c.firstChild!.textContent!.trim());
    expect(chips).toEqual(['React.js', 'Python']);
    const row = report.fields[0];
    expect(row.status).toBe('filled');
    expect(row.reason).toMatch(/Cobol/);
  }, 30000);
});

function byLabel(rows: FieldReport[], re: RegExp) {
  return rows.find((r) => re.test(r.label));
}
