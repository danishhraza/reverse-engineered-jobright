import { ApifyError, monthlyUsage, runSearch, toJobs, type Experience, type JobSearch, type WorkArrangement } from '../jobs/apify';
import { getSettings, getStore } from '../profile/storage';
import { getJobSearch, getQueue, setJobSearch } from '../queue/store';

// "Find jobs" on the Autopilot page: search career sites on Apify and add the
// results to the queue. It runs here, not in the background, so a search that
// takes a couple of minutes isn't cut off when Chrome idles the service worker.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const lines = (id: string) => $<HTMLTextAreaElement>(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
const checked = <T extends string>(name: string) => Array.from(document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)).map((i) => i.value as T);
const money = (n: number) => `$${n < 1 ? n.toFixed(3).replace(/0$/, '') : n.toFixed(2)}`;

function say(text: string, kind: '' | 'ok' | 'err' = ''): void {
  const el = $('findMsg');
  el.textContent = text;
  el.className = `muted grow ${kind}`;
}

function readForm(): JobSearch {
  const num = (id: string, min: number, max: number, fallback: number) => {
    const v = Number($<HTMLInputElement>(id).value);
    return Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(min, v)) : fallback;
  };
  return {
    titles: lines('fTitles'),
    locations: lines('fLocations'),
    timeRange: $<HTMLSelectElement>('fTime').value as JobSearch['timeRange'],
    count: Math.round(num('fCount', 10, 500, 20)),
    work: checked<WorkArrangement>('fWork'),
    experience: checked<Experience>('fExp'),
    supportedOnly: $<HTMLInputElement>('fSupported').checked,
    removeAgency: $<HTMLInputElement>('fNoAgency').checked,
    profile: $<HTMLSelectElement>('fProfile').value || undefined,
    maxUsd: Math.round(num('fMaxUsd', 0.05, 20, 0.5) * 100) / 100,
  };
}

function fillForm(s: JobSearch): void {
  $<HTMLTextAreaElement>('fTitles').value = s.titles.join('\n');
  $<HTMLTextAreaElement>('fLocations').value = s.locations.join('\n');
  $<HTMLSelectElement>('fTime').value = s.timeRange;
  $<HTMLInputElement>('fCount').value = String(s.count);
  $<HTMLInputElement>('fMaxUsd').value = s.maxUsd.toFixed(2);
  for (const i of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="fWork"]'))) i.checked = s.work.includes(i.value as WorkArrangement);
  for (const i of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="fExp"]'))) i.checked = s.experience.includes(i.value as Experience);
  $<HTMLInputElement>('fSupported').checked = s.supportedOnly;
  $<HTMLInputElement>('fNoAgency').checked = s.removeAgency;
  $<HTMLSelectElement>('fProfile').value = s.profile ?? '';
}

async function showUsage(token?: string): Promise<void> {
  const el = $('usage');
  if (!token) {
    el.textContent = 'Add your Apify API token below to search.';
    $<HTMLDetailsElement>('find').querySelector('details')!.open = true;
    return;
  }
  const u = await monthlyUsage(token);
  el.textContent = u ? `Apify this month: ${money(u.usedUsd)} used${u.limitUsd ? ` of your ${money(u.limitUsd)} limit` : ''}.` : '';
}

async function profilesInto(select: HTMLSelectElement): Promise<void> {
  const [store, settings] = await Promise.all([getStore(), getSettings()]);
  const active = store?.profiles.find((p) => p.id === settings.activeProfileId);
  select.innerHTML = '';
  select.add(new Option(`Active profile${active ? ` (${active.name})` : ''}`, ''));
  for (const p of store?.profiles ?? []) select.add(new Option(p.name, p.name));
}

export async function initFindJobs(addJobs: (jobs: ReturnType<typeof toJobs>['jobs']) => Promise<{ added?: number; duplicates?: number } | undefined>): Promise<void> {
  await profilesInto($<HTMLSelectElement>('fProfile'));
  const saved = await getJobSearch();
  fillForm(saved.search);
  $<HTMLInputElement>('fToken').value = saved.token ?? '';
  void showUsage(saved.token);

  $('fTokenSave').addEventListener('click', async () => {
    const token = $<HTMLInputElement>('fToken').value.trim();
    await setJobSearch({ token: token || undefined });
    say(token ? 'Token saved.' : 'Token removed.', 'ok');
    void showUsage(token);
  });

  const btn = $<HTMLButtonElement>('findBtn');
  btn.addEventListener('click', async () => {
    const search = readForm();
    fillForm(search);
    const { token } = await setJobSearch({ search });
    if (!token) {
      say('Add your Apify API token first.', 'err');
      $<HTMLDetailsElement>('find').querySelector('details')!.open = true;
      return;
    }
    if (!search.titles.length) return say('Add at least one job title.', 'err');
    btn.disabled = true;
    btn.textContent = 'Searching…';
    try {
      const run = await runSearch(token, search, { onStatus: (t) => say(t) });
      const { jobs, repeats } = toJobs(run.items, search.profile, await getQueue());
      const r = jobs.length ? await addJobs(jobs) : { added: 0, duplicates: 0 };
      const added = r?.added ?? 0;
      const dupes = (r?.duplicates ?? 0) + repeats;
      const cost = run.costUsd ? ` Cost: ${money(run.costUsd)}.` : '';
      say(
        run.items.length
          ? `Found ${run.items.length}. Added ${added} to the queue${dupes ? `; ${dupes} were already in it or listed twice` : ''}.${cost}`
          : `No jobs matched. Try more titles, a wider location, or a longer time.${cost}`,
        added ? 'ok' : '',
      );
    } catch (e) {
      say(e instanceof ApifyError ? e.message : `Search failed: ${(e as Error).message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Find jobs';
      void showUsage(token);
    }
  });
}
