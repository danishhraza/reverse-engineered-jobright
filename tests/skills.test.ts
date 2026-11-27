import { run } from '../src/engine/run';
import { setJobText } from '../src/engine/salary';
import { mentions, rankSkills, validPicks, type SkillPickRequest } from '../src/engine/skills';
import type { AiAsk } from '../src/engine/fill';
import { exampleProfile } from './helpers';

// Skills boxes: your skills that the job asks for first; the site's options are looked up,
// one AI call picks up to 10, then they're added one by one.

const base = { learned: [], learn: false, overwrite: true, autoAdvance: false, onReport: () => {} };

describe('ranking your skills against the job', () => {
  it('finds skills the description mentions, whole words only', () => {
    const jd = 'You will write C++ and Python services on AWS, using React.js and SQL. Experience with Java is a plus.';
    expect(mentions(jd, 'C++')).toBe(true);
    expect(mentions(jd, 'React')).toBe(true);
    expect(mentions(jd, 'React.js')).toBe(true);
    expect(mentions(jd, 'Java')).toBe(true);
    expect(mentions(jd, 'JavaScript')).toBe(false);
    expect(mentions(jd, 'C')).toBe(false);
    expect(mentions(jd, 'Go')).toBe(false);
  });

  it('puts the asked-for skills first and keeps your order otherwise', () => {
    expect(rankSkills(['Figma', 'Python', 'Docker', 'SQL', 'Python'], 'Python and SQL required')).toEqual(['Python', 'SQL', 'Figma', 'Docker']);
  });

  it('keeps only real options the site showed, without repeats', () => {
    const seen = [
      { query: 'React', options: ['React.js', 'React Native'] },
      { query: 'Python', options: ['Python'] },
    ];
    const picks = validPicks(
      [
        { query: 'React', option: 'react.js' },
        { query: 'React', option: 'Vue' }, // not offered
        { query: 'Python', option: 'Python' },
        { query: 'Python', option: 'Python' }, // repeat
      ],
      seen,
      10,
    );
    expect(picks).toEqual([
      { query: 'React', option: 'React.js' },
      { query: 'Python', option: 'Python' },
    ]);
  });
});

/** A tag picker searched on the server: options per query, a chip when one is clicked. */
function tagPicker(all: string[], freeText = false): { input: HTMLInputElement; chips: () => string[] } {
  document.body.innerHTML = `<form><label for="fn">First Name</label><input id="fn"><label for="sk">Skills</label><div class="tags"><input id="sk" aria-autocomplete="list"></div></form>`;
  const input = document.getElementById('sk') as HTMLInputElement;
  const box = input.parentElement!;
  const close = () => document.getElementById('sk-list')?.remove();
  const chip = (text: string) => {
    const c = document.createElement('span');
    c.className = 'tag';
    c.textContent = text;
    box.insertBefore(c, input);
  };
  input.addEventListener('input', () => {
    close();
    const q = input.value.toLowerCase();
    if (!q || freeText) return;
    setTimeout(() => {
      if (input.value.toLowerCase() !== q) return;
      const ul = document.createElement('ul');
      ul.id = 'sk-list';
      ul.setAttribute('role', 'listbox');
      const hits = all.filter((x) => x.toLowerCase().includes(q.slice(0, 4)));
      if (!hits.length) ul.innerHTML = '<li class="no-results">No results found</li>';
      for (const o of hits) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = o;
        li.addEventListener('click', () => {
          chip(o);
          input.value = '';
          close();
        });
        ul.appendChild(li);
      }
      document.body.appendChild(ul);
    }, 100);
  });
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter' && freeText && input.value.trim()) {
      chip(input.value.trim());
      input.value = '';
    }
  });
  return { input, chips: () => Array.from(box.querySelectorAll('.tag')).map((c) => c.textContent!) };
}

describe('filling a skills box', () => {
  beforeEach(() => setJobText('We need Python and SQL. Bonus: React.'));

  it('looks each skill up, asks the AI once, and adds what it picked', async () => {
    const { chips } = tagPicker(['Python', 'Python Scripting', 'SQL', 'MySQL', 'React.js', 'React Native', 'Docker']);
    const p = exampleProfile('swe');
    p.skills = ['Docker', 'React', 'Python', 'SQL', 'Cobol'];
    const asked: SkillPickRequest[] = [];
    const ai = (async () => null) as AiAsk;
    ai.pickSkills = async (r) => {
      asked.push(r);
      return [
        { query: 'Python', option: 'Python' },
        { query: 'SQL', option: 'SQL' },
        { query: 'React', option: 'React.js' },
      ];
    };
    await run({ ...base, profile: p, ai });
    expect(asked).toHaveLength(1);
    // The job's skills were looked up first, and the AI saw what the site offered for each.
    expect(asked[0].mine.slice(0, 3)).toEqual(['React', 'Python', 'SQL']);
    expect(asked[0].seen.find((s) => s.query === 'React')?.options).toEqual(['React.js', 'React Native']);
    expect(asked[0].seen.some((s) => s.query === 'Cobol')).toBe(false); // the site had nothing
    expect(asked[0].max).toBe(10);
    expect(chips()).toEqual(['Python', 'SQL', 'React.js']);
  }, 60000);

  it('without AI, adds close matches', async () => {
    const { chips } = tagPicker(['Python', 'SQL', 'React.js', 'React Native']);
    const p = exampleProfile('swe');
    p.skills = ['React', 'Python', 'SQL'];
    await run({ ...base, profile: p });
    expect(chips().sort()).toEqual(['Python', 'React.js', 'SQL']);
  }, 60000);

  it('a box that takes any text gets your skills typed in, up to 10', async () => {
    const { chips } = tagPicker([], true);
    const p = exampleProfile('swe');
    p.skills = Array.from({ length: 14 }, (_, i) => `Skill${i + 1}`);
    await run({ ...base, profile: p });
    expect(chips()).toHaveLength(10);
    expect(chips()[0]).toBe('Skill1');
  }, 90000);
});
