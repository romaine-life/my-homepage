#!/usr/bin/env node
// Vendor the ambience client into this repo.
//
// The homepage shows a cross-client-synchronized ambient background behind the
// fzt bookmark terminal by subscribing to ambience's DEFAULT rotating world
// (bare paths: /events, /snapshot). Rather than load ambience's runtime from
// its server at runtime (brittle: unversioned, cache-drifts, and a stale client
// mis-renders against the live 60 Hz / 320x180 authority), we VENDOR a pinned
// snapshot of the client into frontend/ambience/ and serve it from our own
// origin. Only the SSE stream talks to ambience.
//
// The capability handshake (the world advertises servedEffects; this client
// asserts it supports them) is the backstop if the vendored client and the
// world ever drift.
//
// Unlike chess-tactics (which vendors the rain-scoped ambience-rain.wasm because
// it pins a single-effect world), the homepage subscribes to the rotating
// default world and can receive ANY effect — so it vendors the FULL
// ambience.wasm (all effects). The connect-time handshake validates that this
// build covers everything the world serves.
//
// Usage:
//   node scripts/vendor-ambience.mjs            # from https://ambience.romaine.life
//   AMBIENCE_BASE=https://ambience.dev.romaine.life node scripts/vendor-ambience.mjs
//
// Run this once after ambience ships a new client version, then commit the
// updated frontend/ambience/ (including manifest.json) to pin this version.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.AMBIENCE_BASE || 'https://ambience.romaine.life').replace(/\/+$/, '');

// The full client bundle: shared runtime JS + the all-effects WASM. sim.js and
// client.js are ambience's canonical consumer runtime; ambience.wasm is the full
// artifact this rotating-world subscriber needs (all effects, not rain-scoped).
const FILES = ['sim.js', 'client.js', 'wasm_runtime.js', 'wasm_exec.js', 'ambience.wasm'];

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'frontend', 'ambience');

async function main() {
  await mkdir(outDir, { recursive: true });
  const manifest = { base: BASE, files: {} };
  for (const name of FILES) {
    const url = `${BASE}/${name}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`vendor-ambience: ${url} -> HTTP ${res.status}. ` +
        'Is the ambience version with the vendored client deployed at this base?');
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(resolve(outDir, name), bytes);
    manifest.files[name] = bytes.length;
    console.log(`vendored ${name} (${bytes.length} bytes)`);
  }
  await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nWrote ${FILES.length} files + manifest.json to frontend/ambience/ from ${BASE}`);
  console.log('Commit the result to pin this version.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
