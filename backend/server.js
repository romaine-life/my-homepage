// Per-app backend for homepage.romaine.life. Serves the static frontend —
// no server-side logic. All dynamic data (bookmarks, auth) is handled by
// fzt-frontend.home.romaine.life via Bearer-authenticated fetches.
//
// Kept as a Node/Express pod (not nginx) to match the house pattern across
// house-hunt, investing, kill-me, plant-agent, llm-explorer, diagrams,
// fzt-frontend — uniform Dockerfile base, port, probes, and log shape.
import express from 'express';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorText, log, requestLog } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(requestLog());

app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

app.use(express.static(FRONTEND_DIR));

// fzt-browser's built files, from its npm package (PIPT-32).
const FZT_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('@romaine-life/fzt-browser/package.json')), 'dist');
for (const file of ['fzt.wasm', 'fzt-terminal.js', 'fzt-terminal.css', 'fzt-web.js']) {
  app.get(`/${file}`, (_req, res) => res.sendFile(file, { root: FZT_DIR }));
}

// SPA fallback. The app uses history.replaceState rather than client routing,
// but the fallback keeps deep URLs safe. Express 5 dropped the bare `*` route
// pattern, so use a regex.
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// The image's self-test (`--self-test`, run read-only by the web-app suite's image check): the
// page, the fzt-browser package's files and its generated config naming this release, each
// answering with its own content type, and the wasm a real WebAssembly module. `--source` checks
// only what the repo itself serves, its packages included, for the backend's own test.
const SOURCE_ROUTES = [['/', 'text/html'], ['/style.css', 'text/css'], ['/script.js', 'javascript'], ['/fzt-terminal.js', 'javascript'], ['/fzt-terminal.css', 'text/css'], ['/fzt-web.js', 'javascript']];
const BUILT_ROUTES = [['/config.js', 'javascript']];

async function selfTest(built) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/health`);
    if (health.status !== 200 || (await health.json()).status !== 'healthy') throw new Error(`/health: HTTP ${health.status}`);
    for (const [route, type] of built ? [...SOURCE_ROUTES, ...BUILT_ROUTES] : SOURCE_ROUTES) {
      const response = await fetch(base + route);
      const body = await response.text();
      if (response.status !== 200 || !body.length || !(response.headers.get('content-type') || '').includes(type)) {
        throw new Error(`${route}: HTTP ${response.status}, ${response.headers.get('content-type')}, ${body.length} bytes`);
      }
      if (route === '/config.js' && !body.includes(`homepageVersion: "${process.env.APP_VERSION}"`)) {
        throw new Error(`config.js doesn't name this release (${process.env.APP_VERSION})`);
      }
    }
    if (built) {
      const version = await (await fetch(`${base}/version.json`)).json();
      if (version.version !== process.env.APP_VERSION || version.sha !== process.env.SOURCE_SHA || !version.fztBrowser) {
        throw new Error(`version.json names ${JSON.stringify(version)}, not this image`);
      }
    }
    const wasm = Buffer.from(await (await fetch(`${base}/fzt.wasm`)).arrayBuffer());
    if (wasm.subarray(0, 4).toString('hex') !== '0061736d') throw new Error('fzt.wasm is not a WebAssembly module');
  } finally {
    server.closeAllConnections();
    server.close();
  }
  log.info('my-homepage self-test passed', { routes: built ? 'built' : 'source' });
}

if (process.argv.includes('--self-test')) {
  // Its result is the exit code; nothing is left open, so the process then ends.
  selfTest(!process.argv.includes('--source')).catch((error) => {
    log.error('my-homepage self-test failed', { error: errorText(error, { stack: false }) });
    process.exitCode = 1;
  });
} else {
  app.listen(PORT, () => log.info('my-homepage ready', { port: PORT }));
}
