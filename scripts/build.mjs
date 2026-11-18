import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });
seed();

/**
 * Your own profile JSON (profiles/<name>.json), its resumes (profiles/resumes/<resumeFileName>)
 * and job-site email (profiles/account.json) go into dist/seed/, and the extension imports them
 * on install and on every reload. All of these are gitignored. SEED=0 leaves them out
 * (for a copy you give to someone else).
 */
function seed() {
  if (process.env.SEED === '0' || !existsSync('profiles')) return;
  const file = readdirSync('profiles').find((f) => f.endsWith('.json') && f !== 'example.json' && f !== 'account.json');
  if (!file) return;
  const store = JSON.parse(readFileSync(`profiles/${file}`, 'utf8'));
  const hash = createHash('sha1').update(JSON.stringify(store));
  mkdirSync('dist/seed', { recursive: true });
  writeFileSync('dist/seed/profiles.json', JSON.stringify(store));
  const resumes = {};
  for (const p of store.profiles ?? []) {
    const pdf = p.resumeFileName && `profiles/resumes/${p.resumeFileName}`;
    if (!pdf || !existsSync(pdf)) continue;
    copyFileSync(pdf, `dist/seed/${p.id}.pdf`);
    hash.update(readFileSync(pdf));
    resumes[p.id] = p.resumeFileName;
  }
  const account = existsSync('profiles/account.json') ? JSON.parse(readFileSync('profiles/account.json', 'utf8')) : undefined;
  if (account) hash.update(JSON.stringify(account));
  writeFileSync('dist/seed/seed.json', JSON.stringify({ version: hash.digest('hex').slice(0, 12), profiles: 'profiles.json', resumes, account }));
  console.log(`Seed: profiles/${file} + ${Object.keys(resumes).length} resume(s)${account ? ' + login email' : ''} -> dist/seed/`);
}

const options = {
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content/index.ts',
    sidepanel: 'src/ui/sidepanel.ts',
    options: 'src/ui/options.ts',
    queue: 'src/ui/queue.ts',
    // Standalone engine for injecting into a page without the extension (manual testing).
    inject: 'src/inject.ts',
  },
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outdir: 'dist',
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
