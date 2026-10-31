import { cancel } from '../src/engine/control';
import { run } from '../src/engine/run';
import type { FillReport } from '../src/types';
import { exampleProfile, mountAsyncCombobox } from './helpers';

it('reports what it is doing and stops promptly when cancelled', async () => {
  document.body.innerHTML = `
    <form>
      <div class="field"><label for="fn">First Name</label><input id="fn"></div>
      <div id="c"><label>Country</label></div>
      <div class="field"><label for="ln">Last Name</label><input id="ln"></div>
      <div class="field"><label for="em">Email</label><input id="em"></div>
    </form>`;
  // Options never match, so this dropdown would keep the fill busy for ~12s.
  mountAsyncCombobox(document.getElementById('c')!, ['Narnia', 'Mordor'], 50);

  const reports: FillReport[] = [];
  const started = Date.now();
  const p = run({
    profile: exampleProfile('swe'),
    learned: [],
    overwrite: true,
    autoAdvance: false,
    learn: false,
    onReport: (r) => {
      reports.push(r);
      if (/Country/.test(r.current ?? '') && !reports.some((x) => x.cancelled)) setTimeout(cancel, 300);
    },
  });
  const report = await p;

  expect(Date.now() - started).toBeLessThan(5000);
  expect(report.cancelled).toBe(true);
  expect(report.done).toBe(true);
  expect(report.message).toMatch(/^Stopped/);
  // Filled before the cancel; untouched after it.
  expect((document.getElementById('fn') as HTMLInputElement).value).toBe('Alex');
  expect((document.getElementById('em') as HTMLInputElement).value).toBe('');
  expect(reports.map((r) => r.current).filter(Boolean)).toEqual(expect.arrayContaining([expect.stringMatching(/Filling "First Name"/), expect.stringMatching(/Picking "Country"/)]));

  // A new fill after a cancel runs normally.
  const again = await run({ profile: exampleProfile('swe'), learned: [], overwrite: true, autoAdvance: false, learn: false, onReport: () => {} });
  expect(again.cancelled).toBeUndefined();
  expect((document.getElementById('em') as HTMLInputElement).value).toBe('alex@example.com');
});
