import { run } from '../src/engine/run';
import type { AiAsk } from '../src/engine/fill';
import { comboboxDisplay, scanFields } from '../src/engine/fields';
import { exampleProfile } from './helpers';

// Markup taken from a Wolve application (react-select dropdowns, Yes/No radios
// whose labels sit beside them with for=), via the extension's page snapshot.

const base = { learned: [], learn: false, overwrite: true, onReport: () => {} };

/** A react-select like Wolve's: value in a "single-value" node, input in an "input-container". */
function reactSelect(id: string, question: string, options: string[]): string {
  return `<div class="pad-v-3"><label class="external-form__label" for="${id}"><span>${question}</span></label>
    <div class="react-select css-container"><div class="react-select__control"><div class="react-select__value-container">
      <div class="react-select__placeholder">Select...</div>
      <div class="react-select__input-container"><input class="react-select__input" id="${id}" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-label="${question}" data-options="${options.join('|')}"></div>
    </div></div></div></div>`;
}

function yesNo(n: number, question: string): string {
  const one = (v: 'true' | 'false', text: string) => `<div class="col-1-2"><div class="checkable-input">
      <div id="answer-label-${n}-${v}" class="sr-only">${question} ${text.toLowerCase()}</div>
      <input class="checkable-input__input" type="radio" id="q${n}_${v}" name="answers[${n}][boolean_answer]" aria-labelledby="answer-label-${n}-${v}" value="${v}">
      <label aria-labelledby="answer-label-${n}-${v}" class="checkable-input__label" for="q${n}_${v}">${text}</label></div></div>`;
  return `<div class="pad-v-3"><label class="external-form__label" for="q${n}"><span>${question}</span></label>
    <div class="frow frow--gutters">${one('true', 'Yes')}${one('false', 'No')}</div></div>`;
}

beforeEach(() => {
  document.body.innerHTML = `<form>
    ${reactSelect('years', 'How many years of full-time experience do you currently have?', ['Less than 2 years', '2-5 years', '5+ years'])}
    ${reactSelect('soon', 'If offered the position, how soon would you be able to start?', ['Immediately', 'Within 1 month', 'Within 2 months', '3+ months'])}
    ${yesNo(7, 'Are you willing to work in our office 5 days a week?')}
    ${yesNo(9, 'Is any member of your household or immediate family currently employed by a proprietary trading firm, hedge fund or brokerage firm?')}
    <div><label for="pc">Postcode</label><input id="pc"></div>
  </form>`;
  // react-select behaviour: typing/clicking opens a listbox; picking shows a single-value node.
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('.react-select__input'))) {
    const open = () => {
      document.getElementById(`${input.id}-list`)?.remove();
      const ul = document.createElement('div');
      ul.id = `${input.id}-list`;
      ul.setAttribute('role', 'listbox');
      for (const o of input.dataset.options!.split('|').filter((x) => !input.value || x.toLowerCase().includes(input.value.toLowerCase()))) {
        const li = document.createElement('div');
        li.setAttribute('role', 'option');
        li.textContent = o;
        li.addEventListener('click', () => {
          const vc = input.closest('.react-select__value-container')!;
          vc.querySelector('.react-select__placeholder')?.remove();
          vc.querySelector('.react-select__single-value')?.remove();
          vc.insertAdjacentHTML('afterbegin', `<div class="react-select__single-value">${o}</div>`);
          input.value = '';
          ul.remove();
        });
        ul.appendChild(li);
      }
      document.body.appendChild(ul);
    };
    input.addEventListener('mousedown', open);
    input.addEventListener('input', open);
    input.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Escape' && document.getElementById(`${input.id}-list`)?.remove());
  }
});

describe('Wolve', () => {
  it('sees each Yes/No question once, not again through its labels', () => {
    const office = scanFields().filter((f) => /office 5 days/.test(f.label));
    expect(office.map((f) => f.kind)).toEqual(['radio']);
  });

  it('reads a react-select value, and its placeholder as empty', () => {
    const years = document.getElementById('years') as HTMLElement;
    expect(comboboxDisplay(years)).toBe('');
    years.closest('.react-select__value-container')!.insertAdjacentHTML('afterbegin', '<div class="react-select__single-value">Less than 2 years</div>');
    expect(comboboxDisplay(years)).toBe('Less than 2 years');
  });

  it('fills the dropdowns, office days and postcode; asks the AI once per question', async () => {
    const p = exampleProfile('swe');
    p.preferences.startAvailability = 'Within 2 months after offer acceptance';
    p.answers.push({ pattern: '/(office|on-?site).*(days?|week)/i', answer: 'Yes' });
    const asked: string[] = [];
    const ai: AiAsk = async (q) => {
      asked.push(q.question);
      if (/years/.test(q.question)) return { answer: 'Less than 2 years', confidence: 0.85 };
      if (/how soon/.test(q.question)) return { answer: 'Within 2 months', confidence: 0.9 };
      return null;
    };
    const report = await run({ ...base, profile: p, autoAdvance: false, ai });
    const shown = (id: string) => document.getElementById(id)!.closest('.react-select__value-container')!.querySelector('.react-select__single-value')?.textContent;
    expect(shown('years')).toBe('Less than 2 years');
    expect(shown('soon')).toBe('Within 2 months');
    expect((document.getElementById('q7_true') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('pc') as HTMLInputElement).value).toBe('62701');
    expect(report.fields.find((f) => /years/.test(f.label))?.status).toBe('filled');
    // Each question at most once.
    expect(asked.length).toBe(new Set(asked).size);
  }, 60000);
});
