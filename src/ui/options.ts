import { validateStore } from '../profile/merge';
import { getAccount, getLearned, getResume, getSettings, getStore, setAccount, setLearned, setResume, setSettings, setStore } from '../profile/storage';
import type { ProfileStore, Settings } from '../types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const editor = $<HTMLTextAreaElement>('editor');
const msg = $('msg');

function say(text: string, kind: 'ok' | 'err' = 'ok'): void {
  msg.textContent = text;
  msg.className = kind;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function save(store: ProfileStore): Promise<void> {
  await setStore(store);
  const settings = await getSettings();
  if (!settings.activeProfileId || !store.profiles.some((p) => p.id === settings.activeProfileId)) {
    await setSettings({ activeProfileId: store.profiles[0].id });
  }
  await render();
}

async function render(): Promise<void> {
  const [store, settings, learned] = await Promise.all([getStore(), getSettings(), getLearned()]);
  editor.value = store ? JSON.stringify(store, null, 2) : '';
  for (const k of ['autoAdvance', 'overwrite', 'learn', 'showFab'] as const) $<HTMLInputElement>(k).checked = settings[k];

  const list = $('profiles');
  list.innerHTML = '';
  if (!store) {
    list.innerHTML = '<p class="muted">No profiles yet. Import a profile JSON (see <code>profiles/example.json</code> in the repo).</p>';
  } else {
    for (const p of store.profiles) {
      const resume = await getResume(p.id);
      const div = document.createElement('div');
      div.className = 'profile';
      div.innerHTML = `
        <div>
          <div class="name">${esc(p.name)} ${settings.activeProfileId === p.id ? '<span class="pill filled">active</span>' : ''}</div>
          <div class="muted">${resume ? `Resume: ${esc(resume.name)} (${Math.round((resume.dataUrl.length * 0.75) / 1024)} KB)` : `<span style="color:var(--warn)">No resume file</span>${p.resumeFileName ? ` — expected ${esc(p.resumeFileName)}` : ''}`}</div>
        </div>
        <div class="actions">
          <label><button data-act="upload">${resume ? 'Replace PDF' : 'Attach PDF'}</button><input type="file" accept=".pdf,.doc,.docx" hidden /></label>
          ${resume ? '<button data-act="removeResume" class="danger">Remove PDF</button>' : ''}
          ${settings.activeProfileId === p.id ? '' : '<button data-act="activate">Make active</button>'}
        </div>`;
      const fileInput = div.querySelector('input[type=file]') as HTMLInputElement;
      div.querySelector('[data-act="upload"]')!.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(file);
        });
        await setResume(p.id, { name: file.name, type: file.type || 'application/pdf', dataUrl });
        say(`Saved ${file.name} for ${p.name}`);
        render();
      });
      div.querySelector('[data-act="removeResume"]')?.addEventListener('click', async () => {
        await setResume(p.id, null);
        render();
      });
      div.querySelector('[data-act="activate"]')?.addEventListener('click', async () => {
        await setSettings({ activeProfileId: p.id });
        render();
      });
      list.appendChild(div);
    }
  }

  const lt = $('learned');
  if (!learned.length) {
    lt.innerHTML = '<p class="muted">None yet.</p>';
  } else {
    lt.innerHTML = '<table><thead><tr><th>Question</th><th>Answer</th><th></th></tr></thead><tbody></tbody></table>';
    const tbody = lt.querySelector('tbody')!;
    learned.forEach((a, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(a.pattern)}</td><td>${esc(a.answer)}</td><td><button class="danger">Delete</button></td>`;
      tr.querySelector('button')!.addEventListener('click', async () => {
        learned.splice(i, 1);
        await setLearned(learned);
        render();
      });
      tbody.appendChild(tr);
    });
  }
}

$('saveBtn').addEventListener('click', async () => {
  try {
    const store = validateStore(JSON.parse(editor.value));
    await save(store);
    say('Saved.');
  } catch (e) {
    say(String((e as Error).message ?? e), 'err');
  }
});

$('importBtn').addEventListener('click', () => $<HTMLInputElement>('importFile').click());
$<HTMLInputElement>('importFile').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const store = validateStore(JSON.parse(await file.text()));
    await save(store);
    say(`Imported ${store.profiles.length} profiles. Now attach a resume PDF to each.`);
  } catch (err) {
    say(`Import failed: ${(err as Error).message}`, 'err');
  }
});

$('exportBtn').addEventListener('click', async () => {
  const store = await getStore();
  if (!store) return say('Nothing to export', 'err');
  const url = URL.createObjectURL(new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'autofill-profiles.json';
  a.click();
  URL.revokeObjectURL(url);
});

for (const k of ['autoAdvance', 'overwrite', 'learn', 'showFab'] as const) {
  $<HTMLInputElement>(k).addEventListener('change', (e) => setSettings({ [k]: (e.target as HTMLInputElement).checked } as Partial<Settings>));
}

// ---------- Job site login ----------

async function renderAccount(): Promise<void> {
  const a = await getAccount();
  $<HTMLInputElement>('accEmail').value = a.email ?? '';
  $<HTMLInputElement>('accUser').value = a.username ?? '';
  $<HTMLInputElement>('accPass').value = a.password ?? '';
}

$<HTMLInputElement>('accShow').addEventListener('change', (e) => {
  $<HTMLInputElement>('accPass').type = (e.target as HTMLInputElement).checked ? 'text' : 'password';
});
$('accSave').addEventListener('click', async () => {
  const v = (id: string) => $<HTMLInputElement>(id).value.trim() || undefined;
  await setAccount({ email: v('accEmail'), username: v('accUser'), password: $<HTMLInputElement>('accPass').value || undefined });
  $('accMsg').textContent = 'Saved.';
});
$('accClear').addEventListener('click', async () => {
  await setAccount({});
  await renderAccount();
  $('accMsg').textContent = 'Cleared.';
});

render();
renderAccount();
