import { readFileSync } from 'node:fs';
import { classify, resolve } from '../src/engine/answers';
import { scanFields } from '../src/engine/fields';
import { exampleProfile } from './helpers';

// Manual check against a saved real page:
//   LIVE_HTML=path/to/page.html npx vitest run tests/live-scan.test.ts
// Prints every field with its detected question, key and planned answer.

const file = process.env.LIVE_HTML;

describe.skipIf(!file)('live page scan', () => {
  it('classifies fields', () => {
    document.documentElement.innerHTML = readFileSync(file!, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');
    const profile = exampleProfile('swe');
    const rows = scanFields().map((f) => {
      const c = classify(f, profile.answers, []);
      const r = c ? resolve(c, profile, f) : null;
      const plan = !r ? '-' : 'desired' in r ? `= ${r.desired.text.slice(0, 40)}` : 'flag' in r ? `FLAG ${r.flag}` : `skip ${r.skip}`;
      return `${f.kind.padEnd(13)} ${f.required ? '*' : ' '} ${f.label.slice(0, 70).padEnd(70)} ${(c?.key ?? '?').padEnd(18)} ${plan}`;
    });
    console.log('\n' + rows.join('\n'));
  });
});
