#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const ambienceRoot = path.resolve(
  process.env.AMBIENCE_REPO || path.join(repoRoot, '..', 'ambience'),
);
const checkOnly = process.argv.includes('--check');

const ambienceWeb = path.join(ambienceRoot, 'cmd', 'ambience', 'web');
const frontendDir = path.join(repoRoot, 'frontend');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeOrCheck(file, next) {
  const current = fs.existsSync(file) ? read(file) : '';
  if (current === next) return true;
  if (checkOnly) {
    console.error(`${path.relative(repoRoot, file)} is not synced`);
    return false;
  }
  fs.writeFileSync(file, next);
  return true;
}

function ensureAmbienceWeb() {
  const required = [
    path.join(ambienceWeb, 'sim.js'),
    path.join(ambienceWeb, 'client.js'),
  ];
  for (const p of required) {
    if (!fs.existsSync(p)) {
      console.error(`ambience web asset not found: ${p}`);
      process.exit(2);
    }
  }
}

ensureAmbienceWeb();

const ok = [
  writeOrCheck(path.join(frontendDir, 'ambience-sim.js'), read(path.join(ambienceWeb, 'sim.js'))),
  writeOrCheck(path.join(frontendDir, 'ambience-client.js'), read(path.join(ambienceWeb, 'client.js'))),
].every(Boolean);

if (!ok) process.exit(1);

if (!checkOnly) {
  console.log(`synced ambience assets from ${ambienceRoot}`);
}
