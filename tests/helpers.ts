import { readFileSync } from 'node:fs';
import { resolveProfile, validateStore } from '../src/profile/merge';

export function exampleProfile(id = 'swe') {
  const store = validateStore(JSON.parse(readFileSync('profiles/example.json', 'utf8')));
  return resolveProfile(store, id);
}

/**
 * A react-select-like dropdown: an <input role=combobox>; options render
 * asynchronously after typing, filtered by the query; clicking one shows it
 * in a "single-value" node.
 */
export function mountAsyncCombobox(container: HTMLElement, options: string[], delay = 300): HTMLInputElement {
  const wrap = document.createElement('div');
  wrap.className = 'select__container';
  const single = document.createElement('div');
  single.className = 'select__single-value';
  const input = document.createElement('input');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  const listId = `list-${Math.random().toString(36).slice(2)}`;
  input.setAttribute('aria-controls', listId);
  wrap.append(single, input);
  container.appendChild(wrap);

  let list: HTMLElement | null = null;
  const close = () => {
    list?.remove();
    list = null;
    input.setAttribute('aria-expanded', 'false');
  };
  const open = (q: string) => {
    close();
    input.setAttribute('aria-expanded', 'true');
    list = document.createElement('div');
    list.id = listId;
    list.setAttribute('role', 'listbox');
    const loading = document.createElement('div');
    loading.setAttribute('role', 'option');
    loading.textContent = 'Loading...';
    list.appendChild(loading);
    document.body.appendChild(list);
    const l = list;
    setTimeout(() => {
      if (list !== l) return;
      l.innerHTML = '';
      for (const o of options.filter((x) => !q || x.toLowerCase().includes(q.toLowerCase()))) {
        const el = document.createElement('div');
        el.setAttribute('role', 'option');
        el.className = 'select__option';
        el.textContent = o;
        el.addEventListener('click', () => {
          single.textContent = o;
          input.value = '';
          close();
        });
        l.appendChild(el);
      }
    }, delay);
  };
  input.addEventListener('mousedown', () => open(input.value));
  input.addEventListener('input', () => open(input.value));
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  });
  return input;
}

/** Workday-style dropdown: a <button aria-haspopup=listbox> that opens a listbox elsewhere in the DOM. */
export function mountButtonDropdown(container: HTMLElement, label: string, options: string[]): HTMLButtonElement {
  const field = document.createElement('div');
  field.setAttribute('data-automation-id', `formField-${label.replace(/\W/g, '')}`);
  const l = document.createElement('label');
  l.textContent = label;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.textContent = 'Select One';
  field.append(l, btn);
  container.appendChild(field);
  btn.addEventListener('click', () => {
    if (document.querySelector('[data-test-list]')) return;
    btn.setAttribute('aria-expanded', 'true');
    const ul = document.createElement('ul');
    ul.setAttribute('role', 'listbox');
    ul.setAttribute('data-test-list', '');
    setTimeout(() => {
      for (const o of options) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = o;
        li.addEventListener('click', () => {
          btn.textContent = o;
          btn.setAttribute('aria-expanded', 'false');
          ul.remove();
        });
        ul.appendChild(li);
      }
    }, 150);
    document.body.appendChild(ul);
  });
  return btn;
}
