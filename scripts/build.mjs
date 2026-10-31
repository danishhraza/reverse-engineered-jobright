import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

const options = {
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content/index.ts',
    sidepanel: 'src/ui/sidepanel.ts',
    options: 'src/ui/options.ts',
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
