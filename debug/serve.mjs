// Tiny static server for the debug pages: node debug/serve.mjs  ->  http://localhost:5179/react-select.html
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

await build({ entryPoints: ['debug/react-select-page.ts'], bundle: true, format: 'iife', outdir: 'debug/out', define: { 'process.env.NODE_ENV': '"development"' } });
const types = { '.html': 'text/html', '.js': 'text/javascript' };
createServer(async (req, res) => {
  const path = join('debug', decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(5179, () => console.log('debug pages on http://localhost:5179/react-select.html'));
